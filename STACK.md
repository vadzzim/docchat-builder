# MVP stack

Technical decisions for the project. Original requirements are in [BRIEF.md](BRIEF.md), agreed MVP scope is in [MVP.md](MVP.md), and agent workflow rules are in [AGENTS.md](AGENTS.md).

## Core stack

| Area | Choice | Purpose |
| --- | --- | --- |
| Application | Next.js App Router + TypeScript | Landing page, dashboard, and chat interface |
| UI | Tailwind CSS + selected shadcn/ui components | Styling and basic components |
| Server logic | Supabase Edge Functions | Document processing, chat, limit enforcement, and billing |
| Database | Supabase Postgres + pgvector | Product data, document chunks, and vector search |
| Authentication | Supabase Auth | Registration and sign-in |
| Files | Supabase Storage, private bucket | Source documents |
| Data access | Supabase SDK + SQL migrations + RLS | Data operations and tenant isolation |
| Validation | Zod | Input validation at application boundaries |
| Local AI | Ollama: `qwen3:0.6b` with thinking disabled + `bge-m3` | Local answer generation and embeddings; no cloud AI key required |
| Deployed AI | OpenRouter | Cloud answers and embeddings; exact models selected and verified before deployment |
| Widget | Small JavaScript loader + iframe | Embedding chat on external websites |
| Billing | Stripe Checkout in test mode | Preferred option; mock billing is acceptable if Stripe is unavailable |
| Verification | Playwright + targeted logic tests | Main user journey and critical server rules |
| Hosting | Vercel + Supabase | Frontend and backend deployment |

## Architecture boundaries

- Use one repository. Business logic lives in Supabase Edge Functions and Postgres; do not duplicate it in Next.js API routes.
- Standard dashboard operations use the Supabase SDK with RLS. Privileged operations require server-side checks of identity, data ownership, and limits.
- Dashboard chat and the widget share the same server implementation for retrieval and answer generation.
- AI/Stripe secrets and privileged Supabase keys remain server-side.
- Use Zod for server-side input validation. Schemas can be reused in forms; client-side validation does not replace server-side validation.
- Public chat has server-side request and AI usage limits. A public bot identifier does not grant access to bot management or source files.

## Document processing

- The MVP accepts only UTF-8 `.txt` and `.md` files. PDF, DOCX, OCR, and website imports are deferred.
- Flow: upload to Storage → authorized Edge Function invocation → read and split text → generate embeddings → store chunks in Postgres → mark ready.
- Persist processing status, provide clear errors, and allow retries without duplicate data. Partially processed documents must not participate in retrieval.
- Enforce file size and total knowledge limits on the server. Initial product limits are in MVP.md (100 KiB per document); validate them through end-to-end processing checks and embedding API limits before launch.
- Verify that processing fits within Edge Function limits. Do not treat background execution without completion guarantees as a substitute for a durable queue.

## AI configuration and validation

- Use one local Ollama instance for chat and embeddings. Start with `qwen3:0.6b` with thinking explicitly disabled; keep `qwen2.5:1.5b` as the comparison candidate.
- Use `bge-m3` dense embeddings with 1024 dimensions for both document chunks and queries.
- Compare both chat models on the same 15 questions covering direct answers, multiple sources, and missing information. Record answer correctness, unsupported claims, source accuracy, and response time. The initial model choice is not a claim of verified quality or speed.
- Measure memory use and latency with both embedding and chat workloads on the actual development machine. Keep initial context and batches small.
- Keep server-side endpoint URLs, model identifiers, and credentials configurable for local Ollama and deployed OpenRouter. Reuse compatible API calls where supported; verify streaming and embedding response formats. Do not build a general provider framework.
- Local Supabase Edge Functions must reach Ollama through an address accessible from their container; container localhost is not the Windows host. Hosted functions must use the cloud endpoint, not the developer's machine.
- Before deployment, select available OpenRouter models and verify quotas, data policies, cost, and the complete user journey. Cloud credentials are only required for that integration stage.
- Switching chat models requires repeating the answer-quality checks. Switching embedding models or implementations requires compatibility checks and reindexing when needed; matching model names or vector dimensions alone do not establish compatibility. Never mix incompatible document and query vectors.
- Local models process text on the development machine. When cloud AI is enabled, retrieved source excerpts are sent to the chat provider; use synthetic demo documents until provider data policies have been reviewed.

## Deferred additions

- Trigger.dev: reconsider for demanding formats, larger documents, or a durable background queue.
- A separate backend service, ORM, vector database, LangChain, and global UI state store.
- A general multi-provider AI framework and additional services without a concrete need.

## Decisions before implementation

- Validate the local AI configuration above; select and verify OpenRouter models before cloud deployment.
- Confirm Stripe access; clearly label demonstration billing if Stripe is unavailable.
- Validate the initial document and plan limits in MVP.md. Pin dependency versions in the manifest and lockfile when initializing the project.

Update this file when the agreed stack changes so technical decisions remain in one place.
