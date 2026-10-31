//! Keeps the desktop app and the website showing the same notebooks (HANDOFF D57). The app is
//! local-first: everything is saved on this computer at once and works offline. When signed in
//! to the Writey account, a sync round brings the website's changes down and sends this
//! computer's up: notebooks, pages, ink, PDFs and pictures, conversations.
//!
//! Rows: the later change wins. Ink: the server keeps a version per page; if both sides wrote
//! on the same page since the last sync, nothing is lost — this computer's ink becomes a new
//! page at the end of the notebook. Files are uploaded once and downloaded when a page needs them.

pub mod auth;
pub mod remote;

use std::collections::BTreeSet;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::AppResult;
use crate::store::sync::PageApplied;
use crate::store::Store;
use remote::{Put, Remote};

/// How a round went, for the UI and the event to the page.
#[derive(Serialize, Default, Debug, Clone)]
pub struct Report {
    pub pulled: usize,
    pub pushed: usize,
    /// Pages whose ink changed here (open pages reload them).
    pub pages: Vec<String>,
    /// Pages added because both sides wrote on the same page.
    pub conflicts: Vec<String>,
    /// Notebook or page lists changed.
    pub lists_changed: bool,
}

const CURSOR: &str = "sync_cursor";

/// Cursor position for incremental pulls: RFC3339 `updated_at` plus row `id` tie-breaker.
fn read_cursor(cursor: &Value, key: &str) -> String {
    match &cursor[key] {
        Value::Object(o) => {
            let at = o.get("at").and_then(|v| v.as_str()).unwrap_or("");
            let id = o.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if at.is_empty() {
                String::new()
            } else if id.is_empty() {
                at.to_string()
            } else {
                format!("{at}\x1f{id}")
            }
        }
        // Older cursors stored only a timestamp; treat as (at, "").
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn write_cursor(cursor: &mut Value, key: &str, at: &str, id: &str) {
    cursor[key] = json!({ "at": at, "id": id });
}

async fn pull<R: Remote>(store: &Store, remote: &R, report: &mut Report) -> AppResult<()> {
    let cursor = store.setting(CURSOR)?.unwrap_or_else(|| json!({}));
    let mut cursor = cursor;
    let since = |k: &str| read_cursor(&cursor, k);
    let (c_nb, c_pg, c_th) = (since("notebooks"), since("pages"), since("threads"));

    let notebooks = remote.notebooks(&c_nb).await?;
    for n in &notebooks {
        if store.apply_notebook(n)? {
            report.pulled += 1;
            report.lists_changed = true;
        }
    }
    if let Some(last) = notebooks.last() {
        write_cursor(&mut cursor, "notebooks", &last.updated_at, &last.id);
    }

    let pages = remote.pages(&c_pg).await?;
    for p in &pages {
        match store.apply_page(p)? {
            PageApplied::Same => {}
            PageApplied::Meta => {
                report.pulled += 1;
                report.lists_changed = true;
            }
            PageApplied::NeedsContent => {
                let (version, bytes) = remote.content(&p.id).await?;
                store.set_remote_content(&p.id, version, bytes.as_deref())?;
                report.pulled += 1;
                report.lists_changed = true;
                report.pages.push(p.id.clone());
            }
            PageApplied::Conflict => {
                if let Some(copy) = store.conflict_copy(&p.id)? {
                    report.conflicts.push(copy);
                }
                let (version, bytes) = remote.content(&p.id).await?;
                store.set_remote_content(&p.id, version, bytes.as_deref())?;
                report.pulled += 1;
                report.lists_changed = true;
                report.pages.push(p.id.clone());
            }
        }
    }
    // A page that arrived before its notebook is picked up next round: don't move past it.
    if !pages.iter().any(|p| {
        store.get_notebook(&p.notebook_id).ok().flatten().is_none() && p.deleted_at.is_none()
    }) {
        if let Some(last) = pages.last() {
            write_cursor(&mut cursor, "pages", &last.updated_at, &last.id);
        }
    }

    let threads = remote.threads(&c_th).await?;
    let mut changed: BTreeSet<String> = BTreeSet::new();
    for t in &threads {
        if store.apply_thread(t)? {
            changed.insert(t.id.clone());
        }
    }
    if let Some(last) = threads.last() {
        write_cursor(&mut cursor, "threads", &last.updated_at, &last.id);
    }
    if !changed.is_empty() {
        let ids: Vec<String> = changed.into_iter().collect();
        report.pulled += store.apply_messages(&remote.messages(&ids).await?)?;
    }
    // Conversations deleted on the website.
    let on_server = remote.thread_ids().await?;
    report.pulled += store.drop_threads_not_on_server(&on_server)?;

    store.set_setting(CURSOR, &cursor)?;
    Ok(())
}

/// One full round: down, then up.
pub async fn sync_once<R: Remote>(store: &Store, remote: &R) -> AppResult<Report> {
    let mut report = Report::default();
    pull(store, remote, &mut report).await?;
    push(store, remote, &mut report).await?;
    Ok(report)
}

async fn push<R: Remote>(store: &Store, remote: &R, report: &mut Report) -> AppResult<()> {
    let notebooks = store.dirty_notebooks()?;
    if !notebooks.is_empty() {
        remote.push_notebooks(&notebooks).await?;
        for n in &notebooks {
            store.notebook_pushed(n)?;
        }
        report.pushed += notebooks.len();
    }

    // Files before the pages that show them.
    for (row, mime) in store.assets_to_upload()? {
        let Ok(bytes) = store.asset_bytes(&row.id) else {
            continue;
        };
        remote.put_asset(&row, &mime, &bytes).await?;
        store.asset_uploaded(&row.id)?;
        report.pushed += 1;
    }

    let pages = store.dirty_pages()?;
    if !pages.is_empty() {
        remote.push_pages(&pages).await?;
        for p in &pages {
            store.page_pushed(p)?;
        }
        report.pushed += pages.len();
    }

    for c in store.dirty_contents()? {
        match remote
            .put_content(&c.id, c.remote_version.unwrap_or(0), &c.content)
            .await?
        {
            Put::Saved(v) => {
                store.content_pushed(&c.id, c.version, v)?;
                report.pushed += 1;
            }
            Put::Conflict(_) => {
                // Written on elsewhere since this computer last synced: keep both.
                if let Some(copy) = store.conflict_copy(&c.id)? {
                    report.conflicts.push(copy);
                }
                let (version, bytes) = remote.content(&c.id).await?;
                store.set_remote_content(&c.id, version, bytes.as_deref())?;
                report.pages.push(c.id.clone());
                report.lists_changed = true;
            }
        }
    }

    let threads = store.dirty_threads()?;
    if !threads.is_empty() {
        remote.push_threads(&threads).await?;
        for t in &threads {
            store.thread_pushed(t)?;
        }
        report.pushed += threads.len();
    }
    let messages = store.unsynced_messages()?;
    if !messages.is_empty() {
        remote.push_messages(&messages).await?;
        store.messages_pushed(&messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>())?;
        report.pushed += messages.len();
    }
    let gone = store.deleted_threads()?;
    if !gone.is_empty() {
        remote.delete_threads(&gone).await?;
        store.threads_deleted_remotely(&gone)?;
    }

    // Conflict copies and anything changed since go up in the next round.
    if !report.conflicts.is_empty() {
        Box::pin(push_again(store, remote, report)).await?;
    }
    Ok(())
}

async fn push_again<R: Remote>(store: &Store, remote: &R, report: &mut Report) -> AppResult<()> {
    let pages = store.dirty_pages()?;
    remote.push_pages(&pages).await?;
    for p in &pages {
        store.page_pushed(p)?;
    }
    for c in store.dirty_contents()? {
        if let Put::Saved(v) = remote
            .put_content(&c.id, c.remote_version.unwrap_or(0), &c.content)
            .await?
        {
            store.content_pushed(&c.id, c.version, v)?;
            report.pushed += 1;
        }
    }
    Ok(())
}

/// How often a signed-in app syncs on its own; local saves and focusing the window sync sooner.
pub const INTERVAL: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests;
