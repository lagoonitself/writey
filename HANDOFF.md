# Writey — Handoff

The single place to learn **what Writey is, what was decided and why, where it stands, and what's next**.
Read this first, then `docs/ARCHITECTURE.md` for the technical design.
Update this file whenever a decision changes or a phase ships.

Last updated: 2026-10-24

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

| #   | Topic                       | Decision                                                                                                                                                                                                               |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Platform                    | Web app in **Chrome on desktop** (laptop + pen tablet). iPad/iOS later. No Safari work in v1.                                                                                                                          |
| D2  | Tutor vs solver             | **Both, from your wording.** "How do I…/hint" → explain or nudge. "Solve this/show me the answer" → full solution.                                                                                                     |
| D3  | Chat vs handwriting         | "continue / next / what's next / solve / show me / write it" → **ink on page**. "why / how does / explain / I don't understand" → **chat**. "check / is this right / mistake" → **red marks + chat**. Unclear → a fast PLAN call decides; still unclear → chat, with a "Write this on the page" button. Every handwritten step has a "Why?" button. Voice overrides: "just explain", "write it". |
| D4  | Handwriting style           | **(a) now:** single-stroke handwriting font drawn stroke by stroke (math laid out by MathJax, glyphs swapped for single-stroke ones). **(b) later:** learned from the owner's handwriting.                              |
| D5  | AI ink                      | **Distinct color**, grouped (erasable as one), shown first as a **ghost preview** with **Accept / Redo / Discard / Why?**. Placed right below your last line. "Writey, keep it" accepts.                               |
| D6  | What the AI sees            | Region around your recent strokes, extended up to the problem statement, plus PDF text there. Lines get numbered tags (L1, L2…) on the image sent to the model only. A lasso selection overrides.                       |
| D7  | Memory                      | One conversation per page. Nothing global.                                                                                                                                                                             |
| D8  | Proactive help              | None in v1. Writey acts only when addressed. A no-wake-word "study mode" is a later opt-in.                                                                                                                            |
| D9  | Spoken replies              | Available, **off by default**.                                                                                                                                                                                         |
| D10 | Page model                  | Notebooks with fixed pages (A4); PDFs import page by page. No infinite canvas.                                                                                                                                         |
| D11 | AI providers (thinking)     | **OpenRouter** (user key), **OpenCode Zen** (user key), **ChatGPT plan** via official "Sign in with ChatGPT". Nothing else.                                                                                             |
| D12 | Default model               | **DeepSeek V4.1 Flash** (native vision) via OpenRouter, changeable in settings.                                                                                                                                        |
| D13 | Voice (**changed**)         | **No Gemini Live, no cloud voice.** Speech-to-text runs **locally** (faster-whisper on the owner's GPU) inside **Writey Helper**, a small local Python server. TTS: Fish Audio (cloud) first, local later. Text box always available. |
| D14 | Addressing Writey           | Wake word **"Writey"** (openWakeWord, custom model) **plus push-to-talk** (key or pen-tablet button). Fuzzy transcript match as backup.                                                                                 |
| D15 | ChatGPT sign-in             | Official open-source flow = loopback login (`127.0.0.1`) with tokens stored locally, so it lives **in the Helper**. A hosted website flow would need an OpenAI client ID (waitlist). OpenRouter/Zen keys are stored encrypted in Supabase. |
| D16 | Stack                       | React + TS + Vite; custom canvas engine; one Cloudflare Worker (Hono) for API + static hosting; Supabase (Postgres + Google auth); R2 for files.                                                                        |
| D17 | Diagrams                    | AI writes a diagram **spec** (axes, plot, arrow, rect, spring…) and Writey draws it hand-drawn style. Phase 5.                                                                                                          |
| D18 | Name / license              | Product and repo are **Writey**. **MIT**.                                                                                                                                                                              |
| D19 | Speech models               | **English only.** STT: **NVIDIA Parakeet TDT 0.6B v2** (English, fastest, no Whisper-style hallucination in silence), via ONNX; fallback faster-whisper distil-large-v3. TTS: **Fish Audio OpenAudio S1-mini** (0.5B, local; weights are CC BY-NC-SA, non-commercial); fallback Kokoro-82M. Gate: **Silero VAD** (speech only, not any sound). |
| D20 | OpenCode                    | Means **OpenCode Zen** only.                                                                                                                                                                                           |
| D21 | Browser ↔ Helper (proposed) | Browser owns mic (`echoCancellation`), VAD, playback, 30 s transcript buffer and trigger check. Helper is an inference server on `127.0.0.1`: speech segments → text, text → audio, ChatGPT proxy. Writey's own speech is appended to the transcript as text, never re-transcribed. Desktop wrapper (Electron/Tauri) later. **Awaiting owner OK.** |

### Superseded

- ~~Gemini Live as voice tier 1~~ → dropped (D13).
- ~~Plain local files instead of a cloud DB (personal-use idea)~~ → Supabase + R2, because the project went open-source and multi-user.
- ~~ChatGPT tokens in the database~~ → Helper-only until a hosted client ID exists (D15).

## 4. Owner's setup

- Windows laptop, **8 GB dedicated GPU (NVIDIA)**, Chrome, **Huion** pen tablet (enable Windows Ink in the Huion driver to get `pointerType: 'pen'`).
- Pressure is ignored in v1.

## 5. Current state (2026-10-24)

- **Live:** https://writey.anilreddy2569900.workers.dev
- **Supabase project:** `writey` (ref `ksnpzfgcxjallzucvuhr`). Google OAuth is on. Migrations in `supabase/migrations` are applied.
- **Shipped**
  - Phase 0: monorepo, CI, auth shell, Worker API, schema.
  - Phase 1: notebook app. Ink engine, pens, highlighter, lasso, text box, undo/redo, pages, notebooks, PDF/image import, R2 page saves with version check, IndexedDB crash buffer.
  - Redesign (Bricolage Grotesque + Caveat, floating dock, notebook covers), an eraser that cuts strokes instead of deleting them, pencil cursors.
- **Not started:** `packages/inkscript`, `packages/ai-core`, `apps/helper`, provider keys, the chat panel, and any AI feature.

## 6. Next up (in order)

1. **Math handwriting spike** (§5.5): render ~20 typical formulas with single-stroke glyphs and judge them. This is the biggest risk, so do it before Phase 3.
2. **Phase 2 — Ask by typing:** encrypted provider keys (OpenRouter, OpenCode Zen), context capture with line labels, PLAN/PRODUCE calls, chat panel with KaTeX, cancel/stop, error messages, vision check. Build an **eval set** of 20–30 real handwritten pages and test DeepSeek on them.
3. **Phase 3 — Writey writes:** InkScript, layout, handwriting renderer, ghost preview + accept, check-my-work marks.
4. **Phase 4 — Writey Helper:** push-to-talk, wake word, VAD, Whisper, optional TTS, and Sign in with ChatGPT in the same process.
5. **Phase 5 — Diagrams.**

## 7. Open questions for the owner

1. OK the browser ↔ Helper split (D21)?
2. Delete the leftover e2e test user `writey-e2e@test.invalid` in Supabase? (Awaiting OK.)

## 8. Gotchas

- Free Supabase org allows only 2 active projects. The `roleplay` project was **paused** to make room. Don't unpause it without freeing a slot.
- Use `pnpm run deploy`, not `pnpm deploy` (that's a pnpm built-in). See AGENTS.md for the non-interactive deploy recipe.
- Worker free plan: ~10 ms CPU per request. Stream AI bodies through unparsed; never parse big bodies in the Worker.
