//! "Connect OpenRouter": OAuth PKCE in the browser instead of pasting a key. OpenRouter sends
//! the browser back to a localhost address, where Writey trades the code for a key.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::loopback::Loopback;
use crate::error::{AppError, AppResult};

const AUTH_URL: &str = "https://openrouter.ai/auth";
const KEYS_URL: &str = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK_PATH: &str = "/openrouter";
/// OpenRouter accepts localhost callbacks on port 3000; any free port is the fallback.
const PORTS: [u16; 2] = [3000, 0];
const TIMEOUT: Duration = Duration::from_secs(300);

/// Returns the new API key once the user approves Writey on openrouter.ai.
pub async fn connect(
    http: &reqwest::Client,
    cancel: CancellationToken,
    open: impl FnOnce(&str) -> AppResult<()>,
) -> AppResult<String> {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let verifier = B64URL.encode(raw);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    let lb = Loopback::bind(&PORTS).await?;
    let mut url = url::Url::parse(AUTH_URL).expect("valid url");
    url.query_pairs_mut()
        .append_pair(
            "callback_url",
            &format!("http://localhost:{}{CALLBACK_PATH}", lb.port()),
        )
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    open(url.as_str())?;
    let (params, reply) = lb.wait(CALLBACK_PATH, TIMEOUT, cancel).await?;
    let Some(code) = params.get("code") else {
        let msg = "OpenRouter didn’t send a sign-in code. Try connecting again.";
        reply.page(false, msg).await;
        return Err(AppError::new("sign_in_failed", msg));
    };
    let res = http
        .post(KEYS_URL)
        .json(&serde_json::json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }))
        .send()
        .await;
    let key = match res {
        Ok(r) if r.status().is_success() => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v["key"].as_str().map(String::from)),
        Ok(r) => {
            let msg = format!("OpenRouter refused the sign-in ({}).", r.status().as_u16());
            reply.page(false, &msg).await;
            return Err(AppError::new("sign_in_failed", msg));
        }
        Err(e) => {
            let msg = format!("Couldn't reach OpenRouter: {e}");
            reply.page(false, &msg).await;
            return Err(AppError::new("network", msg));
        }
    };
    match key {
        Some(k) => {
            reply
                .page(
                    true,
                    "OpenRouter is connected. You can close this tab and go back to Writey.",
                )
                .await;
            Ok(k)
        }
        None => {
            let msg = "OpenRouter did not return a key.";
            reply.page(false, msg).await;
            Err(AppError::new("sign_in_failed", msg))
        }
    }
}
