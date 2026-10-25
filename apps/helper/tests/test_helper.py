import base64
import hashlib
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from writey_helper.chatgpt import (
    DYNAMIC_CLIENT,
    PLAN_SCOPE,
    SCOPES,
    ChatGPT,
    ChatGPTError,
    pkce_pair,
    sanitize_request,
)
from writey_helper.pairing import Pairing
from writey_helper.server import create_app
from writey_helper.store import Store

ORIGIN = "http://localhost:5173"
HOST = {"host": "127.0.0.1:47823"}


class FakeOpenAI:
    """Stands in for auth.openai.com and api.openai.com."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.token_responses: list[httpx.Response] = []

    def handler(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        path = req.url.path
        if path.endswith("/.well-known/openid-configuration"):
            return httpx.Response(200, json={"jwks_uri": "https://auth.openai.com/jwks", "revocation_endpoint": "https://auth.openai.com/revoke"})
        if path.endswith("/oauth/token"):
            return self.token_responses.pop(0)
        if path == "/revoke":
            return httpx.Response(200)
        if path == "/v1/models":
            return httpx.Response(200, json={"models": [{"slug": "gpt-6", "display_name": "GPT-6", "visibility": "list"}, {"slug": "hidden", "visibility": "hide"}]})
        if path == "/v1/responses":
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b"data: {}\n\n")
        return httpx.Response(404)

    def form(self, i: int) -> dict[str, str]:
        return {k: v[0] for k, v in parse_qs(self.requests[i].content.decode()).items()}


def tokens(scope: str = SCOPES, expires_in: int = 3600, refresh: str = "rt-1") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "access_token": "at-1",
            "refresh_token": refresh,
            "id_token": "idt",
            "expires_in": expires_in,
            "scope": scope,
            "token_type": "Bearer",
        },
    )


async def verify(id_token: str, client_id: str, nonce: str) -> dict:
    assert client_id.startswith("oaiapp_")
    return {"sub": "user-1", "email": "me@example.com", "nonce": nonce}


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(tmp_path)


@pytest.fixture
def openai() -> FakeOpenAI:
    return FakeOpenAI()


@pytest.fixture
def chatgpt(store: Store, openai: FakeOpenAI):
    opened: list[str] = []
    c = ChatGPT(
        store,
        httpx.AsyncClient(transport=httpx.MockTransport(openai.handler)),
        open_browser=lambda url: opened.append(url) or True,
        verify_id_token=verify,
    )
    c.opened = opened  # type: ignore[attr-defined]
    return c


def query(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


async def sign_in(c: ChatGPT, openai: FakeOpenAI, scope: str = SCOPES) -> dict[str, str]:
    await c.start_login()
    q = query(c.opened[-1])  # type: ignore[attr-defined]
    openai.token_responses.append(tokens(scope))
    ok, _ = await c.handle_callback({"state": q["state"], "code": "abc", "client_id": "oaiapp_123"})
    assert ok
    await c.close()
    return q


# --------------------------------------------------------------------- pieces


def test_pkce_challenge_is_s256_of_verifier() -> None:
    verifier, challenge = pkce_pair()
    digest = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=")
    assert challenge == digest.decode()


def test_sanitize_forces_plan_rules() -> None:
    clean = sanitize_request(
        {"model": "m", "input": [], "temperature": 0.2, "max_output_tokens": 9, "store": True, "stream": False}
    )
    assert clean == {"model": "m", "input": [], "store": False, "stream": True}
    with pytest.raises(ChatGPTError):
        sanitize_request({"model": "m"})


def test_pairing_codes_are_single_use_and_lock_after_failures(store: Store) -> None:
    p = Pairing(store)
    code = p.code
    token = p.pair(code, ORIGIN)
    assert token and p.check(token)
    assert p.pair(code, ORIGIN) is None  # used up
    for _ in range(5):
        p.pair("000000" if p.code != "000000" else "111111", ORIGIN)
    assert p.locked and p.pair(p.code, ORIGIN) is None
    assert "hash" in json.dumps(store.read("pairing")) and token not in json.dumps(store.read("pairing"))


# --------------------------------------------------------------------- sign-in


async def test_first_sign_in_registers_and_saves_tokens(chatgpt: ChatGPT, openai: FakeOpenAI, store: Store) -> None:
    q = await sign_in(chatgpt, openai)
    assert q["client_id"] == DYNAMIC_CLIENT
    assert q["agent_name_hint"] == "Writey"
    assert q["ext_agent_host_id"].startswith("urn:uuid:")
    assert q["scope"] == SCOPES and q["resource"] == "https://api.openai.com/v1"
    assert q["redirect_uri"].startswith("http://127.0.0.1:") and q["redirect_uri"].endswith("/auth/callback")
    assert "id_token_hint" not in q

    form = openai.form(0)
    assert form["grant_type"] == "authorization_code"
    assert form["client_id"] == "oaiapp_123"  # the issued id, never dynamic_agent_client
    assert form["redirect_uri"] == q["redirect_uri"]
    assert hashlib.sha256(form["code_verifier"].encode()).digest() == base64.urlsafe_b64decode(q["code_challenge"] + "==")

    record = store.read("chatgpt") or {}
    assert record["client_id"] == "oaiapp_123" and record["refresh_token"] == "rt-1"
    assert chatgpt.status() == {
        "signed_in": True,
        "email": "me@example.com",
        "plan_usage": True,
        "welcome": True,
        "login_pending": False,
        "error": None,
    }


async def test_reauth_reuses_the_issued_client_and_hints(chatgpt: ChatGPT, openai: FakeOpenAI) -> None:
    await sign_in(chatgpt, openai)
    await chatgpt.logout()
    await chatgpt.start_login()
    q = query(chatgpt.opened[-1])  # type: ignore[attr-defined]
    assert q["client_id"] == "oaiapp_123"
    assert "agent_name_hint" not in q
    assert q["login_hint"] == "me@example.com"
    assert "id_token_hint" not in q  # dropped at sign-out
    await chatgpt.close()


async def test_callback_rejects_wrong_state_and_handles_cancel(chatgpt: ChatGPT) -> None:
    await chatgpt.start_login()
    q = query(chatgpt.opened[-1])  # type: ignore[attr-defined]
    ok, _ = await chatgpt.handle_callback({"state": "forged", "code": "x", "client_id": "oaiapp_1"})
    assert not ok and chatgpt.pending is not None  # a forged callback doesn't cancel the real one
    ok, message = await chatgpt.handle_callback({"state": q["state"], "error": "access_denied"})
    assert not ok and "cancelled" in message
    assert chatgpt.status()["signed_in"] is False
    await chatgpt.close()


async def test_registration_without_issued_client_is_incomplete(chatgpt: ChatGPT) -> None:
    await chatgpt.start_login()
    q = query(chatgpt.opened[-1])  # type: ignore[attr-defined]
    ok, _ = await chatgpt.handle_callback({"state": q["state"], "code": "x", "client_id": DYNAMIC_CLIENT})
    assert not ok
    await chatgpt.close()


async def test_missing_plan_scope_keeps_sign_in_but_disables_usage(chatgpt: ChatGPT, openai: FakeOpenAI) -> None:
    await sign_in(chatgpt, openai, scope="openid profile email offline_access")
    s = chatgpt.status()
    assert s["signed_in"] and not s["plan_usage"] and "isn't enabled" in s["error"]
    with pytest.raises(ChatGPTError) as e:
        await chatgpt.access_token()
    assert e.value.code == "plan_usage_disabled"


async def test_callback_listener_serves_the_redirect(chatgpt: ChatGPT, openai: FakeOpenAI) -> None:
    await chatgpt.start_login()
    q = query(chatgpt.opened[-1])  # type: ignore[attr-defined]
    openai.token_responses.append(tokens())
    async with httpx.AsyncClient() as real:
        res = await real.get(q["redirect_uri"], params={"state": q["state"], "code": "abc", "client_id": "oaiapp_9"})
    assert res.status_code == 200 and "signed in" in res.text
    assert chatgpt.status()["signed_in"]


# --------------------------------------------------------------------- tokens


async def test_refresh_rotates_tokens_near_expiry(chatgpt: ChatGPT, openai: FakeOpenAI, store: Store) -> None:
    await sign_in(chatgpt, openai)
    record = store.read("chatgpt") or {}
    record["expires_at"] = time.time() + 30
    store.write("chatgpt", record)
    openai.token_responses.append(
        httpx.Response(200, json={"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 3600})
    )
    assert await chatgpt.access_token() == "at-2"
    form = openai.form(-1)
    assert form == {
        "grant_type": "refresh_token",
        "client_id": "oaiapp_123",
        "refresh_token": "rt-1",
        "resource": "https://api.openai.com/v1",
    }
    assert (store.read("chatgpt") or {})["refresh_token"] == "rt-2"


async def test_dead_refresh_token_signs_out(chatgpt: ChatGPT, openai: FakeOpenAI, store: Store) -> None:
    await sign_in(chatgpt, openai)
    record = store.read("chatgpt") or {}
    record["expires_at"] = 0
    store.write("chatgpt", record)
    openai.token_responses.append(httpx.Response(400, json={"error": "invalid_grant"}))
    with pytest.raises(ChatGPTError) as e:
        await chatgpt.access_token()
    assert e.value.code == "session_expired"
    assert chatgpt.status()["signed_in"] is False
    assert (store.read("chatgpt") or {})["client_id"] == "oaiapp_123"  # registration kept


async def test_logout_revokes_and_forget_deletes(chatgpt: ChatGPT, openai: FakeOpenAI, store: Store) -> None:
    await sign_in(chatgpt, openai)
    assert await chatgpt.logout() == {"revoked": True}
    revoke = next(r for r in openai.requests if r.url.path == "/revoke")
    assert parse_qs(revoke.content.decode())["token_type_hint"] == ["refresh_token"]
    record = store.read("chatgpt") or {}
    assert "refresh_token" not in record and "id_token" not in record and record["client_id"]
    await chatgpt.logout(forget=True)
    assert store.read("chatgpt") is None


# --------------------------------------------------------------------- server


@pytest.fixture
def server(store: Store, openai: FakeOpenAI):
    app = create_app(
        store=store,
        http=httpx.AsyncClient(transport=httpx.MockTransport(openai.handler)),
        open_browser=lambda url: True,
        origins=frozenset({ORIGIN}),
        port=47823,
    )
    with TestClient(app, base_url="http://127.0.0.1:47823") as client:
        yield client, app.state.pairing  # type: ignore[attr-defined]


def test_server_guards_host_origin_and_pairing(server) -> None:
    client, pairing = server
    assert client.get("/health", headers={"host": "evil.example:47823"}).status_code == 403
    assert client.get("/health", headers=HOST).json()["paired"] is False

    pre = client.options("/chatgpt/status", headers={**HOST, "origin": ORIGIN})
    assert pre.status_code == 204
    assert pre.headers["access-control-allow-private-network"] == "true"
    assert pre.headers["access-control-allow-origin"] == ORIGIN
    assert client.options("/pair", headers={**HOST, "origin": "https://evil.example"}).status_code == 403

    assert client.post("/pair", json={"code": "nope"}, headers={**HOST, "origin": ORIGIN}).status_code == 400
    assert client.post("/pair", json={"code": pairing.code}, headers={**HOST, "origin": "https://evil.example"}).status_code == 403
    assert client.get("/chatgpt/status", headers={**HOST, "origin": ORIGIN}).json() == {"error": "not_paired"}

    token = client.post("/pair", json={"code": pairing.code}, headers={**HOST, "origin": ORIGIN}).json()["token"]
    auth = {**HOST, "origin": ORIGIN, "authorization": f"Bearer {token}"}
    status = client.get("/chatgpt/status", headers=auth)
    assert status.status_code == 200 and status.json()["signed_in"] is False
    assert status.headers["access-control-allow-origin"] == ORIGIN
    res = client.post("/chatgpt/responses", json={"model": "m", "input": []}, headers=auth)
    assert res.status_code == 401 and res.json()["error"] == "signed_out"


async def test_responses_proxy_streams_with_plan_rules(chatgpt: ChatGPT, openai: FakeOpenAI) -> None:
    await sign_in(chatgpt, openai)
    res = await chatgpt.open_responses({"model": "gpt-6", "input": [], "temperature": 1})
    body = await res.aread()
    await res.aclose()
    assert body == b"data: {}\n\n"
    sent = next(r for r in openai.requests if r.url.path == "/v1/responses")
    assert sent.headers["authorization"] == "Bearer at-1"
    assert json.loads(sent.content) == {"model": "gpt-6", "input": [], "store": False, "stream": True}
    assert [m["slug"] for m in await chatgpt.models()] == ["gpt-6"]
    assert PLAN_SCOPE in SCOPES
