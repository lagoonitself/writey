//! Signing the desktop app in to the Writey account (the website's Google sign-in), so its
//! notebooks sync with the website. Supabase only returns to the website's own address, so
//! the website hands the sign-in code back to the app: the app opens
//! `SITE/?desktop_login=PORT&challenge=…`, the website sends the browser through Google and,
//! when it comes back with a code, forwards it to `127.0.0.1:PORT`. The app trades the code
//! for its own session with its PKCE verifier; the website never sees the app's tokens.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::remote::{SITE, SUPABASE_KEY, SUPABASE_URL};
use crate::ai::loopback::Loopback;
use crate::error::{AppError, AppResult};
use crate::vault::Vault;

const RECORD: &str = "account";
const CALLBACK_PATH: &str = "/account";
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Clone, Debug, Default)]
pub struct Account {
    pub signed_in: bool,
    pub email: Option<String>,
    pub user_id: Option<String>,
}

pub struct Auth {
    http: reqwest::Client,
    lock: tokio::sync::Mutex<()>,
    login: std::sync::Mutex<Option<CancellationToken>>,
}

fn now_s() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

impl Auth {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            lock: tokio::sync::Mutex::new(()),
            login: std::sync::Mutex::new(None),
        }
    }

    pub fn account(&self, vault: &Vault) -> Account {
        match vault.get(RECORD).ok().flatten() {
            Some(r) if r["refresh_token"].is_string() => Account {
                signed_in: true,
                email: r["email"].as_str().map(String::from),
                user_id: r["user_id"].as_str().map(String::from),
            },
            _ => Account::default(),
        }
    }

    pub fn cancel_login(&self) {
        if let Some(t) = self.login.lock().unwrap_or_else(|e| e.into_inner()).take() {
            t.cancel();
        }
    }

    pub async fn login(
        &self,
        vault: &Vault,
        open: impl FnOnce(&str) -> AppResult<()>,
    ) -> AppResult<Account> {
        self.cancel_login();
        let cancel = CancellationToken::new();
        *self.login.lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let verifier = B64URL.encode(raw);
        let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
        let mut state = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut state);
        let state = B64URL.encode(state);
        let lb = Loopback::bind(&[47824, 0]).await?;
        let mut url = url::Url::parse(SITE).expect("valid url");
        url.query_pairs_mut()
            .append_pair("desktop_login", &lb.port().to_string())
            .append_pair("challenge", &challenge)
            .append_pair("state", &state);
        open(url.as_str())?;
        let result = lb.wait(CALLBACK_PATH, TIMEOUT, cancel).await;
        *self.login.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let (params, reply) = result?;
        if params.get("state") != Some(&state) {
            reply
                .page(
                    false,
                    "This sign-in doesn't match. Start again from Writey.",
                )
                .await;
            return Err(AppError::new(
                "sign_in_failed",
                "The sign-in didn't match. Try again.",
            ));
        }
        let Some(code) = params.get("code") else {
            let why = params
                .get("error")
                .cloned()
                .unwrap_or_else(|| "no code".into());
            reply
                .page(false, &format!("Sign-in didn't finish ({why})."))
                .await;
            return Err(AppError::new(
                "sign_in_failed",
                format!("Sign-in didn't finish ({why})."),
            ));
        };
        match self
            .token(
                "pkce",
                json!({ "auth_code": code, "code_verifier": verifier }),
            )
            .await
        {
            Ok(session) => {
                self.save(vault, &session)?;
                reply.page(true, "Writey on this computer is signed in. Your notebooks will sync. You can close this tab.").await;
                Ok(self.account(vault))
            }
            Err(e) => {
                reply.page(false, &e.message).await;
                Err(e)
            }
        }
    }

    async fn token(&self, grant: &str, body: Value) -> AppResult<Value> {
        let res = self
            .http
            .post(format!("{SUPABASE_URL}/auth/v1/token?grant_type={grant}"))
            .header("apikey", SUPABASE_KEY)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                AppError::new(
                    "network",
                    format!("Couldn't reach your Writey account: {e}"),
                )
            })?;
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let msg = v["error_description"]
                .as_str()
                .or(v["msg"].as_str())
                .unwrap_or("sign-in refused")
                .to_string();
            return Err(if status.as_u16() == 400 || status.as_u16() == 401 {
                AppError::new(
                    "sync_signed_out",
                    format!("Your Writey account sign-in ended ({msg}). Sign in again."),
                )
            } else {
                AppError::new("sync_failed", msg)
            });
        }
        Ok(v)
    }

    fn save(&self, vault: &Vault, s: &Value) -> AppResult<()> {
        vault.set(
            RECORD,
            json!({
                "access_token": s["access_token"],
                "refresh_token": s["refresh_token"],
                "expires_at": now_s() + s["expires_in"].as_f64().unwrap_or(3600.0),
                "email": s["user"]["email"],
                "user_id": s["user"]["id"],
            }),
        )
    }

    /// A valid access token, refreshed when it's about to expire.
    pub async fn access_token(&self, vault: &Vault) -> AppResult<String> {
        let _guard = self.lock.lock().await;
        let r = vault
            .get(RECORD)?
            .ok_or_else(|| AppError::new("sync_signed_out", "Not signed in."))?;
        let fresh = r["expires_at"].as_f64().unwrap_or(0.0) - now_s() > 60.0;
        if let (true, Some(t)) = (fresh, r["access_token"].as_str()) {
            return Ok(t.to_string());
        }
        let refresh = r["refresh_token"]
            .as_str()
            .ok_or_else(|| AppError::new("sync_signed_out", "Not signed in."))?;
        match self
            .token("refresh_token", json!({ "refresh_token": refresh }))
            .await
        {
            Ok(s) => {
                self.save(vault, &s)?;
                Ok(s["access_token"].as_str().unwrap_or_default().to_string())
            }
            Err(e) if e.code == "sync_signed_out" => {
                vault.remove(RECORD)?;
                Err(e)
            }
            Err(e) => Err(e),
        }
    }

    pub async fn logout(&self, vault: &Vault) -> AppResult<()> {
        if let Ok(token) = self.access_token(vault).await {
            let _ = self
                .http
                .post(format!("{SUPABASE_URL}/auth/v1/logout?scope=local"))
                .header("apikey", SUPABASE_KEY)
                .bearer_auth(token)
                .send()
                .await;
        }
        vault.remove(RECORD)
    }
}
