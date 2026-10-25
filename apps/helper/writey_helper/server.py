"""
Writey Helper: a small local server on 127.0.0.1 for things the website can't do itself.
Today that's Sign in with ChatGPT; Parakeet STT and Fish TTS join it in Phase 4
(docs/ARCHITECTURE.md §7.3).
"""

import sys
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from starlette.background import BackgroundTask
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import API, __version__
from .chatgpt import ChatGPT, ChatGPTError, callback_page
from .config import HOST, ORIGINS, PORT, data_dir
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
                        (b"access-control-allow-headers", b"content-type"),
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
    origins: frozenset[str] = ORIGINS,
    port: int = PORT,
) -> FastAPI:
    store = store or Store(data_dir())
    client = http or httpx.AsyncClient(timeout=30)
    chatgpt = ChatGPT(store, client)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await chatgpt.close()
        await client.aclose()

    app = FastAPI(title="Writey Helper", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.chatgpt = chatgpt

    @app.exception_handler(ChatGPTError)
    async def chatgpt_error(_: Request, e: ChatGPTError) -> JSONResponse:
        return JSONResponse({"error": e.code, "message": e.message}, status_code=e.status)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, e: HTTPException) -> JSONResponse:
        return JSONResponse({"error": e.detail}, status_code=e.status_code)

    def writey(request: Request) -> None:
        # Browsers always send Origin on these cross-origin calls, so only Writey's pages
        # get through. Other programs on this computer could already read the token file.
        if request.headers.get("origin") not in origins:
            raise HTTPException(403, "bad_origin")

    def writey_page(url: str) -> bool:
        u = urlsplit(url)
        return f"{u.scheme}://{u.netloc}" in origins and not u.username and not u.password

    @app.get("/", response_class=HTMLResponse)
    async def home() -> str:
        return callback_page("Writey Helper is running. Go back to Writey to use ChatGPT.", True)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "writey-helper", "version": __version__, "api": API}

    @app.get("/chatgpt/connect")
    async def chatgpt_connect(return_to: str, switch: bool = False) -> RedirectResponse:
        # A plain link from Writey: off to OpenAI, and the callback brings you back.
        if not writey_page(return_to):
            raise HTTPException(400, "bad_return")
        url = await chatgpt.start_login(return_to=return_to, switching=switch)
        return RedirectResponse(url, status_code=303, headers={"Cache-Control": "no-store"})

    @app.get("/chatgpt/status", dependencies=[Depends(writey)])
    async def chatgpt_status() -> dict[str, Any]:
        return chatgpt.status()

    @app.post("/chatgpt/welcomed", dependencies=[Depends(writey)])
    async def chatgpt_welcomed() -> dict[str, bool]:
        chatgpt.mark_welcomed()
        return {"ok": True}

    @app.post("/chatgpt/logout", dependencies=[Depends(writey)])
    async def chatgpt_logout(request: Request) -> dict[str, Any]:
        body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
        return await chatgpt.logout(forget=bool(body.get("forget")))

    @app.get("/chatgpt/models", dependencies=[Depends(writey)])
    async def chatgpt_models() -> dict[str, Any]:
        return {"models": await chatgpt.models()}

    @app.post("/chatgpt/responses", dependencies=[Depends(writey)])
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


def serve() -> None:
    if sys.stdout is None:
        # Started hidden at sign-in (pythonw): keep a log in the data folder instead.
        folder = data_dir()
        folder.mkdir(parents=True, exist_ok=True)
        log = open(folder / "helper.log", "a", encoding="utf-8", errors="replace", buffering=1)  # noqa: SIM115
        sys.stdout = sys.stderr = log
    # Windows consoles often use a legacy code page; never crash on a character.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    print(
        f"\n  Writey Helper {__version__} is running on http://{HOST}:{PORT}\n"
        "  In Writey, open Settings and click Continue with ChatGPT.\n"
        "  Leave this running while you use Writey. Ctrl+C to stop.\n",
        flush=True,
    )
    uvicorn.run(create_app(), host=HOST, port=PORT, log_level="warning")


def main() -> None:
    from . import autostart

    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "install":
        autostart.install()
    elif command == "uninstall":
        autostart.uninstall()
    elif command in ("", "serve"):
        serve()
    else:
        print("Usage: writey-helper [serve | install | uninstall]")
        sys.exit(2)


if __name__ == "__main__":
    main()
