//! Running speech on the GPU: CUDA on Windows with an NVIDIA card, CoreML (Apple GPU and
//! Neural Engine) on Apple Silicon. A GPU that can't start is tried once in a child process
//! first, because a broken GPU driver can take the whole process down with it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

/// Where speech runs, as ONNX Runtime's execution provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Accel {
    Cuda,
    Coreml,
    Cpu,
}

impl Accel {
    pub fn provider(self) -> &'static str {
        match self {
            Accel::Cuda => "cuda",
            Accel::Coreml => "coreml",
            Accel::Cpu => "cpu",
        }
    }

    pub fn is_gpu(self) -> bool {
        self != Accel::Cpu
    }
}

/// The best accelerator this computer has, before trying it.
pub fn detect() -> (Accel, Option<String>) {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return (Accel::Coreml, Some("Apple GPU and Neural Engine".into()));
    }
    if cfg!(target_os = "windows") {
        if let Some(name) = nvidia_gpu() {
            return (Accel::Cuda, Some(name));
        }
    }
    (Accel::Cpu, None)
}

/// An NVIDIA GPU with its driver installed: the driver puts nvcuda.dll in System32.
fn nvidia_gpu() -> Option<String> {
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    if !system.join("System32").join("nvcuda.dll").is_file() {
        return None;
    }
    let mut cmd = Command::new(system.join("System32").join("nvidia-smi.exe"));
    cmd.args(["--query-gpu=name", "--format=csv,noheader"]);
    hide_window(&mut cmd);
    let name = cmd
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty());
    Some(name.unwrap_or_else(|| "NVIDIA GPU".into()))
}

#[cfg(windows)]
pub fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_window(_: &mut Command) {}

/// The argument that makes Writey's own executable run a GPU check and exit.
pub const PROBE_ARG: &str = "--writey-speech-probe";

/// Starts a GPU speech session in a child process. True if it came up cleanly.
pub fn probe(accel: Accel, vad_model: &Path, engine_dir: Option<&Path>) -> Result<(), String> {
    if !accel.is_gpu() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg(PROBE_ARG).arg(accel.provider()).arg(vad_model);
    if let Some(dir) = engine_dir {
        cmd.arg(dir);
    }
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("the GPU check stopped ({status})")),
            Ok(None) if std::time::Instant::now() > deadline => {
                let _ = child.kill();
                return Err("the GPU check took too long".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Makes the speech engine libraries in `dir` the ones this process uses (Windows: the
/// executable links them lazily, so this must run before the first speech call).
#[cfg(windows)]
pub fn use_engine_dir(dir: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{LoadLibraryW, SetDllDirectoryW};
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    unsafe {
        if SetDllDirectoryW(wide(dir).as_ptr()) == 0 {
            return Err("couldn't point Windows at the speech engine".into());
        }
        // Load by full path, dependencies first, so no other copy (System32 has its own
        // onnxruntime.dll on Windows 11) gets picked up by name.
        for name in [
            "onnxruntime.dll",
            "onnxruntime_providers_shared.dll",
            "sherpa-onnx-c-api.dll",
        ] {
            let path = dir.join(name);
            if path.is_file() && LoadLibraryW(wide(&path).as_ptr()).is_null() {
                return Err(format!("{name} didn't load"));
            }
        }
    }
    if !dir.join("sherpa-onnx-c-api.dll").is_file() {
        return Err("the speech engine is missing a file".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn use_engine_dir(_: &Path) -> Result<(), String> {
    Ok(())
}

/// Windows downloads the engine; elsewhere it ships inside the app.
pub const ENGINE_DOWNLOADED: bool = cfg!(windows);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_needs_no_probe() {
        assert!(probe(Accel::Cpu, Path::new("nope"), None).is_ok());
        assert_eq!(Accel::Cuda.provider(), "cuda");
        assert!(!Accel::Cpu.is_gpu());
    }
}
