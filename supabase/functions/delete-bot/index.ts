import { errorResponse, HttpError, json, preflight, requirePost } from "../_shared/http.ts";
import { acquireRateLimit } from "../_shared/limits.ts";
import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { botIdSchema, parseJson } from "../_shared/validation.ts";

const maxDeleteMilliseconds = 60000;

type DeleteBotResult = {
  deleted?: boolean;
  already_deleted?: boolean;
  storage_paths?: unknown;
};

function deleteError(error: { code?: string; message: string }): HttpError | Error {
  if (error.code === "42501" || error.message.toLowerCase().includes("access denied")) {
    return new HttpError(404, "Bot not found.", "not_found");
  }
  return new Error("Bot delete failed: " + error.message);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), maxDeleteMilliseconds);
  let release: (() => Promise<void>) | undefined;
  try {
    requirePost(request);
    const requestSignal = AbortSignal.any([request.signal, deadlineController.signal]);
    const { user, admin } = await requireUser(request, requestSignal);
    const input = await parseJson(request, botIdSchema, 20000, requestSignal);
    release = await acquireRateLimit(admin, "delete-bot:" + user.id, 10, 1);

    const { data, error } = await admin.rpc("delete_bot", {
      p_owner_id: user.id,
      p_bot_id: input.bot_id,
    });
    if (error) throw deleteError(error);
    const result = data as DeleteBotResult | null;
    if (!result || (result.deleted !== true && result.already_deleted !== true)) {
      throw new Error("Bot delete returned an invalid result.");
    }

    const alreadyDeleted = result.deleted !== true;
    const paths = alreadyDeleted ? [] : result.storage_paths;
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || path.length < 1 || path.length > 512) || paths.length > 25) {
      throw new Error("Bot delete returned invalid storage paths.");
    }

    let storageRemoved: boolean | null = alreadyDeleted ? null : true;
    if (!alreadyDeleted && paths.length > 0) {
      try {
        const { error: storageError } = await admin.storage.from("documents").remove(paths);
        if (storageError) {
          storageRemoved = false;
          console.error("Bot source cleanup is pending:", storageError.message);
        }
      } catch (storageError) {
        storageRemoved = false;
        console.error("Bot source cleanup is pending:", storageError);
      }
    }

    return json(request, {
      bot_id: input.bot_id,
      deleted: true,
      already_deleted: alreadyDeleted,
      storage_removed: storageRemoved,
      cleanup_pending: alreadyDeleted || paths.length > 0,
      message: alreadyDeleted
        ? "This bot was already deleted. Any source-file cleanup remains queued for verification."
        : storageRemoved === false
          ? "Bot was deleted. Source-file cleanup is pending and will be retried."
          : "Bot and its source files were deleted.",
    });
  } catch (error) {
    return errorResponse(request, error);
  } finally {
    try {
      if (release) await release();
    } catch (releaseError) {
      console.error("Bot delete rate lease release failed:", releaseError);
    } finally {
      clearTimeout(deadlineTimer);
      deadlineController.abort();
    }
  }
});
