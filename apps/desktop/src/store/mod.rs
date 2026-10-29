//! Notebooks on this computer: one SQLite file for rows and page ink, plus a folder of
//! imported PDFs and images. Replaces Supabase + R2 from the web version (HANDOFF D57).

pub mod archive;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

pub const PAGE_MAX_BYTES: usize = 5 * 1024 * 1024;
pub const PDF_MAX_BYTES: usize = 100 * 1024 * 1024;
pub const IMAGE_MAX_BYTES: usize = 25 * 1024 * 1024;

const IMAGE_MIME: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn is_id(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookRow {
    pub id: String,
    pub title: String,
    pub sort_key: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageRow {
    pub id: String,
    pub notebook_id: String,
    pub sort_key: String,
    pub width: f64,
    pub height: f64,
    pub background: Value,
    pub version: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewPage {
    pub sort_key: String,
    pub width: f64,
    pub height: f64,
    pub background: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRow {
    pub id: String,
    pub kind: String,
    pub bytes: i64,
    pub sha256: String,
    pub page_count: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadInfo {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    #[serde(default)]
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

pub enum SaveOutcome {
    Saved(i64),
    Conflict(i64),
}

pub struct Store {
    conn: Mutex<Connection>,
    assets: PathBuf,
}

const SCHEMA: &str = r#"
create table if not exists notebooks (
  id         text primary key,
  title      text not null default 'Untitled notebook',
  sort_key   text not null,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);
create table if not exists pages (
  id          text primary key,
  notebook_id text not null references notebooks (id) on delete cascade,
  sort_key    text not null,
  width       real not null default 595,
  height      real not null default 842,
  background  text not null default '{"kind":"blank"}',
  version     integer not null default 0,
  content     blob,
  updated_at  text not null,
  deleted_at  text
);
create index if not exists pages_notebook on pages (notebook_id, sort_key);
create table if not exists assets (
  id         text primary key,
  kind       text not null check (kind in ('pdf', 'image')),
  mime       text not null,
  bytes      integer not null,
  sha256     text not null,
  page_count integer,
  created_at text not null
);
create table if not exists ai_threads (
  id          text primary key,
  notebook_id text not null references notebooks (id) on delete cascade,
  title       text,
  created_at  text not null,
  updated_at  text not null
);
create index if not exists threads_notebook on ai_threads (notebook_id, updated_at);
create table if not exists ai_messages (
  id         text primary key,
  thread_id  text not null references ai_threads (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  model      text,
  usage      text,
  created_at text not null,
  seq        integer not null
);
create index if not exists messages_thread on ai_messages (thread_id, seq);
create table if not exists settings (
  key   text primary key,
  value text not null
);
"#;

impl Store {
    pub fn open(dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(dir)?;
        let assets = dir.join("assets");
        std::fs::create_dir_all(&assets)?;
        let conn = Connection::open(dir.join("writey.db"))?;
        Self::init(conn, assets)
    }

    #[cfg(test)]
    pub fn in_memory(assets: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&assets)?;
        Self::init(Connection::open_in_memory()?, assets)
    }

    fn init(conn: Connection, assets: PathBuf) -> AppResult<Self> {
        conn.execute_batch(
            "pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on;",
        )?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            assets,
        })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves SQLite itself consistent, so carry on.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ------------------------------------------------------------------ notebooks

    pub fn list_notebooks(&self) -> AppResult<Vec<NotebookRow>> {
        let db = self.db();
        let mut st = db.prepare(
            "select id, title, sort_key, created_at, updated_at from notebooks
             where deleted_at is null order by sort_key",
        )?;
        let rows = st
            .query_map([], notebook_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_notebook(&self, id: &str) -> AppResult<Option<NotebookRow>> {
        let db = self.db();
        Ok(db
            .query_row(
                "select id, title, sort_key, created_at, updated_at from notebooks
                 where id = ?1 and deleted_at is null",
                [id],
                notebook_row,
            )
            .optional()?)
    }

    /// A new notebook with one blank A4 page.
    pub fn create_notebook(
        &self,
        sort_key: &str,
        page_key: &str,
        title: Option<&str>,
    ) -> AppResult<NotebookRow> {
        let id = new_id();
        let at = now();
        let title = title
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("Untitled notebook");
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "insert into notebooks (id, title, sort_key, created_at, updated_at) values (?1, ?2, ?3, ?4, ?4)",
            params![id, title, sort_key, at],
        )?;
        tx.execute(
            "insert into pages (id, notebook_id, sort_key, updated_at) values (?1, ?2, ?3, ?4)",
            params![new_id(), id, page_key, at],
        )?;
        tx.commit()?;
        Ok(NotebookRow {
            id,
            title: title.into(),
            sort_key: sort_key.into(),
            created_at: at.clone(),
            updated_at: at,
        })
    }

    pub fn rename_notebook(&self, id: &str, title: &str) -> AppResult<()> {
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::bad("A notebook needs a name."));
        }
        let n = self.db().execute(
            "update notebooks set title = ?2, updated_at = ?3 where id = ?1 and deleted_at is null",
            params![id, title.chars().take(200).collect::<String>(), now()],
        )?;
        if n == 0 {
            return Err(AppError::not_found("Notebook"));
        }
        Ok(())
    }

    pub fn move_notebook(&self, id: &str, sort_key: &str) -> AppResult<()> {
        self.db().execute(
            "update notebooks set sort_key = ?2 where id = ?1",
            params![id, sort_key],
        )?;
        Ok(())
    }

    /// Notebooks go to the trash first; `purge_trash` removes them for good.
    pub fn trash_notebook(&self, id: &str) -> AppResult<()> {
        self.db().execute(
            "update notebooks set deleted_at = ?2 where id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    pub fn restore_notebook(&self, id: &str) -> AppResult<()> {
        self.db().execute(
            "update notebooks set deleted_at = null where id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Deletes notebooks trashed more than `days` ago, then any asset nothing uses any more.
    pub fn purge_trash(&self, days: i64) -> AppResult<usize> {
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(days))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let n = {
            let db = self.db();
            let n = db.execute(
                "delete from notebooks where deleted_at is not null and deleted_at < ?1",
                [&cutoff],
            )?;
            db.execute(
                "delete from pages where deleted_at is not null and deleted_at < ?1",
                [&cutoff],
            )?;
            n
        };
        self.remove_unused_assets()?;
        Ok(n)
    }

    fn remove_unused_assets(&self) -> AppResult<()> {
        let unused: Vec<String> = {
            let db = self.db();
            let mut st = db.prepare("select id from assets")?;
            let ids = st
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut used = std::collections::HashSet::new();
            let mut st = db.prepare("select background, content from pages")?;
            let mut rows = st.query([])?;
            while let Some(row) = rows.next()? {
                let bg: String = row.get(0)?;
                let content: Option<Vec<u8>> = row.get(1)?;
                let mut text = bg;
                if let Some(c) = content {
                    text.push_str(&gunzip_string(&c).unwrap_or_default());
                }
                for id in &ids {
                    if text.contains(id.as_str()) {
                        used.insert(id.clone());
                    }
                }
            }
            ids.into_iter().filter(|id| !used.contains(id)).collect()
        };
        for id in unused {
            self.db()
                .execute("delete from assets where id = ?1", [&id])?;
            let _ = std::fs::remove_file(self.assets.join(&id));
        }
        Ok(())
    }

    // ------------------------------------------------------------------ pages

    pub fn list_pages(&self, notebook_id: &str) -> AppResult<Vec<PageRow>> {
        let db = self.db();
        let mut st = db.prepare(
            "select id, notebook_id, sort_key, width, height, background, version from pages
             where notebook_id = ?1 and deleted_at is null order by sort_key",
        )?;
        let rows = st
            .query_map([notebook_id], page_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn add_pages(&self, notebook_id: &str, pages: &[NewPage]) -> AppResult<Vec<PageRow>> {
        let at = now();
        let mut db = self.db();
        let tx = db.transaction()?;
        let exists: bool = tx
            .query_row(
                "select 1 from notebooks where id = ?1 and deleted_at is null",
                [notebook_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(AppError::not_found("Notebook"));
        }
        let mut out = Vec::with_capacity(pages.len());
        for p in pages {
            check_background(&p.background)?;
            let id = new_id();
            tx.execute(
                "insert into pages (id, notebook_id, sort_key, width, height, background, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, notebook_id, p.sort_key, p.width, p.height, p.background.to_string(), at],
            )?;
            out.push(PageRow {
                id,
                notebook_id: notebook_id.into(),
                sort_key: p.sort_key.clone(),
                width: p.width,
                height: p.height,
                background: p.background.clone(),
                version: 0,
            });
        }
        tx.execute(
            "update notebooks set updated_at = ?2 where id = ?1",
            params![notebook_id, at],
        )?;
        tx.commit()?;
        out.sort_by(|a, b| a.sort_key.cmp(&b.sort_key));
        Ok(out)
    }

    pub fn move_page(&self, id: &str, sort_key: &str) -> AppResult<()> {
        self.db().execute(
            "update pages set sort_key = ?2 where id = ?1",
            params![id, sort_key],
        )?;
        Ok(())
    }

    pub fn trash_page(&self, id: &str) -> AppResult<()> {
        self.db().execute(
            "update pages set deleted_at = ?2 where id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    /// The page's ink (gzipped JSON, as the ink engine writes it) and its version.
    pub fn page_content(&self, id: &str) -> AppResult<(i64, Option<Vec<u8>>)> {
        self.db()
            .query_row(
                "select version, content from pages where id = ?1 and deleted_at is null",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found("Page"))
    }

    /// Saves only if nobody saved since `base` (another window); returns the new version.
    pub fn save_page(&self, id: &str, base: i64, content: &[u8]) -> AppResult<SaveOutcome> {
        if content.len() > PAGE_MAX_BYTES {
            return Err(AppError::new(
                "too_large",
                "This page is too big to save (over 5 MB of ink).",
            ));
        }
        let at = now();
        let mut db = self.db();
        let tx = db.transaction()?;
        let current: Option<(i64, String)> = tx
            .query_row(
                "select version, notebook_id from pages where id = ?1 and deleted_at is null",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((version, notebook_id)) = current else {
            return Err(AppError::not_found("Page"));
        };
        if version != base {
            return Ok(SaveOutcome::Conflict(version));
        }
        tx.execute(
            "update pages set content = ?2, version = ?3, updated_at = ?4 where id = ?1",
            params![id, content, base + 1, at],
        )?;
        tx.execute(
            "update notebooks set updated_at = ?2 where id = ?1",
            params![notebook_id, at],
        )?;
        tx.commit()?;
        Ok(SaveOutcome::Saved(base + 1))
    }

    // ------------------------------------------------------------------ assets

    pub fn add_asset(
        &self,
        kind: &str,
        mime: &str,
        bytes: &[u8],
        page_count: Option<i64>,
    ) -> AppResult<AssetRow> {
        let max = match kind {
            "pdf" if mime == "application/pdf" => PDF_MAX_BYTES,
            "image" if IMAGE_MIME.contains(&mime) => IMAGE_MAX_BYTES,
            "pdf" | "image" => {
                return Err(AppError::new(
                    "bad_type",
                    format!("Writey can't use a {mime} file here."),
                ))
            }
            _ => return Err(AppError::bad("Unknown kind of file.")),
        };
        if bytes.is_empty() {
            return Err(AppError::bad("The file is empty."));
        }
        if bytes.len() > max {
            return Err(AppError::new(
                "too_large",
                format!(
                    "That file is too big (the limit is {} MB).",
                    max / (1024 * 1024)
                ),
            ));
        }
        if kind == "pdf" && page_count.is_none_or(|n| n < 1) {
            return Err(AppError::bad("A PDF needs at least one page."));
        }
        let sha256 = hex::encode(Sha256::digest(bytes));
        // The same file imported twice is stored once.
        let existing = self
            .db()
            .query_row(
                "select id, kind, bytes, sha256, page_count, created_at from assets where sha256 = ?1 and kind = ?2",
                params![sha256, kind],
                asset_row,
            )
            .optional()?;
        if let Some(row) = existing {
            if self.assets.join(&row.id).is_file() {
                return Ok(row);
            }
        }
        let row = AssetRow {
            id: new_id(),
            kind: kind.into(),
            bytes: bytes.len() as i64,
            sha256,
            page_count,
            created_at: now(),
        };
        write_atomic(&self.assets.join(&row.id), bytes)?;
        self.db().execute(
            "insert into assets (id, kind, mime, bytes, sha256, page_count, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![row.id, row.kind, mime, row.bytes, row.sha256, row.page_count, row.created_at],
        )?;
        Ok(row)
    }

    /// Inserts an asset with a known id (archive import); a no-op if it's already here.
    pub fn put_asset(&self, row: &AssetRow, mime: &str, bytes: &[u8]) -> AppResult<()> {
        if !is_id(&row.id) {
            return Err(AppError::bad("bad asset id"));
        }
        let have: bool = self
            .db()
            .query_row("select 1 from assets where id = ?1", [&row.id], |_| {
                Ok(true)
            })
            .optional()?
            .unwrap_or(false);
        if have && self.assets.join(&row.id).is_file() {
            return Ok(());
        }
        write_atomic(&self.assets.join(&row.id), bytes)?;
        self.db().execute(
            "insert or replace into assets (id, kind, mime, bytes, sha256, page_count, created_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.id,
                row.kind,
                mime,
                bytes.len() as i64,
                hex::encode(Sha256::digest(bytes)),
                row.page_count,
                row.created_at
            ],
        )?;
        Ok(())
    }

    pub fn asset_info(&self, id: &str) -> AppResult<(AssetRow, String)> {
        self.db()
            .query_row(
                "select id, kind, bytes, sha256, page_count, created_at, mime from assets where id = ?1",
                [id],
                |r| Ok((asset_row(r)?, r.get(6)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found("File"))
    }

    pub fn asset_bytes(&self, id: &str) -> AppResult<Vec<u8>> {
        if !is_id(id) {
            return Err(AppError::not_found("File"));
        }
        std::fs::read(self.assets.join(id)).map_err(|_| AppError::not_found("File"))
    }

    // ------------------------------------------------------------------ conversations

    pub fn list_threads(&self, notebook_id: &str) -> AppResult<Vec<ThreadInfo>> {
        let db = self.db();
        let mut st = db.prepare(
            "select id, title, updated_at from ai_threads where notebook_id = ?1 order by updated_at desc",
        )?;
        let rows = st
            .query_map([notebook_id], |r| {
                Ok(ThreadInfo {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn create_thread(&self, notebook_id: &str, title: &str) -> AppResult<ThreadInfo> {
        let id = new_id();
        let at = now();
        let title: String = title.chars().take(80).collect();
        self.db().execute(
            "insert into ai_threads (id, notebook_id, title, created_at, updated_at) values (?1, ?2, ?3, ?4, ?4)",
            params![id, notebook_id, title, at],
        )?;
        Ok(ThreadInfo {
            id,
            title: Some(title),
            updated_at: at,
        })
    }

    pub fn delete_thread(&self, id: &str) -> AppResult<()> {
        self.db()
            .execute("delete from ai_threads where id = ?1", [id])?;
        Ok(())
    }

    pub fn load_messages(&self, thread_id: &str) -> AppResult<Vec<StoredMessage>> {
        let db = self.db();
        let mut st = db.prepare(
            "select id, role, content, model, usage from ai_messages where thread_id = ?1 order by seq",
        )?;
        let rows = st
            .query_map([thread_id], |r| {
                let content: String = r.get(2)?;
                let usage: Option<String> = r.get(4)?;
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    content,
                    r.get::<_, Option<String>>(3)?,
                    usage,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(id, role, content, model, usage)| {
                let c: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
                StoredMessage {
                    id,
                    role,
                    text: c
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    mode: c.get("mode").and_then(Value::as_str).map(Into::into),
                    error: c.get("error").and_then(Value::as_bool),
                    model,
                    usage: usage.and_then(|u| serde_json::from_str(&u).ok()),
                }
            })
            .collect())
    }

    pub fn append_messages(&self, thread_id: &str, messages: &[StoredMessage]) -> AppResult<()> {
        let at = now();
        let mut db = self.db();
        let tx = db.transaction()?;
        let mut seq: i64 = tx.query_row(
            "select coalesce(max(seq), 0) from ai_messages where thread_id = ?1",
            [thread_id],
            |r| r.get(0),
        )?;
        for m in messages {
            if m.role != "user" && m.role != "assistant" {
                return Err(AppError::bad("bad message role"));
            }
            seq += 1;
            let content = serde_json::json!({ "text": m.text, "mode": m.mode, "error": m.error });
            tx.execute(
                "insert into ai_messages (id, thread_id, role, content, model, usage, created_at, seq)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new_id(),
                    thread_id,
                    m.role,
                    content.to_string(),
                    m.model,
                    m.usage.as_ref().map(Value::to_string),
                    at,
                    seq
                ],
            )?;
        }
        tx.execute(
            "update ai_threads set updated_at = ?2 where id = ?1",
            params![thread_id, at],
        )?;
        tx.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------ settings

    pub fn setting(&self, key: &str) -> AppResult<Option<Value>> {
        let v: Option<String> = self
            .db()
            .query_row("select value from settings where key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(v.and_then(|v| serde_json::from_str(&v).ok()))
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> AppResult<()> {
        self.db().execute(
            "insert into settings (key, value) values (?1, ?2) on conflict (key) do update set value = excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db()
    }
}

fn notebook_row(r: &rusqlite::Row) -> rusqlite::Result<NotebookRow> {
    Ok(NotebookRow {
        id: r.get(0)?,
        title: r.get(1)?,
        sort_key: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

fn page_row(r: &rusqlite::Row) -> rusqlite::Result<PageRow> {
    let bg: String = r.get(5)?;
    Ok(PageRow {
        id: r.get(0)?,
        notebook_id: r.get(1)?,
        sort_key: r.get(2)?,
        width: r.get(3)?,
        height: r.get(4)?,
        background: serde_json::from_str(&bg)
            .unwrap_or_else(|_| serde_json::json!({ "kind": "blank" })),
        version: r.get(6)?,
    })
}

fn asset_row(r: &rusqlite::Row) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        bytes: r.get(2)?,
        sha256: r.get(3)?,
        page_count: r.get(4)?,
        created_at: r.get(5)?,
    })
}

fn check_background(bg: &Value) -> AppResult<()> {
    match bg.get("kind").and_then(Value::as_str) {
        Some("blank") => Ok(()),
        Some("pdf") | Some("image") => {
            let id = bg
                .get("assetId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if is_id(id) {
                Ok(())
            } else {
                Err(AppError::bad("A page background needs a file."))
            }
        }
        _ => Err(AppError::bad("Unknown page background.")),
    }
}

pub fn gunzip_string(bytes: &[u8]) -> std::io::Result<String> {
    use std::io::Read;
    let mut s = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut s)?;
    Ok(s)
}

/// Writes through a temporary file, so a crash never leaves half a file behind.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Store::in_memory(dir.path().join("assets")).unwrap(), dir)
    }

    #[test]
    fn notebooks_and_pages() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", None).unwrap();
        assert_eq!(nb.title, "Untitled notebook");
        assert_eq!(s.list_notebooks().unwrap().len(), 1);
        let pages = s.list_pages(&nb.id).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].width, 595.0);
        let added = s
            .add_pages(
                &nb.id,
                &[NewPage {
                    sort_key: "a1".into(),
                    width: 595.0,
                    height: 842.0,
                    background: serde_json::json!({"kind":"blank"}),
                }],
            )
            .unwrap();
        assert_eq!(s.list_pages(&nb.id).unwrap()[1].id, added[0].id);
        s.rename_notebook(&nb.id, "  Physics ").unwrap();
        assert_eq!(s.get_notebook(&nb.id).unwrap().unwrap().title, "Physics");
        s.trash_notebook(&nb.id).unwrap();
        assert!(s.list_notebooks().unwrap().is_empty());
        assert!(s.get_notebook(&nb.id).unwrap().is_none());
    }

    #[test]
    fn page_versions() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", None).unwrap();
        let page = &s.list_pages(&nb.id).unwrap()[0];
        assert_eq!(s.page_content(&page.id).unwrap(), (0, None));
        assert!(matches!(
            s.save_page(&page.id, 0, b"one").unwrap(),
            SaveOutcome::Saved(1)
        ));
        assert!(matches!(
            s.save_page(&page.id, 0, b"two").unwrap(),
            SaveOutcome::Conflict(1)
        ));
        assert_eq!(
            s.page_content(&page.id).unwrap(),
            (1, Some(b"one".to_vec()))
        );
    }

    #[test]
    fn rejects_bad_backgrounds() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", None).unwrap();
        let bad = NewPage {
            sort_key: "a1".into(),
            width: 1.0,
            height: 1.0,
            background: serde_json::json!({"kind":"pdf"}),
        };
        assert!(s.add_pages(&nb.id, &[bad]).is_err());
    }

    #[test]
    fn assets_dedupe_and_validate() {
        let (s, _d) = store();
        let a = s
            .add_asset("image", "image/png", b"png bytes", None)
            .unwrap();
        let b = s
            .add_asset("image", "image/png", b"png bytes", None)
            .unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(s.asset_bytes(&a.id).unwrap(), b"png bytes");
        assert!(s.add_asset("image", "text/html", b"x", None).is_err());
        assert!(s
            .add_asset("pdf", "application/pdf", b"%PDF", None)
            .is_err());
        assert!(s.asset_bytes("../writey.db").is_err());
    }

    #[test]
    fn conversations() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", None).unwrap();
        let t = s.create_thread(&nb.id, "Integrals").unwrap();
        let msg = |role: &str, text: &str| StoredMessage {
            id: String::new(),
            role: role.into(),
            text: text.into(),
            mode: Some("write".into()),
            model: None,
            usage: None,
            error: None,
        };
        s.append_messages(
            &t.id,
            &[
                msg("user", "what's next?"),
                msg("assistant", "Try by parts."),
            ],
        )
        .unwrap();
        s.append_messages(&t.id, &[msg("user", "why?")]).unwrap();
        let m = s.load_messages(&t.id).unwrap();
        assert_eq!(
            m.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["what's next?", "Try by parts.", "why?"]
        );
        assert_eq!(s.list_threads(&nb.id).unwrap()[0].id, t.id);
        s.delete_thread(&t.id).unwrap();
        assert!(s.load_messages(&t.id).unwrap().is_empty());
    }

    #[test]
    fn settings_roundtrip() {
        let (s, _d) = store();
        assert!(s.setting("ai").unwrap().is_none());
        s.set_setting("ai", &serde_json::json!({"provider":"chatgpt","model":"x"}))
            .unwrap();
        assert_eq!(s.setting("ai").unwrap().unwrap()["provider"], "chatgpt");
    }
}
