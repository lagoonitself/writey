//! The speech engine: the mic through Silero VAD into Parakeet, and Kokoro into the speaker.
//! Audio runs on its own threads; results reach the web view as events. The web view still
//! decides what a line means ("Hey …", replies, commands; see voice/client.ts).

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use sherpa_onnx::{
    GenerationConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
    OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use tauri::{AppHandle, Emitter};

use super::echo::EchoGuard;
use super::resample::{to_mono, Resampler};
use super::text::{lexicon_words, Speakable};

const RATE: u32 = 16_000;
const WINDOW: usize = 512;

fn threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8) as i32)
        .unwrap_or(4)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Clone)]
struct SegmentEvent {
    text: String,
    ptt: bool,
    /// Heard over Writey's own voice: an interruption meant for Writey.
    during_speech: bool,
}

#[derive(Serialize, Clone)]
struct StateEvent {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Serialize, Clone)]
struct SpeakingEvent {
    on: bool,
    /// Ended by itself (everything said), not stopped.
    finished: bool,
}

struct Stt {
    rec: OfflineRecognizer,
}

impl Stt {
    fn transcribe(&self, samples: &[f32]) -> String {
        let stream = self.rec.create_stream();
        stream.accept_waveform(RATE as i32, samples);
        self.rec.decode(&stream);
        stream
            .get_result()
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default()
    }
}

struct Tts {
    tts: OfflineTts,
    words: HashSet<String>,
}

struct Segment {
    samples: Vec<f32>,
    ptt: bool,
    during_speech: bool,
}

#[derive(Default)]
struct Ptt {
    active: bool,
    release: bool,
    buf: Vec<f32>,
}

struct Mic {
    stop: Arc<AtomicBool>,
}

enum SayCmd {
    Say { text: String, sid: i32 },
    Stop,
}

pub struct Engine {
    app: AppHandle,
    stt: Arc<Mutex<Option<Arc<Stt>>>>,
    tts: Arc<Mutex<Option<Arc<Tts>>>>,
    mic: Mutex<Option<Mic>>,
    ptt: Arc<Mutex<Ptt>>,
    echo: Arc<Mutex<EchoGuard>>,
    speaker: Mutex<Option<Sender<SayCmd>>>,
    /// Why speech can't play yet (voice still loading), for queued sentences.
    tts_waiting: Arc<AtomicBool>,
}

impl Engine {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            stt: Arc::new(Mutex::new(None)),
            tts: Arc::new(Mutex::new(None)),
            mic: Mutex::new(None),
            ptt: Arc::new(Mutex::new(Ptt::default())),
            echo: Arc::new(Mutex::new(EchoGuard::default())),
            speaker: Mutex::new(None),
            tts_waiting: Arc::new(AtomicBool::new(false)),
        }
    }

    // ------------------------------------------------------------------ models

    pub fn stt_loaded(&self) -> bool {
        lock(&self.stt).is_some()
    }

    pub fn tts_loaded(&self) -> bool {
        lock(&self.tts).is_some()
    }

    pub fn unload(&self) {
        *lock(&self.stt) = None;
        *lock(&self.tts) = None;
    }

    /// Loads Parakeet from `dir` (full precision for a GPU, 8-bit for a CPU).
    pub fn load_stt(&self, dir: &Path, full: bool, provider: &str) -> Result<(), String> {
        let stt = stt_model(dir, full, provider)?;
        // A first run warms the GPU kernels, so the first real sentence isn't slow.
        let _ = stt.transcribe(&vec![0.0; RATE as usize / 2]);
        *lock(&self.stt) = Some(Arc::new(stt));
        Ok(())
    }

    pub fn load_tts(&self, dir: &Path, provider: &str) -> Result<(), String> {
        let tts = tts_model(dir, provider)?;
        *lock(&self.tts) = Some(Arc::new(tts));
        Ok(())
    }

    // ------------------------------------------------------------------ listening

    pub fn listening(&self) -> bool {
        lock(&self.mic).is_some()
    }

    pub fn start_mic(&self, vad_model: &Path) -> Result<(), String> {
        if self.listening() {
            return Ok(());
        }
        if !self.stt_loaded() {
            return Err("not_ready".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let (seg_tx, seg_rx) = mpsc::channel::<Segment>();
        // The transcriber: one segment at a time, in order.
        {
            let stt = self.stt.clone();
            let echo = self.echo.clone();
            let app = self.app.clone();
            std::thread::Builder::new()
                .name("writey-stt".into())
                .spawn(move || transcriber(seg_rx, stt, echo, app))
                .map_err(|e| e.to_string())?;
        }
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        {
            let stop = stop.clone();
            let ptt = self.ptt.clone();
            let echo = self.echo.clone();
            let app = self.app.clone();
            let vad_model = vad_model.to_path_buf();
            std::thread::Builder::new()
                .name("writey-mic".into())
                .spawn(move || listen(vad_model, stop, ptt, echo, app, seg_tx, ready_tx))
                .map_err(|e| e.to_string())?;
        }
        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {
                *lock(&self.mic) = Some(Mic { stop });
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err("the microphone didn't start".into())
            }
        }
    }

    pub fn stop_mic(&self) {
        if let Some(m) = lock(&self.mic).take() {
            m.stop.store(true, Ordering::SeqCst);
        }
        *lock(&self.ptt) = Ptt::default();
    }

    pub fn ptt(&self, down: bool) {
        let mut p = lock(&self.ptt);
        if down {
            p.active = true;
            p.release = false;
            p.buf.clear();
        } else if p.active {
            p.release = true;
        }
    }

    // ------------------------------------------------------------------ speaking

    pub fn say(&self, text: &str, sid: i32) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        lock(&self.echo).said(text);
        let _ = self.speaker_tx().send(SayCmd::Say {
            text: text.into(),
            sid,
        });
    }

    pub fn stop_speaking(&self) {
        if let Some(tx) = lock(&self.speaker).as_ref() {
            let _ = tx.send(SayCmd::Stop);
        }
    }

    pub fn set_tts_waiting(&self, waiting: bool) {
        self.tts_waiting.store(waiting, Ordering::SeqCst);
    }

    fn speaker_tx(&self) -> Sender<SayCmd> {
        let mut guard = lock(&self.speaker);
        if let Some(tx) = guard.as_ref() {
            return tx.clone();
        }
        let (tx, rx) = mpsc::channel();
        let tts = self.tts.clone();
        let echo = self.echo.clone();
        let app = self.app.clone();
        let waiting = self.tts_waiting.clone();
        let _ = std::thread::Builder::new()
            .name("writey-speaker".into())
            .spawn(move || speaker(rx, tts, echo, app, waiting));
        *guard = Some(tx.clone());
        tx
    }
}

fn path(dir: &Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}

/// sherpa-onnx ends the process on a missing model file, so check first.
fn require(dir: &Path, files: &[&str]) -> Result<(), String> {
    for f in files {
        let p = dir.join(f);
        if !p
            .metadata()
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
        {
            return Err(format!("{f} is missing; download the voice models again"));
        }
    }
    Ok(())
}

fn emit_state(app: &AppHandle, kind: &'static str, message: Option<String>) {
    let _ = app.emit("voice:state", StateEvent { kind, message });
}

// ---------------------------------------------------------------------- mic thread

fn vad(model: &Path) -> Result<VoiceActivityDetector, String> {
    if !model.is_file() {
        return Err("the voice detector is missing from the app".into());
    }
    let cfg = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(model.to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: 0.65,
            min_speech_duration: 0.25,
            window_size: WINDOW as i32,
            max_speech_duration: 25.0,
        },
        sample_rate: RATE as i32,
        num_threads: 1,
        provider: Some("cpu".into()),
        ..Default::default()
    };
    VoiceActivityDetector::create(&cfg, 60.0)
        .ok_or_else(|| "the voice detector didn't start".into())
}

fn open_input(tx: SyncSender<Vec<f32>>) -> Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found. Plug one in or check your sound settings.")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("The microphone can't be used: {e}"))?;
    let rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.config();
    let err = |e: cpal::StreamError| log::warn!("mic stream error: {e}");
    macro_rules! build {
        ($t:ty) => {{
            let tx = tx.clone();
            device.build_input_stream(
                &config,
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    let f: Vec<f32> = data
                        .iter()
                        .map(|s| <f32 as cpal::FromSample<$t>>::from_sample_(*s))
                        .collect();
                    // Never block the audio thread; a full queue drops a few ms of audio.
                    let _ = tx.try_send(to_mono(&f, channels));
                },
                err,
                None,
            )
        }};
    }
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::U16 => build!(u16),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::I8 => build!(i8),
        cpal::SampleFormat::U8 => build!(u8),
        cpal::SampleFormat::F64 => build!(f64),
        other => {
            return Err(format!(
                "The microphone uses an unsupported format ({other:?})."
            ))
        }
    }
    .map_err(|e| mic_error(&e.to_string()))?;
    stream.play().map_err(|e| mic_error(&e.to_string()))?;
    Ok((stream, rate))
}

fn mic_error(e: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("The microphone didn't open ({e}). Allow Writey in System Settings → Privacy & Security → Microphone.")
    } else {
        format!("The microphone didn't open ({e}). Check Windows Settings → Privacy → Microphone.")
    }
}

fn listen(
    vad_model: PathBuf,
    stop: Arc<AtomicBool>,
    ptt: Arc<Mutex<Ptt>>,
    echo: Arc<Mutex<EchoGuard>>,
    app: AppHandle,
    seg_tx: Sender<Segment>,
    ready: Sender<Result<(), String>>,
) {
    let vad = match vad(&vad_model) {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(256);
    // The stream must stay on this thread (it isn't Send on every platform).
    let (_stream, rate) = match open_input(tx) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut rs = Resampler::new(rate, RATE);
    let mut pending: Vec<f32> = Vec::with_capacity(WINDOW * 4);
    let mut was_speech = false;
    let mut started_over_writey = false;
    // A segment that began before push-to-talk was pressed is dropped (its words go to PTT).
    let mut skip_segment = false;
    let mut last_audio = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        let chunk = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(c) => c,
            Err(RecvTimeoutError::Timeout) => {
                if last_audio.elapsed() > Duration::from_secs(5) {
                    emit_state(
                        &app,
                        "error",
                        Some("The microphone stopped sending sound.".into()),
                    );
                    break;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        last_audio = Instant::now();
        let audio = rs.process(&chunk);
        let (ptt_on, release) = {
            let mut p = lock(&ptt);
            if p.active {
                p.buf.extend_from_slice(&audio);
            }
            let release = p.release;
            if release {
                p.active = false;
                p.release = false;
            }
            (
                p.active || release,
                release.then(|| std::mem::take(&mut p.buf)),
            )
        };
        if ptt_on && was_speech {
            skip_segment = true;
        }
        if let Some(buf) = release {
            if buf.len() >= (RATE as usize * 3) / 10 {
                let _ = seg_tx.send(Segment {
                    samples: buf,
                    ptt: true,
                    during_speech: false,
                });
            } else {
                emit_state(&app, "listening", None);
            }
        }
        pending.extend_from_slice(&audio);
        let mut fed = 0;
        while pending.len() - fed >= WINDOW {
            vad.accept_waveform(&pending[fed..fed + WINDOW]);
            fed += WINDOW;
            let speech = vad.detected();
            if speech && !was_speech {
                started_over_writey = lock(&echo).live();
                if !ptt_on && !started_over_writey {
                    let _ = app.emit("voice:speech-start", ());
                }
            }
            was_speech = speech;
            while let Some(seg) = vad.front() {
                let samples = seg.samples().to_vec();
                vad.pop();
                if ptt_on || skip_segment {
                    skip_segment = false;
                    continue;
                }
                let _ = seg_tx.send(Segment {
                    samples,
                    ptt: false,
                    during_speech: started_over_writey,
                });
            }
        }
        pending.drain(..fed);
    }
    vad.clear();
}

fn transcriber(
    rx: Receiver<Segment>,
    stt: Arc<Mutex<Option<Arc<Stt>>>>,
    echo: Arc<Mutex<EchoGuard>>,
    app: AppHandle,
) {
    while let Ok(seg) = rx.recv() {
        let Some(model) = lock(&stt).clone() else {
            continue;
        };
        emit_state(&app, "transcribing", None);
        let started = Instant::now();
        let text = model.transcribe(&seg.samples);
        log::debug!(
            "transcribed {:.1}s of speech in {:?}",
            seg.samples.len() as f32 / RATE as f32,
            started.elapsed()
        );
        emit_state(&app, "listening", None);
        if text.is_empty() || (!seg.ptt && lock(&echo).is_echo(&text, seg.during_speech)) {
            continue;
        }
        let _ = app.emit(
            "voice:segment",
            SegmentEvent {
                text,
                ptt: seg.ptt,
                during_speech: seg.during_speech,
            },
        );
    }
}

// ---------------------------------------------------------------------- speaker thread

struct Output {
    _stream: cpal::Stream,
    rate: u32,
    buf: Arc<Mutex<VecDeque<f32>>>,
}

fn open_output() -> Result<Output, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No speaker or headphones found.")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.config();
    let buf: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
    let err = |e: cpal::StreamError| log::warn!("speaker stream error: {e}");
    macro_rules! build {
        ($t:ty) => {{
            let buf = buf.clone();
            device.build_output_stream(
                &config,
                move |data: &mut [$t], _: &cpal::OutputCallbackInfo| {
                    let mut b = lock(&buf);
                    for frame in data.chunks_mut(channels) {
                        let v = b.pop_front().unwrap_or(0.0);
                        for s in frame.iter_mut() {
                            *s = <$t as cpal::FromSample<f32>>::from_sample_(v);
                        }
                    }
                },
                err,
                None,
            )
        }};
    }
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::U16 => build!(u16),
        cpal::SampleFormat::I32 => build!(i32),
        other => {
            return Err(format!(
                "The speaker uses an unsupported format ({other:?})."
            ))
        }
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(Output {
        _stream: stream,
        rate,
        buf,
    })
}

const VOICE_WAIT: Duration = Duration::from_secs(300);

fn speaker(
    rx: Receiver<SayCmd>,
    tts: Arc<Mutex<Option<Arc<Tts>>>>,
    echo: Arc<Mutex<EchoGuard>>,
    app: AppHandle,
    waiting: Arc<AtomicBool>,
) {
    let gen = AtomicU64::new(0);
    let mut queue: VecDeque<(String, i32, Instant)> = VecDeque::new();
    let mut out: Option<Output> = None;
    let mut speaking = false;
    let mut idle_since = Instant::now();
    loop {
        let first = match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(c) => Some(c),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut stopped = false;
        for cmd in first.into_iter().chain(rx.try_iter()) {
            match cmd {
                SayCmd::Say { text, sid } => queue.push_back((text, sid, Instant::now())),
                SayCmd::Stop => {
                    gen.fetch_add(1, Ordering::SeqCst);
                    queue.clear();
                    if let Some(o) = &out {
                        lock(&o.buf).clear();
                    }
                    stopped = true;
                }
            }
        }
        if stopped && speaking {
            speaking = false;
            lock(&echo).set_playing(false);
            let _ = app.emit(
                "voice:speaking",
                SpeakingEvent {
                    on: false,
                    finished: false,
                },
            );
        }

        if let Some((text, sid, queued)) = queue.front().cloned() {
            let model = lock(&tts).clone();
            match model {
                None if waiting.load(Ordering::SeqCst) && queued.elapsed() < VOICE_WAIT => {
                    // The voice is still downloading or loading; keep the sentence.
                }
                None => {
                    queue.clear();
                    let _ = app.emit(
                        "voice:issue",
                        "Writey's voice isn't set up yet. Open Settings → Voice to download it.",
                    );
                }
                Some(model) => {
                    queue.pop_front();
                    if out.is_none() {
                        match open_output() {
                            Ok(o) => out = Some(o),
                            Err(e) => {
                                queue.clear();
                                let _ =
                                    app.emit("voice:issue", format!("Writey couldn't speak: {e}"));
                                continue;
                            }
                        }
                    }
                    if !speaking {
                        speaking = true;
                        lock(&echo).set_playing(true);
                        let _ = app.emit(
                            "voice:speaking",
                            SpeakingEvent {
                                on: true,
                                finished: false,
                            },
                        );
                    }
                    let my_gen = gen.load(Ordering::SeqCst);
                    let audio = synthesize(&model, &text, sid);
                    // A stop that arrived while synthesizing wins.
                    let late_stop = rx.try_iter().any(|c| matches!(c, SayCmd::Stop));
                    if late_stop {
                        gen.fetch_add(1, Ordering::SeqCst);
                        queue.clear();
                    }
                    if let (Some(o), Some((samples, rate))) = (&out, audio) {
                        if gen.load(Ordering::SeqCst) == my_gen {
                            let mut r = Resampler::new(rate, o.rate);
                            let mut pcm = r.process(&samples);
                            // A short fade keeps sentence joins from clicking.
                            let fade = pcm.len().min(240);
                            for (i, s) in pcm.iter_mut().rev().take(fade).enumerate() {
                                *s *= i as f32 / fade as f32;
                            }
                            lock(&o.buf).extend(pcm);
                        } else {
                            lock(&o.buf).clear();
                        }
                    }
                }
            }
        }

        let playing = out.as_ref().is_some_and(|o| !lock(&o.buf).is_empty());
        if speaking && queue.is_empty() && !playing {
            speaking = false;
            lock(&echo).set_playing(false);
            idle_since = Instant::now();
            let _ = app.emit(
                "voice:speaking",
                SpeakingEvent {
                    on: false,
                    finished: true,
                },
            );
        }
        // Let go of the speaker when quiet, so a new default device is picked up next time.
        if !speaking && out.is_some() && idle_since.elapsed() > Duration::from_secs(5) {
            out = None;
        }
    }
}

fn synthesize(model: &Tts, text: &str, sid: i32) -> Option<(Vec<f32>, u32)> {
    let spoken = Speakable {
        known: &model.words,
    }
    .convert(text);
    if spoken.trim().is_empty() {
        return None;
    }
    let cfg = GenerationConfig {
        sid,
        speed: 1.0,
        ..Default::default()
    };
    let audio = model
        .tts
        .generate_with_config(&spoken, &cfg, None::<fn(&[f32], f32) -> bool>)?;
    Some((audio.samples().to_vec(), audio.sample_rate() as u32))
}

/// For the GPU check in a child process: starts a session on `provider` and returns.
pub fn probe_session(provider: &str, vad_model: &Path) -> bool {
    let cfg = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(vad_model.to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: 0.5,
            min_speech_duration: 0.25,
            window_size: WINDOW as i32,
            max_speech_duration: 20.0,
        },
        sample_rate: RATE as i32,
        num_threads: 1,
        provider: Some(provider.into()),
        ..Default::default()
    };
    let Some(v) = VoiceActivityDetector::create(&cfg, 5.0) else {
        return false;
    };
    v.accept_waveform(&[0.0; WINDOW * 4]);
    true
}

fn stt_model(dir: &Path, full: bool, provider: &str) -> Result<Stt, String> {
    let (enc, dec, join) = if full {
        ("encoder.onnx", "decoder.onnx", "joiner.onnx")
    } else {
        ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx")
    };
    require(dir, &[enc, dec, join, "tokens.txt"])?;
    let mut cfg = OfflineRecognizerConfig::default();
    cfg.model_config.transducer = OfflineTransducerModelConfig {
        encoder: Some(path(dir, enc)),
        decoder: Some(path(dir, dec)),
        joiner: Some(path(dir, join)),
    };
    cfg.model_config.tokens = Some(path(dir, "tokens.txt"));
    cfg.model_config.provider = Some(provider.into());
    cfg.model_config.num_threads = threads();
    let rec = OfflineRecognizer::create(&cfg).ok_or("the speech model didn't load")?;
    Ok(Stt { rec })
}

fn tts_model(dir: &Path, provider: &str) -> Result<Tts, String> {
    require(
        dir,
        &[
            "model.onnx",
            "voices.bin",
            "tokens.txt",
            "lexicon-us-en.txt",
        ],
    )?;
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: Some(path(dir, "model.onnx")),
                voices: Some(path(dir, "voices.bin")),
                tokens: Some(path(dir, "tokens.txt")),
                lexicon: Some(path(dir, "lexicon-us-en.txt")),
                length_scale: 1.0,
                ..Default::default()
            },
            num_threads: threads(),
            provider: Some(provider.into()),
            ..Default::default()
        },
        ..Default::default()
    };
    let tts = OfflineTts::create(&config).ok_or("Writey's voice didn't load")?;
    let words = std::fs::read_to_string(dir.join("lexicon-us-en.txt"))
        .map(|t| lexicon_words(&t))
        .unwrap_or_default();
    Ok(Tts { tts, words })
}

/// Speaks `text` into a WAV file (CI checks that speech round-trips without a sound card).
pub fn synth_to_file(dir: &Path, provider: &str, text: &str, out: &Path) -> Result<(), String> {
    let model = tts_model(dir, provider)?;
    let (samples, rate) = synthesize(&model, text, 3).ok_or("nothing to say")?;
    write_wav(out, &samples, rate).map_err(|e| e.to_string())
}

/// Transcribes a 16-bit WAV file.
pub fn transcribe_file(
    dir: &Path,
    full: bool,
    provider: &str,
    wav: &Path,
) -> Result<String, String> {
    let (samples, rate) = read_wav(wav).map_err(|e| e.to_string())?;
    let samples = Resampler::new(rate, RATE).process(&samples);
    Ok(stt_model(dir, full, provider)?.transcribe(&samples))
}

fn write_wav(path: &Path, samples: &[f32], rate: u32) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&rate.to_le_bytes())?;
    f.write_all(&(rate * 2).to_le_bytes())?;
    f.write_all(&2u16.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for s in samples {
        f.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    f.flush()
}

fn read_wav(path: &Path) -> std::io::Result<(Vec<f32>, u32)> {
    let bytes = std::fs::read(path)?;
    let bad = || std::io::Error::new(std::io::ErrorKind::InvalidData, "not a 16-bit PCM WAV file");
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad());
    }
    let mut i = 12;
    let (mut rate, mut channels, mut bits) = (0u32, 1usize, 16u16);
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
        let body = &bytes[i + 8..(i + 8 + len).min(bytes.len())];
        if id == b"fmt " && body.len() >= 16 {
            channels = u16::from_le_bytes([body[2], body[3]]) as usize;
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            if bits != 16 || rate == 0 {
                return Err(bad());
            }
            let s: Vec<f32> = body
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                .collect();
            return Ok((to_mono(&s, channels.max(1)), rate));
        }
        i += 8 + len + (len & 1);
    }
    Err(bad())
}
