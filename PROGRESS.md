# DocChat progress

## Current boundary

- Next.js 16 App Router, TypeScript, Tailwind, and three small UI primitives are scaffolded.
- Supabase local config uses project `docchat-local` and ports 55321 (API), 55322 (Postgres), 55323 (Studio), and 55324 (mail).
- The initial migration is applied locally. It creates the one-account/one-bot schema, private `documents` Storage bucket, owner-only RLS reads, service-only write/RPC access, UTF-8 source limits, pgvector chunks, visitor session storage, owner/public conversations, monthly quota reservations, expiring concurrency leases, processing leases/generations, deletion tombstones, 30-day cleanup, and the 03:00 `pg_cron` job.
- Existing Edge entrypoints are `create-bot` and `bot-settings`; both validate the bearer session server-side. Upload/process/chat/public session functions are the next bounded slice.
- Ollama helper is configured for `/api/embed` with 1024-dimension validation and `/api/chat` with `think:false`, `num_ctx:4096`, deadlines, and strict NDJSON completion checks.

## Contracts for the next slice

- `POST /functions/v1/create-bot` with `Authorization: Bearer <access_token>` and `{ "name": string, "greeting"?: string, "accent_color"?: "#RRGGBB" }` returns `201 { bot }`.
- `POST /functions/v1/bot-settings` with the same bearer and `{ "bot_id": uuid, ...settings }` updates owner settings. Publishing requires at least one normalized `http(s)` origin.
- Document ingestion will use `create_document_slot(owner, bot, document, file, path, type, bytes)` under the service role. `claim_document_processing` returns a lease and generation; `insert_document_chunks` rejects expired/stale leases; `finalize_document_processing` only exposes the exact stored chunk count for the active generation.
- Chat will reserve `reserve_ai_request(account_id)` immediately before the first model request. `reserve_rate_limit(scope, window_seconds, max_requests, max_concurrent, lease_seconds)` returns a lease id; release must pass both the scope and lease id. Quota is shared across owner and visitor chats and plan changes do not reset the month row.

## Verification

- `pnpm install` completed with the pinned lockfile.
- `tsc --noEmit` passed for the Next app.
- `next build` passed for the production shell.
- Supabase local startup and the migration/RLS/grant/cron foundation checks passed; the database is running on the ports above.
- Foundation journey checks passed: email signup creates an unconfirmed user without a session, Mailpit captures the confirmation email, password sign-in succeeds, bot creation returns `201` with publishing disabled, a second tenant sees no first-tenant bots, foreign bot settings return `404`, direct plan changes return `403`, and privileged quota RPCs are denied to non-service roles.
- The rate-limit regression fixture at `supabase/tests/rate_limit_regression.sql` runs inside `BEGIN`/`ROLLBACK`; it covers window rollover, live concurrency leases, and duplicate release. Run it with a privileged local `psql` connection after Supabase starts.
- Corrective migration `20260916000100_publish_origin_check.sql` is applied locally; publishing can never persist without an allowed origin, including concurrent settings updates. Chat input validation caps questions at 1000 UTF-8 bytes, and grounded prompts budget all system, source, history, and question content at 3000 UTF-8 bytes while selecting history newest first.

## Ingestion slice

- Added owner-only `upload-document`, `process-document`, and `delete-document` Edge endpoints and registered only those entrypoints in `supabase/config.toml`. Uploads accept bounded multipart `.txt`/`.md` files up to 100 KiB, require strict UTF-8 nonempty content, reserve a server-side document slot, upload to the private bucket, and compensate storage/slot state on races or failures.
- Processing claims a 180-second generation lease, embeds UTF-8-byte-bounded chunks with Ollama `bge-m3` in small batches, and finalizes only when the active lease and exact chunk count match. A ready document is idempotent; stale or deleted workers cannot insert or finalize chunks. Requests have a 110-second deadline and provider/database fetches share its abort signal.
- Deletion clears retrieval chunks before removing the private object, leaves a durable tombstone for retry cleanup, and is idempotent. Tombstone draining remains scheduled for the next backend slice.
- Upload compensation, processing failure state writes, and rate-lease releases use fresh `AbortSignal.timeout(10000)` service clients unconditionally, so a deadline firing during cleanup cannot cancel the cleanup request.
- Added Northstar Bikes fixtures in `demo/` and the native Node runner `scripts/ingestion-integration.mjs`. It creates isolated users, reads local keys from Supabase CLI JSON without printing them, and passed valid TXT/Markdown, multilingual chunk byte limits, invalid UTF-8, empty/oversized rejection, exact 1024-dimensional vectors, repeated processing, tenant isolation, deletion, and stale in-flight worker assertions.
- Latest `node scripts/ingestion-integration.mjs`, `node_modules\\.bin\\tsc.cmd --noEmit`, `pnpm build`, `node --check scripts/ingestion-integration.mjs`, and `git diff --check` passed. The sandboxed `pnpm typecheck` wrapper attempted a no-TTY dependency reinstall; the direct compiler check passed outside the sandbox.
