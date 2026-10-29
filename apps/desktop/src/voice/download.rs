//! Downloads for voice: speech models and, on Windows, the speech engine's libraries.
//! Downloads resume after a dropped connection, are checked when a checksum is known, and
//! land in place only once complete, so a half-finished download never gets loaded.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};

/// What to keep from a downloaded file.
#[derive(Clone, Copy, Debug)]
pub enum Keep {
    /// The file itself, under this name.
    As(&'static str),
    /// From a .tar.bz2: these file names, wherever they are in the archive.
    TarFiles(&'static [&'static str]),
    /// From a .tar.bz2: every .dll (Windows libraries).
    TarDlls,
    /// From a .whl (zip): every .dll.
    ZipDlls,
}

#[derive(Clone, Copy, Debug)]
pub struct Item {
    pub url: &'static str,
    pub sha256: Option<&'static str>,
    /// For progress before the server says (and for the size shown in Settings).
    pub approx_bytes: u64,
    pub keep: Keep,
}

/// Downloads `items` into `dest` (created fresh), reporting overall progress 0…1.
pub async fn fetch_all(
    http: &reqwest::Client,
    items: &[Item],
    dest: &Path,
    cache: &Path,
    progress: impl Fn(f64) + Send + Sync,
) -> AppResult<()> {
    let total: u64 = items.iter().map(|i| i.approx_bytes).sum::<u64>().max(1);
    let staging = dest.with_extension("partial");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    std::fs::create_dir_all(cache)?;
    let mut done_before = 0u64;
    for item in items {
        let file = cache.join(file_name(item.url));
        let base = done_before;
        download(http, item, &file, |n| {
            progress(((base + n) as f64 / total as f64).min(0.99))
        })
        .await?;
        let staging2 = staging.clone();
        let file2 = file.clone();
        let keep = item.keep;
        tokio::task::spawn_blocking(move || unpack(&file2, keep, &staging2))
            .await
            .map_err(AppError::internal)??;
        let _ = std::fs::remove_file(&file);
        done_before += item.approx_bytes;
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&staging, dest)?;
    progress(1.0);
    Ok(())
}

fn file_name(url: &str) -> String {
    let name = url.rsplit('/').next().unwrap_or("download");
    let name = name.split('?').next().unwrap_or(name);
    // Hugging Face files share names across repos; keep them apart.
    format!("{:x}-{name}", Sha256::digest(url.as_bytes()))[..16].to_string() + "-" + name
}

/// Fetches `url` into `path`, resuming a partial file left by an earlier try.
async fn download(
    http: &reqwest::Client,
    item: &Item,
    path: &Path,
    progress: impl Fn(u64),
) -> AppResult<()> {
    let part = path.with_extension("part");
    for attempt in 0..4 {
        match download_once(http, item.url, &part, &progress).await {
            Ok(()) => break,
            Err(e) if attempt < 3 && e.code == "network" => {
                log::warn!(
                    "download of {} interrupted ({}); resuming",
                    item.url,
                    e.message
                );
                tokio::time::sleep(std::time::Duration::from_secs(2 << attempt)).await;
            }
            Err(e) => return Err(e),
        }
    }
    if let Some(expected) = item.sha256 {
        let part2 = part.clone();
        let actual = tokio::task::spawn_blocking(move || sha256_file(&part2))
            .await
            .map_err(AppError::internal)??;
        if actual != expected {
            let _ = std::fs::remove_file(&part);
            return Err(AppError::new(
                "bad_download",
                "A download came out damaged. Try again.",
            ));
        }
    }
    std::fs::rename(&part, path)?;
    Ok(())
}

async fn download_once(
    http: &reqwest::Client,
    url: &str,
    part: &Path,
    progress: &impl Fn(u64),
) -> AppResult<()> {
    let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let mut req = http
        .get(url)
        .timeout(std::time::Duration::from_secs(60 * 60));
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let res = req
        .send()
        .await
        .map_err(|e| AppError::new("network", e.to_string()))?;
    let status = res.status();
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && have > 0 {
        // Already complete.
        return Ok(());
    }
    if !status.is_success() {
        return Err(AppError::new(
            "download_failed",
            format!(
                "The download server answered {} for {}",
                status.as_u16(),
                file_name(url)
            ),
        ));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(part)
        .await?;
    let mut done = if resumed { have } else { 0 };
    progress(done);
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::new("network", e.to_string()))?;
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        progress(done);
    }
    file.flush().await?;
    Ok(())
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn base_name(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

fn unpack(file: &Path, keep: Keep, dest: &Path) -> AppResult<()> {
    match keep {
        Keep::As(name) => {
            std::fs::copy(file, dest.join(name))?;
        }
        Keep::TarFiles(names) => {
            let found = untar(file, dest, |n| names.contains(&n))?;
            if let Some(missing) = names.iter().find(|n| !found.iter().any(|f| f == *n)) {
                return Err(AppError::new(
                    "bad_download",
                    format!("The download is missing {missing}."),
                ));
            }
        }
        Keep::TarDlls => {
            let found = untar(file, dest, |n| n.to_ascii_lowercase().ends_with(".dll"))?;
            if found.is_empty() {
                return Err(AppError::new(
                    "bad_download",
                    "The speech engine download had no libraries.",
                ));
            }
        }
        Keep::ZipDlls => {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(file)?).map_err(|_| {
                AppError::new("bad_download", "A download came out damaged. Try again.")
            })?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i)?;
                let name = base_name(entry.name()).to_string();
                if !entry.is_file() || !name.to_ascii_lowercase().ends_with(".dll") {
                    continue;
                }
                let mut out = std::fs::File::create(dest.join(&name))?;
                std::io::copy(&mut entry, &mut out)?;
            }
        }
    }
    Ok(())
}

/// Extracts the files whose base name passes `want`, flattened into `dest`.
fn untar(file: &Path, dest: &Path, want: impl Fn(&str) -> bool) -> AppResult<Vec<String>> {
    let reader =
        bzip2::read::MultiBzDecoder::new(std::io::BufReader::new(std::fs::File::open(file)?));
    let mut archive = tar::Archive::new(reader);
    let mut found = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.to_string_lossy().into_owned();
        let name = base_name(&path).to_string();
        if name.is_empty() || name.starts_with("._") || !want(&name) {
            continue;
        }
        let target: PathBuf = dest.join(&name);
        let mut out = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut out)?;
        out.flush()?;
        found.push(name);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untars_wanted_files_flat() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = dir.path().join("m.tar.bz2");
        {
            let enc = bzip2::write::BzEncoder::new(
                std::fs::File::create(&tarball).unwrap(),
                bzip2::Compression::fast(),
            );
            let mut b = tar::Builder::new(enc);
            for (name, body) in [
                ("model/tokens.txt", "a 1"),
                ("model/test_wavs/0.wav", "RIFF"),
                ("model/lib/x.dll", "MZ"),
            ] {
                let mut h = tar::Header::new_gnu();
                h.set_size(body.len() as u64);
                h.set_mode(0o644);
                h.set_cksum();
                b.append_data(&mut h, name, body.as_bytes()).unwrap();
            }
            b.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        unpack(&tarball, Keep::TarFiles(&["tokens.txt"]), &out).unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("tokens.txt")).unwrap(),
            "a 1"
        );
        assert!(!out.join("0.wav").exists());
        unpack(&tarball, Keep::TarDlls, &out).unwrap();
        assert!(out.join("x.dll").exists());
        assert!(unpack(&tarball, Keep::TarFiles(&["model.onnx"]), &out).is_err());
    }

    #[test]
    fn cache_names_are_distinct() {
        let a = file_name("https://huggingface.co/a/resolve/main/encoder.onnx");
        let b = file_name("https://huggingface.co/b/resolve/main/encoder.onnx");
        assert_ne!(a, b);
        assert!(a.ends_with("-encoder.onnx"));
    }
}
