# AGENTS.md — instructions for AI agents working on Writey

## Read first, in order

1. `HANDOFF.md`: what Writey is, every decision and why, current state, next steps, open questions.
2. `docs/ARCHITECTURE.md`: the technical design (ink engine, help engine, InkScript, providers, voice, data model, phases).
3. `README.md`: setup and commands.

If these disagree, `HANDOFF.md` wins (it's the newest record). Fix the other file when you notice.

## Don't re-litigate settled decisions

These are decided. Don't propose alternatives unless the owner asks:

- **Writey is a desktop app (HANDOFF D57):** Tauri 2 + Rust for Windows and Apple Silicon Macs. The React UI and the TypeScript packages run in the web view; Rust owns storage (SQLite on disk), keys (OS keychain), AI calls, ChatGPT/OpenRouter sign-in and voice. No Supabase, no Python Helper. The website only offers the download and the old web notebooks' export.
- **No Gemini Live, no cloud voice.** STT (Parakeet TDT 0.6B v2), TTS (Kokoro 82M) and Silero VAD run locally in Rust via sherpa-onnx, **on the GPU** (CUDA on NVIDIA, CoreML on Apple Silicon) with automatic CPU fallback.
- English only for speech.
- Thinking providers are **only** OpenRouter, OpenCode Zen and ChatGPT (Sign in with ChatGPT, done by the desktop app). "OpenCode" means OpenCode Zen.
- Default model: DeepSeek V4.1 Flash via OpenRouter.
- Chat vs ink is chosen by intent (see HANDOFF D3). AI ink is a ghost preview with Accept.
- Windows and Apple Silicon Mac with a pen tablet first; iPad later.
- Custom canvas engine (no tldraw/Excalidraw).

## Working style (owner's preferences)

- The owner has handed the project to the agent to build. **Commit and push straight to `main`.** No feature branches or PRs unless asked.
- **Deploy after meaningful changes** without asking.
- Drive the roadmap phase by phase (HANDOFF §6) on your own judgment.
- **Keep reports short:** what shipped, the live URL, and anything the owner must do themselves. No long caveat lists.
- Still confirm genuinely destructive or costly actions (deleting user data, paid plans, unpausing other Supabase projects).
- When a decision changes or a phase ships, **update `HANDOFF.md`** (decisions log, current state, next up) in the same commit.

## Repo map

| Path                  | What                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `apps/desktop`        | The app: Tauri 2 / Rust (store, vault, ai, voice); `cargo test` there          |
| `apps/web`            | React + Vite UI (notebook, toolbar, library); `src/site` is the website        |
| `apps/worker`         | Cloudflare Worker (Hono): website + old notebooks' export API                  |
| `packages/ink-engine` | Page model, editor/undo, geometry, render, serialize                           |
| `packages/shared`     | Types shared by web and worker                                                 |
| `supabase/migrations` | The old web version's schema (read by the export page only)                    |
| `packages/ai-core`    | Prompts, intent rules, focus region + line labels, SSE parsing, error messages |
| `packages/inkscript`  | AI handwriting: InkScript parser, LaTeX layout, glyphs, placement, pen timing  |

`ink-engine`, `inkscript` and `ai-core` stay plain TypeScript with no React, so they're testable and reusable on iPad later.

## Commands

Node 24, pnpm 10, Rust stable.

```bash
pnpm install
pnpm app          # desktop app in dev (UI on :5173)
pnpm app:build    # installers
pnpm lint         # biome check
pnpm format       # biome fix
pnpm typecheck
pnpm test         # vitest
pnpm run deploy   # website; NOT `pnpm deploy` (pnpm built-in)
```

Run `pnpm lint && pnpm typecheck && pnpm test` before pushing, plus `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` in `apps/desktop` if you touched Rust (where sherpa-onnx's GitHub download is blocked, use `DOCS_RS=1 cargo clippy` and `cargo test --no-default-features`). CI runs all of these; the `Desktop` workflow builds the Windows and macOS installers, runs a real-model speech round trip, and publishes the installers to the GitHub release `v<version>` on every push to `main`.

## Releasing the app

Bump `version` in `apps/desktop/tauri.conf.json` and `Cargo.toml` for a new release; pushes to `main` rebuild the installers of the current version. Installers are ad-hoc signed (Windows SmartScreen and macOS Gatekeeper warn on first open) until the owner adds signing certificates.

## Deploying the website (non-interactive)

Wrangler's own login has expired and can't refresh non-interactively. Instead:

- Set `CLOUDFLARE_API_TOKEN` to the `oauth_token` from the cf CLI config (`%APPDATA%\xdg.config\cloudflare\config\default.json`).
- Set `CLOUDFLARE_ACCOUNT_ID` to the owner's account ID (in the same config or `cf whoami`).
- Run `pnpm run deploy`. The web build reads `apps/web/.env.local` (gitignored; Supabase URL + publishable key).
- Live URL: https://writey.writey.workers.dev

## Infra facts

- Supabase project `writey`, ref `ksnpzfgcxjallzucvuhr`. The free org has a 2-active-project limit; `roleplay` is paused on purpose.
- R2 bucket `writey` (binding `FILES`).
- Worker free plan: ~10 ms CPU per request. Never parse large bodies; stream AI responses through.
- Secrets never go in the repo. Provider keys are AES-256-GCM encrypted by the Worker (master key = Worker secret).

## Code conventions

- TypeScript strict, Biome formatting (single quotes, no semicolons). Match surrounding code.
- Units on the page are PDF points; default page is A4 595 × 842.
- Keep comments sparse and purposeful, like the existing code.
- Add Vitest tests for engine/protocol logic (ink-engine, inkscript, ai-core, Worker routes).

## Testing the UI

Run the real app under WebDriver: `pnpm tauri build --debug --no-bundle -- --no-default-features` in `apps/desktop`, then `tauri-driver` (on Linux with `xvfb-run` and `webkit2gtk-driver`) and drive it with W3C WebDriver (`tauri:options.application` = `target/debug/writey`). Drive the canvas with synthetic PointerEvents and call Rust directly with `window.__TAURI_INTERNALS__.invoke(...)`. Debug builds send OpenRouter/Zen requests to `WRITEY_TEST_CHAT_URL` when set, for a fake model.
