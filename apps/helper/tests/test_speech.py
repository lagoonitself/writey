import struct
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from writey_helper.server import create_app
from writey_helper.speech import Backend, Speech
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
    def download(folder: Path) -> None:
        if fail:
            raise OSError("offline")
        folder.mkdir(parents=True, exist_ok=True)
        for name in ("config.json", "vocab.txt", "nemo128.onnx", "encoder-model.int8.onnx",
                     "decoder_joint-model.int8.onnx", "kokoro-v1.0.int8.onnx", "voices-v1.0.bin"):
            (folder / name).write_bytes(b"x")

    return {
        "stt": Backend(download, lambda _: FakeRecognizer()),
        "tts": Backend(download, lambda _: FakeSynth()),
    }


@pytest.fixture
def client(tmp_path: Path):
    app = create_app(
        store=Store(tmp_path),
        origins=frozenset({ORIGIN}),
        port=47823,
        speech=Speech(tmp_path, fake_backends()),
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
    speech = Speech(tmp_path, fake_backends())
    for m in speech.models.values():
        fake_backends()["stt"].download(m.folder)
    app = create_app(store=Store(tmp_path), origins=frozenset({ORIGIN}), port=47823, speech=speech)
    with TestClient(app, base_url="http://127.0.0.1:47823") as c:
        assert c.get("/voice/status", headers=AUTH).json()["stt"]["state"] == "downloaded"
        assert c.post("/stt", content=pcm(1), headers=AUTH).json()["text"] == "Writey, what's next?"


def test_failed_download_reports_an_error(tmp_path: Path) -> None:
    app = create_app(
        store=Store(tmp_path),
        origins=frozenset({ORIGIN}),
        port=47823,
        speech=Speech(tmp_path, fake_backends(fail=True)),
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
