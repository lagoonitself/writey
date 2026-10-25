"""
Local speech models (docs/ARCHITECTURE.md §7): Parakeet TDT 0.6B v2 for speech-to-text and
Kokoro-82M for text-to-speech, both ONNX on this computer. The browser owns the microphone,
voice detection and playback; the Helper only turns audio into text and text into audio.

Models download on first use into the Helper's data folder. Nothing here touches the network
after that, and no audio is ever stored.
"""

import asyncio
import io
import os
import threading
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import httpx

SAMPLE_RATE = 16_000
MAX_SECONDS = 30
MAX_TTS_CHARS = 800

PARAKEET_REPO = "istupakov/parakeet-tdt-0.6b-v2-onnx"
PARAKEET_FILES = {
    "config.json": 1,
    "vocab.txt": 1,
    "nemo128.onnx": 1,
    "encoder-model.int8.onnx": 652_000_000,
    "decoder_joint-model.int8.onnx": 9_000_000,
}
KOKORO_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = {"kokoro-v1.0.int8.onnx": 92_000_000, "voices-v1.0.bin": 28_000_000}

#: Kokoro voices offered in Writey's settings (American and British English).
VOICES = ("af_heart", "af_bella", "af_nicole", "am_michael", "am_fenrir", "bf_emma", "bm_george")
DEFAULT_VOICE = "af_heart"


class SpeechError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class Recognizer(Protocol):
    def recognize(self, audio: Any) -> str: ...


class Synthesizer(Protocol):
    def create(self, text: str, voice: str, speed: float) -> tuple[Any, int]: ...


@dataclass
class Model:
    """One model's lifecycle, as /voice/status reports it."""

    name: str
    files: dict[str, int]
    folder: Path
    state: str = "missing"  # missing | downloading | loading | ready | error
    error: str | None = None
    instance: Any = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    task: asyncio.Task[None] | None = None

    def downloaded(self) -> bool:
        return all((self.folder / f).is_file() for f in self.files)

    def progress(self) -> float:
        total = sum(self.files.values())
        done = sum(size for f, size in self.files.items() if (self.folder / f).is_file())
        # Files still arriving: ours end in .part, Hugging Face's in .incomplete.
        if self.folder.is_dir():
            for pattern in ("*.part", "*.incomplete"):
                done += sum(p.stat().st_size for p in self.folder.rglob(pattern) if p.is_file())
        return round(min(1.0, done / total), 3) if total else 1.0

    def status(self) -> dict[str, Any]:
        state = self.state
        if state == "missing" and self.downloaded():
            state = "downloaded"
        out: dict[str, Any] = {"model": self.name, "state": state}
        if state == "downloading":
            out["progress"] = self.progress()
        if self.error:
            out["error"] = self.error
        return out


Fetch = Callable[[str, Path], Any]


def _download_parakeet(folder: Path) -> None:
    from huggingface_hub import hf_hub_download

    for name in PARAKEET_FILES:
        if not (folder / name).is_file():
            hf_hub_download(PARAKEET_REPO, name, local_dir=folder)


def _session_options() -> Any:
    import onnxruntime as ort

    # A handful of threads beats all of them: laptops mix fast and slow cores, and the
    # two models share the CPU (measured 2026-10-25: 6 threads ran Parakeet 3x faster).
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(2, min(6, (os.cpu_count() or 4) // 2))
    return opts


def _load_parakeet(folder: Path) -> Recognizer:
    import numpy as np
    import onnx_asr

    model = onnx_asr.load_model(
        "nemo-parakeet-tdt-0.6b-v2", folder, quantization="int8", sess_options=_session_options()
    )
    # The first run is several times slower than the rest; pay for it while loading.
    model.recognize(np.zeros(SAMPLE_RATE, dtype=np.float32), sample_rate=SAMPLE_RATE)

    class Parakeet:
        def recognize(self, audio: Any) -> str:
            return str(model.recognize(audio, sample_rate=SAMPLE_RATE))

    return Parakeet()


def _download_kokoro(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    with httpx.Client(follow_redirects=True, timeout=60) as client:
        for name in KOKORO_FILES:
            target = folder / name
            if target.is_file():
                continue
            part = folder / f"{name}.part"
            with client.stream("GET", KOKORO_URL + name) as res:
                res.raise_for_status()
                with part.open("wb") as fh:
                    for chunk in res.iter_bytes(1 << 20):
                        fh.write(chunk)
            part.replace(target)


def _load_kokoro(folder: Path) -> Synthesizer:
    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    session = ort.InferenceSession(
        str(folder / "kokoro-v1.0.int8.onnx"),
        sess_options=_session_options(),
        providers=["CPUExecutionProvider"],
    )
    model = Kokoro.from_session(session, str(folder / "voices-v1.0.bin"))
    model.create("Hello.", voice=DEFAULT_VOICE, lang="en-us")

    class KokoroTTS:
        def create(self, text: str, voice: str, speed: float) -> tuple[Any, int]:
            samples, rate = model.create(text, voice=voice, speed=speed, lang="en-us")
            return samples, rate

    return KokoroTTS()


@dataclass
class Backend:
    """How a model is fetched and opened. Tests swap these for fakes."""

    download: Callable[[Path], None]
    load: Callable[[Path], Any]


DEFAULT_BACKENDS = {
    "stt": Backend(_download_parakeet, _load_parakeet),
    "tts": Backend(_download_kokoro, _load_kokoro),
}


def wav_bytes(samples: Any, rate: int) -> bytes:
    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Speech:
    def __init__(self, folder: Path, backends: dict[str, Backend] | None = None) -> None:
        self.backends = backends or DEFAULT_BACKENDS
        models = folder / "models"
        self.models = {
            "stt": Model("parakeet-tdt-0.6b-v2", PARAKEET_FILES, models / "parakeet-tdt-0.6b-v2"),
            "tts": Model("kokoro-82m", KOKORO_FILES, models / "kokoro-v1.0"),
        }

    def status(self) -> dict[str, Any]:
        return {
            "stt": self.models["stt"].status(),
            "tts": {**self.models["tts"].status(), "voices": list(VOICES)},
        }

    def prepare(self, which: str) -> None:
        """Downloads (if needed) and loads a model in the background."""
        m = self.models[which]
        if m.state in ("ready", "downloading", "loading"):
            return
        m.task = asyncio.get_running_loop().create_task(self._prepare(which))

    async def _prepare(self, which: str) -> None:
        m = self.models[which]
        backend = self.backends[which]
        m.error = None
        try:
            if not m.downloaded():
                m.state = "downloading"
                m.folder.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(backend.download, m.folder)
            m.state = "loading"
            m.instance = await asyncio.to_thread(backend.load, m.folder)
            m.state = "ready"
        except Exception as e:  # noqa: BLE001 - reported to the browser, not raised
            m.state = "error"
            m.error = f"{type(e).__name__}: {e}"[:300]
            print(f"  Couldn't prepare {m.name}: {m.error}", flush=True)

    async def _ready(self, which: str) -> Any:
        m = self.models[which]
        if m.state == "ready":
            return m.instance
        if m.state != "error":
            self.prepare(which)
            # Already on disk: loading takes seconds, so wait for it rather than failing.
            if m.downloaded() and m.task:
                await asyncio.shield(m.task)
                if m.state == "ready":
                    return m.instance
        raise SpeechError("not_ready", f"{m.name} isn't ready yet ({m.state}).", 409)

    async def transcribe(self, pcm: bytes) -> str:
        import numpy as np

        if len(pcm) % 2:
            raise SpeechError("bad_audio", "Audio must be 16-bit PCM.")
        if len(pcm) > SAMPLE_RATE * 2 * MAX_SECONDS:
            raise SpeechError("too_long", f"Speak for at most {MAX_SECONDS} seconds at a time.", 413)
        if len(pcm) < SAMPLE_RATE // 5 * 2:
            return ""
        model = await self._ready("stt")
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        m = self.models["stt"]

        def run() -> str:
            with m.lock:
                return model.recognize(audio)

        return " ".join((await asyncio.to_thread(run)).split())

    async def speak(self, text: str, voice: str = DEFAULT_VOICE, speed: float = 1.0) -> bytes:
        text = " ".join(text.split())
        if not text:
            raise SpeechError("empty", "Nothing to say.")
        if len(text) > MAX_TTS_CHARS:
            raise SpeechError("too_long", "That's too much to say at once.", 413)
        if voice not in VOICES:
            voice = DEFAULT_VOICE
        speed = min(1.5, max(0.7, speed))
        model = await self._ready("tts")
        m = self.models["tts"]

        def run() -> bytes:
            with m.lock:
                samples, rate = model.create(text, voice, speed)
            return wav_bytes(samples, rate)

        return await asyncio.to_thread(run)
