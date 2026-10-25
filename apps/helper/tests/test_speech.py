import struct
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from writey_helper.server import create_app
from writey_helper.speech import KOKORO_FILES, PARAKEET_FILES, Backend, Speech
from writey_helper.store import Store

ORIGIN = "http://localhost:5173"
AUTH = {"host": "127.0.0.1:47823", "origin": ORIGIN}


class FakeRecognizer:
    def __init__(self) -> None:
        self.heard: list[int] = []

    def recognize(self, audio: np.ndarray) -> str:
        assert audio.dtype == np.float32 and abs(float(audio.max())) <= 1
        self.heard.append(len(audio))
        return " Writey, what's next? "


class FakeSynth:
    def create(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        return np.zeros(2400, dtype=np.float32), 24000


def fake_backends(fail: bool = False) -> dict[str, Backend]:
    def download(folder: Path, device: str) -> None:
        if fail:
            raise OSError("offline")
        folder.mkdir(parents=True, exist_ok=True)
        for files in (PARAKEET_FILES[device], KOKORO_FILES[device]):
            for name in files:
                (folder / name).write_bytes(b"x")

    return {
        "stt": Backend(download, lambda _, device: (FakeRecognizer(), device)),
        "tts": Backend(download, lambda _, device: (FakeSynth(), device)),
    }


@pytest.fixture
def client(tmp_path: Path):
    app = create_app(
        store=Store(tmp_path),
        origins=frozenset({ORIGIN}),
        port=47823,
        speech=Speech(tmp_path, fake_backends(), device="cpu"),
    )
    with TestClient(app, base_url="http://127.0.0.1:47823") as c:
        yield c


def wait_ready(client: TestClient) -> dict:
    for _ in range(100):
        status = client.get("/voice/status", headers=AUTH).json()
        if status["stt"]["state"] == "ready" and status["tts"]["state"] == "ready":
            return status
        time.sleep(0.02)
    raise AssertionError(status)


def pcm(seconds: float) -> bytes:
    n = int(16000 * seconds)
    return struct.pack(f"<{n}h", *([1000, -1000] * (n // 2)))


def test_voice_needs_writey_origin(client: TestClient) -> None:
    assert client.get("/voice/status", headers={"host": AUTH["host"]}).status_code == 403
    assert client.post("/stt", content=pcm(1), headers={"host": AUTH["host"]}).status_code == 403


def test_models_download_then_transcribe_and_speak(client: TestClient) -> None:
    status = client.get("/voice/status", headers=AUTH).json()
    assert status["stt"]["state"] == "missing" and status["tts"]["state"] == "missing"
    assert "af_heart" in status["tts"]["voices"]
    client.post("/voice/prepare", json={}, headers=AUTH)
    wait_ready(client)

    res = client.post("/stt", content=pcm(1.5), headers={**AUTH, "content-type": "application/octet-stream"})
    assert res.status_code == 200 and res.json() == {"text": "Writey, what's next?"}
    # Too short to be speech: no model call.
    assert client.post("/stt", content=pcm(0.05), headers=AUTH).json() == {"text": ""}
    assert client.post("/stt", content=pcm(31), headers=AUTH).status_code == 413
    assert client.post("/stt", content=b"\x00\x01\x02", headers=AUTH).status_code == 400

    res = client.post("/tts", json={"text": "  Hello   there. ", "voice": "nope"}, headers=AUTH)
    assert res.status_code == 200 and res.headers["content-type"] == "audio/wav"
    assert res.content[:4] == b"RIFF" and res.content[8:12] == b"WAVE"
    assert client.post("/tts", json={"text": " "}, headers=AUTH).status_code == 400
    assert client.post("/tts", json={"text": "x" * 900}, headers=AUTH).status_code == 413


def test_downloaded_models_load_on_first_use(tmp_path: Path) -> None:
    speech = Speech(tmp_path, fake_backends(), device="cpu")
    for m in speech.models.values():
        fake_backends()["stt"].download(m.folder, "cpu")
    app = create_app(store=Store(tmp_path), origins=frozenset({ORIGIN}), port=47823, speech=speech)
    with TestClient(app, base_url="http://127.0.0.1:47823") as c:
        assert c.get("/voice/status", headers=AUTH).json()["stt"]["state"] == "downloaded"
        assert c.post("/stt", content=pcm(1), headers=AUTH).json()["text"] == "Writey, what's next?"


def test_failed_download_reports_an_error(tmp_path: Path) -> None:
    app = create_app(
        store=Store(tmp_path),
        origins=frozenset({ORIGIN}),
        port=47823,
        speech=Speech(tmp_path, fake_backends(fail=True), device="cpu"),
    )
    with TestClient(app, base_url="http://127.0.0.1:47823") as c:
        c.post("/voice/prepare", json={"tts": False}, headers=AUTH)
        for _ in range(100):
            stt = c.get("/voice/status", headers=AUTH).json()["stt"]
            if stt["state"] == "error":
                break
            time.sleep(0.02)
        assert stt["state"] == "error" and "offline" in stt["error"]
        res = c.post("/stt", content=pcm(1), headers=AUTH)
        assert res.status_code == 409 and res.json()["error"] == "not_ready"


def test_gpu_keeps_speech_to_text_small(tmp_path: Path) -> None:
    stale = tmp_path / "models" / "parakeet-tdt-0.6b-v2" / "encoder-model.onnx.data"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"x")
    speech = Speech(tmp_path, fake_backends(), device="cuda")
    assert not stale.exists()
    assert "encoder-model.int8.onnx" in speech.models["stt"].files
    assert "kokoro-v1.0.onnx" in speech.models["tts"].files
    app = create_app(store=Store(tmp_path), origins=frozenset({ORIGIN}), port=47823, speech=speech)
    with TestClient(app, base_url="http://127.0.0.1:47823") as c:
        assert c.get("/voice/status", headers=AUTH).json()["device"] == "cuda"
        c.post("/voice/prepare", json={}, headers=AUTH)
        status = wait_ready(c)
        assert status["stt"]["device"] == "cuda" and status["tts"]["device"] == "cuda"
