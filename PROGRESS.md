# DocChat progress

## Completed

- Next.js 16 App Router, TypeScript, Tailwind, Supabase local project, private Storage, RLS, tenant isolation, and service-only backend RPCs are in place. Local ports are API 55321, Postgres 55322, Studio 55323, and Mailpit 55324.
- Owner auth, one-bot dashboard, UTF-8 TXT/Markdown ingestion, 1024-dimensional `bge-m3` retrieval, grounded streaming chat, origin-bound visitor sessions, publishing, the external widget, mock billing, bot deletion, tombstones, 30-day retention, and scheduled cleanup are implemented.
- `README.md`, `VALIDATION.md`, `MODEL_EVALUATION.md`, and `WALKTHROUGH.md` provide the reproducible local handoff. `docs/model-evaluation.json` remains the canonical manually assessed record.
- Native runners cover ingestion, chat, billing, cleanup, browser journey, and direct Ollama model comparison. Raw model reports are written to ignored local `test-results/` files.

## Evidence

- Signup confirmation and recovery, tenant isolation, owner history, three real Northstar fixtures, source citations, visitor origin/session boundaries, no visitor owner bearer, mock plan preservation, publish/unpublish, and bot deletion passed in local browser/API checks.
- All 12 public tables have RLS; anonymous reads and privileged RPC execution are denied. Storage outage recovery retained and then drained a tombstone. The scheduled cron call returned HTTP 200 after removing 15 queued objects.
- A 100 KiB ASCII source processed to 197 chunks in about 84.5 seconds; a 100 KiB Chinese UTF-8 source processed to 197 byte-bounded chunks in about 81.4 seconds. Tail facts were retrievable and partial chunks stayed hidden.
- The selected qwen3 model is documented with the 15-question comparison and known conditional-policy/language limitations. No cloud provider, SMTP, Stripe payment, or production deployment has been validated.

## Final acceptance

- Frozen dependency installation, TypeScript, production build, backend integration runners, final live browser runner, 15-question/two-model runner, script syntax, and diff checks passed. Independent review accepted substantive changes and the final verification scripts.
- Root repeated the real production-browser journey and visually checked all ten PNGs now included in `docs/screenshots/`. The app runs on port 3000; the published Northstar demo runs on 3001.
- No local implementation blocker remains. Limitations are documented: small-model factual/language errors, synchronous 110-second ingestion with a 180-second retry lease, and unvalidated cloud/email/payment integrations. Billing is explicitly mock.
- Completed stages have local commits. No paid service, cloud deployment, or git push was performed. Next step: use the local MVP and its documented checks; cloud validation is deferred until separately authorized.
