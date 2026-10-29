"""
Sign in with ChatGPT for open-source, locally run apps, and the Responses proxy that uses
the plan. Follows https://developers.openai.com/siwc/token-sharing-open-source: dynamic
client registration, a loopback callback on 127.0.0.1, PKCE + state + nonce, tokens kept
only on this computer. HANDOFF D15.
"""

import asyncio
import base64
import hashlib
import hmac
import html
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
import jwt

from .store import Store

ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = f"{ISSUER}/api/accounts/authorize"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
DISCOVERY_URL = f"{ISSUER}/.well-known/openid-configuration"
RESOURCE = "https://api.openai.com/v1"
API = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
DYNAMIC_CLIENT = "dynamic_agent_client"
AGENT_NAME = "Writey"
CALLBACK_PATH = "/auth/callback"
CALLBACK_PORT = 1455
LOGIN_TIMEOUT_S = 300
REFRESH_MARGIN_S = 60

# Rejected by plan usage (preview limitations), so stripped before forwarding.
FORBIDDEN_PARAMS = frozenset(
    {
        "background",
        "conversation",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
        "previous_response_id",
    }
)

# Refresh failures that mean the session is gone and the user must sign in again.
TERMINAL_REFRESH_ERRORS = frozenset(
    {
        "invalid_grant",
        "invalid_refresh_token",
        "token_expired",
        "refresh_token_expired",
        "refresh_token_invalidated",
        "refresh_token_reused",
    }
)

RECORD = "chatgpt"


class ChatGPTError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def pkce_pair() -> tuple[str, str]:
    verifier = b64url(secrets.token_bytes(32))
    return verifier, b64url(hashlib.sha256(verifier.encode()).digest())


@dataclass
class PendingLogin:
    state: str
    nonce: str
    verifier: str
    redirect_uri: str
    #: dynamic_agent_client for a first registration, else the issued client id.
    client_id: str
    registering: bool
    #: Where the browser goes once sign-in finishes (a Writey page), or None.
    return_to: str | None = None
    #: "Use another account": replace the saved account only once the new sign-in works.
    switching: bool = False
    started: float = field(default_factory=time.time)

    @property
    def expired(self) -> bool:
        return time.time() - self.started > LOGIN_TIMEOUT_S


def authorize_url(
    p: PendingLogin,
    *,
    host_id: str,
    challenge: str,
    id_token_hint: str | None = None,
    login_hint: str | None = None,
) -> str:
    q = {
        "response_type": "code",
        "client_id": p.client_id,
        "redirect_uri": p.redirect_uri,
        "scope": SCOPES,
        "resource": RESOURCE,
        "state": p.state,
        "nonce": p.nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "ext_agent_host_id": host_id,
    }
    if p.registering:
        q["agent_name_hint"] = AGENT_NAME
    else:
        if id_token_hint:
            q["id_token_hint"] = id_token_hint
        if login_hint:
            q["login_hint"] = login_hint
    return f"{AUTHORIZE_URL}?{urlencode(q)}"


def sanitize_request(body: Any) -> dict[str, Any]:
    """Plan usage needs store=false, stream=true and full history in `input`."""
    if not isinstance(body, dict):
        raise ChatGPTError("bad_request", "The request must be a JSON object.")
    clean = {k: v for k, v in body.items() if k not in FORBIDDEN_PARAMS}
    if not isinstance(clean.get("model"), str) or not isinstance(clean.get("input"), list):
        raise ChatGPTError("bad_request", "The request needs a model and an input list.")
    clean["store"] = False
    clean["stream"] = True
    return clean


def back_to_writey(return_to: str, ok: bool, message: str) -> str:
    """The Writey page to land on, with the outcome in its query string."""
    u = urlsplit(return_to)
    q = [(k, v) for k, v in parse_qsl(u.query) if k not in ("chatgpt", "chatgpt_error")]
    q.append(("chatgpt", "connected" if ok else "error"))
    if not ok:
        q.append(("chatgpt_error", message))
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), ""))


def callback_page(message: str, ok: bool) -> str:
    color = "#0f9d6b" if ok else "#e0263f"
    return (
        "<!doctype html><meta charset=utf-8><title>Writey</title>"
        "<body style='font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;"
        f"background:#e8ebf4'><p style='max-width:28em;text-align:center;color:{color}'>"
        f"{html.escape(message)}</p></body>"
    )


VerifyIdToken = Callable[[str, str, str], Awaitable[dict[str, Any]]]


class ChatGPT:
    def __init__(
        self,
        store: Store,
        http: httpx.AsyncClient,
        verify_id_token: VerifyIdToken | None = None,
    ) -> None:
        self.store = store
        self.http = http
        self.pending: PendingLogin | None = None
        self.last_error: str | None = None
        self._server: asyncio.Server | None = None
        self._refresh_lock = asyncio.Lock()
        self._discovery: dict[str, Any] | None = None
        self._jwks: jwt.PyJWKClient | None = None
        self._verify = verify_id_token or self._verify_id_token

    # ------------------------------------------------------------------ state

    def _record(self) -> dict[str, Any]:
        return self.store.read(RECORD) or {}

    def status(self) -> dict[str, Any]:
        r = self._record()
        signed_in = bool(r.get("refresh_token") or r.get("access_token"))
        return {
            "signed_in": signed_in,
            "email": r.get("email") if signed_in else None,
            "plan_usage": signed_in and PLAN_SCOPE in (r.get("scopes") or []),
            "welcome": signed_in and not r.get("welcomed"),
            "login_pending": bool(self.pending and not self.pending.expired),
            "error": self.last_error,
        }

    def mark_welcomed(self) -> None:
        r = self._record()
        if r:
            r["welcomed"] = True
            self.store.write(RECORD, r)

    # ------------------------------------------------------------------ sign-in

    async def start_login(self, return_to: str | None = None, switching: bool = False) -> str:
        """Gets ready for OpenAI's callback and returns the URL to send the browser to."""
        await self.close()
        r = self._record()
        # Another account registers afresh, so the old client id and hints don't apply.
        registering = switching or not r.get("client_id")
        verifier, challenge = pkce_pair()
        port = await self._listen()
        self.pending = PendingLogin(
            state=b64url(secrets.token_bytes(24)),
            nonce=b64url(secrets.token_bytes(24)),
            verifier=verifier,
            redirect_uri=f"http://127.0.0.1:{port}{CALLBACK_PATH}",
            client_id=DYNAMIC_CLIENT if registering else r["client_id"],
            registering=registering,
            return_to=return_to,
            switching=switching,
        )
        self.last_error = None
        # The URL can carry an ID token hint, so it goes straight to the browser, never to logs.
        return authorize_url(
            self.pending,
            host_id=self.store.host_id(),
            challenge=challenge,
            id_token_hint=None if registering else r.get("id_token"),
            login_hint=None if registering else r.get("email"),
        )

    async def _listen(self) -> int:
        # 1455 is OpenAI's example port; later sign-ins may use any free port.
        last: OSError | None = None
        for port in (CALLBACK_PORT, 0):
            try:
                self._server = await asyncio.start_server(self._on_connection, "127.0.0.1", port)
                return self._server.sockets[0].getsockname()[1]
            except OSError as e:
                last = e
        raise ChatGPTError("no_port", f"Couldn't listen for the sign-in callback: {last}", 500)

    async def close(self) -> None:
        if self._server:
            self._server.close()
            self._server = None

    async def _on_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = await asyncio.wait_for(reader.readline(), 10)
            while (await asyncio.wait_for(reader.readline(), 10)) not in (b"\r\n", b"\n", b""):
                pass
            parts = line.decode("latin-1").split(" ")
            url = urlsplit(parts[1] if len(parts) > 1 else "/")
            location = None
            if url.path != CALLBACK_PATH:
                status, ok, message = "404 Not Found", False, "Not found."
            else:
                return_to = self.pending.return_to if self.pending else None
                ok, message = await self.handle_callback(dict(parse_qsl(url.query)))
                status = "200 OK" if ok else "400 Bad Request"
                if return_to:
                    # Straight back to the Writey page the sign-in started from.
                    status, location = "303 See Other", back_to_writey(return_to, ok, message)
            body = callback_page(message, ok).encode()
            extra = f"Location: {location}\r\n" if location else ""
            writer.write(
                f"HTTP/1.1 {status}\r\n{extra}Content-Type: text/html; charset=utf-8\r\n"
                f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                "Connection: close\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        except (TimeoutError, ConnectionError):
            pass
        finally:
            writer.close()
        if self.pending is None:
            await self.close()

    async def handle_callback(self, params: dict[str, str]) -> tuple[bool, str]:
        p = self.pending
        if not p or p.expired:
            return False, "No Writey sign-in is waiting. Start again from Writey."
        if not hmac.compare_digest(params.get("state", ""), p.state):
            return False, "This sign-in link doesn't match. Start again from Writey."
        self.pending = None
        if params.get("error"):
            self.last_error = (
                "You cancelled the ChatGPT sign-in."
                if params["error"] == "access_denied"
                else f"ChatGPT sign-in failed: {params.get('error_description') or params['error']}"
            )
            return False, self.last_error
        issued = params.get("client_id")
        if p.registering:
            if not issued or issued == DYNAMIC_CLIENT:
                return self._fail("ChatGPT didn't finish registering Writey. Try again.")
        else:
            if issued and issued != p.client_id:
                return self._fail("ChatGPT returned a different app id. Try again.")
            issued = p.client_id
        code = params.get("code")
        if not code:
            return self._fail("ChatGPT didn't send a sign-in code. Try again.")

        try:
            tokens = await self._token_request(
                {
                    "grant_type": "authorization_code",
                    "client_id": issued,
                    "code": code,
                    "code_verifier": p.verifier,
                    "redirect_uri": p.redirect_uri,
                    "resource": RESOURCE,
                }
            )
            claims = await self._verify(str(tokens.get("id_token", "")), issued, p.nonce)
        except ChatGPTError as e:
            return self._fail(e.message)

        prev = self._record()
        if p.switching:
            await self._revoke(prev)
        elif not p.registering and prev.get("subject") and claims["sub"] != prev["subject"]:
            return self._fail(
                "That's a different ChatGPT account. In Writey, choose “Use another account”, "
                "then sign in again."
            )
        scopes = str(tokens.get("scope", "")).split()
        self.store.write(
            RECORD,
            {
                "client_id": issued,
                "subject": claims["sub"],
                "email": claims.get("email"),
                "issuer": ISSUER,
                "ext_agent_host_id": self.store.host_id(),
                "id_token": tokens.get("id_token"),
                "access_token": tokens.get("access_token"),
                "refresh_token": tokens.get("refresh_token"),
                "token_type": tokens.get("token_type", "Bearer"),
                "expires_at": time.time() + float(tokens.get("expires_in", 3600)),
                "scopes": scopes,
                "saved_at": int(time.time()),
                "welcomed": bool(prev.get("welcomed")) and prev.get("subject") == claims["sub"],
            },
        )
        if PLAN_SCOPE not in scopes:
            self.last_error = (
                "ChatGPT plan usage isn't enabled for Writey. Sign in again and allow 'Use your ChatGPT plan', "
                "or use an OpenRouter or OpenCode Zen key."
            )
        return True, "You're signed in to ChatGPT. You can close this tab and go back to Writey."

    def _fail(self, message: str) -> tuple[bool, str]:
        self.last_error = message
        return False, message

    async def _token_request(self, data: dict[str, str]) -> dict[str, Any]:
        try:
            res = await self.http.post(TOKEN_URL, data=data)
        except httpx.HTTPError as e:
            raise ChatGPTError("network", f"Couldn't reach OpenAI: {e}", 503) from e
        try:
            body = res.json()
        except ValueError:
            body = {}
        if res.status_code != 200:
            err = body.get("error") if isinstance(body, dict) else None
            code = err if isinstance(err, str) else (err or {}).get("code", "token_error")
            desc = body.get("error_description") if isinstance(body, dict) else None
            raise ChatGPTError(str(code), f"OpenAI refused the sign-in ({desc or code}).", res.status_code)
        return body

    async def _discover(self) -> dict[str, Any]:
        if self._discovery is None:
            res = await self.http.get(DISCOVERY_URL)
            res.raise_for_status()
            self._discovery = res.json()
        return self._discovery

    async def _verify_id_token(self, id_token: str, client_id: str, nonce: str) -> dict[str, Any]:
        try:
            if self._jwks is None:
                self._jwks = jwt.PyJWKClient((await self._discover())["jwks_uri"])
            key = await asyncio.to_thread(self._jwks.get_signing_key_from_jwt, id_token)
            claims = jwt.decode(
                id_token,
                key.key,
                algorithms=["RS256", "ES256", "PS256"],
                audience=client_id,
                issuer=ISSUER,
                leeway=60,
            )
        except (jwt.PyJWTError, httpx.HTTPError, KeyError) as e:
            raise ChatGPTError("bad_id_token", f"ChatGPT's sign-in couldn't be verified ({e}).") from e
        if not hmac.compare_digest(str(claims.get("nonce", "")), nonce) or not isinstance(
            claims.get("sub"), str
        ):
            raise ChatGPTError("bad_id_token", "ChatGPT's sign-in couldn't be verified.")
        return claims

    # ------------------------------------------------------------------ tokens

    async def access_token(self, force: bool = False) -> str:
        # Refresh tokens rotate, so refreshes are serialized.
        async with self._refresh_lock:
            r = self._record()
            if not r.get("refresh_token") and not r.get("access_token"):
                raise ChatGPTError("signed_out", "Sign in to ChatGPT first.", 401)
            if PLAN_SCOPE not in (r.get("scopes") or []):
                raise ChatGPTError(
                    "plan_usage_disabled",
                    "ChatGPT plan usage isn't enabled for Writey. Sign in again and allow 'Use your ChatGPT plan'.",
                    403,
                )
            fresh = float(r.get("expires_at", 0)) - time.time() > REFRESH_MARGIN_S
            if fresh and r.get("access_token") and not force:
                return str(r["access_token"])
            if not r.get("refresh_token"):
                raise ChatGPTError("session_expired", "Your ChatGPT sign-in ended. Sign in again.", 401)
            return await self._refresh(r)

    async def _refresh(self, r: dict[str, Any]) -> str:
        try:
            tokens = await self._token_request(
                {
                    "grant_type": "refresh_token",
                    "client_id": r["client_id"],
                    "refresh_token": r["refresh_token"],
                    "resource": RESOURCE,
                }
            )
        except ChatGPTError as e:
            if e.code in TERMINAL_REFRESH_ERRORS or e.status == 401:
                for k in ("access_token", "refresh_token", "expires_at"):
                    r.pop(k, None)
                self.store.write(RECORD, r)
                raise ChatGPTError(
                    "session_expired", "Your ChatGPT sign-in ended. Sign in again.", 401
                ) from e
            raise
        r["access_token"] = tokens["access_token"]
        r["refresh_token"] = tokens.get("refresh_token", r["refresh_token"])
        r["expires_at"] = time.time() + float(tokens.get("expires_in", 3600))
        if tokens.get("scope"):
            r["scopes"] = str(tokens["scope"]).split()
        r["saved_at"] = int(time.time())
        self.store.write(RECORD, r)
        return str(r["access_token"])

    async def _revoke(self, r: dict[str, Any]) -> bool | None:
        if not r.get("refresh_token"):
            return None
        try:
            endpoint = (await self._discover())["revocation_endpoint"]
            res = await self.http.post(
                endpoint,
                data={
                    "token": r["refresh_token"],
                    "token_type_hint": "refresh_token",
                    "client_id": r["client_id"],
                },
            )
            return res.status_code == 200
        except (httpx.HTTPError, KeyError):
            return False

    async def logout(self, forget: bool = False) -> dict[str, Any]:
        r = self._record()
        revoked = await self._revoke(r)
        if forget:
            self.store.delete(RECORD)
        elif r:
            # Keep the registration so the next sign-in reuses this client id.
            keep = ("client_id", "subject", "email", "issuer", "ext_agent_host_id", "welcomed")
            self.store.write(RECORD, {k: r[k] for k in keep if k in r})
        self.last_error = None
        return {"revoked": revoked}

    # ------------------------------------------------------------------ API

    async def _authed(self, method: str, url: str, **kw: Any) -> httpx.Response:
        """Sends with the access token; one 401 triggers a forced refresh and a retry."""
        extra = kw.pop("headers", {})
        for attempt in (0, 1):
            token = await self.access_token(force=attempt == 1)
            headers = {**extra, "Authorization": f"Bearer {token}"}
            req = self.http.build_request(method, url, headers=headers, **kw)
            res = await self.http.send(req, stream=True)
            if res.status_code == 401 and attempt == 0:
                await res.aclose()
                continue
            return res
        raise AssertionError("unreachable")

    async def models(self) -> list[dict[str, Any]]:
        res = await self._authed("GET", f"{API}/models")
        try:
            await res.aread()
            if res.status_code != 200:
                raise ChatGPTError("models_failed", f"Couldn't list ChatGPT models ({res.status_code}).", 502)
            data = res.json()
        finally:
            await res.aclose()
        items = data.get("models") or data.get("data") or []
        return [m for m in items if isinstance(m, dict) and m.get("visibility", "list") == "list"]

    async def open_responses(self, body: Any) -> httpx.Response:
        """Starts a streamed Responses call. The caller must close the returned response."""
        clean = sanitize_request(body)
        return await self._authed(
            "POST",
            f"{API}/responses",
            json=clean,
            headers={"Accept": "text/event-stream"},
            timeout=httpx.Timeout(30, read=300),
        )
