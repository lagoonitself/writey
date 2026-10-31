//! Sync against an in-memory account that behaves like the real one: the server stamps
//! `updated_at` on every write and keeps a version per page's ink.

use std::collections::HashMap;
use std::sync::Mutex;

use super::remote::{Put, Remote};
use super::*;
use crate::error::AppError;
use crate::store::sync::{RMessage, RNotebook, RPage, RThread};
use crate::store::{AssetRow, NewPage, SaveOutcome, StoredMessage};

#[derive(Default)]
struct Server {
    clock: u64,
    notebooks: HashMap<String, RNotebook>,
    pages: HashMap<String, RPage>,
    content: HashMap<String, Vec<u8>>,
    threads: HashMap<String, RThread>,
    messages: Vec<RMessage>,
    assets: HashMap<String, (String, Vec<u8>)>,
}

#[derive(Default)]
struct Fake(Mutex<Server>);

impl Server {
    fn tick(&mut self) -> String {
        self.clock += 1;
        format!(
            "2030-01-01T00:00:{:02}.{:06}+00:00",
            self.clock / 1000,
            self.clock % 1000 * 1000
        )
    }
}

fn after(ts: &str, id: &str, since: &str) -> bool {
    if since.is_empty() {
        return true;
    }
    let (since_at, since_id) = match since.split_once('\x1f') {
        Some((a, i)) => (a, i),
        None => (since, ""),
    };
    if ts > since_at {
        return true;
    }
    ts == since_at && id > since_id
}

impl Remote for Fake {
    async fn notebooks(&self, since: &str) -> AppResult<Vec<RNotebook>> {
        let s = self.0.lock().unwrap();
        let mut v: Vec<_> = s
            .notebooks
            .values()
            .filter(|n| after(&n.updated_at, &n.id, since))
            .cloned()
            .collect();
        v.sort_by(|a, b| a.updated_at.cmp(&b.updated_at).then(a.id.cmp(&b.id)));
        Ok(v)
    }
    async fn pages(&self, since: &str) -> AppResult<Vec<RPage>> {
        let s = self.0.lock().unwrap();
        let mut v: Vec<_> = s
            .pages
            .values()
            .filter(|p| after(&p.updated_at, &p.id, since))
            .cloned()
            .collect();
        v.sort_by(|a, b| a.updated_at.cmp(&b.updated_at).then(a.id.cmp(&b.id)));
        Ok(v)
    }
    async fn threads(&self, since: &str) -> AppResult<Vec<RThread>> {
        let s = self.0.lock().unwrap();
        Ok(s.threads
            .values()
            .filter(|t| after(&t.updated_at, &t.id, since))
            .cloned()
            .collect())
    }
    async fn thread_ids(&self) -> AppResult<Vec<String>> {
        Ok(self.0.lock().unwrap().threads.keys().cloned().collect())
    }
    async fn messages(&self, ids: &[String]) -> AppResult<Vec<RMessage>> {
        let s = self.0.lock().unwrap();
        Ok(s.messages
            .iter()
            .filter(|m| ids.contains(&m.thread_id))
            .cloned()
            .collect())
    }
    async fn push_notebooks(&self, rows: &[RNotebook]) -> AppResult<()> {
        let mut s = self.0.lock().unwrap();
        for n in rows {
            let t = s.tick();
            s.notebooks.insert(
                n.id.clone(),
                RNotebook {
                    updated_at: t,
                    ..n.clone()
                },
            );
        }
        Ok(())
    }
    async fn push_pages(&self, rows: &[RPage]) -> AppResult<()> {
        let mut s = self.0.lock().unwrap();
        for p in rows {
            if !s.notebooks.contains_key(&p.notebook_id) {
                return Err(AppError::new(
                    "sync_failed",
                    "row-level security: no such notebook",
                ));
            }
            let t = s.tick();
            let version = s.pages.get(&p.id).map(|x| x.version).unwrap_or(0);
            s.pages.insert(
                p.id.clone(),
                RPage {
                    updated_at: t,
                    version,
                    ..p.clone()
                },
            );
        }
        Ok(())
    }
    async fn push_threads(&self, rows: &[RThread]) -> AppResult<()> {
        let mut s = self.0.lock().unwrap();
        for th in rows {
            let t = s.tick();
            s.threads.insert(
                th.id.clone(),
                RThread {
                    updated_at: t,
                    ..th.clone()
                },
            );
        }
        Ok(())
    }
    async fn push_messages(&self, rows: &[RMessage]) -> AppResult<()> {
        let mut s = self.0.lock().unwrap();
        for m in rows {
            if !s.messages.iter().any(|x| x.id == m.id) {
                s.messages.push(m.clone());
                let t = s.tick();
                if let Some(th) = s.threads.get_mut(&m.thread_id) {
                    th.updated_at = t;
                }
            }
        }
        Ok(())
    }
    async fn delete_threads(&self, ids: &[String]) -> AppResult<()> {
        let mut s = self.0.lock().unwrap();
        for id in ids {
            s.threads.remove(id);
        }
        Ok(())
    }
    async fn content(&self, page: &str) -> AppResult<(i64, Option<Vec<u8>>)> {
        let s = self.0.lock().unwrap();
        Ok((
            s.pages.get(page).map(|p| p.version).unwrap_or(0),
            s.content.get(page).cloned(),
        ))
    }
    async fn put_content(&self, page: &str, base: i64, bytes: &[u8]) -> AppResult<Put> {
        let mut s = self.0.lock().unwrap();
        let t = s.tick();
        let p = s
            .pages
            .get_mut(page)
            .ok_or_else(|| AppError::not_found("page"))?;
        if p.version != base {
            return Ok(Put::Conflict(p.version));
        }
        p.version += 1;
        p.updated_at = t;
        let v = p.version;
        s.content.insert(page.into(), bytes.to_vec());
        Ok(Put::Saved(v))
    }
    async fn asset(&self, id: &str) -> AppResult<(String, Vec<u8>)> {
        self.0
            .lock()
            .unwrap()
            .assets
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::not_found("asset"))
    }
    async fn put_asset(&self, row: &AssetRow, mime: &str, bytes: &[u8]) -> AppResult<()> {
        self.0
            .lock()
            .unwrap()
            .assets
            .insert(row.id.clone(), (mime.into(), bytes.to_vec()));
        Ok(())
    }
}

impl Fake {
    /// The website writing on a page.
    fn web_writes(&self, page: &str, ink: &[u8]) {
        let mut s = self.0.lock().unwrap();
        let t = s.tick();
        let p = s.pages.get_mut(page).unwrap();
        p.version += 1;
        p.updated_at = t;
        s.content.insert(page.into(), ink.to_vec());
    }

    fn web_renames(&self, notebook: &str, title: &str) {
        let mut s = self.0.lock().unwrap();
        let t = s.tick();
        let n = s.notebooks.get_mut(notebook).unwrap();
        n.title = title.into();
        n.updated_at = t;
    }
}

fn computer() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    (Store::in_memory(dir.path().join("assets")).unwrap(), dir)
}

fn block<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn write(store: &Store, page: &str, ink: &[u8]) {
    let (v, _) = store.page_content(page).unwrap();
    assert!(matches!(
        store.save_page(page, v, ink).unwrap(),
        SaveOutcome::Saved(_)
    ));
}

#[test]
fn a_new_notebook_goes_up_and_comes_down_elsewhere() {
    let server = Fake::default();
    let (a, _da) = computer();
    let nb = a.create_notebook("a0", "a0", Some("Calculus")).unwrap();
    let page = a.list_pages(&nb.id).unwrap()[0].id.clone();
    write(&a, &page, b"ink from A");
    let asset = a.add_asset("image", "image/png", b"\x89PNG", None).unwrap();
    a.add_pages(
        &nb.id,
        &[NewPage {
            sort_key: "a1".into(),
            width: 595.0,
            height: 842.0,
            background: serde_json::json!({ "kind": "image", "assetId": asset.id }),
        }],
    )
    .unwrap();
    let r = block(sync_once(&a, &server)).unwrap();
    assert!(r.pushed >= 4, "{r:?}");
    {
        let s = server.0.lock().unwrap();
        assert_eq!(s.notebooks[&nb.id].title, "Calculus");
        assert_eq!(s.pages[&page].version, 1);
        assert_eq!(s.content[&page], b"ink from A");
        assert!(s.assets.contains_key(&asset.id));
    }
    // Nothing left to send.
    let r = block(sync_once(&a, &server)).unwrap();
    assert_eq!(r.pushed, 0, "{r:?}");

    let (b, _db) = computer();
    let r = block(sync_once(&b, &server)).unwrap();
    assert!(r.lists_changed);
    assert_eq!(b.get_notebook(&nb.id).unwrap().unwrap().title, "Calculus");
    let pages = b.list_pages(&nb.id).unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(b.page_content(&page).unwrap().1.unwrap(), b"ink from A");
    // B has nothing new to send back.
    assert_eq!(block(sync_once(&b, &server)).unwrap().pushed, 0);
}

#[test]
fn website_changes_reach_the_app() {
    let server = Fake::default();
    let (a, _d) = computer();
    let nb = a.create_notebook("a0", "a0", Some("Old")).unwrap();
    let page = a.list_pages(&nb.id).unwrap()[0].id.clone();
    block(sync_once(&a, &server)).unwrap();
    server.web_renames(&nb.id, "Renamed on the web");
    server.web_writes(&page, b"web ink");
    let r = block(sync_once(&a, &server)).unwrap();
    assert_eq!(r.pages, vec![page.clone()]);
    assert_eq!(
        a.get_notebook(&nb.id).unwrap().unwrap().title,
        "Renamed on the web"
    );
    assert_eq!(a.page_content(&page).unwrap().1.unwrap(), b"web ink");
    // Then the app writes on top of it: one clean upload.
    write(&a, &page, b"app ink");
    block(sync_once(&a, &server)).unwrap();
    assert_eq!(server.0.lock().unwrap().content[&page], b"app ink");
    assert!(block(sync_once(&a, &server)).unwrap().conflicts.is_empty());
}

#[test]
fn both_sides_wrote_on_a_page_and_nothing_is_lost() {
    let server = Fake::default();
    let (a, _d) = computer();
    let nb = a.create_notebook("a0", "a0", None).unwrap();
    let page = a.list_pages(&nb.id).unwrap()[0].id.clone();
    write(&a, &page, b"first");
    block(sync_once(&a, &server)).unwrap();
    server.web_writes(&page, b"from the web");
    write(&a, &page, b"from the app");
    let r = block(sync_once(&a, &server)).unwrap();
    assert_eq!(r.conflicts.len(), 1);
    let copy = &r.conflicts[0];
    assert_eq!(a.page_content(&page).unwrap().1.unwrap(), b"from the web");
    assert_eq!(a.page_content(copy).unwrap().1.unwrap(), b"from the app");
    // The copy is on the server too, after the original.
    let s = server.0.lock().unwrap();
    assert_eq!(s.content[copy], b"from the app");
    assert!(s.pages[copy].sort_key > s.pages[&page].sort_key);
}

#[test]
fn two_computers_take_turns() {
    let server = Fake::default();
    let (a, _da) = computer();
    let (b, _db) = computer();
    let nb = a.create_notebook("a0", "a0", None).unwrap();
    let page = a.list_pages(&nb.id).unwrap()[0].id.clone();
    write(&a, &page, b"A1");
    block(sync_once(&a, &server)).unwrap();
    block(sync_once(&b, &server)).unwrap();
    write(&b, &page, b"B1");
    block(sync_once(&b, &server)).unwrap();
    let r = block(sync_once(&a, &server)).unwrap();
    assert!(r.conflicts.is_empty());
    assert_eq!(a.page_content(&page).unwrap().1.unwrap(), b"B1");
    a.trash_notebook(&nb.id).unwrap();
    block(sync_once(&a, &server)).unwrap();
    block(sync_once(&b, &server)).unwrap();
    assert!(
        b.get_notebook(&nb.id).unwrap().is_none(),
        "trash reaches the other computer"
    );
}

#[test]
fn conversations_sync_and_web_deletes_reach_the_app() {
    let server = Fake::default();
    let (a, _da) = computer();
    let nb = a.create_notebook("a0", "a0", None).unwrap();
    let t = a.create_thread(&nb.id, "Integrals").unwrap();
    let msg = |role: &str, text: &str| StoredMessage {
        id: String::new(),
        role: role.into(),
        text: text.into(),
        mode: None,
        model: None,
        usage: None,
        error: None,
    };
    a.append_messages(
        &t.id,
        &[msg("user", "what's next?"), msg("assistant", "By parts.")],
    )
    .unwrap();
    block(sync_once(&a, &server)).unwrap();
    assert_eq!(server.0.lock().unwrap().messages.len(), 2);

    let (b, _db) = computer();
    block(sync_once(&b, &server)).unwrap();
    let got: Vec<String> = b
        .load_messages(&t.id)
        .unwrap()
        .into_iter()
        .map(|m| m.text)
        .collect();
    assert_eq!(got, ["what's next?", "By parts."]);

    // Deleted on the website: gone here on the next sync.
    server.0.lock().unwrap().threads.remove(&t.id);
    block(sync_once(&a, &server)).unwrap();
    assert!(a.list_threads(&nb.id).unwrap().is_empty());

    // Deleted here: gone from the server.
    let t2 = b.list_threads(&nb.id).unwrap();
    assert_eq!(t2.len(), 1);
    let t3 = b.create_thread(&nb.id, "second").unwrap();
    block(sync_once(&b, &server)).unwrap();
    b.delete_thread(&t3.id).unwrap();
    block(sync_once(&b, &server)).unwrap();
    assert!(!server.0.lock().unwrap().threads.contains_key(&t3.id));
}

#[test]
fn cursor_tiebreaker_fetches_every_page_with_the_same_updated_at() {
    use crate::store::NewPage;

    let server = Fake::default();
    let (a, _da) = computer();
    let nb = a.create_notebook("a0", "a0", None).unwrap();
    let page_a = a.list_pages(&nb.id).unwrap()[0].id.clone();
    a.add_pages(
        &nb.id,
        &[NewPage {
            sort_key: "a1".into(),
            width: 595.0,
            height: 842.0,
            background: serde_json::json!({ "kind": "blank" }),
        }],
    )
    .unwrap();
    let page_b = a.list_pages(&nb.id).unwrap()[1].id.clone();
    block(sync_once(&a, &server)).unwrap();

    let ts = "2030-06-01T12:00:00+00:00";
    {
        let mut s = server.0.lock().unwrap();
        for (id, key) in [(&page_a, "b0"), (&page_b, "b1")] {
            let p = s.pages.get_mut(id).unwrap();
            p.updated_at = ts.into();
            p.sort_key = key.into();
        }
    }

    let (b, _db) = computer();
    block(sync_once(&b, &server)).unwrap();
    let keys: Vec<_> = b
        .list_pages(&nb.id)
        .unwrap()
        .into_iter()
        .map(|p| p.sort_key)
        .collect();
    assert_eq!(keys, vec!["b0", "b1"]);
}
