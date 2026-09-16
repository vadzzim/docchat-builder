import { errorResponse, HttpError, json, preflight, readBoundedBody, requirePost } from "../_shared/http.ts";
import { acquireRateLimit } from "../_shared/limits.ts";
import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { decodeUtf8, safeFileName } from "../_shared/text.ts";
import { uuidSchema } from "../_shared/validation.ts";

const maxSourceBytes = 102400;
const maxMultipartBytes = 125 * 1024;
const maxUploadMilliseconds = 110000;

function slotError(error: { message: string }): HttpError | Error {
  const message = error.message.toLowerCase();
  if (message.includes("access denied")) return new HttpError(404, "Bot not found.", "not_found");
  if (message.includes("limit")) return new HttpError(409, error.message, "document_limit_reached");
  return new Error("Document slot creation failed: " + error.message);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), maxUploadMilliseconds);
  let release: (() => Promise<void>) | undefined;
  let admin: ReturnType<typeof createAdminClient> | undefined;
  let ownerId = "";
  let documentId = "";
  let storagePath = "";
  try {
    requirePost(request);
    const auth = await requireUser(request, deadlineController.signal);
    admin = auth.admin;
    ownerId = auth.user.id;
    release = await acquireRateLimit(admin, "upload:" + ownerId, 20, 1);

    const boundedBody = await readBoundedBody(request, maxMultipartBytes, deadlineController.signal, 30000);
    if (boundedBody.byteLength === 0) throw new HttpError(400, "Choose a .txt or .md file.", "file_required");
    const formRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: boundedBody,
    });
    let form: FormData;
    try {
      form = await formRequest.formData();
    } catch {
      throw new HttpError(400, "Upload must use multipart form data.", "invalid_multipart");
    }

    const botIdValue = form.get("bot_id");
    const botId = uuidSchema.safeParse(typeof botIdValue === "string" ? botIdValue : "");
    if (!botId.success) throw new HttpError(400, "Bot id is invalid.", "validation_error");
    const fileValue = form.get("file");
    if (!(fileValue instanceof File)) throw new HttpError(400, "Choose a .txt or .md file.", "file_required");
    if (fileValue.size < 1) {
      throw new HttpError(400, "The document is empty.", "empty_document");
    }
    if (fileValue.size > maxSourceBytes) {
      throw new HttpError(413, "Source files must be between 1 byte and 100 KiB.", "source_too_large");
    }

    const { data: bot, error: botError } = await admin.from("bots")
      .select("id,account_id").eq("id", botId.data).maybeSingle();
    if (botError) throw new Error("Bot lookup failed: " + botError.message);
    if (!bot || bot.account_id !== ownerId) throw new HttpError(404, "Bot not found.", "not_found");

    const bytes = new Uint8Array(await fileValue.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > maxSourceBytes) {
      throw new HttpError(413, "Source files must be between 1 byte and 100 KiB.", "source_too_large");
    }
    decodeUtf8(bytes);
    const file = safeFileName(fileValue.name);
    documentId = crypto.randomUUID();
    storagePath = botId.data + "/" + documentId + "/" + file.fileName;

    const { error: slotFailure } = await admin.rpc("create_document_slot", {
      p_owner_id: ownerId,
      p_bot_id: botId.data,
      p_document_id: documentId,
      p_file_name: file.fileName,
      p_storage_path: storagePath,
      p_content_type: file.contentType,
      p_source_size_bytes: bytes.byteLength,
    });
    if (slotFailure) throw slotError(slotFailure);

    const { error: uploadError } = await admin.storage.from("documents").upload(storagePath, bytes, {
      contentType: file.contentType,
      cacheControl: "3600",
      upsert: false,
    });
    if (uploadError) throw new Error("Source storage upload failed: " + uploadError.message);

    const { data: current, error: currentError } = await admin.from("documents")
      .select("*").eq("id", documentId).eq("bot_id", botId.data).maybeSingle();
    if (currentError) throw new Error("Upload state check failed: " + currentError.message);
    if (!current || current.status !== "pending") {
      await admin.storage.from("documents").remove([storagePath]);
      throw new HttpError(409, "The upload was cancelled. Try again.", "upload_cancelled");
    }
    return json(request, { document: current, next: "POST /functions/v1/process-document" }, 201);
  } catch (error) {
    if (admin && documentId) {
      // The row may have been deleted while Storage accepted the PUT. Remove the
      // object and cancel a still-pending slot; deletion tombstones remain for cleanup.
      const cleanupAdmin = createAdminClient(AbortSignal.timeout(10000));
      const cleanup = await Promise.allSettled([
        ...(storagePath ? [cleanupAdmin.storage.from("documents").remove([storagePath])] : []),
        cleanupAdmin.rpc("cancel_document_upload", { p_owner_id: ownerId, p_document_id: documentId }),
      ]);
      for (const result of cleanup) {
        if (result.status === "fulfilled" && result.value.error) {
          console.error("Upload compensation failed:", result.value.error.message);
        } else if (result.status === "rejected") {
          console.error("Upload compensation failed:", result.reason);
        }
      }
    }
    return errorResponse(request, error);
  } finally {
    try {
      if (release) await release();
    } catch (releaseError) {
      console.error("Upload rate lease release failed:", releaseError);
    } finally {
      clearTimeout(deadlineTimer);
      deadlineController.abort();
    }
  }
});
