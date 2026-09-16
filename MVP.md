# MVP scope and acceptance

Product decisions delegated to the orchestrator. See BRIEF.md for the original brief and STACK.md for technical choices.

## Product

- Working name: DocChat. This is a placeholder, not a verified brand or domain.
- Audience: small businesses that need website support answers from their own documentation.
- English interface, landing page, documentation, and demo. Answers follow the question's language where supported by the selected model.
- One account owner and one bot per account. No teams, invitations, or roles.
- Email/password authentication, email verification, password reset, and sign-out. Production email delivery must be configured and tested before launch.

## Core experience

1. Register and create a bot with a name, greeting, and accent color.
2. Upload UTF-8 TXT or Markdown documents and see processing status and clear errors.
3. Ask questions in the dashboard and receive streaming answers grounded in ready documents, with source names and relevant excerpts.
4. Copy an embed snippet and use the same chat on an external test page.
5. View usage and try a clearly labeled test upgrade.

- No user-editable system prompt, website crawler, PDF, OCR, or external knowledge connectors.
- Documents can be listed, deleted, and retried after processing failure. Replacement means deleting the old document and uploading a new one.
- Return a clear insufficient-information response when retrieval does not support an answer. Treat uploaded text as untrusted content, not instructions.
- Publishing is explicit and disabled by default. Explain that answers and cited excerpts from uploaded knowledge become available to visitors when published; original files remain private.
- Bot owners can disable public chat and configure allowed website origins. Origin restrictions supplement server-side abuse controls; they are not authentication.
- Save owner chat history. Visitor sessions use scoped, unguessable credentials and cannot read other sessions. No owner-facing visitor inbox or analytics dashboard.
- Retain conversations for 30 days and implement cleanup. Deleting a bot removes its conversations, documents, chunks, and stored files. Document deletion removes source data from retrieval; already generated chat messages remain until conversation cleanup.

## Initial limits and billing

These are product defaults to validate during implementation, not claims about provider capacity or profitability.

| Limit | Free | Pro (test) |
| --- | --- | --- |
| Bots | 1 | 1 |
| Documents | 5 | 25 |
| Source file size | 100 KiB | 100 KiB |
| Total source text | 500 KiB | 2,500 KiB |
| AI requests per UTC calendar month | 100 | 1,000 |
| Illustrative monthly price | $0 | $19, no live charge |

- Count dashboard and widget AI requests against the same allowance. Atomically reserve quota before dispatch; requests rejected before AI dispatch do not consume it. Requests dispatched to the provider count even if the client disconnects or the provider fails.
- Enforce input, context, output, ingestion, concurrency, and request-rate limits on the server. Select technical thresholds during integration checks; message quotas alone are not a spend cap.
- Use Stripe test Checkout and verified webhooks if access is available. Otherwise use explicitly labeled mock billing with no payment details collected. No live payments in the MVP.
- A downgrade preserves existing data but prevents new uploads above the lower limits. Monthly request counts do not reset on plan changes.

## Acceptance

- Complete the registration → upload → grounded answer → external embed journey with real services.
- Validate local chat candidates with the 15-question comparison defined in STACK.md. Repeat quality and end-to-end checks with the selected OpenRouter models before deployment.
- Verify tenant isolation, public/private access, quota enforcement under concurrent requests, and billing state changes.
- Demonstrate insufficient-information responses, source references, empty files, invalid encoding, oversized uploads, and provider errors.
- Retry interrupted ingestion without duplicates; expose only completely processed documents and prevent deleted documents from being recreated by in-flight work.
- Provide usable mobile layouts, keyboard access, and clear loading, empty, and error states.
- Deliver a written walkthrough with screenshots and synthetic company documents. Video is deferred unless requested.

## External prerequisites

- Local development uses Supabase CLI with Docker and Ollama; cloud Supabase, Vercel, and AI credentials are not required to start. AI models and their validation procedure are defined in STACK.md.
- Deployment requires an authorized Supabase project, a frontend deployment account, production email configuration for authentication, and an OpenRouter API key. The orchestrator selects cloud models after availability and quality/cost checks.
- Stripe test access, if available; otherwise proceed with mock billing.
- An owner-approved spending ceiling before incurring service costs. Do not purchase plans or enable live payments without explicit authorization.
- Use a hosting-provided URL initially. Custom domain, brand assets, and customer documents are not prerequisites; use synthetic content for the demo.

Store credentials through local environment configuration or provider secret stores, never in tracked files or chat messages. Account access and budget are external prerequisites; they do not block local UI and business-logic work.
