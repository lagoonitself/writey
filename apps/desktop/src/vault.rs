//! Secrets on this computer: API keys and the ChatGPT sign-in. One AES-256-GCM encrypted
//! file in the app's data folder; its key lives in the OS keychain (Windows Credential
//! Manager, macOS Keychain). Where no keychain is available, the key sits in an owner-only
//! file next to it, as the old Writey Helper kept its tokens.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

const KEYCHAIN_SERVICE: &str = "Writey";
const KEYCHAIN_USER: &str = "vault-key";
const FILE: &str = "vault.bin";
const KEY_FILE: &str = "vault.key";

#[derive(Serialize, Deserialize)]
struct Envelope {
    /// Where the key is: "keychain" or "file".
    key: String,
    nonce: String,
    data: String,
}

/// Decrypted contents, the key and where the key is kept.
type Opened = (Map<String, Value>, [u8; 32], String);

pub struct Vault {
    dir: PathBuf,
    /// Loaded on first use.
    cache: Mutex<Option<Opened>>,
}

impl Vault {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
            cache: Mutex::new(None),
        }
    }

    pub fn get(&self, name: &str) -> AppResult<Option<Value>> {
        self.with(|m| Ok(m.get(name).cloned()))
    }

    pub fn set(&self, name: &str, value: Value) -> AppResult<()> {
        self.update(|m| {
            m.insert(name.into(), value);
        })
    }

    pub fn remove(&self, name: &str) -> AppResult<()> {
        self.update(|m| {
            m.remove(name);
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Map<String, Value>) -> AppResult<T>) -> AppResult<T> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache.is_none() {
            *cache = Some(self.load()?);
        }
        f(&cache.as_ref().expect("loaded").0)
    }

    fn update(&self, f: impl FnOnce(&mut Map<String, Value>)) -> AppResult<()> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache.is_none() {
            *cache = Some(self.load()?);
        }
        let (map, key, place) = cache.as_mut().expect("loaded");
        f(map);
        self.save(map, key, place)
    }

    fn load(&self) -> AppResult<Opened> {
        let path = self.dir.join(FILE);
        let Ok(raw) = std::fs::read(&path) else {
            let (key, place) = self.new_key()?;
            return Ok((Map::new(), key, place));
        };
        let env: Envelope =
            serde_json::from_slice(&raw).map_err(|_| locked("the saved keys file is damaged"))?;
        let key = match env.key.as_str() {
            "keychain" => keychain_get()?,
            _ => self.file_key_get()?,
        };
        let nonce = B64.decode(env.nonce).map_err(|_| locked("bad nonce"))?;
        let data = B64.decode(env.data).map_err(|_| locked("bad data"))?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(AppError::internal)?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&nonce), data.as_ref())
            .map_err(|_| locked("the key doesn't match"))?;
        let map: Map<String, Value> = serde_json::from_slice(&plain)?;
        Ok((map, key, env.key))
    }

    fn save(&self, map: &Map<String, Value>, key: &[u8; 32], place: &str) -> AppResult<()> {
        let cipher = Aes256Gcm::new_from_slice(key).map_err(AppError::internal)?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let plain = serde_json::to_vec(map)?;
        let data = cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_ref())
            .map_err(AppError::internal)?;
        let env = Envelope {
            key: place.into(),
            nonce: B64.encode(nonce),
            data: B64.encode(data),
        };
        std::fs::create_dir_all(&self.dir)?;
        crate::store::write_atomic(&self.dir.join(FILE), &serde_json::to_vec(&env)?)?;
        Ok(())
    }

    /// A fresh key, kept in the keychain when there is one.
    fn new_key(&self) -> AppResult<([u8; 32], String)> {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        if !cfg!(test) {
            match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
                .and_then(|e| e.set_password(&B64.encode(key)))
            {
                Ok(()) => return Ok((key, "keychain".into())),
                Err(e) => log::warn!("no keychain ({e}); keeping the vault key in a file"),
            }
        }
        std::fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(KEY_FILE);
        crate::store::write_atomic(&path, B64.encode(key).as_bytes())?;
        restrict(&path);
        Ok((key, "file".into()))
    }

    fn file_key_get(&self) -> AppResult<[u8; 32]> {
        let raw = std::fs::read_to_string(self.dir.join(KEY_FILE))
            .map_err(|_| locked("the key file is missing"))?;
        decode_key(raw.trim())
    }

    /// Forgets every saved key and sign-in (used when the keychain lost the vault key).
    pub fn reset(&self) -> AppResult<()> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        *cache = None;
        let _ = std::fs::remove_file(self.dir.join(FILE));
        let _ = std::fs::remove_file(self.dir.join(KEY_FILE));
        if !cfg!(test) {
            if let Ok(e) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER) {
                let _ = e.delete_credential();
            }
        }
        Ok(())
    }
}

fn keychain_get() -> AppResult<[u8; 32]> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| locked(&e.to_string()))?;
    let raw = entry
        .get_password()
        .map_err(|e| locked(&format!("the keychain didn't open ({e})")))?;
    decode_key(&raw)
}

fn decode_key(raw: &str) -> AppResult<[u8; 32]> {
    B64.decode(raw)
        .ok()
        .and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok())
        .ok_or_else(|| locked("the key is damaged"))
}

fn locked(why: &str) -> AppError {
    AppError::new(
        "vault_locked",
        format!("Writey couldn't open your saved keys: {why}. Reset them in Settings → Privacy and add them again."),
    )
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::new(dir.path());
        assert!(v.get("openrouter").unwrap().is_none());
        v.set("openrouter", serde_json::json!({ "key": "sk-or-123" }))
            .unwrap();
        let raw = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!raw.contains("sk-or-123"));
        let again = Vault::new(dir.path());
        assert_eq!(
            again.get("openrouter").unwrap().unwrap()["key"],
            "sk-or-123"
        );
        again.remove("openrouter").unwrap();
        assert!(Vault::new(dir.path()).get("openrouter").unwrap().is_none());
    }

    #[test]
    fn wrong_key_is_locked() {
        let dir = tempfile::tempdir().unwrap();
        Vault::new(dir.path()).set("x", Value::Bool(true)).unwrap();
        std::fs::write(dir.path().join(KEY_FILE), B64.encode([7u8; 32])).unwrap();
        let err = Vault::new(dir.path()).get("x").unwrap_err();
        assert_eq!(err.code, "vault_locked");
    }
}
