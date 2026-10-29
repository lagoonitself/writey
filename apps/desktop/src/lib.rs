//! Writey for Windows and macOS. The notebook UI (React, the ink engine, handwriting and
//! diagrams in TypeScript) runs in the system web view; this crate is everything around it:
//! notebooks on disk, keys in the OS keychain, model calls, ChatGPT and OpenRouter sign-in,
//! and local speech on the GPU.

pub mod ai;
pub mod error;
pub mod store;
pub mod vault;
pub mod voice;

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use ai::{Ai, CredentialInfo, StreamEvent};
use error::{AppError, AppResult};
use store::{
    AssetRow, NewPage, NotebookRow, PageRow, SaveOutcome, Store, StoredMessage, ThreadInfo,
};
use vault::Vault;
use voice::{Voice, VoiceStatus};

pub struct App {
    pub store: Store,
    pub vault: Vault,
    pub ai: Ai,
    pub voice: Arc<Voice>,
    openrouter: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
}

/// `.writey` files Writey was opened with, waiting for the page to ask for them.
#[derive(Default)]
struct OpenedFiles(std::sync::Mutex<Vec<String>>);

fn writey_files<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| a.to_lowercase().ends_with(".writey"))
        .collect()
}

type Cmd<'a> = State<'a, App>;

fn header<'a>(req: &'a Request<'_>, name: &str) -> AppResult<&'a str> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::bad(format!("missing {name}")))
}

fn raw_body<'a>(req: &'a Request<'_>) -> AppResult<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        _ => Err(AppError::bad("expected bytes")),
    }
}

fn open_browser(app: &tauri::AppHandle, url: &str) -> AppResult<()> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::new("browser", format!("Couldn't open your browser: {e}")))
}

// ---------------------------------------------------------------------- notebooks

#[tauri::command]
async fn notebooks_list(s: Cmd<'_>) -> AppResult<Vec<NotebookRow>> {
    s.store.list_notebooks()
}

#[tauri::command]
async fn notebook_get(s: Cmd<'_>, id: String) -> AppResult<Option<NotebookRow>> {
    s.store.get_notebook(&id)
}

#[tauri::command]
async fn notebook_create(
    s: Cmd<'_>,
    sort_key: String,
    page_key: String,
    title: Option<String>,
) -> AppResult<NotebookRow> {
    s.store
        .create_notebook(&sort_key, &page_key, title.as_deref())
}

#[tauri::command]
async fn notebook_rename(s: Cmd<'_>, id: String, title: String) -> AppResult<()> {
    s.store.rename_notebook(&id, &title)
}

#[tauri::command]
async fn notebook_move(s: Cmd<'_>, id: String, sort_key: String) -> AppResult<()> {
    s.store.move_notebook(&id, &sort_key)
}

#[tauri::command]
async fn notebook_trash(s: Cmd<'_>, id: String) -> AppResult<()> {
    s.store.trash_notebook(&id)
}

#[tauri::command]
async fn notebook_restore(s: Cmd<'_>, id: String) -> AppResult<()> {
    s.store.restore_notebook(&id)
}

#[tauri::command]
async fn pages_list(s: Cmd<'_>, notebook_id: String) -> AppResult<Vec<PageRow>> {
    s.store.list_pages(&notebook_id)
}

#[tauri::command]
async fn pages_add(
    s: Cmd<'_>,
    notebook_id: String,
    pages: Vec<NewPage>,
) -> AppResult<Vec<PageRow>> {
    s.store.add_pages(&notebook_id, &pages)
}

#[tauri::command]
async fn page_move(s: Cmd<'_>, id: String, sort_key: String) -> AppResult<()> {
    s.store.move_page(&id, &sort_key)
}

#[tauri::command]
async fn page_trash(s: Cmd<'_>, id: String) -> AppResult<()> {
    s.store.trash_page(&id)
}

/// The page's version (8 bytes, little-endian) followed by its gzipped ink, if any.
#[tauri::command]
async fn page_load(s: Cmd<'_>, id: String) -> AppResult<Response> {
    let (version, content) = s.store.page_content(&id)?;
    let mut out = (version as u64).to_le_bytes().to_vec();
    out.extend_from_slice(content.as_deref().unwrap_or_default());
    Ok(Response::new(out))
}

/// Body: gzipped ink. Headers: `x-page-id`, `x-base-version`.
#[tauri::command]
async fn page_save(s: Cmd<'_>, request: Request<'_>) -> AppResult<Value> {
    let id = header(&request, "x-page-id")?;
    let base: i64 = header(&request, "x-base-version")?
        .parse()
        .map_err(|_| AppError::bad("bad version"))?;
    Ok(match s.store.save_page(id, base, raw_body(&request)?)? {
        SaveOutcome::Saved(v) => json!({ "ok": true, "version": v }),
        SaveOutcome::Conflict(v) => json!({ "ok": false, "conflictVersion": v }),
    })
}

/// Body: the file. Headers: `x-kind` (pdf or image), `x-mime`, `x-page-count` for PDFs.
#[tauri::command]
async fn asset_add(s: Cmd<'_>, request: Request<'_>) -> AppResult<AssetRow> {
    let kind = header(&request, "x-kind")?;
    let mime = header(&request, "x-mime")?;
    let pages = header(&request, "x-page-count")
        .ok()
        .and_then(|p| p.parse().ok());
    s.store.add_asset(kind, mime, raw_body(&request)?, pages)
}

#[tauri::command]
async fn asset_read(s: Cmd<'_>, id: String) -> AppResult<Response> {
    Ok(Response::new(s.store.asset_bytes(&id)?))
}

// ---------------------------------------------------------------------- conversations

#[tauri::command]
async fn threads_list(s: Cmd<'_>, notebook_id: String) -> AppResult<Vec<ThreadInfo>> {
    s.store.list_threads(&notebook_id)
}

#[tauri::command]
async fn thread_create(s: Cmd<'_>, notebook_id: String, title: String) -> AppResult<ThreadInfo> {
    s.store.create_thread(&notebook_id, &title)
}

#[tauri::command]
async fn thread_delete(s: Cmd<'_>, id: String) -> AppResult<()> {
    s.store.delete_thread(&id)
}

#[tauri::command]
async fn messages_load(s: Cmd<'_>, thread_id: String) -> AppResult<Vec<StoredMessage>> {
    s.store.load_messages(&thread_id)
}

#[tauri::command]
async fn messages_append(
    s: Cmd<'_>,
    thread_id: String,
    messages: Vec<StoredMessage>,
) -> AppResult<()> {
    s.store.append_messages(&thread_id, &messages)
}

// ---------------------------------------------------------------------- settings and files

#[tauri::command]
async fn setting_get(s: Cmd<'_>, key: String) -> AppResult<Option<Value>> {
    s.store.setting(&key)
}

#[tauri::command]
async fn setting_set(s: Cmd<'_>, key: String, value: Value) -> AppResult<()> {
    s.store.set_setting(&key, &value)
}

#[tauri::command]
async fn archive_export(s: Cmd<'_>, path: String, ids: Vec<String>) -> AppResult<usize> {
    store::archive::export(&s.store, &ids, std::path::Path::new(&path))
}

/// How many notebooks a `.writey` file holds, so the UI can make room for them.
#[tauri::command]
async fn archive_peek(path: String) -> AppResult<usize> {
    let f = std::fs::File::open(&path)?;
    let mut zip =
        zip::ZipArchive::new(f).map_err(|_| AppError::bad("That isn't a Writey file."))?;
    let manifest: Value = {
        let entry = zip
            .by_name("manifest.json")
            .map_err(|_| AppError::bad("That isn't a Writey file."))?;
        serde_json::from_reader(entry).map_err(|_| AppError::bad("This Writey file is damaged."))?
    };
    Ok(manifest["notebooks"].as_array().map(Vec::len).unwrap_or(0))
}

#[tauri::command]
async fn archive_import(
    s: Cmd<'_>,
    path: String,
    sort_keys: Vec<String>,
) -> AppResult<store::archive::ImportSummary> {
    store::archive::import(&s.store, std::path::Path::new(&path), move |_| {
        sort_keys.clone()
    })
}

#[tauri::command]
async fn trash_empty(s: Cmd<'_>, older_than_days: i64) -> AppResult<usize> {
    s.store.purge_trash(older_than_days.max(0))
}

#[tauri::command]
async fn data_folder_open(app: tauri::AppHandle) -> AppResult<()> {
    let dir = app.path().app_data_dir()?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::new("open", e.to_string()))
}

/// A picture Writey pastes from Wikimedia Commons (HANDOFF D49), when the web view can't
/// fetch it directly. Only Commons' own image host.
#[tauri::command]
async fn picture_fetch(s: Cmd<'_>, url: String) -> AppResult<Response> {
    let u = url::Url::parse(&url).map_err(|_| AppError::bad("bad url"))?;
    if u.scheme() != "https" || u.host_str() != Some("upload.wikimedia.org") {
        return Err(AppError::bad("bad url"));
    }
    let res = s.ai.http.get(u).send().await?;
    let is_image = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("image/"));
    if !res.status().is_success() || !is_image {
        return Err(AppError::new(
            "picture_unavailable",
            "Couldn't download the picture.",
        ));
    }
    let bytes = res.bytes().await?;
    if bytes.len() > store::IMAGE_MAX_BYTES {
        return Err(AppError::new("too_large", "That picture is too big."));
    }
    Ok(Response::new(bytes.to_vec()))
}

// ---------------------------------------------------------------------- AI

#[tauri::command]
async fn credentials_list(s: Cmd<'_>) -> AppResult<Vec<CredentialInfo>> {
    s.ai.list_credentials(&s.vault)
}

#[tauri::command]
async fn credential_save(s: Cmd<'_>, provider: String, key: String) -> AppResult<CredentialInfo> {
    s.ai.save_credential(&s.vault, &provider, &key).await
}

#[tauri::command]
async fn credential_delete(s: Cmd<'_>, provider: String) -> AppResult<()> {
    s.ai.delete_credential(&s.vault, &provider)
}

#[tauri::command]
async fn vault_reset(s: Cmd<'_>) -> AppResult<()> {
    s.vault.reset()
}

#[tauri::command]
async fn models_list(s: Cmd<'_>, provider: String) -> AppResult<Value> {
    s.ai.models(&s.vault, &provider).await
}

#[tauri::command]
async fn ai_chat(
    s: Cmd<'_>,
    provider: String,
    body: String,
    id: u32,
    on_event: Channel<StreamEvent>,
) -> AppResult<()> {
    s.ai.chat(&s.vault, &provider, body, id, on_event).await
}

#[tauri::command]
async fn ai_chatgpt(
    s: Cmd<'_>,
    body: String,
    id: u32,
    on_event: Channel<StreamEvent>,
) -> AppResult<()> {
    s.ai.chatgpt_responses(&s.vault, body, id, on_event).await
}

#[tauri::command]
fn ai_abort(s: Cmd<'_>, id: u32) {
    s.ai.abort(id);
}

#[tauri::command]
async fn chatgpt_status(s: Cmd<'_>) -> AppResult<ai::chatgpt::Status> {
    s.ai.chatgpt.status(&s.vault)
}

#[tauri::command]
async fn chatgpt_login(
    app: tauri::AppHandle,
    s: Cmd<'_>,
    switch_account: bool,
) -> AppResult<ai::chatgpt::Status> {
    let status =
        s.ai.chatgpt
            .login(&s.vault, switch_account, |url| open_browser(&app, url))
            .await;
    focus(&app);
    status
}

#[tauri::command]
fn chatgpt_cancel_login(s: Cmd<'_>) {
    s.ai.chatgpt.cancel_login();
}

#[tauri::command]
async fn chatgpt_logout(s: Cmd<'_>) -> AppResult<Value> {
    Ok(json!({ "revoked": s.ai.chatgpt.logout(&s.vault).await? }))
}

#[tauri::command]
async fn chatgpt_welcomed(s: Cmd<'_>) -> AppResult<()> {
    s.ai.chatgpt.mark_welcomed(&s.vault)
}

#[tauri::command]
async fn openrouter_connect(app: tauri::AppHandle, s: Cmd<'_>) -> AppResult<CredentialInfo> {
    let cancel = tokio_util::sync::CancellationToken::new();
    if let Some(old) = s
        .openrouter
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(cancel.clone())
    {
        old.cancel();
    }
    let key = ai::openrouter::connect(&s.ai.http, cancel, |url| open_browser(&app, url)).await;
    focus(&app);
    s.ai.save_credential(&s.vault, "openrouter", &key?).await
}

#[tauri::command]
fn openrouter_cancel(s: Cmd<'_>) {
    if let Some(c) = s
        .openrouter
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        c.cancel();
    }
}

fn focus(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------------- voice

#[tauri::command]
fn voice_status(s: Cmd<'_>) -> VoiceStatus {
    s.voice.status()
}

#[tauri::command]
async fn voice_prepare(s: Cmd<'_>, stt: bool, tts: bool) -> AppResult<VoiceStatus> {
    Ok(s.voice.prepare(stt, tts).await)
}

#[tauri::command]
async fn voice_start(s: Cmd<'_>) -> AppResult<()> {
    let v = s.voice.clone();
    tauri::async_runtime::spawn_blocking(move || v.start_listening())
        .await
        .map_err(AppError::internal)?
}

#[tauri::command]
fn voice_stop(s: Cmd<'_>) {
    s.voice.stop_listening();
}

#[tauri::command]
fn voice_ptt(s: Cmd<'_>, down: bool) {
    s.voice.ptt(down);
}

#[tauri::command]
fn voice_say(s: Cmd<'_>, text: String, voice: String) {
    s.voice.say(&text, &voice);
}

#[tauri::command]
fn voice_stop_speaking(s: Cmd<'_>) {
    s.voice.stop_speaking();
}

#[tauri::command]
async fn voice_set_prefer(s: Cmd<'_>, prefer: String) -> AppResult<VoiceStatus> {
    let prefer = if prefer == "cpu" { "cpu" } else { "auto" };
    s.store.set_setting("voice_device", &json!(prefer))?;
    s.voice.set_prefer(prefer);
    Ok(s.voice.status())
}

#[tauri::command]
async fn voice_remove_models(s: Cmd<'_>) -> AppResult<VoiceStatus> {
    s.voice.remove_models()?;
    Ok(s.voice.status())
}

// ---------------------------------------------------------------------- app

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> Value {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|u| !u.is_empty());
    // "anil" → "Anil"; account names like "anilreddy2569900" read better without digits.
    let user_name = user.map(|u| {
        let letters: String = u.chars().take_while(|c| c.is_alphabetic()).collect();
        let mut c = letters.chars();
        c.next()
            .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
            .unwrap_or_default()
    });
    json!({
        "version": app.package_info().version.to_string(),
        "user_name": user_name.filter(|n| n.len() > 1),
    })
}

#[tauri::command]
fn opened_files(files: State<'_, OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *files.0.lock().unwrap_or_else(|e| e.into_inner()))
}

fn open_files(app: &tauri::AppHandle, files: Vec<String>) {
    use tauri::Emitter;
    if files.is_empty() {
        return;
    }
    // The page asks once it has loaded; one that's already running hears the event.
    app.state::<OpenedFiles>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend(files.clone());
    let _ = app.emit("app:open-files", ());
    focus(app);
}

pub fn run() {
    if let Some(code) = voice::run_probe_from_args() {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            focus(app);
            open_files(app, writey_files(args.into_iter().skip(1)));
        }))
        .manage(OpenedFiles(std::sync::Mutex::new(writey_files(
            std::env::args().skip(1),
        ))))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let local = app.path().app_local_data_dir()?;
            let store = Store::open(&data).map_err(|e| e.message)?;
            // Trash older than 30 days goes for good.
            if let Err(e) = store.purge_trash(30) {
                log::warn!("emptying the trash failed: {}", e.message);
            }
            let prefer = store
                .setting("voice_device")
                .ok()
                .flatten()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "auto".into());
            let vad = app
                .path()
                .resolve(
                    "resources/silero_vad.onnx",
                    tauri::path::BaseDirectory::Resource,
                )
                .unwrap_or_default();
            let ai = Ai::new();
            let voice = Arc::new(Voice::new(
                app.handle().clone(),
                local.join("voice"),
                vad,
                ai.http.clone(),
                prefer,
            ));
            voice.warm_up();
            app.manage(App {
                store,
                vault: Vault::new(&data),
                ai,
                voice,
                openrouter: std::sync::Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notebooks_list,
            notebook_get,
            notebook_create,
            notebook_rename,
            notebook_move,
            notebook_trash,
            notebook_restore,
            pages_list,
            pages_add,
            page_move,
            page_trash,
            page_load,
            page_save,
            asset_add,
            asset_read,
            threads_list,
            thread_create,
            thread_delete,
            messages_load,
            messages_append,
            setting_get,
            setting_set,
            archive_export,
            archive_peek,
            archive_import,
            trash_empty,
            data_folder_open,
            picture_fetch,
            credentials_list,
            credential_save,
            credential_delete,
            vault_reset,
            models_list,
            ai_chat,
            ai_chatgpt,
            ai_abort,
            chatgpt_status,
            chatgpt_login,
            chatgpt_cancel_login,
            chatgpt_logout,
            chatgpt_welcomed,
            openrouter_connect,
            openrouter_cancel,
            voice_status,
            voice_prepare,
            voice_start,
            voice_stop,
            voice_ptt,
            voice_say,
            voice_stop_speaking,
            voice_set_prefer,
            voice_remove_models,
            app_info,
            opened_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Writey")
        .run(|_app, _event| {
            // macOS hands over files opened from Finder as an event.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned());
                open_files(_app, writey_files(files));
            }
        });
}
