# AGENTS.md — instructions for AI agents working on Writey

## Read first, in order

1. `HANDOFF.md`: what Writey is, every decision and why, current state, next steps, open questions.
2. `docs/ARCHITECTURE.md`: the technical design (ink engine, help engine, InkScript, providers, Helper, data model, phases).
3. `README.md`: setup and commands.

If these disagree, `HANDOFF.md` wins (it's the newest record). Fix the other file when you notice.

## Don't re-litigate settled decisions

These are decided. Don't propose alternatives unless the owner asks:

- **No Gemini Live, no cloud voice, no browser-run voice models.** STT (Parakeet TDT 0.6B v2) and TTS (Fish OpenAudio S1-mini) run locally in the Python Writey Helper. The browser owns mic, VAD, playback and the transcript (HANDOFF D21). **Voice is switched off for now (D56):** the Helper is ChatGPT-only; the browser voice code stays behind `VOICE_ENABLED`.
- English only for speech.
- Thinking providers are **only** OpenRouter, OpenCode Zen and ChatGPT (Sign in with ChatGPT via the Helper). "OpenCode" means OpenCode Zen.
- Default model: DeepSeek V4.1 Flash via OpenRouter.
- Chat vs ink is chosen by intent (see HANDOFF D3). AI ink is a ghost preview with Accept.
- Chrome on desktop with a pen tablet first; iPad later.
- Custom canvas engine (no tldraw/Excalidraw).

## Working style (owner's preferences)

- The owner has handed the project to the agent to build. **Commit and push straight to `main`.** No feature branches or PRs unless asked.
- **Deploy after meaningful changes** without asking.
- Drive the roadmap phase by phase (HANDOFF §6) on your own judgment.
- **Keep reports short:** what shipped, the live URL, and anything the owner must do themselves. No long caveat lists.
- Still confirm genuinely destructive or costly actions (deleting user data, paid plans, unpausing other Supabase projects).
- When a decision changes or a phase ships, **update `HANDOFF.md`** (decisions log, current state, next up) in the same commit.

## Repo map

| Path                  | What                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `apps/web`            | React + Vite app (notebook UI, toolbar, library)                                        |
| `apps/worker`         | Cloudflare Worker (Hono): `/api/*` + hosts `web/dist`                                   |
| `packages/ink-engine` | Page model, editor/undo, geometry, render, serialize                                    |
| `packages/shared`     | Types shared by web and worker                                                          |
| `supabase/migrations` | SQL schema + RLS                                                                        |
| `packages/ai-core`    | Prompts, intent rules, focus region + line labels, SSE parsing, error messages          |
| `apps/helper`         | Writey Helper (Python, uv): Sign in with ChatGPT + Responses proxy (voice removed, D56) |
| `packages/inkscript`  | AI handwriting: InkScript parser, LaTeX layout, glyphs, placement, pen timing           |

`ink-engine`, `inkscript` and `ai-core` stay plain TypeScript with no React, so they're testable and reusable on iPad later.

## Commands

Node 24, pnpm 10.

```bash
pnpm install
pnpm dev          # web :5173 + worker :8787
pnpm lint         # biome check
pnpm format       # biome fix
pnpm typecheck
pnpm test         # vitest
pnpm run deploy   # NOT `pnpm deploy` (pnpm built-in)
```

Run `pnpm lint && pnpm typecheck && pnpm test` before pushing, plus `uv run --directory apps/helper pytest` if you touched the Helper. CI runs all of these.

## Deploying (non-interactive)

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

Run `pnpm dev`, open http://localhost:5173 and sign in with the e2e test user (`writey-e2e@test.invalid`; ask the owner or reset the password via SQL). For headless checks, sign in from the console with `(await import('/src/lib/supabase.ts')).supabase.auth.signInWithPassword(...)` and drive the canvas with synthetic PointerEvents.
