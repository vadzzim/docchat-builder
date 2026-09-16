import { embed, vectorLiteral } from "../_shared/ai.ts";
import { errorResponse, HttpError, json, preflight, requirePost } from "../_shared/http.ts";
import { acquireRateLimit } from "../_shared/limits.ts";
import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { decodeUtf8, splitText } from "../_shared/text.ts";
import { documentIdSchema, parseJson } from "../_shared/validation.ts";

const maxProcessMilliseconds = 110000;
const processLeaseSeconds = 180;
const embeddingBatchSize = 8;

type ClaimResult = {
  claimed?: boolean;
  status?: string;
  document_id?: string;
  bot_id?: string;
  storage_path?: string;
  generation?: number;
};

function claimError(error: { message: string }): HttpError | Error {
  if (error.message.toLowerCase().includes("access denied")) {
    return new HttpError(404, "Document not found.", "not_found");
  }
  return new Error("Document claim failed: " + error.message);
}

function processingError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  return new HttpError(502, "Document processing failed. You can retry it.", "processing_failed");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), maxProcessMilliseconds);
  let release: (() => Promise<void>) | undefined;
  let admin: ReturnType<typeof createAdminClient> | undefined;
  let ownerId = "";
  let documentId = "";
  let leaseId = "";
  let generation = 0;
  let claimed = false;
  try {
    requirePost(request);
    const auth = await requireUser(request, deadlineController.signal);
    admin = auth.admin;
    ownerId = auth.user.id;
    const input = await parseJson(request, documentIdSchema);
    documentId = input.document_id;
    release = await acquireRateLimit(admin, "process:" + ownerId, 20, 1);

    const { data: document, error: documentError } = await admin.from("documents")
      .select("id,bot_id,storage_path,status")
      .eq("id", documentId).maybeSingle();
    if (documentError) throw new Error("Document lookup failed: " + documentError.message);
    if (!document) throw new HttpError(404, "Document not found.", "not_found");
    const { data: bot, error: botError } = await admin.from("bots")
      .select("id,account_id").eq("id", document.bot_id).maybeSingle();
    if (botError) throw new Error("Bot lookup failed: " + botError.message);
    if (!bot || bot.account_id !== ownerId) throw new HttpError(404, "Document not found.", "not_found");

    leaseId = crypto.randomUUID();
    const { data: claim, error: claimFailure } = await admin.rpc("claim_document_processing", {
      p_owner_id: ownerId,
      p_document_id: documentId,
      p_lease_id: leaseId,
      p_lease_seconds: processLeaseSeconds,
    });
    if (claimFailure) throw claimError(claimFailure);
    const claimedDocument = claim as ClaimResult | null;
    if (!claimedDocument?.claimed) {
      return json(request, {
        document_id: documentId,
        status: claimedDocument?.status ?? document.status,
        idempotent: claimedDocument?.status === "ready",
      }, claimedDocument?.status === "processing" ? 202 : 200);
    }
    claimed = true;
    generation = Number(claimedDocument.generation);
    const storagePath = claimedDocument.storage_path ?? document.storage_path;
    const deadline = Date.now() + maxProcessMilliseconds;
    const { data: source, error: sourceError } = await admin.storage.from("documents").download(storagePath);
    if (sourceError || !source) throw new Error("Source download failed: " + (sourceError?.message ?? "missing source"));
    const sourceBytes = new Uint8Array(await source.arrayBuffer());
    if (sourceBytes.byteLength < 1 || sourceBytes.byteLength > 102400) {
      throw new HttpError(422, "Stored source file is outside the allowed size.", "invalid_source");
    }
    const text = decodeUtf8(sourceBytes);
    const chunks = splitText(text, 600, 80);
    if (chunks.length === 0) throw new HttpError(422, "The document is empty.", "empty_document");

    for (let offset = 0; offset < chunks.length; offset += embeddingBatchSize) {
      if (Date.now() >= deadline) throw new HttpError(504, "Document processing timed out. Retry it.", "processing_timeout");
      const batch = chunks.slice(offset, offset + embeddingBatchSize);
      const vectors = await embed(batch, deadlineController.signal);
      if (vectors.length !== batch.length) throw new Error("Embedding count did not match chunk count.");
      const rows = batch.map((content, index) => ({
        chunk_index: offset + index,
        content,
        embedding: vectorLiteral(vectors[index]),
      }));
      const { data: inserted, error: insertError } = await admin.rpc("insert_document_chunks", {
        p_document_id: documentId,
        p_lease_id: leaseId,
        p_generation: generation,
        p_chunks: rows,
      });
      if (insertError) throw new Error("Chunk insert failed: " + insertError.message);
      if (inserted !== true) {
        throw new HttpError(409, "Document processing was cancelled. Retry the upload.", "processing_cancelled");
      }
    }

    if (Date.now() >= deadline) throw new HttpError(504, "Document processing timed out. Retry it.", "processing_timeout");
    const { data: finalized, error: finalizeError } = await admin.rpc("finalize_document_processing", {
      p_document_id: documentId,
      p_lease_id: leaseId,
      p_generation: generation,
      p_chunk_count: chunks.length,
    });
    if (finalizeError) throw new Error("Document finalize failed: " + finalizeError.message);
    if (finalized !== true) {
      throw new HttpError(409, "Document processing was cancelled. Retry the upload.", "processing_cancelled");
    }
    return json(request, { document_id: documentId, status: "ready", chunk_count: chunks.length });
  } catch (error) {
    if (admin && claimed && leaseId && generation > 0) {
      const failureAdmin = createAdminClient(AbortSignal.timeout(10000));
      const { error: failure } = await failureAdmin.rpc("fail_document_processing", {
        p_document_id: documentId,
        p_lease_id: leaseId,
        p_generation: generation,
        p_error: error instanceof HttpError ? error.message : "Document processing failed.",
      });
      if (failure) console.error("Document failure state update failed:", failure.message);
    }
    return errorResponse(request, processingError(error));
  } finally {
    try {
      if (release) await release();
    } catch (releaseError) {
      console.error("Process rate lease release failed:", releaseError);
    } finally {
      clearTimeout(deadlineTimer);
      deadlineController.abort();
    }
  }
});
