//! Sign in with ChatGPT for open-source, locally run apps, and the Responses calls that use
//! the plan. Follows https://developers.openai.com/siwc/token-sharing-open-source: dynamic
//! client registration, a loopback callback on 127.0.0.1, PKCE + state + nonce, tokens kept
//! only on this computer (HANDOFF D15). A port of the Python Writey Helper, which the desktop
//! app replaces: nothing to install, nothing running in the background.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::loopback::Loopback;
use crate::error::{AppError, AppResult};
use crate::vault::Vault;

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY_URL: &str = "https://auth.openai.com/.well-known/openid-configuration";
const RESOURCE: &str = "https://api.openai.com/v1";
const API: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "Writey";
const CALLBACK_PATH: &str = "/auth/callback";
/// OpenAI's example port; any free port works for later sign-ins.
const CALLBACK_PORTS: [u16; 2] = [1455, 0];
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const REFRESH_MARGIN_S: f64 = 60.0;
const RECORD: &str = "chatgpt";

/// Rejected by plan usage (preview limitations), so stripped before sending.
const FORBIDDEN_PARAMS: &[&str] = &[
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
];

/// Refresh failures that mean the session is gone and the user must sign in again.
const TERMINAL_REFRESH_ERRORS: &[&str] = &[
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Status {
    pub signed_in: bool,
    pub email: Option<String>,
    /// The plan-usage scope was granted, so requests can use the ChatGPT plan.
    pub plan_usage: bool,
    /// First sign-in: show the "You're using your ChatGPT plan" notice once.
    pub welcome: bool,
    pub login_pending: bool,
    pub error: Option<String>,
}

pub struct ChatGpt {
    http: reqwest::Client,
    refresh_lock: tokio::sync::Mutex<()>,
    login: std::sync::Mutex<Option<CancellationToken>>,
    last_error: std::sync::Mutex<Option<String>>,
    jwks: tokio::sync::Mutex<Option<(Value, jsonwebtoken::jwk::JwkSet)>>,
}

struct Pending {
    state: String,
    nonce: String,
    verifier: String,
    redirect_uri: String,
    client_id: String,
    registering: bool,
    switching: bool,
}

fn random(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    B64URL.encode(b)
}

fn pkce_pair() -> (String, String) {
    let verifier = random(32);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn now_s() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Plan usage needs store=false, stream=true and the full history in `input`.
pub fn sanitize_request(body: &str) -> AppResult<Value> {
    let v: Value =
        serde_json::from_str(body).map_err(|_| AppError::bad("The request must be JSON."))?;
    let Value::Object(map) = v else {
        return Err(AppError::new(
            "bad_request",
            "The request must be a JSON object.",
        ));
    };
    let mut clean: Map<String, Value> = map
        .into_iter()
        .filter(|(k, _)| !FORBIDDEN_PARAMS.contains(&k.as_str()))
        .collect();
    if !clean.get("model").is_some_and(Value::is_string)
        || !clean.get("input").is_some_and(Value::is_array)
    {
        return Err(AppError::new(
            "bad_request",
            "The request needs a model and an input list.",
        ));
    }
    clean.insert("store".into(), Value::Bool(false));
    clean.insert("stream".into(), Value::Bool(true));
    Ok(Value::Object(clean))
}

impl ChatGpt {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            refresh_lock: tokio::sync::Mutex::new(()),
            login: std::sync::Mutex::new(None),
            last_error: std::sync::Mutex::new(None),
            jwks: tokio::sync::Mutex::new(None),
        }
    }

    fn record(&self, vault: &Vault) -> AppResult<Map<String, Value>> {
        Ok(match vault.get(RECORD)? {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        })
    }

    fn host_id(&self, vault: &Vault) -> AppResult<String> {
        if let Some(Value::String(id)) = vault.get("host_id")? {
            return Ok(id);
        }
        let id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        vault.set("host_id", Value::String(id.clone()))?;
        Ok(id)
    }

    fn set_error(&self, e: Option<String>) {
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = e;
    }

    pub fn status(&self, vault: &Vault) -> AppResult<Status> {
        let r = self.record(vault)?;
        let signed_in = r.get("refresh_token").is_some_and(|v| !v.is_null())
            || r.get("access_token").is_some_and(|v| !v.is_null());
        let scopes = scopes(&r);
        Ok(Status {
            signed_in,
            email: if signed_in {
                r.get("email").and_then(Value::as_str).map(Into::into)
            } else {
                None
            },
            plan_usage: signed_in && scopes.iter().any(|s| s == PLAN_SCOPE),
            welcome: signed_in && !r.get("welcomed").and_then(Value::as_bool).unwrap_or(false),
            login_pending: self
                .login
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some(),
            error: self
                .last_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        })
    }

    pub fn mark_welcomed(&self, vault: &Vault) -> AppResult<()> {
        let mut r = self.record(vault)?;
        if !r.is_empty() {
            r.insert("welcomed".into(), Value::Bool(true));
            vault.set(RECORD, Value::Object(r))?;
        }
        Ok(())
    }

    pub fn cancel_login(&self) {
        if let Some(t) = self.login.lock().unwrap_or_else(|p| p.into_inner()).take() {
            t.cancel();
        }
    }

    // ------------------------------------------------------------------ sign-in

    /// Opens OpenAI's sign-in in the browser (through `open`) and waits for it to come back.
    pub async fn login(
        &self,
        vault: &Vault,
        switching: bool,
        open: impl FnOnce(&str) -> AppResult<()>,
    ) -> AppResult<Status> {
        self.cancel_login();
        let cancel = CancellationToken::new();
        *self.login.lock().unwrap_or_else(|p| p.into_inner()) = Some(cancel.clone());
        let result = self.login_inner(vault, switching, open, cancel).await;
        *self.login.lock().unwrap_or_else(|p| p.into_inner()) = None;
        match result {
            Ok(()) => self.status(vault),
            Err(e) if e.code == "cancelled" => self.status(vault),
            Err(e) => {
                self.set_error(Some(e.message.clone()));
                Err(e)
            }
        }
    }

    async fn login_inner(
        &self,
        vault: &Vault,
        switching: bool,
        open: impl FnOnce(&str) -> AppResult<()>,
        cancel: CancellationToken,
    ) -> AppResult<()> {
        let r = self.record(vault)?;
        // Another account registers afresh, so the old client id and hints don't apply.
        let saved_client = r.get("client_id").and_then(Value::as_str).map(String::from);
        let registering = switching || saved_client.is_none();
        let (verifier, challenge) = pkce_pair();
        let lb = Loopback::bind(&CALLBACK_PORTS).await?;
        let p = Pending {
            state: random(24),
            nonce: random(24),
            verifier,
            redirect_uri: format!("http://127.0.0.1:{}{CALLBACK_PATH}", lb.port()),
            client_id: if registering {
                DYNAMIC_CLIENT.into()
            } else {
                saved_client.unwrap_or_default()
            },
            registering,
            switching,
        };
        self.set_error(None);
        let mut url = url::Url::parse(AUTHORIZE_URL).expect("valid url");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("response_type", "code")
                .append_pair("client_id", &p.client_id)
                .append_pair("redirect_uri", &p.redirect_uri)
                .append_pair("scope", SCOPES)
                .append_pair("resource", RESOURCE)
                .append_pair("state", &p.state)
                .append_pair("nonce", &p.nonce)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("ext_agent_host_id", &self.host_id(vault)?);
            if p.registering {
                q.append_pair("agent_name_hint", AGENT_NAME);
            } else {
                if let Some(h) = r.get("id_token").and_then(Value::as_str) {
                    q.append_pair("id_token_hint", h);
                }
                if let Some(h) = r.get("email").and_then(Value::as_str) {
                    q.append_pair("login_hint", h);
                }
            }
        }
        // The URL can carry an ID token hint, so it goes straight to the browser, never to logs.
        open(url.as_str())?;
        let (params, reply) = lb.wait(CALLBACK_PATH, LOGIN_TIMEOUT, cancel).await?;
        match self.handle_callback(vault, &p, &params).await {
            Ok(message) => {
                reply.page(true, &message).await;
                Ok(())
            }
            Err(e) => {
                reply.page(false, &e.message).await;
                Err(e)
            }
        }
    }

    async fn handle_callback(
        &self,
        vault: &Vault,
        p: &Pending,
        params: &std::collections::HashMap<String, String>,
    ) -> AppResult<String> {
        let fail = |m: &str| AppError::new("sign_in_failed", m);
        if !constant_eq(
            params.get("state").map(String::as_str).unwrap_or(""),
            &p.state,
        ) {
            return Err(fail(
                "This sign-in link doesn't match. Start again from Writey.",
            ));
        }
        if let Some(err) = params.get("error") {
            return Err(if err == "access_denied" {
                fail("You cancelled the ChatGPT sign-in.")
            } else {
                let desc = params.get("error_description").unwrap_or(err);
                AppError::new("sign_in_failed", format!("ChatGPT sign-in failed: {desc}"))
            });
        }
        let issued = match params.get("client_id") {
            Some(c) if p.registering && c != DYNAMIC_CLIENT => c.clone(),
            _ if p.registering => {
                return Err(fail("ChatGPT didn't finish registering Writey. Try again."))
            }
            Some(c) if c != &p.client_id => {
                return Err(fail("ChatGPT returned a different app id. Try again."))
            }
            _ => p.client_id.clone(),
        };
        let code = params
            .get("code")
            .ok_or_else(|| fail("ChatGPT didn't send a sign-in code. Try again."))?;
        let tokens = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", &issued),
                ("code", code),
                ("code_verifier", &p.verifier),
                ("redirect_uri", &p.redirect_uri),
                ("resource", RESOURCE),
            ])
            .await?;
        let claims = self
            .verify_id_token(
                tokens
                    .get("id_token")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                &issued,
                &p.nonce,
            )
            .await?;
        let sub = claims["sub"].as_str().unwrap_or_default().to_string();

        let prev = self.record(vault)?;
        let prev_sub = prev.get("subject").and_then(Value::as_str);
        if p.switching {
            self.revoke(&prev).await;
        } else if !p.registering && prev_sub.is_some_and(|s| s != sub) {
            return Err(fail(
                "That's a different ChatGPT account. In Writey, choose “Use another account”, then sign in again.",
            ));
        }
        let scope_str = tokens
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let scopes: Vec<&str> = scope_str.split_whitespace().collect();
        let welcomed = prev
            .get("welcomed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && prev_sub == Some(sub.as_str());
        let record = json!({
            "client_id": issued,
            "subject": sub,
            "email": claims.get("email"),
            "issuer": ISSUER,
            "ext_agent_host_id": self.host_id(vault)?,
            "id_token": tokens.get("id_token"),
            "access_token": tokens.get("access_token"),
            "refresh_token": tokens.get("refresh_token"),
            "token_type": tokens.get("token_type").cloned().unwrap_or(json!("Bearer")),
            "expires_at": now_s() + tokens.get("expires_in").and_then(Value::as_f64).unwrap_or(3600.0),
            "scopes": scopes,
            "saved_at": now_s() as i64,
            "welcomed": welcomed,
        });
        vault.set(RECORD, record)?;
        if !scopes.contains(&PLAN_SCOPE) {
            self.set_error(Some(
                "ChatGPT plan usage isn't enabled for Writey. Sign in again and allow 'Use your ChatGPT plan', or use an OpenRouter or OpenCode Zen key."
                    .into(),
            ));
        }
        Ok("You're signed in to ChatGPT. You can close this tab and go back to Writey.".into())
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> AppResult<Map<String, Value>> {
        let res = self
            .http
            .post(TOKEN_URL)
            .form(form)
            .send()
            .await
            .map_err(|e| AppError::new("network", format!("Couldn't reach OpenAI: {e}")))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status != reqwest::StatusCode::OK {
            let code = match &body["error"] {
                Value::String(s) => s.clone(),
                Value::Object(o) => o
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("token_error")
                    .into(),
                _ => "token_error".into(),
            };
            let desc = body["error_description"]
                .as_str()
                .unwrap_or(&code)
                .to_string();
            return Err(token_error(
                &code,
                status.as_u16(),
                format!("OpenAI refused the sign-in ({desc})."),
            ));
        }
        match body {
            Value::Object(m) => Ok(m),
            _ => Err(AppError::new(
                "token_error",
                "OpenAI sent an unexpected reply.",
            )),
        }
    }

    async fn discovery(&self) -> AppResult<(Value, jsonwebtoken::jwk::JwkSet)> {
        let mut cache = self.jwks.lock().await;
        if let Some(c) = cache.as_ref() {
            return Ok(c.clone());
        }
        let disc: Value = self
            .http
            .get(DISCOVERY_URL)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let jwks_uri = disc["jwks_uri"]
            .as_str()
            .ok_or_else(|| AppError::new("bad_id_token", "No JWKS address."))?;
        let set: jsonwebtoken::jwk::JwkSet = self
            .http
            .get(jwks_uri)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        *cache = Some((disc.clone(), set.clone()));
        Ok((disc, set))
    }

    async fn verify_id_token(
        &self,
        id_token: &str,
        client_id: &str,
        nonce: &str,
    ) -> AppResult<Value> {
        use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
        let bad = |why: String| {
            AppError::new(
                "bad_id_token",
                format!("ChatGPT's sign-in couldn't be verified ({why})."),
            )
        };
        let header = decode_header(id_token).map_err(|e| bad(e.to_string()))?;
        if !matches!(
            header.alg,
            Algorithm::RS256 | Algorithm::ES256 | Algorithm::PS256
        ) {
            return Err(bad(format!("{:?}", header.alg)));
        }
        let (_, set) = self.discovery().await?;
        let jwk = match &header.kid {
            Some(kid) => set.find(kid),
            None => set.keys.first(),
        }
        .ok_or_else(|| bad("unknown signing key".into()))?;
        let key = DecodingKey::from_jwk(jwk).map_err(|e| bad(e.to_string()))?;
        let mut v = Validation::new(header.alg);
        v.set_audience(&[client_id]);
        v.set_issuer(&[ISSUER]);
        v.leeway = 60;
        let data = decode::<Value>(id_token, &key, &v).map_err(|e| bad(e.to_string()))?;
        let claims = data.claims;
        if !constant_eq(claims["nonce"].as_str().unwrap_or(""), nonce) || !claims["sub"].is_string()
        {
            return Err(bad("nonce".into()));
        }
        Ok(claims)
    }

    // ------------------------------------------------------------------ tokens

    pub async fn access_token(&self, vault: &Vault, force: bool) -> AppResult<String> {
        // Refresh tokens rotate, so refreshes are serialized.
        let _guard = self.refresh_lock.lock().await;
        let mut r = self.record(vault)?;
        let access = r
            .get("access_token")
            .and_then(Value::as_str)
            .map(String::from);
        let refresh = r
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(String::from);
        if access.is_none() && refresh.is_none() {
            return Err(AppError::new("signed_out", "Sign in to ChatGPT first."));
        }
        if !scopes(&r).iter().any(|s| s == PLAN_SCOPE) {
            return Err(AppError::new(
                "plan_usage_disabled",
                "ChatGPT plan usage isn't enabled for Writey. Sign in again and allow 'Use your ChatGPT plan'.",
            ));
        }
        let expires = r.get("expires_at").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(a) = access {
            if !force && expires - now_s() > REFRESH_MARGIN_S {
                return Ok(a);
            }
        }
        let Some(refresh) = refresh else {
            return Err(AppError::new(
                "session_expired",
                "Your ChatGPT sign-in ended. Sign in again.",
            ));
        };
        let client_id = r
            .get("client_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let tokens = match self
            .token_request(&[
                ("grant_type", "refresh_token"),
                ("client_id", &client_id),
                ("refresh_token", &refresh),
                ("resource", RESOURCE),
            ])
            .await
        {
            Ok(t) => t,
            Err(e) if e.code == "session_expired" => {
                for k in ["access_token", "refresh_token", "expires_at"] {
                    r.remove(k);
                }
                vault.set(RECORD, Value::Object(r))?;
                return Err(e);
            }
            Err(e) => return Err(e),
        };
        let access = tokens
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        r.insert("access_token".into(), json!(access));
        if let Some(rt) = tokens.get("refresh_token") {
            r.insert("refresh_token".into(), rt.clone());
        }
        r.insert(
            "expires_at".into(),
            json!(
                now_s()
                    + tokens
                        .get("expires_in")
                        .and_then(Value::as_f64)
                        .unwrap_or(3600.0)
            ),
        );
        if let Some(s) = tokens.get("scope").and_then(Value::as_str) {
            r.insert(
                "scopes".into(),
                json!(s.split_whitespace().collect::<Vec<_>>()),
            );
        }
        r.insert("saved_at".into(), json!(now_s() as i64));
        vault.set(RECORD, Value::Object(r))?;
        Ok(access)
    }

    async fn revoke(&self, r: &Map<String, Value>) -> Option<bool> {
        let refresh = r.get("refresh_token").and_then(Value::as_str)?;
        let client_id = r
            .get("client_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let endpoint = match self.discovery().await {
            Ok((d, _)) => d["revocation_endpoint"].as_str().map(String::from),
            Err(_) => None,
        };
        let Some(endpoint) = endpoint else {
            return Some(false);
        };
        let res = self
            .http
            .post(endpoint)
            .form(&[
                ("token", refresh),
                ("token_type_hint", "refresh_token"),
                ("client_id", client_id),
            ])
            .send()
            .await;
        Some(matches!(res, Ok(r) if r.status() == reqwest::StatusCode::OK))
    }

    /// Signs out; keeps the registration so the next sign-in reuses this client id.
    pub async fn logout(&self, vault: &Vault) -> AppResult<Option<bool>> {
        let r = self.record(vault)?;
        let revoked = self.revoke(&r).await;
        if !r.is_empty() {
            let keep = [
                "client_id",
                "subject",
                "email",
                "issuer",
                "ext_agent_host_id",
                "welcomed",
            ];
            let kept: Map<String, Value> = r
                .into_iter()
                .filter(|(k, _)| keep.contains(&k.as_str()))
                .collect();
            vault.set(RECORD, Value::Object(kept))?;
        }
        self.set_error(None);
        Ok(revoked)
    }

    // ------------------------------------------------------------------ API

    /// Sends with the access token; one 401 forces a refresh and a retry.
    async fn authed(
        &self,
        vault: &Vault,
        build: impl Fn(&str) -> reqwest::RequestBuilder,
    ) -> AppResult<reqwest::Response> {
        for attempt in 0..2 {
            let token = self.access_token(vault, attempt == 1).await?;
            let res = build(&token)
                .send()
                .await
                .map_err(|e| AppError::new("network", format!("Couldn't reach ChatGPT: {e}")))?;
            if res.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                continue;
            }
            return Ok(res);
        }
        unreachable!()
    }

    pub async fn models(&self, vault: &Vault) -> AppResult<Value> {
        let res = self
            .authed(vault, |t| {
                self.http.get(format!("{API}/models")).bearer_auth(t)
            })
            .await?;
        if !res.status().is_success() {
            return Err(AppError::new(
                "models_failed",
                format!("Couldn't list ChatGPT models ({}).", res.status()),
            ));
        }
        let data: Value = res.json().await?;
        let items = data
            .get("models")
            .or_else(|| data.get("data"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let listed: Vec<Value> = items
            .into_iter()
            .filter(|m| {
                m.is_object()
                    && m.get("visibility")
                        .and_then(Value::as_str)
                        .unwrap_or("list")
                        == "list"
            })
            .collect();
        Ok(json!({ "models": listed }))
    }

    pub async fn open_responses(&self, vault: &Vault, body: &str) -> AppResult<reqwest::Response> {
        let clean = sanitize_request(body)?;
        let bytes = serde_json::to_vec(&clean)?;
        self.authed(vault, |t| {
            self.http
                .post(format!("{API}/responses"))
                .bearer_auth(t)
                .header("Accept", "text/event-stream")
                .header("Content-Type", "application/json")
                .body(bytes.clone())
        })
        .await
    }
}

fn scopes(r: &Map<String, Value>) -> Vec<String> {
    r.get("scopes")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

fn token_error(code: &str, status: u16, message: String) -> AppError {
    if TERMINAL_REFRESH_ERRORS.contains(&code) || status == 401 {
        AppError::new(
            "session_expired",
            "Your ChatGPT sign-in ended. Sign in again.",
        )
    } else {
        AppError {
            code: "token_error",
            message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_plan_requests() {
        let v = sanitize_request(r#"{"model":"gpt","input":[],"temperature":0.2,"store":true,"stream":false,"tools":[]}"#).unwrap();
        assert_eq!(v["store"], false);
        assert_eq!(v["stream"], true);
        assert!(v.get("temperature").is_none());
        assert!(v.get("tools").is_some());
        assert!(sanitize_request(r#"{"model":"gpt"}"#).is_err());
        assert!(sanitize_request("[]").is_err());
    }

    #[test]
    fn pkce_challenge_matches_verifier() {
        let (v, c) = pkce_pair();
        assert_eq!(c, B64URL.encode(Sha256::digest(v.as_bytes())));
        assert!(v.len() >= 43);
    }

    #[test]
    fn status_reads_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let g = ChatGpt::new(reqwest::Client::new());
        assert!(!g.status(&vault).unwrap().signed_in);
        vault
            .set(
                RECORD,
                json!({ "refresh_token": "r", "email": "a@b.c", "scopes": [PLAN_SCOPE] }),
            )
            .unwrap();
        let s = g.status(&vault).unwrap();
        assert!(s.signed_in && s.plan_usage && s.welcome);
        assert_eq!(s.email.as_deref(), Some("a@b.c"));
        g.mark_welcomed(&vault).unwrap();
        assert!(!g.status(&vault).unwrap().welcome);
    }

    #[test]
    fn terminal_refresh_errors_end_the_session() {
        assert_eq!(
            token_error("invalid_grant", 400, String::new()).code,
            "session_expired"
        );
        assert_eq!(
            token_error("whatever", 401, String::new()).code,
            "session_expired"
        );
        assert_eq!(
            token_error("server_error", 500, "x".into()).code,
            "token_error"
        );
    }

    #[tokio::test]
    async fn signed_out_has_no_token() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let g = ChatGpt::new(reqwest::Client::new());
        assert_eq!(
            g.access_token(&vault, false).await.unwrap_err().code,
            "signed_out"
        );
        vault.set(RECORD, json!({ "access_token": "a", "expires_at": now_s() + 600.0, "scopes": [PLAN_SCOPE] })).unwrap();
        assert_eq!(g.access_token(&vault, false).await.unwrap(), "a");
        vault
            .set(
                RECORD,
                json!({ "access_token": "a", "expires_at": now_s() + 600.0, "scopes": [] }),
            )
            .unwrap();
        assert_eq!(
            g.access_token(&vault, false).await.unwrap_err().code,
            "plan_usage_disabled"
        );
    }
}
