# DocChat progress

## Current boundary

- Next.js 16 App Router, TypeScript, Tailwind, and three small UI primitives are scaffolded.
- Supabase local config uses project `docchat-local` and ports 55321 (API), 55322 (Postgres), 55323 (Studio), and 55324 (mail).
- The initial migration is applied locally. It creates the one-account/one-bot schema, private `documents` Storage bucket, owner-only RLS reads, service-only write/RPC access, UTF-8 source limits, pgvector chunks, visitor session storage, owner/public conversations, monthly quota reservations, expiring concurrency leases, processing leases/generations, deletion tombstones, 30-day cleanup, and the 03:00 `pg_cron` job.
- Edge entrypoints validate bearer sessions for owner operations; visitor session and chat entrypoints use their scoped server-side checks.
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

## Chat slice

- Added `public-session` for published, origin-bound visitor sessions. The loader request must carry an HTTP `Origin` equal to its normalized `embed_origin`; bot and hashed-IP leases are reserved before the bot lookup, and the response contains only the visitor token and safe widget settings.
- Added streaming `chat` for owner and visitor actors. It validates the current publication/session binding, checks ready knowledge and conversation ownership, acquires actor and bot leases before history, reserves shared monthly quota immediately before the first model call, retrieves up to three ready chunks, streams strict Ollama output over `meta`/`token`/`done`/`error` SSE events, and saves only completed exchanges with citations.
- Visitor chat accepts the configured `WIDGET_ORIGIN` (default `http://127.0.0.1:3000`) or the session's bound embedding origin. Provider cancellation, quota reservation, stable message ordering, and current publication checks remain server-side.
- Added the `save_chat_exchange` RPC and identity-backed `messages.message_order` index, and registered only `public-session` and `chat` in the local Supabase config. Added `scripts/chat-integration.mjs` for isolated live owner/visitor, origin, quota, concurrency, history, and cleanup checks.
- Focused checks passed for `node --check scripts/chat-integration.mjs`, the direct TypeScript compiler, and `git diff --check`. The full `node scripts/chat-integration.mjs` runner passed against local Supabase, Edge Functions, Storage, and Ollama, covering owner/visitor publication, origin, insufficient-information, conversation isolation, quota, concurrency, ordered persistence, no-document rejection, and cleanup.

### Chat contracts

- `POST /functions/v1/public-session` with `{ "bot_id": uuid, "embed_origin": http(s) origin }` and matching HTTP `Origin` returns `201 { session_token, expires_at, bot: { name, greeting, accent_color } }`. The token is only usable for its bot and bound origin while the bot is published.
- `POST /functions/v1/chat` accepts `{ "bot_id": uuid, "message": string, "conversation_id"?: uuid, "session_token"?: string, "embed_origin"?: http(s) origin }`. Owners authenticate with a Supabase bearer token; visitors authenticate only with the session token and an allowed HTTP `Origin`.
- Chat success is `text/event-stream`: `meta { conversation_id }`, zero or more `token { token }`, and `done { citations, usage: { monthly_used, monthly_limit } }`. Failures during streaming use `error { error, code }`; pre-stream validation and access failures use JSON `{ error, code }`.

## Owner browser slice

- Added real Supabase email/password flows at `/auth`: sign-up with confirmation-email state, sign-in, forgot-password email, callback verification, expired-link errors, recovery password form, and sign-out. Reset links stay on the password form until the owner chooses to continue.
- Added the protected `/dashboard` owner shell. It creates the single bot through `create-bot`, reads bot/documents/conversations/usage through the browser SDK and RLS, and keeps the app's server operations in Edge Functions.
- Added responsive Knowledge and Chat tabs. Owners can upload bounded TXT/Markdown files, see the row immediately, process with bounded status polling, retry failures, and delete with a clear history-preservation notice. Plan limits and UTC monthly usage are visible and remain server-authoritative.
- Added `components/chat-panel.tsx` for owner bearer-authenticated SSE chat. It buffers UTF-8 SSE frames, requires a `done` event before marking an answer complete, keeps a visible incomplete marker on error/cancel, reloads ordered owner history by `message_order`, and renders source excerpts as plain text in accessible details.
- Added `lib/edge-client.ts` for browser-safe Edge Function calls; it sends only the public Supabase URL/anon key and never exposes service credentials. Local auth redirects explicitly allow both `127.0.0.1:3000` and `localhost:3000`.

Root's live browser checks covered confirmation and recovery links (including expired/reused and literal-percent errors), isolated owner signup and bot creation, three real document uploads and processing, grounded streamed answers with citations and restored history, insufficient-information responses, invalid/oversized input, sign-out/sign-in, and a 390px no-overflow layout. The direct TypeScript compiler and `pnpm build` pass for this slice.

## External widget and publishing slice

- Added a Settings tab for owner-editable bot name, greeting, accent color, allowed website origins, and explicit public-chat enable/disable. The confirmation copy explains that answers and cited excerpts become public, original files remain private, and origins supplement server-side controls rather than authenticate visitors.
- Added a selectable/copyable `widget.js` snippet. The loader derives the app origin from its own script URL, requests `public-session` from the actual embedding page without an anon key, and sends the visitor token to the iframe only after exact `event.source` and origin checks. The token is never placed in the iframe URL.
- Added `/widget` with a compact visitor chat that uses native fetch and the scoped visitor token only. The iframe validates its parent source and exact origin before accepting the session, streams buffered SSE answers, keeps incomplete replies visibly incomplete, supports source excerpts, New chat, close, Escape, and preserves state while hidden.
- The widget panel keeps its transcript scrollable while the composer stays visible, mounts safely when a snippet is placed in the document head, and bounds the loader's public-session request with a 15-second timeout.
- An expired visitor session clears its token, conversation, and transcript before showing an explicit reconnect action; it never retries the failed question with a replacement session.
- Added `demo/server.mjs` and `npm run demo`. It serves only the synthetic Northstar Bikes page on `127.0.0.1:3001`, reads `?bot_id=` or `DOCCHAT_BOT_ID`, and injects the actual local widget snippet. It does not expose filesystem routes.

Root verified the real external-page journey, private/published transitions, invalid origins, immediate unpublish, shared usage, owner/visitor history separation, absent owner Authorization headers, Escape/focus return, preserved hidden transcript, a 390px layout with visible composer, real expired-session renewal without the old conversation id, head placement, and recovery after a stalled session request. The demo rejects filesystem paths. Independent review findings were fixed and rechecked. TypeScript, production build, loader/demo syntax checks, and `git diff --check` pass.

## Mock billing slice

- Added owner-authenticated `POST /functions/v1/mock-billing` with `{ "plan": "free" | "pro" }`. The verified bearer user supplies the account id; caller-supplied `account_id` fields are rejected, and the browser never receives a service credential.
- Added service-only `set_mock_account_plan` RPC with an account-row lock. It changes only `accounts.plan`, preserving monthly usage, documents, conversations, and source files. The response explicitly marks the change as mock and uncharged.
- Added a Billing tab showing the Free `$0` and Pro `$19 / month (illustrative)` limits, current document/source/request usage, and the UTC monthly reset. Downgrades confirm that data is preserved and explain when Free uploads remain blocked above its limits; the UI refreshes the server plan and usage after a change.
- Added `scripts/billing-integration.mjs` and `npm run test:billing` coverage for unauthenticated and direct writes, account spoofing, usage-preserving plan changes, concurrent plan/quota locking, six Pro documents surviving downgrade, Free upload rejection at the cap, and slot release/recovery. The runner cleans test files, tombstones, and users without printing runtime keys.

Root verified real browser Free → Pro → Free transitions with unchanged usage and documents, the corrected 320px layout, and a failed post-mutation usage read that still displays the committed plan. Independent authorization/locking review passed. The live billing runner, TypeScript, production build, script syntax, and diff checks pass.

## Bot deletion and durable storage cleanup slice

- Added service-only `delete_bot(p_owner_id, p_bot_id)`, with account → document → bot locking to coordinate upload, processing, and document deletion races. It cascades bot data, returns its owned Storage paths in the same transaction, and leaves deletion tombstones for late uploads and retry cleanup. The owner `delete-bot` Edge endpoint confirms the verified owner, performs a bounded private Storage delete, reports pending cleanup truthfully on failures or repeated calls, and exposes a destructive Settings action that keeps the account active.
- Added cron-only `cleanup-storage`. It requires a configured 32-byte-plus `CRON_SECRET`, takes a single 120-second cleanup lease, drains at most 25 tombstones older than five minutes, removes each private object before calling `complete_storage_cleanup`, and retains failed markers. The migration installs `pg_net`, schedules the internal Kong request every minute, and extends its request timeout to cover the bounded handler.
- Replaced the retention routine so messages older than 30 days expire independently; conversations use their own activity age; expired or revoked visitor sessions remain while any conversation references them. Public IP limiting now uses only Kong's overwritten `x-real-ip`, avoiding spoofable `x-forwarded-for` rate keys.
- Added `scripts/local-setup.mjs` and `npm run setup:local`. It reads pinned Supabase CLI status in memory, updates only the browser URL/anon key, preserves unrelated env lines, generates or preserves the ignored `.env.functions.local` cron secret, and writes only the DocChat Vault secret. Serve the functions with `npx supabase@2.117.0 functions serve --env-file .env.functions.local` after applying migrations.
- Added `scripts/cleanup-integration.mjs` and `npm run test:cleanup`. The live runner passed isolated foreign-owner, cascade, controlled document-lock/delete concurrency, stale-worker, old-session, DB-only deletion followed by endpoint retry, young/aged tombstone, late-upload (including final object absence), untracked-Storage, retention, wrong/missing-secret, and cron-schedule checks without printing runtime keys. Root also observed the real minute `pg_cron` → `pg_net` invocation returning HTTP 200 with all queued tombstones removed.
- Applied migrations `20260916000500_bot_cleanup.sql` and corrective lock migration `20260916000600_bot_delete_lock.sql` locally. `node --check` for both native scripts, the direct TypeScript compiler, `pnpm build`, and `git diff --check` pass.

Root independently verified browser cancellation/confirmation and deletion during real processing, with the account remaining active and bot/document/chunk/Storage counts all zero. Forged forwarding headers now share Kong's canonical IP scope. All 12 public tables have RLS; cleanup and deletion RPCs deny browser roles. A real outage of only the verified DocChat Storage container retained the source and tombstone; restart and retry removed both. Independent review findings on lock ordering and repeated-delete copy were fixed and accepted.
