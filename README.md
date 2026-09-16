# DocChat

DocChat turns a small set of support documents into a private, cited chatbot. Owners upload UTF-8 TXT or Markdown files, test grounded answers in the dashboard, and publish an origin-restricted visitor widget when the answers are ready. The MVP runs locally with Supabase, Ollama, and a synthetic Northstar Bikes demo.

## Local prerequisites

Use Windows with:

- Docker Desktop running.
- Node.js 24.14 and pnpm 10.30.3.
- Ollama running on the host. The commands below use the default Windows installation path because this machine does not have `ollama` on `PATH`.

The local Supabase project uses `docchat-local` and avoids common ports:

| Service | URL |
| --- | --- |
| Supabase API | http://127.0.0.1:55321 |
| Postgres | 127.0.0.1:55322 |
| Studio | http://127.0.0.1:55323 |
| Mailpit | http://127.0.0.1:55324 |
| Next app | http://127.0.0.1:3000 |
| External demo | http://127.0.0.1:3001 |

## Install and start

From PowerShell in the repository:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
npx --yes supabase@2.117.0 start -x analytics,vector,logflare,imgproxy,realtime,supavisor
npx --yes supabase@2.117.0 migration up --local
npm run setup:local
```

`npm run setup:local` reads the local CLI status without printing keys, writes only the browser URL and anon key to the ignored `.env.local`, preserves or generates the ignored Edge Function `CRON_SECRET`, and stores that secret in the local Supabase Vault. It does not overwrite unrelated environment entries. Never put a service role key in `.env.local` or browser code.

Load the local models once:

```powershell
ollama pull bge-m3
ollama pull qwen3:0.6b
ollama pull qwen2.5:1.5b
```

Edge Functions reach the host model server at `http://host.docker.internal:11434`. The product uses `qwen3:0.6b`; `qwen2.5:1.5b` is only the comparison model. The model comparison runner talks directly to `http://127.0.0.1:11434` from Windows.

Keep the Ollama application running. If it is not already serving, run `& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" serve` in a separate terminal. The verified Docker Desktop setup reaches the host's loopback listener through `host.docker.internal`.

In the first service terminal, keep the Edge Functions running:

```powershell
npx --yes supabase@2.117.0 functions serve --env-file .env.functions.local
```

In a second PowerShell window, start the app for development:

```powershell
npm.cmd run dev -- --hostname 127.0.0.1
```

For a production-like local run:

```powershell
pnpm build
npm.cmd run start -- --hostname 127.0.0.1
```

Start the safe synthetic external page in another window:

```powershell
npm run demo
```

It serves only `/` and `/index.html`. Pass the bot explicitly with `http://127.0.0.1:3001/?bot_id=<published-bot-id>` or set `DOCCHAT_BOT_ID`; it does not serve arbitrary files.

These commands use the repository's `docchat-local` Docker project and apply pending migrations without resetting data. Keep other Docker projects untouched. Stop the three foreground servers with Ctrl+C when finished; `npx --yes supabase@2.117.0 stop` from this repository stops this local Supabase project and preserves its data. Do not use `db reset`, Docker prune, or volume deletion to restart the MVP.

## First use

Open http://127.0.0.1:3000 and create an account. Supabase sends the confirmation email to local Mailpit; open http://127.0.0.1:55324, follow the confirmation link, and sign in. Create the one bot, upload `demo/shipping.md`, `demo/returns.txt`, and `demo/support.md`, and wait for each document to become ready. Test the owner chat and inspect its source excerpts.

Publishing stays off until Settings has at least one allowed `http(s)` origin and the owner confirms the disclosure. The generated snippet loads `public/widget.js`; it creates a scoped visitor session from the embedding page and passes that token to the iframe through a checked `postMessage` handshake. The token is never put in the iframe URL and the widget does not use the owner's browser session.

## Checks

The check command uses the pinned Deno runtime through `npx`, checks the Next app and every Edge Function against the tracked `deno.lock` in frozen mode, runs the app and Edge Function linters, and executes the named regression tests. The first run downloads Deno and the remote Edge Function type imports. These checks do not require local Supabase, Ollama, Mailpit, the app, or the external demo.

```powershell
npm run check
git diff --check
npm run manifest
```

Run `npm run typecheck:app` or `npm run typecheck:edge` for one typecheck scope, and `npm run lint:app` or `npm run lint:edge` for one lint scope. These commands cover `app`, `components`, `lib`, `public`, and `supabase/functions`; scripts and test files are checked by their own commands. App lint keeps the existing Next path aliases, browser globals, and IIFE widget syntax; Edge lint only relaxes Deno's import-prefix rule for the existing URL imports. `npm run manifest` writes an ignored JSON record with the commit, runtime versions, dependency pins, and lockfile hashes to `test-results/runtime-manifest.json`.

GitHub Actions in `.github/workflows/ci.yml` runs the frozen install, typecheck, lint, named regressions, build, and whitespace check on every pull request and `main` push. A separate local-integration job starts the pinned Supabase CLI with Docker, a deterministic Ollama-compatible provider, the Next app, and the synthetic demo, then runs the ingestion, chat, billing, cleanup, and browser checks against the real local HTTP and database paths. It uses no cloud credentials or model downloads. Sanitized command status/timing records and the runtime manifest are uploaded as workflow artifacts even when a check fails; service logs are excluded from uploaded artifacts because startup output can contain local runtime keys.

These service-backed checks use local services and synthetic data. They clean their own fixtures; they do not print passwords, tokens, or runtime keys.

```powershell
npm run test:ingestion
npm run test:ingestion -- --max-source
npm run test:chat
npm run test:billing
npm run test:cleanup
npm run test:browser
npm run test:model
npm run test:eval
npm run test:eval-aggregate
```

The browser smoke test needs the app, Edge Functions, Supabase, Mailpit, Ollama, and the external demo running. It uses a fresh confirmation email, real document processing, and local recovery-link checks. The model comparison and the 32-output RAG challenge set can take several minutes on the local GPU and write ignored raw reports under `test-results/`. See [docs/RAG_EVALUATION.md](docs/RAG_EVALUATION.md) for the challenge set, fixed/retrieved lanes, and exact manual aggregation workflow.

Processing is synchronous with a 110-second request deadline and a 180-second processing lease. The measured 100 KiB files took about 81–85 seconds on this machine; slower hardware may time out. After an interrupted worker's lease expires, retry the document in Knowledge. Partial chunks remain unavailable to chat, and a retry replaces the failed generation. This MVP has no durable background queue. To replay the bounded local mixed-load check, run `npm run test:ingestion -- --max-source` and `npm run test:chat` in separate terminals against the same warm services; both suites must pass. This is a single smoke run, not a capacity benchmark. Request ID, save, delivery, and retry handling are documented in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Local-only boundary

This repository is a local MVP. It has no production SMTP, cloud/OpenRouter configuration, live Stripe payment flow, or production deployment claim. Review [VALIDATION.md](VALIDATION.md) for the evidence and known model limitations, [MODEL_EVALUATION.md](MODEL_EVALUATION.md) for the reproducible comparison, and [WALKTHROUGH.md](WALKTHROUGH.md) for the screenshot walkthrough.
