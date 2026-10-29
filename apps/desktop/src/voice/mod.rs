//! Talking to Writey, all on this computer (HANDOFF D13, D19, D57): Silero VAD and Parakeet
//! to hear you, Kokoro to answer out loud. Speech runs on the GPU when there is one (CUDA on
//! NVIDIA, CoreML on Apple Silicon) and falls back to the CPU by itself.

pub mod download;
pub mod echo;
pub mod gpu;
pub mod models;
pub mod resample;
pub mod text;

#[cfg(feature = "voice")]
pub mod engine;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use gpu::Accel;
use models::Pack;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ModelState {
    Missing,
    Downloading { progress: f64 },
    Downloaded,
    Loading,
    Ready,
    Error { error: String },
}

#[derive(Serialize, Clone)]
pub struct ModelStatus {
    #[serde(flatten)]
    pub state: ModelState,
    /// Download size in bytes.
    pub bytes: u64,
    /// "gpu" or "cpu" once loaded.
    pub device: Option<&'static str>,
}

#[derive(Serialize, Clone)]
pub struct VoiceStatus {
    /// Voice is part of this build.
    pub available: bool,
    /// What speech runs on: "cuda", "coreml" or "cpu".
    pub accel: Accel,
    pub gpu_name: Option<String>,
    /// Why the GPU isn't used, when there is one.
    pub gpu_error: Option<String>,
    /// "auto" (GPU when there is one) or "cpu".
    pub prefer: String,
    /// Windows: the speech engine's libraries, downloaded once.
    pub engine: Option<ModelStatus>,
    pub stt: ModelStatus,
    pub tts: ModelStatus,
    pub voices: Vec<Value>,
    pub listening: bool,
}

struct Inner {
    stt: ModelState,
    tts: ModelState,
    engine: ModelState,
    stt_device: Option<&'static str>,
    tts_device: Option<&'static str>,
    accel: Accel,
    gpu_name: Option<String>,
    gpu_error: Option<String>,
    prefer: String,
    /// The engine libraries this process loaded (Windows: they can't be swapped without a restart).
    engine_loaded: Option<&'static str>,
    probed: Option<Result<(), String>>,
}

pub struct Voice {
    app: AppHandle,
    root: PathBuf,
    vad_model: PathBuf,
    http: reqwest::Client,
    inner: Arc<Mutex<Inner>>,
    preparing: tokio::sync::Mutex<()>,
    #[cfg(feature = "voice")]
    engine: engine::Engine,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Voice {
    pub fn new(
        app: AppHandle,
        root: PathBuf,
        vad_model: PathBuf,
        http: reqwest::Client,
        prefer: String,
    ) -> Self {
        let (accel, gpu_name) = if prefer == "cpu" {
            (Accel::Cpu, gpu::detect().1)
        } else {
            gpu::detect()
        };
        let v = Self {
            #[cfg(feature = "voice")]
            engine: engine::Engine::new(app.clone()),
            app,
            root,
            vad_model,
            http,
            inner: Arc::new(Mutex::new(Inner {
                stt: ModelState::Missing,
                tts: ModelState::Missing,
                engine: ModelState::Missing,
                stt_device: None,
                tts_device: None,
                accel,
                gpu_name,
                gpu_error: None,
                prefer,
                engine_loaded: None,
                probed: None,
            })),
            preparing: tokio::sync::Mutex::new(()),
        };
        v.refresh_disk_state();
        v
    }

    fn models_dir(&self) -> PathBuf {
        self.root.join("models")
    }

    fn stt_pack(accel: Accel) -> &'static Pack {
        if accel.is_gpu() {
            &models::STT_GPU
        } else {
            &models::STT_CPU
        }
    }

    fn engine_pack(accel: Accel) -> &'static Pack {
        if accel == Accel::Cuda {
            &models::RUNTIME_WIN_CUDA
        } else {
            &models::RUNTIME_WIN_CPU
        }
    }

    fn have(&self, pack: &Pack) -> bool {
        self.models_dir().join(pack.dir).is_dir()
    }

    /// Marks packs already on disk as downloaded.
    fn refresh_disk_state(&self) {
        let accel = lock(&self.inner).accel;
        let stt = self.have(Self::stt_pack(accel)) || self.have(&models::STT_GPU);
        let tts = self.have(&models::TTS);
        let eng = self.have(Self::engine_pack(accel));
        let mut i = lock(&self.inner);
        if matches!(i.stt, ModelState::Missing | ModelState::Downloaded) {
            i.stt = if stt {
                ModelState::Downloaded
            } else {
                ModelState::Missing
            };
        }
        if matches!(i.tts, ModelState::Missing | ModelState::Downloaded) {
            i.tts = if tts {
                ModelState::Downloaded
            } else {
                ModelState::Missing
            };
        }
        if matches!(i.engine, ModelState::Missing | ModelState::Downloaded) {
            i.engine = if eng {
                ModelState::Downloaded
            } else {
                ModelState::Missing
            };
        }
    }

    pub fn status(&self) -> VoiceStatus {
        let i = lock(&self.inner);
        VoiceStatus {
            available: cfg!(feature = "voice"),
            accel: i.accel,
            gpu_name: i.gpu_name.clone(),
            gpu_error: i.gpu_error.clone(),
            prefer: i.prefer.clone(),
            engine: gpu::ENGINE_DOWNLOADED.then(|| ModelStatus {
                state: i.engine.clone(),
                bytes: Self::engine_pack(i.accel).bytes(),
                device: None,
            }),
            stt: ModelStatus {
                state: i.stt.clone(),
                bytes: Self::stt_pack(i.accel).bytes(),
                device: i.stt_device,
            },
            tts: ModelStatus {
                state: i.tts.clone(),
                bytes: models::TTS.bytes(),
                device: i.tts_device,
            },
            voices: models::VOICES
                .iter()
                .map(|(id, _, name)| json!({ "id": id, "name": name }))
                .collect(),
            listening: self.listening(),
        }
    }

    fn emit_status(&self) {
        let _ = self.app.emit("voice:models", self.status());
    }

    fn set(&self, f: impl FnOnce(&mut Inner)) {
        f(&mut lock(&self.inner));
        self.emit_status();
    }

    /// "auto" uses the GPU when there is one; "cpu" never does. Takes effect for models
    /// loaded after this (a restart switches models already in use).
    pub fn set_prefer(&self, prefer: &str) {
        let (accel, name) = if prefer == "cpu" {
            (Accel::Cpu, gpu::detect().1)
        } else {
            gpu::detect()
        };
        self.set(|i| {
            i.prefer = prefer.into();
            i.accel = accel;
            i.gpu_name = name;
            i.gpu_error = None;
            i.probed = None;
            if !matches!(
                i.stt,
                ModelState::Ready | ModelState::Loading | ModelState::Downloading { .. }
            ) {
                i.stt = ModelState::Missing;
            }
        });
        self.refresh_disk_state();
        self.emit_status();
    }

    // ------------------------------------------------------------------ preparing

    /// Downloads (first time) and loads what's asked for, in the background.
    pub async fn prepare(self: &Arc<Self>, stt: bool, tts: bool) -> VoiceStatus {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = me.preparing.lock().await;
            if let Err(e) = me.prepare_inner(stt, tts).await {
                log::error!("voice prepare failed: {}", e.message);
            }
            #[cfg(feature = "voice")]
            me.engine.set_tts_waiting(false);
            me.emit_status();
        });
        #[cfg(feature = "voice")]
        if tts {
            self.engine.set_tts_waiting(true);
        }
        self.status()
    }

    async fn prepare_inner(&self, want_stt: bool, want_tts: bool) -> AppResult<()> {
        if !cfg!(feature = "voice") {
            return Err(AppError::new(
                "voice_unavailable",
                "Voice isn't part of this build of Writey.",
            ));
        }
        let accel = self.ensure_engine().await?;
        if want_stt && !matches!(lock(&self.inner).stt, ModelState::Ready) {
            // The GPU fell back: the full model already here runs on the CPU too.
            let pack =
                if !accel.is_gpu() && self.have(&models::STT_GPU) && !self.have(&models::STT_CPU) {
                    &models::STT_GPU
                } else {
                    Self::stt_pack(accel)
                };
            self.ensure_pack(pack, |i, s| i.stt = s).await?;
            self.load(true, pack, accel).await;
        }
        if want_tts && !matches!(lock(&self.inner).tts, ModelState::Ready) {
            self.ensure_pack(&models::TTS, |i, s| i.tts = s).await?;
            self.load(false, &models::TTS, accel).await;
        }
        Ok(())
    }

    /// Windows: downloads and loads the engine libraries (CUDA build for NVIDIA GPUs).
    /// Then checks the GPU in a child process. Returns what speech will run on.
    async fn ensure_engine(&self) -> AppResult<Accel> {
        let mut accel = lock(&self.inner).accel;
        if gpu::ENGINE_DOWNLOADED {
            let loaded = lock(&self.inner).engine_loaded;
            match loaded {
                Some(id) => {
                    // A CPU-only engine is already in this process: the GPU needs a restart.
                    if accel == Accel::Cuda && id != models::RUNTIME_WIN_CUDA.id {
                        self.set(|i| {
                            i.gpu_error = Some("Restart Writey to start using the GPU.".into());
                            i.accel = Accel::Cpu;
                        });
                        accel = Accel::Cpu;
                    }
                }
                None => {
                    let pack = Self::engine_pack(accel);
                    self.ensure_pack(pack, |i, s| i.engine = s).await?;
                    let dir = self.models_dir().join(pack.dir);
                    let result = tokio::task::spawn_blocking(move || gpu::use_engine_dir(&dir))
                        .await
                        .map_err(AppError::internal)?;
                    if let Err(e) = result {
                        self.set(|i| i.engine = ModelState::Error { error: e.clone() });
                        return Err(AppError::new("engine_failed", e));
                    }
                    self.set(|i| {
                        i.engine = ModelState::Ready;
                        i.engine_loaded = Some(pack.id);
                    });
                }
            }
        }
        if accel.is_gpu() {
            let probed = lock(&self.inner).probed.clone();
            let result = match probed {
                Some(r) => r,
                None => {
                    let vad = self.vad_model.clone();
                    let dir = gpu::ENGINE_DOWNLOADED
                        .then(|| self.models_dir().join(Self::engine_pack(accel).dir));
                    let r = tokio::task::spawn_blocking(move || {
                        gpu::probe(accel, &vad, dir.as_deref())
                    })
                    .await
                    .map_err(AppError::internal)?;
                    lock(&self.inner).probed = Some(r.clone());
                    r
                }
            };
            if let Err(e) = result {
                log::warn!("GPU speech unavailable: {e}");
                self.set(|i| {
                    i.gpu_error = Some(format!(
                        "The GPU couldn't run speech ({e}), so the CPU does."
                    ));
                    i.accel = Accel::Cpu;
                });
                accel = Accel::Cpu;
                self.refresh_disk_state();
            }
        }
        Ok(accel)
    }

    async fn ensure_pack(
        &self,
        pack: &'static Pack,
        put: fn(&mut Inner, ModelState),
    ) -> AppResult<()> {
        let dir = self.models_dir().join(pack.dir);
        if dir.is_dir() {
            return Ok(());
        }
        self.set(|i| put(i, ModelState::Downloading { progress: 0.0 }));
        let inner = self.inner.clone();
        let app = self.app.clone();
        let last = Mutex::new(-1i64);
        let me_status = |p: f64| {
            let step = (p * 200.0) as i64;
            let mut l = lock(&last);
            if step != *l {
                *l = step;
                put(&mut lock(&inner), ModelState::Downloading { progress: p });
                let _ = app.emit("voice:progress", json!({ "pack": pack.id, "progress": p }));
            }
        };
        let cache = self.root.join("downloads");
        match download::fetch_all(&self.http, pack.items, &dir, &cache, me_status).await {
            Ok(()) => {
                self.set(|i| put(i, ModelState::Downloaded));
                Ok(())
            }
            Err(e) => {
                self.set(|i| {
                    put(
                        i,
                        ModelState::Error {
                            error: e.message.clone(),
                        },
                    )
                });
                Err(e)
            }
        }
    }

    #[cfg(feature = "voice")]
    async fn load(&self, stt: bool, pack: &'static Pack, accel: Accel) {
        let set = |i: &mut Inner, s: ModelState, device: Option<&'static str>| {
            if stt {
                i.stt = s;
                i.stt_device = device;
            } else {
                i.tts = s;
                i.tts_device = device;
            }
        };
        self.set(|i| set(i, ModelState::Loading, None));
        let dir = self.models_dir().join(pack.dir);
        let full = pack.id == models::STT_GPU.id;
        let mut result = Err(String::new());
        // The GPU first; if it won't take the model, the same files on the CPU.
        for a in if accel.is_gpu() {
            vec![accel, Accel::Cpu]
        } else {
            vec![Accel::Cpu]
        } {
            let started = std::time::Instant::now();
            result = if stt {
                self.engine.load_stt(&dir, full, a.provider())
            } else {
                self.engine.load_tts(&dir, a.provider())
            };
            match &result {
                Ok(()) => {
                    log::info!(
                        "{} loaded on {} in {:?}",
                        pack.id,
                        a.provider(),
                        started.elapsed()
                    );
                    self.set(|i| {
                        set(
                            i,
                            ModelState::Ready,
                            Some(if a.is_gpu() { "gpu" } else { "cpu" }),
                        )
                    });
                    return;
                }
                Err(e) => log::warn!("{} didn't load on {}: {e}", pack.id, a.provider()),
            }
        }
        let error = result.err().unwrap_or_default();
        self.set(|i| set(i, ModelState::Error { error }, None));
    }

    #[cfg(not(feature = "voice"))]
    async fn load(&self, _stt: bool, _pack: &'static Pack, _accel: Accel) {}

    /// Deletes downloaded models (and the Windows engine) to free disk space.
    pub fn remove_models(&self) -> AppResult<()> {
        self.stop_listening();
        #[cfg(feature = "voice")]
        self.engine.unload();
        for p in [&models::STT_GPU, &models::STT_CPU, &models::TTS] {
            let _ = std::fs::remove_dir_all(self.models_dir().join(p.dir));
        }
        let _ = std::fs::remove_dir_all(self.root.join("downloads"));
        self.set(|i| {
            i.stt = ModelState::Missing;
            i.tts = ModelState::Missing;
            i.stt_device = None;
            i.tts_device = None;
        });
        Ok(())
    }

    // ------------------------------------------------------------------ listening and speaking

    pub fn listening(&self) -> bool {
        #[cfg(feature = "voice")]
        return self.engine.listening();
        #[cfg(not(feature = "voice"))]
        false
    }

    pub fn start_listening(&self) -> AppResult<()> {
        #[cfg(feature = "voice")]
        {
            if !matches!(lock(&self.inner).stt, ModelState::Ready) {
                return Err(AppError::new(
                    "not_ready",
                    "The speech model isn't ready yet.",
                ));
            }
            self.engine.start_mic(&self.vad_model).map_err(|e| {
                if e == "not_ready" {
                    AppError::new("not_ready", "The speech model isn't ready yet.")
                } else {
                    AppError::new("mic", e)
                }
            })?;
            self.emit_status();
            Ok(())
        }
        #[cfg(not(feature = "voice"))]
        Err(AppError::new(
            "voice_unavailable",
            "Voice isn't part of this build of Writey.",
        ))
    }

    pub fn stop_listening(&self) {
        #[cfg(feature = "voice")]
        self.engine.stop_mic();
        self.emit_status();
    }

    pub fn ptt(&self, _down: bool) {
        #[cfg(feature = "voice")]
        self.engine.ptt(_down);
    }

    pub fn say(&self, _text: &str, _voice: &str) {
        #[cfg(feature = "voice")]
        self.engine.say(_text, models::voice_id(_voice));
    }

    pub fn stop_speaking(&self) {
        #[cfg(feature = "voice")]
        self.engine.stop_speaking();
    }

    /// Loads the voice on start when it's downloaded, so the first answer can be spoken.
    pub fn warm_up(self: &Arc<Self>) {
        let (stt, tts) = {
            let i = lock(&self.inner);
            (
                matches!(i.stt, ModelState::Downloaded),
                matches!(i.tts, ModelState::Downloaded),
            )
        };
        if cfg!(feature = "voice") && (stt || tts) {
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                me.prepare(stt, tts).await;
            });
        }
    }
}

/// `writey --writey-speech-probe <provider> <vad model> [engine dir]`: exit 0 when a GPU
/// session starts. Runs before anything else in `main`.
pub fn run_probe_from_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(gpu::PROBE_ARG) {
        return None;
    }
    let provider = args.get(2).cloned().unwrap_or_default();
    let vad = PathBuf::from(args.get(3).cloned().unwrap_or_default());
    if let Some(dir) = args.get(4) {
        if gpu::use_engine_dir(Path::new(dir)).is_err() {
            return Some(3);
        }
    }
    #[cfg(feature = "voice")]
    return Some(if engine::probe_session(&provider, &vad) {
        0
    } else {
        2
    });
    #[cfg(not(feature = "voice"))]
    {
        let _ = (provider, vad);
        Some(4)
    }
}
