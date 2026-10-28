# Writey

A handwritten notebook for math and physics with an AI you talk to.
Say **"Writey, what's next?"** and it continues your work in handwriting on the page.
Say **"Writey, why does this work?"** and it explains in a side chat.

Open source (MIT). Bring your own AI keys: OpenRouter, OpenCode Zen or your ChatGPT plan.

See [HANDOFF.md](HANDOFF.md) for decisions and current state, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works.

## Layout

| Path                  | What                                         |
| --------------------- | -------------------------------------------- |
| `apps/web`            | React app (Vite)                             |
| `apps/worker`         | Cloudflare Worker: API + hosts the built app |
| `packages/ink-engine` | Page model, hit-testing, undo, ink rendering |
| `packages/ai-core`    | Prompts, intent rules, focus region, streams |
| `packages/inkscript`  | Writey's handwriting: LaTeX layout, glyphs   |
| `apps/helper`         | Writey Helper: ChatGPT sign-in               |
| `packages/shared`     | Types shared by web and worker               |
| `supabase/migrations` | Database schema and row-level security       |

## Development

Requires Node 24 and pnpm 10.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in Supabase URL + publishable key
pnpm dev                                        # web on :5173, worker on :8787
```

Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `apps/worker/wrangler.jsonc` to your project, and apply `supabase/migrations` in order. Deploying needs an R2 bucket named `writey` (`wrangler dev` simulates it locally).

Provider keys are encrypted with a 32-byte master key. Put `CREDENTIALS_KEY=<base64>` in `apps/worker/.dev.vars` for local dev, and set it in production with `wrangler secret put CREDENTIALS_KEY`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

| Command           | Does                                    |
| ----------------- | --------------------------------------- |
| `pnpm lint`       | Biome lint + format check               |
| `pnpm format`     | Auto-fix lint and formatting            |
| `pnpm typecheck`  | TypeScript across all packages          |
| `pnpm test`       | Vitest across all packages              |
| `pnpm run deploy` | Build the web app and deploy the Worker |

### Google sign-in setup (once)

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** (Web application).
2. Authorized redirect URI: `https://<your-project>.supabase.co/auth/v1/callback`.
3. Supabase dashboard → Authentication → Sign In / Providers → **Google**: paste the client ID and secret.
4. Supabase → Authentication → URL Configuration: add `http://localhost:5173` and your deployed URL to the redirect allow list.

## License

[MIT](LICENSE)
