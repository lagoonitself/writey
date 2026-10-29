//! Model calls. The UI builds the request body (prompts, page images, tools) exactly as the
//! web version did; Rust adds the key or ChatGPT token, sends it, and streams the reply
//! back unparsed over a Tauri channel. Keys never reach the web view.

pub mod chatgpt;
pub mod loopback;
pub mod openrouter;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::vault::Vault;

pub const KEY_PROVIDERS: [&str; 2] = ["openrouter", "opencode-zen"];
pub const BODY_MAX_BYTES: usize = 16 * 1024 * 1024;
const KEY_MAX_LENGTH: usize = 512;
const MODELS_TTL: Duration = Duration::from_secs(3600);
pub const REFERER: &str = "https://github.com/lagoonitself/writey";

fn chat_url(provider: &str) -> String {
    // Debug builds can point at a fake model for end-to-end tests.
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("WRITEY_TEST_CHAT_URL") {
        return url;
    }
    match provider {
        "openrouter" => "https://openrouter.ai/api/v1/chat/completions",
        _ => "https://opencode.ai/inference/openai/v1/chat/completions",
    }
    .into()
}

fn models_url(provider: &str) -> &'static str {
    match provider {
        "openrouter" => "https://openrouter.ai/api/v1/models?input_modalities=image",
        _ => "https://opencode.ai/zen/v1/models",
    }
}

pub fn check_key_provider(p: &str) -> AppResult<()> {
    if KEY_PROVIDERS.contains(&p) {
        Ok(())
    } else {
        Err(AppError::new(
            "bad_provider",
            format!("Unknown provider {p}"),
        ))
    }
}

/// What the UI may know about a saved key: never the key itself.
#[derive(Serialize, Clone)]
pub struct CredentialInfo {
    pub provider: String,
    pub label: Option<String>,
    pub last4: String,
    pub created_at: String,
}

/// One event of a streamed model reply, in order: `head`, then `data`…, then `end` or `error`.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StreamEvent {
    Head { status: u16, content_type: String },
    Data { text: String },
    End,
    Error { message: String },
}

pub struct Ai {
    pub http: reqwest::Client,
    running: Mutex<HashMap<u32, CancellationToken>>,
    models: Mutex<HashMap<String, (Instant, Value)>>,
    pub chatgpt: chatgpt::ChatGpt,
}

impl Ai {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("Writey/", env!("CARGO_PKG_VERSION"), " (desktop)"))
            .connect_timeout(Duration::from_secs(20))
            // Reasoning models can think for a while between chunks.
            .read_timeout(Duration::from_secs(300))
            .build()
            .expect("http client");
        Self {
            chatgpt: chatgpt::ChatGpt::new(http.clone()),
            http,
            running: Mutex::new(HashMap::new()),
            models: Mutex::new(HashMap::new()),
        }
    }

    // ------------------------------------------------------------------ keys

    pub fn list_credentials(&self, vault: &Vault) -> AppResult<Vec<CredentialInfo>> {
        let mut out = Vec::new();
        for p in KEY_PROVIDERS {
            if let Some(v) = vault.get(&format!("key:{p}"))? {
                out.push(CredentialInfo {
                    provider: p.into(),
                    label: v["label"].as_str().map(Into::into),
                    last4: v["last4"].as_str().unwrap_or_default().into(),
                    created_at: v["created_at"].as_str().unwrap_or_default().into(),
                });
            }
        }
        Ok(out)
    }

    pub async fn save_credential(
        &self,
        vault: &Vault,
        provider: &str,
        key: &str,
    ) -> AppResult<CredentialInfo> {
        check_key_provider(provider)?;
        let key = key.trim();
        if key.len() < 8 || key.len() > KEY_MAX_LENGTH || key.chars().any(char::is_whitespace) {
            return Err(AppError::new(
                "bad_key",
                "That doesn’t look like an API key.",
            ));
        }
        if provider == "openrouter" && !self.openrouter_key_works(key).await {
            return Err(AppError::new(
                "invalid_key",
                "OpenRouter says this key isn’t valid.",
            ));
        }
        let info = CredentialInfo {
            provider: provider.into(),
            label: None,
            last4: key
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
            created_at: crate::store::now(),
        };
        vault.set(
            &format!("key:{provider}"),
            json!({ "key": key, "label": info.label, "last4": info.last4, "created_at": info.created_at }),
        )?;
        Ok(info)
    }

    pub fn delete_credential(&self, vault: &Vault, provider: &str) -> AppResult<()> {
        check_key_provider(provider)?;
        vault.remove(&format!("key:{provider}"))
    }

    /// A clear 401 means the key is wrong. Anything else (an outage) doesn't block saving.
    async fn openrouter_key_works(&self, key: &str) -> bool {
        match self
            .http
            .get("https://openrouter.ai/api/v1/key")
            .bearer_auth(key)
            .send()
            .await
        {
            Ok(res) => res.status() != reqwest::StatusCode::UNAUTHORIZED,
            Err(_) => true,
        }
    }

    // ------------------------------------------------------------------ models

    pub async fn models(&self, vault: &Vault, provider: &str) -> AppResult<Value> {
        if provider == "chatgpt" {
            return self.chatgpt.models(vault).await;
        }
        check_key_provider(provider)?;
        if let Some((at, v)) = self
            .models
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(provider)
        {
            if at.elapsed() < MODELS_TTL {
                return Ok(v.clone());
            }
        }
        let res = self.http.get(models_url(provider)).send().await?;
        if !res.status().is_success() {
            return Err(AppError::new(
                "upstream_error",
                format!("The model list didn't load ({}).", res.status()),
            ));
        }
        let v: Value = res.json().await?;
        self.models
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(provider.into(), (Instant::now(), v.clone()));
        Ok(v)
    }

    // ------------------------------------------------------------------ streaming

    fn begin(&self, id: u32) -> CancellationToken {
        let token = CancellationToken::new();
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, token.clone());
        token
    }

    fn finish(&self, id: u32) {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }

    pub fn abort(&self, id: u32) {
        if let Some(t) = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        {
            t.cancel();
        }
    }

    /// Sends a Chat Completions body to OpenRouter or OpenCode Zen and streams the reply.
    pub async fn chat(
        &self,
        vault: &Vault,
        provider: &str,
        body: String,
        id: u32,
        ch: Channel<StreamEvent>,
    ) -> AppResult<()> {
        check_key_provider(provider)?;
        if body.len() > BODY_MAX_BYTES {
            return local_error(&ch, 413, "too_large");
        }
        let key = match vault.get(&format!("key:{provider}")) {
            Ok(Some(v)) => v["key"].as_str().unwrap_or_default().to_string(),
            Ok(None) => return local_error(&ch, 400, "no_key"),
            Err(_) => return local_error(&ch, 400, "key_unreadable"),
        };
        let mut req = self
            .http
            .post(chat_url(provider))
            .bearer_auth(key)
            .header("Content-Type", "application/json")
            .body(body);
        if provider == "openrouter" {
            req = req
                .header("HTTP-Referer", REFERER)
                .header("X-Title", "Writey");
        }
        let token = self.begin(id);
        let result = tokio::select! {
            _ = token.cancelled() => Ok(()),
            res = req.send() => match res {
                Ok(res) => pump(res, &ch, &token).await,
                Err(e) => send_error(&ch, &format!("Couldn't reach {}: {e}", provider_label(provider))),
            },
        };
        self.finish(id);
        result
    }

    /// Streams a Responses API call with the ChatGPT plan.
    pub async fn chatgpt_responses(
        &self,
        vault: &Vault,
        body: String,
        id: u32,
        ch: Channel<StreamEvent>,
    ) -> AppResult<()> {
        if body.len() > BODY_MAX_BYTES {
            return local_error(&ch, 413, "too_large");
        }
        let token = self.begin(id);
        let result = tokio::select! {
            _ = token.cancelled() => Ok(()),
            res = self.chatgpt.open_responses(vault, &body) => match res {
                Ok(res) => pump(res, &ch, &token).await,
                Err(e) => {
                    let status = match e.code { "signed_out" | "session_expired" => 401, "plan_usage_disabled" => 403, "network" => 503, _ => 400 };
                    send(&ch, StreamEvent::Head { status, content_type: "application/json".into() })?;
                    send(&ch, StreamEvent::Data { text: json!({ "error": e.code, "message": e.message }).to_string() })?;
                    send(&ch, StreamEvent::End)
                }
            },
        };
        self.finish(id);
        result
    }
}

impl Default for Ai {
    fn default() -> Self {
        Self::new()
    }
}

pub fn provider_label(p: &str) -> &'static str {
    match p {
        "openrouter" => "OpenRouter",
        "opencode-zen" => "OpenCode Zen",
        _ => "ChatGPT",
    }
}

fn send(ch: &Channel<StreamEvent>, ev: StreamEvent) -> AppResult<()> {
    // The window may be gone; nothing to do about it.
    ch.send(ev)
        .map_err(|e| AppError::new("closed", e.to_string()))
}

fn send_error(ch: &Channel<StreamEvent>, message: &str) -> AppResult<()> {
    send(
        ch,
        StreamEvent::Error {
            message: message.into(),
        },
    )
}

/// A failure decided here (no key, too big), shaped like the Worker's JSON errors.
fn local_error(ch: &Channel<StreamEvent>, status: u16, code: &str) -> AppResult<()> {
    send(
        ch,
        StreamEvent::Head {
            status,
            content_type: "application/json".into(),
        },
    )?;
    send(
        ch,
        StreamEvent::Data {
            text: json!({ "error": code }).to_string(),
        },
    )?;
    send(ch, StreamEvent::End)
}

/// Copies a response to the channel as text, keeping UTF-8 characters whole across chunks.
async fn pump(
    res: reqwest::Response,
    ch: &Channel<StreamEvent>,
    token: &CancellationToken,
) -> AppResult<()> {
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    send(
        ch,
        StreamEvent::Head {
            status,
            content_type,
        },
    )?;
    let mut stream = res.bytes_stream();
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let next = tokio::select! {
            _ = token.cancelled() => return Ok(()),
            n = stream.next() => n,
        };
        match next {
            None => break,
            Some(Err(e)) => return send_error(ch, &format!("The connection dropped: {e}")),
            Some(Ok(bytes)) => {
                carry.extend_from_slice(&bytes);
                let text = take_utf8(&mut carry);
                if !text.is_empty() {
                    send(ch, StreamEvent::Data { text })?;
                }
            }
        }
    }
    if !carry.is_empty() {
        send(
            ch,
            StreamEvent::Data {
                text: String::from_utf8_lossy(&carry).into_owned(),
            },
        )?;
    }
    send(ch, StreamEvent::End)
}

/// Takes the longest valid UTF-8 prefix out of `buf`, leaving a split character behind.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        // Truly invalid bytes: let the lossy conversion replace them.
        Err(_) => buf.len(),
    };
    let rest = buf.split_off(valid);
    let text = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_chunks() {
        let s = "x = π · ∫";
        let bytes = s.as_bytes();
        let mut buf = bytes[..5].to_vec(); // "x = " + first byte of π
        let mut out = take_utf8(&mut buf);
        assert_eq!(out, "x = ");
        assert_eq!(buf.len(), 1);
        buf.extend_from_slice(&bytes[5..]);
        out.push_str(&take_utf8(&mut buf));
        assert_eq!(out, s);
        assert!(buf.is_empty());
    }

    #[test]
    fn invalid_bytes_do_not_stall() {
        let mut buf = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut buf), "a\u{fffd}b");
        assert!(buf.is_empty());
    }
}
