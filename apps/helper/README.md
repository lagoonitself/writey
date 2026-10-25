# Writey Helper

A small local server that does what the Writey website can't do by itself. Today that's
**Sign in with ChatGPT**, so Writey can use your ChatGPT Plus or Pro plan. Local speech
models (Parakeet STT, Fish S1-mini TTS) come next (docs/ARCHITECTURE.md §7).

It listens on `127.0.0.1:47823` only, answers just Writey's own sites, and keeps your ChatGPT
tokens in your user folder (`%APPDATA%\Writey\helper` on Windows). They never go to Writey's
server or the browser.

## Install it

**Windows:** in Writey, open **Settings → ChatGPT → Continue with ChatGPT**. The first time, it
offers `writey-helper-setup.cmd`. Run it once: it installs [uv](https://docs.astral.sh/uv/) if
needed, installs the Helper with `uv tool install`, and runs `writey-helper install`, which starts
it now and at every Windows sign-in (hidden, no window). It also replaces an older Helper that is
already running. `writey-helper uninstall` undoes it.

**macOS / Linux:** run it in a terminal and keep it open:

```bash
uvx --from "git+https://github.com/lagoonitself/writey#subdirectory=apps/helper" writey-helper
```

From a Writey checkout: `uv run --directory apps/helper writey-helper`.

Then **Continue with ChatGPT** sends the tab to OpenAI, you pick your account, and OpenAI sends
you back to the Writey page you were on. No codes, nothing to paste.

| Variable             | Default                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `WRITEY_HELPER_PORT` | `47823`                                                             |
| `WRITEY_ORIGINS`     | `https://writey.anilreddy2569900.workers.dev,http://localhost:5173` |
| `WRITEY_HELPER_HOME` | Your OS's per-user app data folder                                  |

## How sign-in works

It follows OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source).
The first sign-in registers Writey with `client_id=dynamic_agent_client` and this computer's
`ext_agent_host_id`, and OpenAI returns the real `oaiapp_…` client id. The flow uses PKCE,
`state` and `nonce`, with the callback on `http://127.0.0.1:1455/auth/callback`. Writey starts it with a
plain link to `GET /chatgpt/connect?return_to=<Writey page>`; after the callback the Helper
redirects the tab back there with `?chatgpt=connected` (or `=error`). The Helper
checks the ID token against OpenAI's keys, then refreshes the hourly access token as needed.
Model calls go to `https://api.openai.com/v1/responses` with `store: false` and `stream: true`.

## Develop

```bash
uv run pytest
```
