//! The store's side of sync: what still needs uploading, and how rows from the Writey account
//! land here. Ids are the same on both sides. Rows changed here carry `dirty`; rows the server
//! knows carry `on_server`; page ink carries `content_dirty` and the server version it was
//! based on (`remote_version`).

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{now, AssetRow, Store};
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RNotebook {
    pub id: String,
    pub title: String,
    pub sort_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RPage {
    pub id: String,
    pub notebook_id: String,
    pub sort_key: String,
    pub width: f64,
    pub height: f64,
    pub background: Value,
    /// Server content version (0: never written on).
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RThread {
    pub id: String,
    pub notebook_id: String,
    pub title: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: Value,
    pub model: Option<String>,
    pub usage: Option<Value>,
    pub created_at: String,
}

/// Local ink waiting to go up.
pub struct DirtyContent {
    pub id: String,
    pub remote_version: Option<i64>,
    pub content: Vec<u8>,
    pub version: i64,
}

/// What applying a server page did here.
#[derive(Debug, PartialEq)]
pub enum PageApplied {
    /// Nothing new.
    Same,
    /// Only the page's place or background changed.
    Meta,
    /// The server has newer ink and nothing local is waiting: fetch it.
    NeedsContent,
    /// The server has newer ink and so does this computer: keep both.
    Conflict,
}

/// Server timestamps are RFC 3339 with any precision; compare them as instants.
fn newer(a: &str, b: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(a),
        chrono::DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(a), Ok(b)) => a > b,
        _ => a > b,
    }
}

impl Store {
    // ------------------------------------------------------------------ uploading

    pub fn dirty_notebooks(&self) -> AppResult<Vec<RNotebook>> {
        let db = self.conn();
        let mut st = db.prepare(
            "select id, title, sort_key, created_at, updated_at, deleted_at from notebooks where dirty = 1",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(RNotebook {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    sort_key: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    deleted_at: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Marks a notebook uploaded, unless it changed again meanwhile.
    pub fn notebook_pushed(&self, n: &RNotebook) -> AppResult<()> {
        self.conn().execute(
            "update notebooks set dirty = 0, on_server = 1 where id = ?1 and updated_at = ?2",
            params![n.id, n.updated_at],
        )?;
        Ok(())
    }

    pub fn dirty_pages(&self) -> AppResult<Vec<RPage>> {
        let db = self.conn();
        let mut st = db.prepare(
            "select p.id, p.notebook_id, p.sort_key, p.width, p.height, p.background, p.updated_at, p.deleted_at
             from pages p join notebooks n on n.id = p.notebook_id
             where p.dirty = 1 and (n.on_server = 1 or n.dirty = 1)",
        )?;
        let rows = st
            .query_map([], |r| {
                let bg: String = r.get(5)?;
                Ok(RPage {
                    id: r.get(0)?,
                    notebook_id: r.get(1)?,
                    sort_key: r.get(2)?,
                    width: r.get(3)?,
                    height: r.get(4)?,
                    background: serde_json::from_str(&bg).unwrap_or(Value::Null),
                    version: 0,
                    updated_at: r.get(6)?,
                    deleted_at: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn page_pushed(&self, p: &RPage) -> AppResult<()> {
        self.conn().execute(
            "update pages set dirty = 0, on_server = 1 where id = ?1 and updated_at = ?2",
            params![p.id, p.updated_at],
        )?;
        Ok(())
    }

    pub fn dirty_contents(&self) -> AppResult<Vec<DirtyContent>> {
        let db = self.conn();
        let mut st = db.prepare(
            "select id, remote_version, content, version from pages
             where content_dirty = 1 and content is not null and on_server = 1",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(DirtyContent {
                    id: r.get(0)?,
                    remote_version: r.get(1)?,
                    content: r.get(2)?,
                    version: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The server took local ink as `remote_version`; clean unless edited meanwhile.
    pub fn content_pushed(
        &self,
        id: &str,
        local_version: i64,
        remote_version: i64,
    ) -> AppResult<()> {
        let db = self.conn();
        db.execute(
            "update pages set remote_version = ?2 where id = ?1",
            params![id, remote_version],
        )?;
        db.execute(
            "update pages set content_dirty = 0 where id = ?1 and version = ?2",
            params![id, local_version],
        )?;
        Ok(())
    }

    pub fn assets_to_upload(&self) -> AppResult<Vec<(AssetRow, String)>> {
        let db = self.conn();
        let mut st = db.prepare(
            "select id, kind, bytes, sha256, page_count, created_at, mime from assets where uploaded = 0",
        )?;
        let rows = st
            .query_map([], |r| Ok((super::asset_row(r)?, r.get::<_, String>(6)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn asset_uploaded(&self, id: &str) -> AppResult<()> {
        self.conn()
            .execute("update assets set uploaded = 1 where id = ?1", [id])?;
        Ok(())
    }

    pub fn dirty_threads(&self) -> AppResult<Vec<RThread>> {
        let db = self.conn();
        let mut st = db.prepare(
            "select t.id, t.notebook_id, t.title, t.created_at, t.updated_at from ai_threads t
             join notebooks n on n.id = t.notebook_id where t.dirty = 1 and (n.on_server = 1 or n.dirty = 1)",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(RThread {
                    id: r.get(0)?,
                    notebook_id: r.get(1)?,
                    title: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn thread_pushed(&self, t: &RThread) -> AppResult<()> {
        self.conn().execute(
            "update ai_threads set dirty = 0, on_server = 1 where id = ?1 and updated_at = ?2",
            params![t.id, t.updated_at],
        )?;
        Ok(())
    }

    pub fn unsynced_messages(&self) -> AppResult<Vec<RMessage>> {
        let db = self.conn();
        let mut st = db.prepare(
            "select m.id, m.thread_id, m.role, m.content, m.model, m.usage, m.created_at from ai_messages m
             join ai_threads t on t.id = m.thread_id where m.synced = 0 and t.on_server = 1 order by m.seq",
        )?;
        let rows = st
            .query_map([], |r| {
                let content: String = r.get(3)?;
                let usage: Option<String> = r.get(5)?;
                Ok(RMessage {
                    id: r.get(0)?,
                    thread_id: r.get(1)?,
                    role: r.get(2)?,
                    content: serde_json::from_str(&content).unwrap_or(Value::Null),
                    model: r.get(4)?,
                    usage: usage.and_then(|u| serde_json::from_str(&u).ok()),
                    created_at: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn messages_pushed(&self, ids: &[String]) -> AppResult<()> {
        let db = self.conn();
        for id in ids {
            db.execute("update ai_messages set synced = 1 where id = ?1", [id])?;
        }
        Ok(())
    }

    pub fn deleted_threads(&self) -> AppResult<Vec<String>> {
        let db = self.conn();
        let mut st = db.prepare("select id from deleted_threads")?;
        let rows = st
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn threads_deleted_remotely(&self, ids: &[String]) -> AppResult<()> {
        let db = self.conn();
        for id in ids {
            db.execute("delete from deleted_threads where id = ?1", [id])?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------ downloading

    /// Applies a notebook from the server; true if anything here changed.
    pub fn apply_notebook(&self, r: &RNotebook) -> AppResult<bool> {
        let db = self.conn();
        let local: Option<(String, String, String, Option<String>, bool)> = db
            .query_row(
                "select title, sort_key, updated_at, deleted_at, dirty from notebooks where id = ?1",
                [&r.id],
                |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?)),
            )
            .optional()?;
        match local {
            None => {
                db.execute(
                    "insert into notebooks (id, title, sort_key, created_at, updated_at, deleted_at, dirty, on_server)
                     values (?1, ?2, ?3, ?4, ?5, ?6, 0, 1)",
                    params![r.id, r.title, r.sort_key, r.created_at, r.updated_at, r.deleted_at],
                )?;
                Ok(true)
            }
            // Both changed: the later change wins.
            Some((_, _, updated, _, true)) if !newer(&r.updated_at, &updated) => {
                db.execute("update notebooks set on_server = 1 where id = ?1", [&r.id])?;
                Ok(false)
            }
            Some((title, key, _, deleted, _)) => {
                db.execute(
                    "update notebooks set title = ?2, sort_key = ?3, updated_at = ?4, deleted_at = ?5,
                     dirty = 0, on_server = 1 where id = ?1",
                    params![r.id, r.title, r.sort_key, r.updated_at, r.deleted_at],
                )?;
                Ok(title != r.title || key != r.sort_key || deleted != r.deleted_at)
            }
        }
    }

    pub fn apply_page(&self, r: &RPage) -> AppResult<PageApplied> {
        let db = self.conn();
        // A page whose notebook isn't here yet waits for the next round.
        let has_notebook: bool = db
            .query_row(
                "select 1 from notebooks where id = ?1",
                [&r.notebook_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_notebook {
            return Ok(PageApplied::Same);
        }
        type Local = (
            String,
            String,
            Option<String>,
            bool,
            bool,
            Option<i64>,
            f64,
            f64,
        );
        let local: Option<Local> = db
            .query_row(
                "select sort_key, background, deleted_at, dirty, content_dirty, remote_version, width, height
                 from pages where id = ?1",
                [&r.id],
                |x| {
                    Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?, x.get(5)?, x.get(6)?, x.get(7)?))
                },
            )
            .optional()?;
        let bg = r.background.to_string();
        let Some((key, local_bg, deleted, dirty, content_dirty, remote_version, w, h)) = local
        else {
            db.execute(
                "insert into pages (id, notebook_id, sort_key, width, height, background, version, updated_at,
                 deleted_at, dirty, on_server, content_dirty, remote_version)
                 values (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, 0, 1, 0, ?9)",
                params![
                    r.id,
                    r.notebook_id,
                    r.sort_key,
                    r.width,
                    r.height,
                    bg,
                    if r.updated_at.is_empty() { now() } else { r.updated_at.clone() },
                    r.deleted_at,
                    // Nothing to fetch for a page never written on.
                    if r.version == 0 { Some(0) } else { None::<i64> },
                ],
            )?;
            return Ok(if r.version > 0 {
                PageApplied::NeedsContent
            } else {
                PageApplied::Meta
            });
        };
        let mut result = PageApplied::Same;
        let meta_changed = key != r.sort_key
            || deleted != r.deleted_at
            || serde_json::from_str::<Value>(&local_bg).ok().as_ref() != Some(&r.background)
            || w != r.width
            || h != r.height;
        if meta_changed && !dirty {
            db.execute(
                "update pages set sort_key = ?2, width = ?3, height = ?4, background = ?5, deleted_at = ?6,
                 dirty = 0, on_server = 1 where id = ?1",
                params![r.id, r.sort_key, r.width, r.height, bg, r.deleted_at],
            )?;
            result = PageApplied::Meta;
        } else {
            db.execute("update pages set on_server = 1 where id = ?1", [&r.id])?;
        }
        if r.version > remote_version.unwrap_or(-1) && r.version > 0 {
            result = if content_dirty {
                PageApplied::Conflict
            } else {
                PageApplied::NeedsContent
            };
        } else if remote_version.is_none() && r.version == 0 {
            db.execute("update pages set remote_version = 0 where id = ?1", [&r.id])?;
        }
        Ok(result)
    }

    /// Server ink replaces this computer's (which had no unsaved changes). Bumps the local
    /// version so an open page notices.
    pub fn set_remote_content(
        &self,
        id: &str,
        remote_version: i64,
        content: Option<&[u8]>,
    ) -> AppResult<()> {
        self.conn().execute(
            "update pages set content = ?2, remote_version = ?3, version = version + 1, content_dirty = 0,
             updated_at = ?4 where id = ?1",
            params![id, content, remote_version, now()],
        )?;
        Ok(())
    }

    /// Two computers wrote on the same page: this computer's ink moves to a new page at the end
    /// of the notebook (to be uploaded), and the page itself takes the server's ink.
    pub fn conflict_copy(&self, id: &str) -> AppResult<Option<String>> {
        let mut db = self.conn();
        let tx = db.transaction()?;
        type Page = (String, f64, f64, String, Option<Vec<u8>>);
        let page: Option<Page> = tx
            .query_row(
                "select notebook_id, width, height, background, content from pages where id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((notebook, w, h, bg, Some(content))) = page else {
            return Ok(None);
        };
        let last: String = tx.query_row(
            "select max(sort_key) from pages where notebook_id = ?1",
            [&notebook],
            |r| r.get(0),
        )?;
        // A key after the last one: extending it keeps it valid for fractional indexing.
        let key = format!("{last}V");
        let copy = super::new_id();
        tx.execute(
            "insert into pages (id, notebook_id, sort_key, width, height, background, version, content,
             updated_at, dirty, on_server, content_dirty) values (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 1, 0, 1)",
            params![copy, notebook, key, w, h, bg, content, now()],
        )?;
        tx.execute("update pages set content_dirty = 0 where id = ?1", [id])?;
        tx.commit()?;
        Ok(Some(copy))
    }

    pub fn apply_thread(&self, r: &RThread) -> AppResult<bool> {
        let db = self.conn();
        let has_notebook: bool = db
            .query_row(
                "select 1 from notebooks where id = ?1",
                [&r.notebook_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        let gone: bool = db
            .query_row(
                "select 1 from deleted_threads where id = ?1",
                [&r.id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_notebook || gone {
            return Ok(false);
        }
        let n = db.execute(
            "insert into ai_threads (id, notebook_id, title, created_at, updated_at, dirty, on_server)
             values (?1, ?2, ?3, ?4, ?5, 0, 1)
             on conflict (id) do update set title = excluded.title, on_server = 1,
               updated_at = max(ai_threads.updated_at, excluded.updated_at)",
            params![r.id, r.notebook_id, r.title, r.created_at, r.updated_at],
        )?;
        Ok(n > 0)
    }

    /// Adds messages this computer doesn't have yet; returns how many.
    pub fn apply_messages(&self, msgs: &[RMessage]) -> AppResult<usize> {
        let mut db = self.conn();
        let tx = db.transaction()?;
        let mut added = 0;
        for m in msgs {
            let exists: bool = tx
                .query_row("select 1 from ai_messages where id = ?1", [&m.id], |_| {
                    Ok(true)
                })
                .optional()?
                .unwrap_or(false);
            let has_thread: bool = tx
                .query_row(
                    "select 1 from ai_threads where id = ?1",
                    [&m.thread_id],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if exists || !has_thread || (m.role != "user" && m.role != "assistant") {
                continue;
            }
            let seq: i64 = tx.query_row(
                "select coalesce(max(seq), 0) + 1 from ai_messages where thread_id = ?1",
                [&m.thread_id],
                |r| r.get(0),
            )?;
            tx.execute(
                "insert into ai_messages (id, thread_id, role, content, model, usage, created_at, seq, synced)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
                params![
                    m.id,
                    m.thread_id,
                    m.role,
                    m.content.to_string(),
                    m.model,
                    m.usage.as_ref().map(Value::to_string),
                    m.created_at,
                    seq
                ],
            )?;
            added += 1;
        }
        tx.commit()?;
        Ok(added)
    }

    /// Threads the server no longer has (deleted on the website) go here too.
    pub fn drop_threads_not_on_server(&self, server_ids: &[String]) -> AppResult<usize> {
        let db = self.conn();
        let mut st = db.prepare("select id from ai_threads where on_server = 1 and dirty = 0")?;
        let local: Vec<String> = st
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut n = 0;
        for id in local.iter().filter(|id| !server_ids.contains(id)) {
            n += db.execute("delete from ai_threads where id = ?1", [id])?;
        }
        Ok(n)
    }

    /// A file a synced page needs, downloaded from the account.
    pub fn put_downloaded_asset(&self, id: &str, mime: &str, bytes: &[u8]) -> AppResult<AssetRow> {
        let kind = if mime == "application/pdf" {
            "pdf"
        } else {
            "image"
        };
        let row = AssetRow {
            id: id.into(),
            kind: kind.into(),
            bytes: bytes.len() as i64,
            sha256: String::new(),
            page_count: None,
            created_at: now(),
        };
        self.put_asset(&row, mime, bytes)?;
        self.asset_uploaded(id)?;
        Ok(row)
    }

    pub fn has_asset_file(&self, id: &str) -> bool {
        super::is_id(id) && self.assets.join(id).is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SaveOutcome;

    fn store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Store::in_memory(dir.path().join("a")).unwrap(), dir)
    }

    #[test]
    fn new_local_work_is_dirty() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", Some("Math")).unwrap();
        assert_eq!(s.dirty_notebooks().unwrap().len(), 1);
        assert_eq!(s.dirty_pages().unwrap().len(), 1);
        let n = &s.dirty_notebooks().unwrap()[0];
        s.notebook_pushed(n).unwrap();
        assert!(s.dirty_notebooks().unwrap().is_empty());
        s.rename_notebook(&nb.id, "Physics").unwrap();
        assert_eq!(s.dirty_notebooks().unwrap()[0].title, "Physics");
    }

    #[test]
    fn edits_during_upload_stay_dirty() {
        let (s, _d) = store();
        s.create_notebook("a0", "a0", None).unwrap();
        let n = s.dirty_notebooks().unwrap().remove(0);
        std::thread::sleep(std::time::Duration::from_millis(3));
        s.rename_notebook(&n.id, "Later").unwrap();
        s.notebook_pushed(&n).unwrap();
        assert_eq!(s.dirty_notebooks().unwrap().len(), 1);
    }

    #[test]
    fn server_rows_arrive() {
        let (s, _d) = store();
        let nb = RNotebook {
            id: "11111111-1111-4111-8111-111111111111".into(),
            title: "From the web".into(),
            sort_key: "Zz".into(),
            created_at: "2026-10-01T00:00:00+00:00".into(),
            updated_at: "2026-10-01T00:00:00+00:00".into(),
            deleted_at: None,
        };
        assert!(s.apply_notebook(&nb).unwrap());
        assert!(s.dirty_notebooks().unwrap().is_empty());
        let page = RPage {
            id: "22222222-2222-4222-8222-222222222222".into(),
            notebook_id: nb.id.clone(),
            sort_key: "a0".into(),
            width: 595.0,
            height: 842.0,
            background: serde_json::json!({ "kind": "blank" }),
            version: 3,
            updated_at: "2026-10-01T00:00:00+00:00".into(),
            deleted_at: None,
        };
        assert_eq!(s.apply_page(&page).unwrap(), PageApplied::NeedsContent);
        s.set_remote_content(&page.id, 3, Some(b"ink")).unwrap();
        assert_eq!(s.page_content(&page.id).unwrap().1.unwrap(), b"ink");
        assert_eq!(s.apply_page(&page).unwrap(), PageApplied::Same);
        assert!(s.dirty_contents().unwrap().is_empty());
        // Edited here, then the server moves on: both kept.
        let (v, _) = s.page_content(&page.id).unwrap();
        assert!(matches!(
            s.save_page(&page.id, v, b"mine").unwrap(),
            SaveOutcome::Saved(_)
        ));
        assert_eq!(s.dirty_contents().unwrap().len(), 1);
        let newer = RPage {
            version: 4,
            ..page.clone()
        };
        assert_eq!(s.apply_page(&newer).unwrap(), PageApplied::Conflict);
        let copy = s.conflict_copy(&page.id).unwrap().unwrap();
        s.set_remote_content(&page.id, 4, Some(b"theirs")).unwrap();
        let pages = s.list_pages(&nb.id).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[1].id, copy);
        assert!(pages[1].sort_key > pages[0].sort_key);
        assert_eq!(s.page_content(&copy).unwrap().1.unwrap(), b"mine");
        assert_eq!(s.page_content(&page.id).unwrap().1.unwrap(), b"theirs");
    }

    #[test]
    fn later_change_wins_on_notebook_conflicts() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", Some("Local")).unwrap();
        let older = RNotebook {
            id: nb.id.clone(),
            title: "Server".into(),
            sort_key: "a0".into(),
            created_at: nb.created_at.clone(),
            updated_at: "2000-01-01T00:00:00+00:00".into(),
            deleted_at: None,
        };
        s.apply_notebook(&older).unwrap();
        assert_eq!(s.get_notebook(&nb.id).unwrap().unwrap().title, "Local");
        let later = RNotebook {
            updated_at: "2999-01-01T00:00:00+00:00".into(),
            ..older
        };
        s.apply_notebook(&later).unwrap();
        assert_eq!(s.get_notebook(&nb.id).unwrap().unwrap().title, "Server");
    }

    #[test]
    fn threads_and_messages() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", None).unwrap();
        let t = RThread {
            id: "33333333-3333-4333-8333-333333333333".into(),
            notebook_id: nb.id.clone(),
            title: Some("q".into()),
            created_at: now(),
            updated_at: now(),
        };
        assert!(s.apply_thread(&t).unwrap());
        let m = RMessage {
            id: "44444444-4444-4444-8444-444444444444".into(),
            thread_id: t.id.clone(),
            role: "user".into(),
            content: serde_json::json!({ "text": "hi" }),
            model: None,
            usage: None,
            created_at: now(),
        };
        assert_eq!(s.apply_messages(&[m.clone(), m]).unwrap(), 1);
        assert_eq!(s.load_messages(&t.id).unwrap()[0].text, "hi");
        assert!(s.unsynced_messages().unwrap().is_empty());
        assert_eq!(s.drop_threads_not_on_server(&[]).unwrap(), 1);
        assert!(s.list_threads(&nb.id).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_synced_thread_leaves_a_tombstone() {
        let (s, _d) = store();
        let nb = s.create_notebook("a0", "a0", None).unwrap();
        let t = s.create_thread(&nb.id, "x").unwrap();
        let rt = s.dirty_threads().unwrap().remove(0);
        s.thread_pushed(&rt).unwrap();
        s.delete_thread(&t.id).unwrap();
        assert_eq!(s.deleted_threads().unwrap(), vec![t.id.clone()]);
        // The server still lists it until the delete goes up: don't bring it back.
        assert!(!s.apply_thread(&rt).unwrap());
    }

    #[test]
    fn pages_of_unknown_notebooks_wait() {
        let (s, _d) = store();
        let p = RPage {
            id: "22222222-2222-4222-8222-222222222222".into(),
            notebook_id: "99999999-9999-4999-8999-999999999999".into(),
            sort_key: "a0".into(),
            width: 1.0,
            height: 1.0,
            background: serde_json::json!({ "kind": "blank" }),
            version: 0,
            updated_at: now(),
            deleted_at: None,
        };
        assert_eq!(s.apply_page(&p).unwrap(), PageApplied::Same);
    }
}
