# Writey — Handoff

The single place to learn **what Writey is, what was decided and why, where it stands, and what's next**.
Read this first, then `docs/ARCHITECTURE.md` for the technical design.
Update this file whenever a decision changes or a phase ships.

Last updated: 2026-10-25

---

## 1. The idea (in the owner's words, condensed)

A digital notepad: laptop + pen tablet (later iPad + Apple Pencil). You write, solve problems, take notes, import PDFs and images and write on top of them. You pick pens, paper and backgrounds. That part is basic and table stakes.

On top of it sits an AI you **talk to**. The old way is screenshotting your work into another AI. The new way: while you're solving, you just **say** something, with no button press:

- "Writey, solve this" / "what's next?" / "continue" → it **writes the next step in handwriting on the page**, continuing your work.
- "Writey, how does this work?" / "I don't get this step" → a **chat box pops up on the side** and explains.

It "sees" your work because we own the canvas: it reads your strokes, the PDF text and an image of the region you're working on. No screen capture.

The owner wants **both** outputs (chat and handwriting). Writey picks one from what you said, and you can always override.

## 2. Who it's for

- Started as "just me" (the owner is the primary user, showcasing it on a laptop + Huion pen tablet).
- Then became **open source (MIT), multi-user, $0 hosting, bring-your-own AI keys**. This is the current direction, and the deployed app has Google login.
- Subjects: **math and physics**, any level (school, college, engineers, self-study).

## 3. Decisions log

| #   | Topic                   | Decision                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Platform                | Web app in **Chrome on desktop** (laptop + pen tablet). iPad/iOS later. No Safari work in v1.                                                                                                                                                                                                                                                                                                    |
| D2  | Tutor vs solver         | **Both, from your wording.** "How do I…/hint" → explain or nudge. "Solve this/show me the answer" → full solution.                                                                                                                                                                                                                                                                               |
| D3  | Chat vs handwriting     | "continue / next / what's next / solve / show me / write it" → **ink on page**. "why / how does / explain / I don't understand" → **chat**. "check / is this right / mistake" → **red marks + chat**. Unclear → a fast PLAN call decides; still unclear → chat, with a "Write this on the page" button. Every handwritten step has a "Why?" button. Voice overrides: "just explain", "write it". |
| D4  | Handwriting style       | **(a) now:** single-stroke handwriting font drawn stroke by stroke (math laid out by MathJax, glyphs swapped for single-stroke ones). **(b) later:** learned from the owner's handwriting.                                                                                                                                                                                                       |
| D5  | AI ink                  | **Distinct color**, grouped (erasable as one), shown first as a **ghost preview** with **Accept / Redo / Discard / Why?**. Placed right below your last line. "Writey, keep it" accepts.                                                                                                                                                                                                         |
| D6  | What the AI sees        | Region around your recent strokes, extended up to the problem statement, plus PDF text there. Lines get numbered tags (L1, L2…) on the image sent to the model only. A lasso selection overrides.                                                                                                                                                                                                |
| D7  | Memory                  | One conversation per page. Nothing global.                                                                                                                                                                                                                                                                                                                                                       |
| D8  | Proactive help          | None in v1. Writey acts only when addressed. A no-wake-word "study mode" is a later opt-in.                                                                                                                                                                                                                                                                                                      |
| D9  | Spoken replies          | Available, **off by default**.                                                                                                                                                                                                                                                                                                                                                                   |
| D10 | Page model              | Notebooks with fixed pages (A4); PDFs import page by page. No infinite canvas.                                                                                                                                                                                                                                                                                                                   |
| D11 | AI providers (thinking) | **OpenRouter** (user key), **OpenCode Zen** (user key), **ChatGPT plan** via official "Sign in with ChatGPT". Nothing else.                                                                                                                                                                                                                                                                      |
| D12 | Default model           | **DeepSeek V4.1 Flash** (native vision) via OpenRouter, changeable in settings.                                                                                                                                                                                                                                                                                                                  |
| D13 | Voice (**changed**)     | **No Gemini Live, no cloud voice, no browser-run models.** Speech-to-text and text-to-speech run as **local models in Python** (Writey Helper) on the owner's GPU. Text box always available.                                                                                                                                                                                                    |
| D14 | Addressing Writey       | Say **"Writey …"**, detected by fuzzy match in the transcript (Silero VAD gates it, so a silent room transcribes nothing), **or** hold **push-to-talk** (key or pen-tablet button). An openWakeWord model is added only if misses are common.                                                                                                                                                    |
| D15 | ChatGPT sign-in         | Official open-source flow = loopback login (`127.0.0.1`) with tokens stored locally, so it lives **in the Helper**. A hosted website flow would need an OpenAI client ID (waitlist). OpenRouter/Zen keys are stored encrypted in Supabase.                                                                                                                                                       |
| D16 | Stack                   | React + TS + Vite; custom canvas engine; one Cloudflare Worker (Hono) for API + static hosting; Supabase (Postgres + Google auth); R2 for files.                                                                                                                                                                                                                                                 |
| D17 | Diagrams                | AI writes a diagram **spec** (axes, plot, arrow, rect, spring…) and Writey draws it hand-drawn style. Phase 5.                                                                                                                                                                                                                                                                                   |
| D18 | Name / license          | Product and repo are **Writey**. **MIT**.                                                                                                                                                                                                                                                                                                                                                        |
| D19 | Speech models           | **English only.** STT: **NVIDIA Parakeet TDT 0.6B v2** (English, fastest, no Whisper-style hallucination in silence) via onnx-asr; fallback faster-whisper distil-large-v3. TTS: **Fish Audio OpenAudio S1-mini** (0.5B, local; weights are CC BY-NC-SA, non-commercial); fallback Kokoro-82M. Gate: **Silero VAD** (speech only, not any sound).                                                |
| D20 | OpenCode                | Means **OpenCode Zen** only.                                                                                                                                                                                                                                                                                                                                                                     |
| D21 | Browser ↔ Helper        | **Approved.** Browser owns mic (`echoCancellation`), Silero VAD, playback, 30 s transcript and trigger check. Helper is a local model server on `127.0.0.1:47823`: WS `/stt` (speech segment → text), `/tts` (text → audio), ChatGPT sign-in + proxy. Writey's own speech is appended to the transcript as text, never re-transcribed. Desktop wrapper (Electron/Tauri) later.                   |
| D22 | Key storage             | The Worker never holds the Supabase service-role key. Keys are AES-256-GCM encrypted by the Worker (master key = Worker secret `CREDENTIALS_KEY`), and written and read only through the `save_provider_secret()` / `provider_secret()` security-definer functions, acting on the caller's own row. Clients can list metadata (provider, last 4, date) but can't select or write the ciphertext. |
| D23 | Phase 2 output          | Until Phase 3 ships ink, **every answer goes to the chat panel**. PLAN still decides mode and scope, so "hint" stays a hint and "check" checks.                                                                                                                                                                                                                                                  |
| D24 | Zen models              | Writey speaks Chat Completions only for now, so on OpenCode Zen the GPT, Claude and Gemini families (other wire formats) and the `-free` models (OpenCode app only) show as unavailable. DeepSeek, GLM, Kimi, MiniMax and similar work.                                                                                                                                                          |

### Superseded

- ~~Gemini Live as voice tier 1~~ → dropped (D13).
- ~~Plain local files instead of a cloud DB (personal-use idea)~~ → Supabase + R2, because the project went open-source and multi-user.
- ~~ChatGPT tokens in the database~~ → Helper-only until a hosted client ID exists (D15).
- ~~Fish Audio cloud API for TTS~~ → Fish S1-mini running locally (D19).
- ~~Voice models in the browser (Moonshine/Whisper WebGPU, Kokoro.js) or a Chrome extension~~ → rejected; the owner wants local Python models (an extension can't run models better than a page, and ChatGPT sign-in needs a local server anyway).
- ~~openWakeWord as the primary trigger~~ → transcript match + push-to-talk (D14).

## 4. Owner's setup

- Windows laptop, **8 GB dedicated GPU (NVIDIA)**, Chrome, **Huion** pen tablet (enable Windows Ink in the Huion driver to get `pointerType: 'pen'`).
- Pressure is ignored in v1.

## 5. Current state (2026-10-25)

- **Live:** https://writey.anilreddy2569900.workers.dev
- **Supabase project:** `writey` (ref `ksnpzfgcxjallzucvuhr`). Google OAuth is on. Migrations in `supabase/migrations` are applied.
- **Shipped**
  - Phase 0: monorepo, CI, auth shell, Worker API, schema.
  - Phase 1: notebook app. Ink engine, pens, highlighter, lasso, text box, undo/redo, pages, notebooks, PDF/image import, R2 page saves with version check, IndexedDB crash buffer.
  - Redesign (Bricolage Grotesque + Caveat, floating dock, notebook covers), an eraser that cuts strokes instead of deleting them, pencil cursors.
  - **Phase 2: Ask by typing.** Settings (gear icon): Connect OpenRouter (OAuth PKCE) or paste a key, OpenCode Zen key, provider and model picker (OpenRouter list filtered to vision models). "Ask Writey" chat panel (Ctrl+K), one thread per page saved in `ai_threads`/`ai_messages`. Context capture: focus region from recent writing or the lasso, extended up to the problem; magenta L1… line tags; region image plus a page thumbnail; PDF text and typed text. PLAN (JSON, no reasoning) then PRODUCE (streamed Markdown + KaTeX). Stop button, plain error messages, token and cost display, "What Writey saw" preview. Code: `packages/ai-core` (prompts, intent rules, focus region, SSE parsing, errors), `apps/worker/src/ai.ts` + `crypto.ts`, `apps/web/src/{help,chat,settings}`.
- **Not started:** `packages/inkscript`, `apps/helper`, the eval set, and ink output.
- **Not yet tested against a real model**, because no real provider key has been saved yet. Every path was verified with fake keys (real OpenRouter and Zen rejections) and a stubbed stream.

## 6. Next up (in order)

The owner gave the go on 2026-10-25.

1. **Owner:** add an AI key in Settings (Connect OpenRouter is one click) and try a real page. Then the **eval set**: 20–30 real handwritten pages (photos or Writey pages) to test DeepSeek V4.1 Flash on reading and on step quality.
2. **Math handwriting spike** (§5.5): render ~20 typical formulas with single-stroke glyphs and judge them. This is the biggest risk, so do it before Phase 3.
3. **Phase 3 — Writey writes:** InkScript, layout, handwriting renderer, ghost preview + accept, check-my-work marks.
4. **Phase 4 — Voice + Helper:** browser voice client (mic, Silero VAD, transcript, trigger, push-to-talk) + Python Helper (Parakeet STT, Fish S1-mini TTS) + Sign in with ChatGPT, all in one Helper process. Measure S1-mini latency/VRAM first.
5. **Phase 5 — Diagrams.**

## 7. Open questions for the owner

1. Delete the leftover e2e test user `writey-e2e@test.invalid` in Supabase? (Awaiting OK.)

## 8. Gotchas

- Free Supabase org allows only 2 active projects. The `roleplay` project was **paused** to make room. Don't unpause it without freeing a slot.
- Use `pnpm run deploy`, not `pnpm deploy` (that's a pnpm built-in). See AGENTS.md for the non-interactive deploy recipe.
- Worker free plan: ~10 ms CPU per request. Stream AI bodies through unparsed; never parse big bodies in the Worker.
- Worker secret `CREDENTIALS_KEY` encrypts every saved provider key. If it is lost or changed, users must re-enter their keys. Local dev uses a different key in `apps/worker/.dev.vars`.
- Biome must not format `pnpm-lock.yaml` (pnpm rewrites it), so it's excluded in `biome.json`. CI was red from 2026-10-24 until this fix because docs weren't Biome-formatted. Run `pnpm format` before pushing doc edits.
- The e2e test user's password lives in `apps/web/.e2e.local` (gitignored, this machine only). Reset it via SQL if it's missing.
