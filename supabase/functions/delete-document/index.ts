import { errorResponse, HttpError, json, preflight, requirePost } from "../_shared/http.ts";
import { acquireRateLimit } from "../_shared/limits.ts";
import { requireUser } from "../_shared/supabase.ts";
import { documentIdSchema, parseJson } from "../_shared/validation.ts";

const maxDeleteMilliseconds = 60000;

function deleteError(error: { message: string }): HttpError | Error {
  if (error.message.toLowerCase().includes("access denied")) {
    return new HttpError(404, "Document not found.", "not_found");
  }
  return new Error("Document delete failed: " + error.message);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), maxDeleteMilliseconds);
  let release: (() => Promise<void>) | undefined;
  try {
    requirePost(request);
    const { user, admin } = await requireUser(request, deadlineController.signal);
    const input = await parseJson(request, documentIdSchema);
    release = await acquireRateLimit(admin, "delete:" + user.id, 30, 2);

    const { data: document, error: documentError } = await admin.from("documents")
      .select("id,bot_id").eq("id", input.document_id).maybeSingle();
    if (documentError) throw new Error("Document lookup failed: " + documentError.message);
    if (!document) return json(request, { document_id: input.document_id, deleted: true, already_deleted: true });
    const { data: bot, error: botError } = await admin.from("bots")
      .select("id,account_id").eq("id", document.bot_id).maybeSingle();
    if (botError) throw new Error("Bot lookup failed: " + botError.message);
    if (!bot || bot.account_id !== user.id) throw new HttpError(404, "Document not found.", "not_found");

    const { data: storagePath, error: beginError } = await admin.rpc("begin_document_delete", {
      p_owner_id: user.id,
      p_document_id: input.document_id,
    });
    if (beginError) throw deleteError(beginError);
    if (typeof storagePath !== "string" || !storagePath) throw new Error("Document delete path was missing.");

    const { error: storageError } = await admin.storage.from("documents").remove([storagePath]);
    if (storageError) {
      // The row remains deleting and the tombstone remains durable; cleanup can retry.
      throw new HttpError(502, "The source file could not be removed yet. Try again.", "storage_delete_failed");
    }
    const { error: finishError } = await admin.rpc("finish_document_delete", {
      p_owner_id: user.id,
      p_document_id: input.document_id,
    });
    if (finishError) throw new Error("Document delete finalize failed: " + finishError.message);
    return json(request, {
      document_id: input.document_id,
      deleted: true,
      storage_removed: true,
      cleanup_pending: true,
    });
  } catch (error) {
    return errorResponse(request, error);
  } finally {
    try {
      if (release) await release();
    } catch (releaseError) {
      console.error("Delete rate lease release failed:", releaseError);
    } finally {
      clearTimeout(deadlineTimer);
      deadlineController.abort();
    }
  }
});
