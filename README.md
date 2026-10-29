# Writey

A handwritten notebook for math and physics with an AI you talk to, **on the web and for Windows and Apple Silicon Macs**, kept in sync.
Say **"Hey, what's next?"** and it continues your work in handwriting on the page.
Say **"Hey, why does this work?"** and it sketches on the page and explains beside it.

Open source (MIT). Bring your own AI: your ChatGPT plan, OpenRouter or OpenCode Zen. Use it at [writey.writey.workers.dev](https://writey.writey.workers.dev), or get the app (offline notebooks, voice on your GPU) and sign in with the same Google account to sync.

**Download:** [Windows](https://github.com/lagoonitself/writey/releases/latest/download/Writey-Windows-Setup.exe) · [Mac (Apple Silicon)](https://github.com/lagoonitself/writey/releases/latest/download/Writey-macOS-AppleSilicon.dmg)

See [HANDOFF.md](HANDOFF.md) for decisions and current state, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works.

## Layout

| Path                  | What                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `apps/desktop`        | The app (Tauri 2, Rust): storage, keys, AI calls, sign-ins, local voice on the GPU |
| `apps/web`            | The UI (React + Vite), shared by the website and the app                           |
| `apps/worker`         | Cloudflare Worker: the website's API (also used by desktop sync) + hosting         |
| `apps/helper`         | Writey Helper (Python): Sign in with ChatGPT for the website                       |
| `packages/ink-engine` | Page model, hit-testing, undo, ink rendering                                       |
| `packages/ai-core`    | Prompts, intent rules, focus region, streams                                       |
| `packages/inkscript`  | Writey's handwriting: LaTeX layout, glyphs, diagrams                               |
| `packages/shared`     | Types shared by the UI and the worker                                              |

## Development

Requires Node 24, pnpm 10 and Rust (stable). On Linux also the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and `libasound2-dev`.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # Supabase URL + publishable key (website)
pnpm dev          # the website: UI on :5173, Worker on :8787
pnpm app          # the desktop app, with the UI hot-reloading from :5173
pnpm app:build    # installers in apps/desktop/target/release/bundle
```

The first `cargo` build downloads sherpa-onnx's libraries from GitHub. Voice models are downloaded by the app (Settings → Voice). On macOS run `node scripts/macos-frameworks.mjs target/release` in `apps/desktop` after `cargo build --release` and before `pnpm app:build`, so the speech libraries are bundled.

| Command                                | Does                                     |
| -------------------------------------- | ---------------------------------------- |
| `pnpm lint` / `pnpm format`            | Biome lint + format check / auto-fix     |
| `pnpm typecheck`                       | TypeScript across all packages           |
| `pnpm test`                            | Vitest across all packages               |
| `cd apps/desktop && cargo test`        | Rust tests                               |
| `cargo test --test voice -- --ignored` | Real-model speech round trip (downloads) |
| `pnpm run deploy`                      | Build and deploy the website             |

## License

[MIT](LICENSE)
