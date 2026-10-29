//! Voice checks that need the network and big downloads, so they run in CI on purpose:
//! `cargo test --release --test voice -- --ignored --nocapture`.

use std::path::PathBuf;
use std::time::Instant;

use writey_lib::voice::download::{fetch_all, Item};
use writey_lib::voice::models::{self, Pack};

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Writey CI")
        .build()
        .unwrap()
}

fn root() -> PathBuf {
    std::env::var_os("WRITEY_VOICE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("writey-voice-test"))
}

/// Every file Writey downloads still exists where models.rs says.
#[tokio::test]
#[ignore]
async fn download_urls_are_live() {
    let packs = [
        &models::STT_GPU,
        &models::STT_CPU,
        &models::TTS,
        &models::RUNTIME_WIN_CPU,
        &models::RUNTIME_WIN_CUDA,
    ];
    let client = http();
    let mut bad = Vec::new();
    for p in packs {
        for Item {
            url, approx_bytes, ..
        } in p.items
        {
            let res = client
                .get(*url)
                .header(reqwest::header::RANGE, "bytes=0-0")
                .send()
                .await;
            match res {
                Ok(r) if r.status().is_success() => {
                    let size = r
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.rsplit('/').next())
                        .and_then(|v| v.parse::<u64>().ok());
                    println!(
                        "ok   {url} ({} MB, expected ~{} MB)",
                        size.unwrap_or(0) / 1_000_000,
                        approx_bytes / 1_000_000
                    );
                }
                Ok(r) => bad.push(format!("{} {url}", r.status())),
                Err(e) => bad.push(format!("{e} {url}")),
            }
        }
    }
    assert!(bad.is_empty(), "missing downloads:\n{}", bad.join("\n"));
}

async fn ensure(pack: &Pack) -> PathBuf {
    let dir = root().join(pack.dir);
    if !dir.is_dir() {
        let started = Instant::now();
        fetch_all(&http(), pack.items, &dir, &root().join("downloads"), |_| {})
            .await
            .unwrap();
        println!("downloaded {} in {:?}", pack.id, started.elapsed());
    }
    dir
}

/// Kokoro says a sentence, Parakeet hears it back. `WRITEY_TEST_PROVIDER` picks the
/// accelerator (cpu, cuda, coreml); Windows first downloads the speech engine.
#[cfg(feature = "voice")]
#[tokio::test]
#[ignore]
async fn speech_round_trip() {
    use writey_lib::voice::{engine, gpu};
    let provider = std::env::var("WRITEY_TEST_PROVIDER").unwrap_or_else(|_| "cpu".into());
    if gpu::ENGINE_DOWNLOADED {
        let pack = if provider == "cuda" {
            &models::RUNTIME_WIN_CUDA
        } else {
            &models::RUNTIME_WIN_CPU
        };
        let dir = ensure(pack).await;
        gpu::use_engine_dir(&dir).unwrap();
    }
    let tts = ensure(&models::TTS).await;
    let full = provider != "cpu";
    let stt = ensure(if full {
        &models::STT_GPU
    } else {
        &models::STT_CPU
    })
    .await;

    let wav = root().join("said.wav");
    let text =
        "Hey Writey, what is the derivative of x squared? It's 2x, so the answer is 2 times 3.";
    let t = Instant::now();
    engine::synth_to_file(&tts, &provider, text, &wav).unwrap();
    println!("spoke in {:?}", t.elapsed());
    let t = Instant::now();
    let heard = engine::transcribe_file(&stt, full, &provider, &wav).unwrap();
    println!("heard in {:?}: {heard}", t.elapsed());
    let h = heard.to_lowercase();
    for word in ["derivative", "squared", "answer"] {
        assert!(h.contains(word), "expected {word:?} in {heard:?}");
    }
    assert!(
        h.contains("times"),
        "expected the spoken numbers in {heard:?}"
    );
}
