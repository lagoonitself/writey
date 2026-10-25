# Writey Helper

A small local server that does what the Writey website can't do by itself. Today that's
**Sign in with ChatGPT**, so Writey can use your ChatGPT Plus or Pro plan. Local speech
models (Parakeet STT, Fish S1-mini TTS) come next (docs/ARCHITECTURE.md §7).

It listens on `127.0.0.1:47823` only, answers just Writey's own sites, and keeps your ChatGPT
tokens in your user folder (`%APPDATA%\Writey\helper` on Windows). They never go to Writey's
server or the browser.

## Run it

Needs [uv](https://docs.astral.sh/uv/getting-started/installation/).

```bash
uvx --from "git+https://github.com/lagoonitself/writey#subdirectory=apps/helper" writey-helper
```

From a Writey checkout: `uv run --directory apps/helper writey-helper`.

The window shows a six-digit pairing code. In Writey, open **Settings → ChatGPT**, type the
code once, then click **Continue with ChatGPT**. Leave the Helper running while you use Writey.

| Variable             | Default                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `WRITEY_HELPER_PORT` | `47823`                                                             |
| `WRITEY_ORIGINS`     | `https://writey.anilreddy2569900.workers.dev,http://localhost:5173` |
| `WRITEY_HELPER_HOME` | Your OS's per-user app data folder                                  |

## How sign-in works

It follows OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source).
The first sign-in registers Writey with `client_id=dynamic_agent_client` and this computer's
`ext_agent_host_id`, and OpenAI returns the real `oaiapp_…` client id. The flow uses PKCE,
`state` and `nonce`, with the callback on `http://127.0.0.1:1455/auth/callback`. The Helper
checks the ID token against OpenAI's keys, then refreshes the hourly access token as needed.
Model calls go to `https://api.openai.com/v1/responses` with `store: false` and `stream: true`.

## Develop

```bash
uv run pytest
```
