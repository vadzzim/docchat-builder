# Operations notes

These notes describe the failure evidence the local MVP exposes. They are deliberately small: the service does not claim to provide a durable queue, distributed tracing, metrics backend, or automatic retry policy.

## Request correlation

`chat` and `process-document` generate a fresh UUID for every non-preflight request. The ID is returned in `X-Request-Id`; chat also includes it in the SSE `meta` and `error` events. CORS exposes the header to the dashboard and widget. The owner and widget show the ID beside a surfaced failure so an operator can find the matching local function log record.

The JSON trace records only an endpoint, UUID identifiers that were authorized before logging, event (`stage_start`, `stage_end`, or one `terminal`), monotonic elapsed milliseconds, stage/status/outcome, error code, time to first token, quota/save/delivery status, chunk count, and cleanup failure count. It does not record prompts, answer tokens, source documents, credentials, user emails, or exception messages. The terminal event is emitted once after cleanup. A missing terminal event identifies a killed or hung worker; the last stage start remains useful evidence.

Quota and save status are intentionally explicit:

- `quota_status=committed` means the reservation RPC returned success; a transport failure is `unknown`, and a validated limit rejection is `rejected`.
- `save_status=confirmed` means the save RPC returned `true`; a transport failure is `unknown` because the database may have committed, and `false` is `rejected`.
- `delivery_status=queued` means the response event was accepted by the server stream; a failed enqueue or lost connection is `unknown`. A queued `done` event does not prove that the browser received it.

## Recovery after an interrupted request

Use the request ID to locate the terminal trace and its last stage. In the local Docker project, filter the Edge runtime output without printing the complete log or any environment values:

```powershell
docker logs supabase_edge_runtime_docchat-local 2>&1 | Select-String "<request-id>"
```

If save or delivery is `unknown`, use the authorized conversation ID from the trace to inspect the owner's History before deciding whether a manual retry is appropriate. Owner History covers owner conversations only; a visitor conversation ID requires an authorized operator or service-role database lookup, and the widget has no self-service history. A quota reservation can remain committed even when the provider or client fails. The service does not automatically retry because doing so could duplicate a saved exchange or consume another quota unit. The widget reports unknown save status without telling visitors to reload or claiming that nothing was saved.

For a local Ollama failure, keep the application and Docker project running and check the native service and loaded models:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/version
Invoke-RestMethod http://127.0.0.1:11434/api/tags | Select-Object -ExpandProperty models
ollama list
```

After correcting the host service or `OLLAMA_BASE_URL`, run the real `npm run test:chat` (and `npm run test:ingestion` when ingestion is affected), then retry from the UI and correlate the new request ID. `npm run test:provider` exercises only the deterministic stub contract; it does not reach Ollama. For Storage unavailability, leave the document in its failed/pending state, restore Storage, and use the document Retry control; scheduled tombstone cleanup will retry eligible stale objects. `npm run test:cleanup` creates and deletes its own fixtures and is not a repair tool for customer documents. For an expired processing lease, wait past its approximately 180-second `lease_expires_at`, then retry the document in Knowledge so the next generation can claim it.

Rate-limit lease cleanup remains sequential and bounded. Cleanup failures are counted in the terminal event; they do not rewrite the request's original outcome.

## Synchronous boundary and provider decision

Document processing remains synchronous with a 110-second deadline and a 180-second lease. Chat remains synchronous with its existing 120-second deadline. The local mixed-load check used the exact 100 KiB `--max-source` fixture while a real chat request ran concurrently; both suites passed on the warm development GPU (ingestion suite wall time about 60 seconds, chat suite about 20 seconds). This is a single local smoke run, not a throughput or production-capacity claim, so the MVP keeps the queue decision deferred.

The implemented AI boundary is Ollama's `/api/embed` and streaming `/api/chat` HTTP API. OpenRouter is a deployment target in the product plan, but it does not share this contract automatically: an adapter, streaming and embedding compatibility checks, model and policy verification, and reindex checks are required before enabling it. A general provider framework and durable worker are deferred until those constraints require them.

## Decisions and revisit conditions

| Decision | Tradeoff | Revisit when |
| --- | --- | --- |
| Keep local inference on native Ollama endpoints. | Local setup is simple and reproducible, while OpenRouter still needs an adapter and compatibility checks. | A cloud deployment is authorized and its model, data policy, streaming, embedding, and reindex checks pass. |
| Keep document ingestion synchronous with its 110-second deadline and 180-second lease. | Large or slow files can time out and require a UI retry; there is no durable queue. | Real workload evidence shows repeated deadline failures or throughput pressure that justifies a durable worker. |
| Keep visitor access behind an origin-bound bearer session and server-side bot checks. | The widget has no visitor history or recovery path, and origin restrictions are only one abuse-control layer. | A product requirement adds visitor history, multiple operators, or a trusted deployment proxy and identity boundary. |
| Charge a dispatched AI attempt after quota reservation and do not retry automatically. | Provider failure or a later disconnect can consume quota; a save or delivery `unknown` needs investigation. | A durable operation ID, saved result record, and explicit policy for unknown external dispatch make safe replay possible. |
| Defer logical-operation idempotency. | A new send is a new attempt; an owner can check History for an `unknown` save, with no exactly-once promise. | Add an ownership- and payload-bound operation ID, durable saved-result state, and an unknown-dispatch policy before enabling replay. |
