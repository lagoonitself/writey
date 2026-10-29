//! `.writey` files: notebooks with their pages, pictures, PDFs and conversations, as one zip.
//! Used for backups, moving notebooks between computers, and bringing notebooks over from
//! the old web version (its "Export my notebooks" page writes the same format).

use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{new_id, now, AssetRow, NotebookRow, PageRow, Store, StoredMessage, ThreadInfo};
use crate::error::{AppError, AppResult};

pub const FORMAT: &str = "writey";
pub const VERSION: u32 = 1;
/// Zip bombs: refuse archives that expand past this.
const MAX_UNPACKED: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    exported_at: String,
    notebooks: Vec<NotebookEntry>,
    #[serde(default)]
    assets: Vec<AssetEntry>,
}

#[derive(Serialize, Deserialize)]
struct NotebookEntry {
    #[serde(flatten)]
    row: NotebookRow,
    pages: Vec<PageEntry>,
    #[serde(default)]
    threads: Vec<ThreadEntry>,
}

#[derive(Serialize, Deserialize)]
struct PageEntry {
    #[serde(flatten)]
    row: PageRow,
    /// Path of the gzipped ink inside the zip; none for a page never written on.
    content: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ThreadEntry {
    #[serde(flatten)]
    info: ThreadInfo,
    messages: Vec<StoredMessage>,
}

#[derive(Serialize, Deserialize)]
struct AssetEntry {
    #[serde(flatten)]
    row: AssetRow,
    mime: String,
    file: String,
}

#[derive(Serialize)]
pub struct ImportSummary {
    pub notebooks: usize,
    pub pages: usize,
    pub first_id: Option<String>,
}

/// Writes the given notebooks (all of them when `ids` is empty) to `path`.
pub fn export(store: &Store, ids: &[String], path: &Path) -> AppResult<usize> {
    let notebooks: Vec<NotebookRow> = store
        .list_notebooks()?
        .into_iter()
        .filter(|n| ids.is_empty() || ids.contains(&n.id))
        .collect();
    if notebooks.is_empty() {
        return Err(AppError::bad("There are no notebooks to export."));
    }
    let tmp = path.with_extension("writey-partial");
    let file = std::fs::File::create(&tmp)?;
    let result = write_zip(store, notebooks, file);
    match result {
        Ok(n) => {
            std::fs::rename(&tmp, path)?;
            Ok(n)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn write_zip<W: Write + Seek>(
    store: &Store,
    notebooks: Vec<NotebookRow>,
    out: W,
) -> AppResult<usize> {
    let mut zip = zip::ZipWriter::new(out);
    // Ink is gzipped already and PDFs/images are compressed, so store them as they are.
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut manifest = Manifest {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: now(),
        notebooks: Vec::new(),
        assets: Vec::new(),
    };
    let mut asset_ids: Vec<String> = Vec::new();
    let count = notebooks.len();
    for nb in notebooks {
        let mut pages = Vec::new();
        for page in store.list_pages(&nb.id)? {
            let (_, content) = store.page_content(&page.id)?;
            let path = match content {
                Some(bytes) => {
                    let name = format!("pages/{}.json.gz", page.id);
                    zip.start_file(&name, stored)?;
                    zip.write_all(&bytes)?;
                    collect_asset_ids(
                        store,
                        &super::gunzip_string(&bytes).unwrap_or_default(),
                        &mut asset_ids,
                    )?;
                    Some(name)
                }
                None => None,
            };
            if let Some(id) = page.background.get("assetId").and_then(Value::as_str) {
                if !asset_ids.iter().any(|a| a == id) {
                    asset_ids.push(id.into());
                }
            }
            pages.push(PageEntry {
                row: page,
                content: path,
            });
        }
        let mut threads = Vec::new();
        for info in store.list_threads(&nb.id)? {
            let messages = store.load_messages(&info.id)?;
            threads.push(ThreadEntry { info, messages });
        }
        manifest.notebooks.push(NotebookEntry {
            row: nb,
            pages,
            threads,
        });
    }
    for id in asset_ids {
        let Ok((row, mime)) = store.asset_info(&id) else {
            continue;
        };
        let Ok(bytes) = store.asset_bytes(&id) else {
            continue;
        };
        let file = format!("assets/{id}");
        zip.start_file(&file, stored)?;
        zip.write_all(&bytes)?;
        manifest.assets.push(AssetEntry { row, mime, file });
    }
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())?;
    zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    zip.finish()?;
    Ok(count)
}

/// Assets that a page's ink refers to (pasted pictures), found by id.
fn collect_asset_ids(store: &Store, ink: &str, out: &mut Vec<String>) -> AppResult<()> {
    if !ink.contains("assetId") {
        return Ok(());
    }
    let db = store.conn();
    let mut st = db.prepare("select id from assets")?;
    for id in st.query_map([], |r| r.get::<_, String>(0))? {
        let id = id?;
        if ink.contains(id.as_str()) && !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(())
}

/// Adds the notebooks in a `.writey` file as new notebooks (new ids, so importing twice
/// gives two copies, never overwrites). They go first in the library.
pub fn import(
    store: &Store,
    path: &Path,
    first_key: impl Fn(usize) -> Vec<String>,
) -> AppResult<ImportSummary> {
    let file = std::fs::File::open(path)?;
    import_from(store, file, first_key)
}

pub fn import_from<R: Read + Seek>(
    store: &Store,
    reader: R,
    sort_keys: impl Fn(usize) -> Vec<String>,
) -> AppResult<ImportSummary> {
    let mut zip =
        zip::ZipArchive::new(reader).map_err(|_| AppError::bad("That isn't a Writey file."))?;
    let unpacked: u64 = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.size()))
        .sum();
    if unpacked > MAX_UNPACKED {
        return Err(AppError::bad("That file is too big to import."));
    }
    let manifest: Manifest = {
        let mut f = zip
            .by_name("manifest.json")
            .map_err(|_| AppError::bad("That isn't a Writey file."))?;
        let mut s = String::new();
        f.read_to_string(&mut s)?;
        serde_json::from_str(&s)
            .map_err(|e| AppError::bad(format!("This Writey file is damaged ({e}).")))?
    };
    if manifest.format != FORMAT || manifest.version > VERSION {
        return Err(AppError::bad(
            "This Writey file comes from a newer Writey. Update Writey first.",
        ));
    }

    for a in &manifest.assets {
        let mut bytes = Vec::new();
        zip.by_name(&a.file)
            .map_err(|_| AppError::bad(format!("A file is missing from the archive: {}", a.file)))?
            .read_to_end(&mut bytes)?;
        store.put_asset(&a.row, &a.mime, &bytes)?;
    }

    let keys = sort_keys(manifest.notebooks.len());
    let mut pages_total = 0;
    let mut first_id = None;
    let mut contents: HashMap<String, Vec<u8>> = HashMap::new();
    for nb in &manifest.notebooks {
        for p in &nb.pages {
            if let Some(name) = &p.content {
                let mut bytes = Vec::new();
                if let Ok(mut f) = zip.by_name(name) {
                    f.read_to_end(&mut bytes)?;
                    contents.insert(name.clone(), bytes);
                }
            }
        }
    }

    let mut db = store.conn();
    let tx = db.transaction()?;
    let at = now();
    for (i, nb) in manifest.notebooks.iter().enumerate() {
        let id = new_id();
        first_id.get_or_insert_with(|| id.clone());
        let key = keys.get(i).cloned().unwrap_or_else(|| format!("Zz{i:04}"));
        tx.execute(
            "insert into notebooks (id, title, sort_key, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5)",
            params![id, nb.row.title, key, nb.row.created_at, at],
        )?;
        for p in &nb.pages {
            let content = p.content.as_ref().and_then(|n| contents.get(n));
            tx.execute(
                "insert into pages (id, notebook_id, sort_key, width, height, background, version, content, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    new_id(),
                    id,
                    p.row.sort_key,
                    p.row.width,
                    p.row.height,
                    p.row.background.to_string(),
                    if content.is_some() { 1 } else { 0 },
                    content,
                    at
                ],
            )?;
            pages_total += 1;
        }
        for t in &nb.threads {
            let tid = new_id();
            tx.execute(
                "insert into ai_threads (id, notebook_id, title, created_at, updated_at) values (?1, ?2, ?3, ?4, ?4)",
                params![tid, id, t.info.title, t.info.updated_at],
            )?;
            for (seq, m) in t.messages.iter().enumerate() {
                if m.role != "user" && m.role != "assistant" {
                    continue;
                }
                let content =
                    serde_json::json!({ "text": m.text, "mode": m.mode, "error": m.error });
                tx.execute(
                    "insert into ai_messages (id, thread_id, role, content, model, usage, created_at, seq)
                     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        new_id(),
                        tid,
                        m.role,
                        content.to_string(),
                        m.model,
                        m.usage.as_ref().map(Value::to_string),
                        t.info.updated_at,
                        seq as i64 + 1
                    ],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(ImportSummary {
        notebooks: manifest.notebooks.len(),
        pages: pages_total,
        first_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::NewPage;

    #[test]
    fn export_then_import() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::in_memory(dir.path().join("a")).unwrap();
        let nb = s.create_notebook("a0", "a0", Some("Calculus")).unwrap();
        let asset = s
            .add_asset("image", "image/png", b"\x89PNG fake", None)
            .unwrap();
        s.add_pages(
            &nb.id,
            &[NewPage {
                sort_key: "a1".into(),
                width: 595.0,
                height: 842.0,
                background: serde_json::json!({ "kind": "image", "assetId": asset.id }),
            }],
        )
        .unwrap();
        let page = &s.list_pages(&nb.id).unwrap()[0];
        s.save_page(&page.id, 0, b"\x1f\x8b fake gzip").unwrap();
        let t = s.create_thread(&nb.id, "q").unwrap();
        s.append_messages(
            &t.id,
            &[StoredMessage {
                id: String::new(),
                role: "user".into(),
                text: "hi".into(),
                mode: None,
                model: None,
                usage: None,
                error: None,
            }],
        )
        .unwrap();

        let file = dir.path().join("out.writey");
        assert_eq!(export(&s, &[], &file).unwrap(), 1);

        let other = Store::in_memory(dir.path().join("b")).unwrap();
        let summary = import(&other, &file, |n| (0..n).map(|i| format!("a{i}")).collect()).unwrap();
        assert_eq!(summary.notebooks, 1);
        assert_eq!(summary.pages, 2);
        let id = summary.first_id.unwrap();
        assert_eq!(other.get_notebook(&id).unwrap().unwrap().title, "Calculus");
        let pages = other.list_pages(&id).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(
            other.page_content(&pages[0].id).unwrap(),
            (1, Some(b"\x1f\x8b fake gzip".to_vec()))
        );
        assert_eq!(other.asset_bytes(&asset.id).unwrap(), b"\x89PNG fake");
        let threads = other.list_threads(&id).unwrap();
        assert_eq!(other.load_messages(&threads[0].id).unwrap()[0].text, "hi");
    }

    #[test]
    fn rejects_other_zips() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::in_memory(dir.path().join("a")).unwrap();
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            z.start_file("hello.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"hi").unwrap();
            z.finish().unwrap();
        }
        buf.set_position(0);
        assert!(import_from(&s, buf, |_| vec![]).is_err());
    }
}
