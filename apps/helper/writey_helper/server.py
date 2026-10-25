"""
Writey Helper: a small local server on 127.0.0.1 for things the website can't do itself.
Today that's Sign in with ChatGPT; Parakeet STT and Fish TTS join it in Phase 4
(docs/ARCHITECTURE.md §7.3).
"""

import html
import sys
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__
from .chatgpt import ChatGPT, ChatGPTError
from .config import HOST, ORIGINS, PORT, data_dir
from .pairing import Pairing
from .store import Store


class Guard:
    """
    Every request must name this machine as its Host (stops DNS rebinding), and browsers
    may read responses only from Writey's own origins. Preflights allow Chrome's
    private network access to 127.0.0.1.
    """

    def __init__(self, app: ASGIApp, origins: frozenset[str], port: int) -> None:
        self.app = app
        self.origins = origins
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
        if headers.get("host") not in self.hosts:
            await JSONResponse({"error": "bad_host"}, status_code=403)(scope, receive, send)
            return
        origin = headers.get("origin")
        allowed = origin in self.origins
        cors = (
            [
                (b"access-control-allow-origin", origin.encode()),
                (b"vary", b"Origin"),
            ]
            if allowed and origin
            else []
        )
        if scope["method"] == "OPTIONS":
            if not allowed:
                await JSONResponse({"error": "bad_origin"}, status_code=403)(scope, receive, send)
                return
            await send(
                {
                    "type": "http.response.start",
                    "status": 204,
                    "headers": [
                        *cors,
                        (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
                        (b"access-control-allow-headers", b"authorization, content-type"),
                        (b"access-control-allow-private-network", b"true"),
                        (b"access-control-max-age", b"600"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start" and cors:
                message["headers"] = [*message.get("headers", []), *cors]
            await send(message)

        await self.app(scope, receive, send_with_cors)


def create_app(
    store: Store | None = None,
    http: httpx.AsyncClient | None = None,
    open_browser: Callable[[str], bool] | None = None,
    origins: frozenset[str] = ORIGINS,
    port: int = PORT,
) -> FastAPI:
    store = store or Store(data_dir())
    client = http or httpx.AsyncClient(timeout=30)
    pairing = Pairing(store)
    chatgpt = ChatGPT(store, client, **({"open_browser": open_browser} if open_browser else {}))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await chatgpt.close()
        await client.aclose()

    app = FastAPI(title="Writey Helper", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.pairing = pairing
    app.state.chatgpt = chatgpt

    @app.exception_handler(ChatGPTError)
    async def chatgpt_error(_: Request, e: ChatGPTError) -> JSONResponse:
        return JSONResponse({"error": e.code, "message": e.message}, status_code=e.status)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, e: HTTPException) -> JSONResponse:
        return JSONResponse({"error": e.detail}, status_code=e.status_code)

    def paired(request: Request) -> None:
        if request.headers.get("origin") not in origins:
            raise HTTPException(403, "bad_origin")
        auth = request.headers.get("authorization", "")
        if not pairing.check(auth.removeprefix("Bearer ").strip()):
            raise HTTPException(401, "not_paired")

    @app.get("/", response_class=HTMLResponse)
    async def home() -> str:
        # Readable only on this machine: the Host check blocks rebinding and other sites
        # can't read cross-origin responses.
        code = " ".join([pairing.code[:3], pairing.code[3:]])
        return (
            "<!doctype html><meta charset=utf-8><title>Writey Helper</title>"
            "<body style='font:16px system-ui;display:grid;place-items:center;height:100vh;"
            "margin:0;background:#e8ebf4;text-align:center'><div><h1>Writey Helper is running</h1>"
            f"<p>Pairing code</p><p style='font-size:40px;font-weight:700;letter-spacing:.1em'>"
            f"{html.escape(code)}</p><p>Type it into Writey → Settings → ChatGPT.</p></div></body>"
        )

    @app.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        auth = request.headers.get("authorization", "")
        return {
            "ok": True,
            "service": "writey-helper",
            "version": __version__,
            "paired": pairing.check(auth.removeprefix("Bearer ").strip()),
        }

    @app.post("/pair")
    async def pair(request: Request) -> dict[str, str]:
        origin = request.headers.get("origin", "")
        if origin not in origins:
            raise HTTPException(403, "bad_origin")
        body = await request.json()
        token = pairing.pair(str(body.get("code", "")), origin)
        if not token:
            raise HTTPException(429 if pairing.locked else 400, "locked" if pairing.locked else "bad_code")
        print("Paired with", origin)
        return {"token": token}

    @app.get("/chatgpt/status", dependencies=[Depends(paired)])
    async def chatgpt_status() -> dict[str, Any]:
        return chatgpt.status()

    @app.post("/chatgpt/login", dependencies=[Depends(paired)])
    async def chatgpt_login() -> dict[str, bool]:
        await chatgpt.start_login()
        return {"started": True}

    @app.post("/chatgpt/welcomed", dependencies=[Depends(paired)])
    async def chatgpt_welcomed() -> dict[str, bool]:
        chatgpt.mark_welcomed()
        return {"ok": True}

    @app.post("/chatgpt/logout", dependencies=[Depends(paired)])
    async def chatgpt_logout(request: Request) -> dict[str, Any]:
        body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
        return await chatgpt.logout(forget=bool(body.get("forget")))

    @app.get("/chatgpt/models", dependencies=[Depends(paired)])
    async def chatgpt_models() -> dict[str, Any]:
        return {"models": await chatgpt.models()}

    @app.post("/chatgpt/responses", dependencies=[Depends(paired)])
    async def chatgpt_responses(request: Request) -> StreamingResponse:
        upstream = await chatgpt.open_responses(await request.json())
        return StreamingResponse(
            upstream.aiter_raw(),
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "text/event-stream"),
            headers={"Cache-Control": "no-store"},
            background=BackgroundTask(upstream.aclose),
        )

    guarded = Guard(app, origins, port)
    guarded.state = app.state  # type: ignore[attr-defined]
    return guarded  # type: ignore[return-value]


def main() -> None:
    # Windows consoles often use a legacy code page; never crash on a character.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    app = create_app()
    code = app.state.pairing.code  # type: ignore[attr-defined]
    print(
        f"\n  Writey Helper {__version__} is running on http://{HOST}:{PORT}\n"
        f"  Pairing code: {code[:3]} {code[3:]}\n"
        "  In Writey, open Settings > ChatGPT and type this code once.\n"
        "  Leave this window open while you use Writey. Ctrl+C to stop.\n",
        flush=True,
    )
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
