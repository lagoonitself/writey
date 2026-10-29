//! Which speech models and engine libraries Writey downloads, and from where.
//!
//! - Speech to text: NVIDIA Parakeet TDT 0.6B v2 (English). Full precision on a GPU,
//!   8-bit on a CPU (8-bit layers have no GPU kernels).
//! - Text to speech: Kokoro 82M v1.0 with its US English lexicon.
//! - Windows only: sherpa-onnx's libraries, the CUDA build plus NVIDIA's CUDA 12 and
//!   cuDNN 9 runtime for NVIDIA GPUs, else the CPU build. macOS ships them in the app.

use super::download::{Item, Keep};

pub const SHERPA_VERSION: &str = "2.0.1";

const MB: u64 = 1_000_000;

pub struct Pack {
    pub id: &'static str,
    /// Folder under the voice models folder; bump it when the files change.
    pub dir: &'static str,
    pub items: &'static [Item],
}

impl Pack {
    pub fn bytes(&self) -> u64 {
        self.items.iter().map(|i| i.approx_bytes).sum()
    }
}

macro_rules! hf {
    ($name:literal, $bytes:expr) => {
        Item {
            url: concat!("https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2/resolve/main/", $name),
            sha256: None,
            approx_bytes: $bytes,
            keep: Keep::As($name),
        }
    };
}

pub const STT_GPU: Pack = Pack {
    id: "stt-gpu",
    dir: "parakeet-tdt-0.6b-v2-fp32",
    items: &[
        hf!("encoder.onnx", 45 * MB),
        hf!("encoder.weights", 2_440 * MB),
        hf!("decoder.onnx", 30 * MB),
        hf!("joiner.onnx", 14 * MB),
        hf!("tokens.txt", 0),
    ],
};

pub const STT_CPU: Pack = Pack {
    id: "stt-cpu",
    dir: "parakeet-tdt-0.6b-v2-int8",
    items: &[Item {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
        sha256: None,
        approx_bytes: 480 * MB,
        keep: Keep::TarFiles(&["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]),
    }],
};

pub const TTS: Pack = Pack {
    id: "tts",
    dir: "kokoro-multi-lang-v1_0",
    items: &[Item {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
        sha256: None,
        approx_bytes: 340 * MB,
        keep: Keep::TarFiles(&["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt"]),
    }],
};

/// Speech engine libraries for Windows without a usable NVIDIA GPU.
pub const RUNTIME_WIN_CPU: Pack = Pack {
    id: "engine-cpu",
    dir: "engine-cpu-2.0.1",
    items: &[Item {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-lib.tar.bz2",
        sha256: None,
        approx_bytes: 30 * MB,
        keep: Keep::TarDlls,
    }],
};

/// Speech engine libraries for NVIDIA GPUs: sherpa-onnx's CUDA build (ONNX Runtime 1.28 for
/// CUDA 12 and cuDNN 9) and NVIDIA's redistributable CUDA libraries from their PyPI wheels.
pub const RUNTIME_WIN_CUDA: Pack = Pack {
    id: "engine-cuda",
    dir: "engine-cuda12-2.0.1",
    items: &[
        Item {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2",
            sha256: None,
            approx_bytes: 260 * MB,
            keep: Keep::TarDlls,
        },
        wheel(
            "https://files.pythonhosted.org/packages/59/df/e7c3a360be4f7b93cee39271b792669baeb3846c58a4df6dfcf187a7ffab/nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl",
            "8e018af8fa02363876860388bd10ccb89eb9ab8fb0aa749aaf58430a9f7c4891",
            3_591_604,
        ),
        wheel(
            "https://files.pythonhosted.org/packages/20/e2/fc9a0e985249d873150276d5afb02e39a66817fedbf1a385724393e505ed/nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
            "623f43027d40d44ceadf0043f002bd25cf353e8f13ce90b9a87057019f560661",
            553_162_896,
        ),
        wheel(
            "https://files.pythonhosted.org/packages/20/ee/29955203338515b940bd4f60ffdbc073428f25ef9bfbce44c9a066aedc5c/nvidia_cufft_cu12-11.4.1.4-py3-none-win_amd64.whl",
            "8e5bfaac795e93f80611f807d42844e8e27e340e0cde270dcb6c65386d795b80",
            200_067_309,
        ),
        wheel(
            "https://files.pythonhosted.org/packages/e5/98/1bd66fd09cbe1a5920cb36ba87029d511db7cca93979e635fd431ad3b6c0/nvidia_curand_cu12-10.3.10.19-py3-none-win_amd64.whl",
            "e8129e6ac40dc123bd948e33d3e11b4aa617d87a583fa2f21b3210e90c743cde",
            68_774_847,
        ),
        wheel(
            "https://files.pythonhosted.org/packages/aa/38/f856579877f7c1c5066e61182e7de7bc27bf35a78c8d1b0fa592e6985bc4/nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64.whl",
            "06e9b0026f3bad97d2b58666330fabec04fe1672f776661ecb0ce0029c27f142",
            743_068_852,
        ),
        wheel(
            "https://files.pythonhosted.org/packages/52/de/823919be3b9d0ccbf1f784035423c5f18f4267fb0123558d58b813c6ec86/nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-win_amd64.whl",
            "72972ebdcf504d69462d3bcd67e7b81edd25d0fb85a2c46d3ea3517666636349",
            76_408_187,
        ),
    ],
};

const fn wheel(url: &'static str, sha256: &'static str, bytes: u64) -> Item {
    Item {
        url,
        sha256: Some(sha256),
        approx_bytes: bytes,
        keep: Keep::ZipDlls,
    }
}

/// Kokoro v1.0 voices: speaker id and a friendly name. English voices only.
pub const VOICES: &[(&str, i32, &str)] = &[
    ("af_heart", 3, "Heart (US)"),
    ("af_bella", 2, "Bella (US)"),
    ("af_nicole", 6, "Nicole (US)"),
    ("af_sarah", 9, "Sarah (US)"),
    ("af_nova", 7, "Nova (US)"),
    ("am_michael", 16, "Michael (US)"),
    ("am_fenrir", 14, "Fenrir (US)"),
    ("am_puck", 18, "Puck (US)"),
    ("bf_emma", 21, "Emma (UK)"),
    ("bf_isabella", 22, "Isabella (UK)"),
    ("bm_george", 26, "George (UK)"),
    ("bm_fable", 25, "Fable (UK)"),
];

pub fn voice_id(name: &str) -> i32 {
    VOICES
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, id, _)| *id)
        .unwrap_or(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_are_sane() {
        for p in [
            &STT_GPU,
            &STT_CPU,
            &TTS,
            &RUNTIME_WIN_CPU,
            &RUNTIME_WIN_CUDA,
        ] {
            assert!(!p.items.is_empty());
            assert!(p.items.iter().all(|i| i.url.starts_with("https://")));
        }
        assert!(STT_GPU.bytes() > 2_000 * MB);
        assert_eq!(voice_id("af_heart"), 3);
        assert_eq!(voice_id("nope"), 3);
        assert!(STT_GPU.items.iter().any(|i| i.url.ends_with("/tokens.txt")));
    }
}
