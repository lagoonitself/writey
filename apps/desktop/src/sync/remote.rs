//! The Writey account as the sync engine sees it: the website's Supabase tables (rows, through
//! PostgREST with the user's token, so row-level security applies) and its Worker (page ink in
//! R2 with a version check, PDFs and pictures).

use std::future::Future;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::store::sync::{RMessage, RNotebook, RPage, RThread};
use crate::store::AssetRow;

pub const SUPABASE_URL: &str = "https://ksnpzfgcxjallzucvuhr.supabase.co";
/// Public by design (it's in the website's code); row-level security protects the data.
pub const SUPABASE_KEY: &str = "sb_publishable_ga-uXWG_WWoxz5jrl4y6hQ_UcZ7JNgo";
pub const SITE: &str = "https://writey.writey.workers.dev";

pub enum Put {
    Saved(i64),
    Conflict(i64),
}

/// What sync needs from the account. `since` is a server timestamp ("" = everything).
pub trait Remote {
    fn notebooks(&self, since: &str) -> impl Future<Output = AppResult<Vec<RNotebook>>> + Send;
    fn pages(&self, since: &str) -> impl Future<Output = AppResult<Vec<RPage>>> + Send;
    fn threads(&self, since: &str) -> impl Future<Output = AppResult<Vec<RThread>>> + Send;
    fn thread_ids(&self) -> impl Future<Output = AppResult<Vec<String>>> + Send;
    fn messages(
        &self,
        thread_ids: &[String],
    ) -> impl Future<Output = AppResult<Vec<RMessage>>> + Send;
    fn push_notebooks(&self, rows: &[RNotebook]) -> impl Future<Output = AppResult<()>> + Send;
    fn push_pages(&self, rows: &[RPage]) -> impl Future<Output = AppResult<()>> + Send;
    fn push_threads(&self, rows: &[RThread]) -> impl Future<Output = AppResult<()>> + Send;
    fn push_messages(&self, rows: &[RMessage]) -> impl Future<Output = AppResult<()>> + Send;
    fn delete_threads(&self, ids: &[String]) -> impl Future<Output = AppResult<()>> + Send;
    /// The page's server version and ink (None when never written on).
    fn content(&self, page: &str)
        -> impl Future<Output = AppResult<(i64, Option<Vec<u8>>)>> + Send;
    fn put_content(
        &self,
        page: &str,
        base: i64,
        bytes: &[u8],
    ) -> impl Future<Output = AppResult<Put>> + Send;
    /// A file's type and bytes.
    fn asset(&self, id: &str) -> impl Future<Output = AppResult<(String, Vec<u8>)>> + Send;
    fn put_asset(
        &self,
        row: &AssetRow,
        mime: &str,
        bytes: &[u8],
    ) -> impl Future<Output = AppResult<()>> + Send;
}

pub struct Http {
    pub http: reqwest::Client,
    pub token: String,
}

const PAGE_SIZE: usize = 1000;

impl Http {
    fn rest(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{SUPABASE_URL}/rest/v1/{path}"))
            .header("apikey", SUPABASE_KEY)
            .bearer_auth(&self.token)
    }

    fn worker(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{SITE}/api{path}"))
            .bearer_auth(&self.token)
    }

    /// All rows of a select, a page at a time, oldest change first.
    async fn select<T: serde::de::DeserializeOwned>(
        &self,
        table: &str,
        query: &str,
    ) -> AppResult<Vec<T>> {
        let mut out = Vec::new();
        loop {
            let res = self
                .rest(
                    reqwest::Method::GET,
                    &format!("{table}?{query}&limit={PAGE_SIZE}&offset={}", out.len()),
                )
                .send()
                .await?;
            let batch: Vec<T> = check(res).await?.json().await?;
            let n = batch.len();
            out.extend(batch);
            if n < PAGE_SIZE {
                return Ok(out);
            }
        }
    }

    async fn upsert(&self, table: &str, rows: Value, ignore: bool) -> AppResult<()> {
        if rows.as_array().is_some_and(|a| a.is_empty()) {
            return Ok(());
        }
        let prefer = if ignore {
            "resolution=ignore-duplicates,return=minimal"
        } else {
            "resolution=merge-duplicates,return=minimal"
        };
        let res = self
            .rest(reqwest::Method::POST, &format!("{table}?on_conflict=id"))
            .header("Prefer", prefer)
            .json(&rows)
            .send()
            .await?;
        check(res).await?;
        Ok(())
    }
}

async fn check(res: reqwest::Response) -> AppResult<reqwest::Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body = res.text().await.unwrap_or_default();
    Err(if status == reqwest::StatusCode::UNAUTHORIZED {
        AppError::new(
            "sync_signed_out",
            "Your Writey account sign-in ended. Sign in again to keep syncing.",
        )
    } else {
        AppError::new(
            "sync_failed",
            format!(
                "The Writey account answered {status}: {}",
                body.chars().take(200).collect::<String>()
            ),
        )
    })
}

/// PostgREST filter: rows after `(at, id)` in `(updated_at asc, id asc)` order. Plain `gt` on
/// `updated_at` alone skips rows that share the same timestamp as the cursor.
fn since_filter(at: &str, id: &str) -> String {
    if at.is_empty() {
        return String::new();
    }
    let enc_at = url::form_urlencoded::byte_serialize(at.as_bytes()).collect::<String>();
    if id.is_empty() {
        return format!("&updated_at=gt.{enc_at}");
    }
    let enc_id = url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
    format!("&or=(updated_at.gt.{enc_at},and(updated_at.eq.{enc_at},id.gt.{enc_id}))")
}

fn parse_since(since: &str) -> (&str, &str) {
    match since.split_once('\x1f') {
        Some((at, id)) => (at, id),
        None => (since, ""),
    }
}

impl Remote for Http {
    async fn notebooks(&self, since: &str) -> AppResult<Vec<RNotebook>> {
        let (at, id) = parse_since(since);
        self.select(
            "notebooks",
            &format!(
                "select=id,title,sort_key,created_at,updated_at,deleted_at&order=updated_at,id{}",
                since_filter(at, id)
            ),
        )
        .await
    }

    async fn pages(&self, since: &str) -> AppResult<Vec<RPage>> {
        let (at, id) = parse_since(since);
        self.select(
            "pages",
            &format!(
                "select=id,notebook_id,sort_key,width,height,background,version,updated_at,deleted_at&order=updated_at,id{}",
                since_filter(at, id)
            ),
        )
        .await
    }

    async fn threads(&self, since: &str) -> AppResult<Vec<RThread>> {
        let (at, id) = parse_since(since);
        self.select(
            "ai_threads",
            &format!(
                "select=id,notebook_id,title,created_at,updated_at&order=updated_at,id{}",
                since_filter(at, id)
            ),
        )
        .await
    }

    async fn thread_ids(&self) -> AppResult<Vec<String>> {
        let rows: Vec<Value> = self.select("ai_threads", "select=id&order=id").await?;
        Ok(rows
            .iter()
            .filter_map(|r| r["id"].as_str().map(String::from))
            .collect())
    }

    async fn messages(&self, thread_ids: &[String]) -> AppResult<Vec<RMessage>> {
        let mut out = Vec::new();
        for chunk in thread_ids.chunks(50) {
            let ids = chunk.join(",");
            out.extend(
                self.select::<RMessage>(
                    "ai_messages",
                    &format!("select=id,thread_id,role,content,model,usage,created_at&thread_id=in.({ids})&order=created_at,id"),
                )
                .await?,
            );
        }
        Ok(out)
    }

    async fn push_notebooks(&self, rows: &[RNotebook]) -> AppResult<()> {
        let rows: Vec<Value> = rows
            .iter()
            .map(|n| json!({ "id": n.id, "title": n.title, "sort_key": n.sort_key, "created_at": n.created_at, "deleted_at": n.deleted_at }))
            .collect();
        self.upsert("notebooks", Value::Array(rows), false).await
    }

    async fn push_pages(&self, rows: &[RPage]) -> AppResult<()> {
        let rows: Vec<Value> = rows
            .iter()
            .map(|p| {
                json!({
                    "id": p.id, "notebook_id": p.notebook_id, "sort_key": p.sort_key, "width": p.width,
                    "height": p.height, "background": p.background, "deleted_at": p.deleted_at,
                })
            })
            .collect();
        self.upsert("pages", Value::Array(rows), false).await
    }

    async fn push_threads(&self, rows: &[RThread]) -> AppResult<()> {
        let rows: Vec<Value> = rows
            .iter()
            .map(|t| json!({ "id": t.id, "notebook_id": t.notebook_id, "title": t.title, "created_at": t.created_at }))
            .collect();
        self.upsert("ai_threads", Value::Array(rows), false).await
    }

    async fn push_messages(&self, rows: &[RMessage]) -> AppResult<()> {
        let rows: Vec<Value> = rows
            .iter()
            .map(|m| {
                json!({
                    "id": m.id, "thread_id": m.thread_id, "role": m.role, "content": m.content,
                    "model": m.model, "usage": m.usage, "created_at": m.created_at,
                })
            })
            .collect();
        self.upsert("ai_messages", Value::Array(rows), true).await
    }

    async fn delete_threads(&self, ids: &[String]) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let res = self
            .rest(
                reqwest::Method::DELETE,
                &format!("ai_threads?id=in.({})", ids.join(",")),
            )
            .send()
            .await?;
        check(res).await?;
        Ok(())
    }

    async fn content(&self, page: &str) -> AppResult<(i64, Option<Vec<u8>>)> {
        let res = check(
            self.worker(reqwest::Method::GET, &format!("/pages/{page}/content"))
                .send()
                .await?,
        )
        .await?;
        let version = res
            .headers()
            .get("X-Page-Version")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if res.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok((version, None));
        }
        Ok((version, Some(res.bytes().await?.to_vec())))
    }

    async fn put_content(&self, page: &str, base: i64, bytes: &[u8]) -> AppResult<Put> {
        let res = self
            .worker(reqwest::Method::PUT, &format!("/pages/{page}/content"))
            .header("X-Page-Version", base.to_string())
            .header("Content-Type", "application/octet-stream")
            .body(bytes.to_vec())
            .send()
            .await?;
        if res.status() == reqwest::StatusCode::CONFLICT {
            let v: Value = res.json().await.unwrap_or(Value::Null);
            return Ok(Put::Conflict(v["version"].as_i64().unwrap_or(-1)));
        }
        let v: Value = check(res).await?.json().await?;
        Ok(Put::Saved(v["version"].as_i64().unwrap_or(base + 1)))
    }

    async fn asset(&self, id: &str) -> AppResult<(String, Vec<u8>)> {
        let res = check(
            self.worker(reqwest::Method::GET, &format!("/assets/{id}"))
                .send()
                .await?,
        )
        .await?;
        let mime = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        Ok((mime, res.bytes().await?.to_vec()))
    }

    async fn put_asset(&self, row: &AssetRow, mime: &str, bytes: &[u8]) -> AppResult<()> {
        use sha2::Digest;
        let mut req = self
            .worker(reqwest::Method::POST, &format!("/assets?kind={}", row.kind))
            .header("Content-Type", mime)
            .header("X-Asset-Id", &row.id)
            .header("X-Content-Sha256", hex::encode(sha2::Sha256::digest(bytes)))
            .body(bytes.to_vec());
        if let Some(n) = row.page_count {
            req = req.header("X-Page-Count", n.to_string());
        }
        check(req.send().await?).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::since_filter;

    #[test]
    fn since_filter_uses_id_tiebreaker() {
        assert!(since_filter("", "").is_empty());
        assert_eq!(
            since_filter("2026-01-01T00:00:00+00:00", ""),
            "&updated_at=gt.2026-01-01T00%3A00%3A00%2B00%3A00"
        );
        let q = since_filter("2026-01-01T00:00:00+00:00", "bbbb");
        assert!(q.contains("updated_at.gt."));
        assert!(q.contains("id.gt."));
    }
}
