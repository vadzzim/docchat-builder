import { errorResponse, HttpError, json, requirePost } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";

const cleanupGraceMilliseconds = 5 * 60 * 1000;
const cleanupBatchSize = 25;
const cleanupLeaseSeconds = 120;
const cleanupDeadlineMilliseconds = 50000;

function secretMatches(expected: string, supplied: string): boolean {
  let difference = expected.length ^ supplied.length;
  const length = Math.max(expected.length, supplied.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expected.charCodeAt(index) || 0) ^ (supplied.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function requireCronSecret(request: Request): void {
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  if (expected.length < 32) {
    throw new HttpError(503, "Storage cleanup is not configured.", "cron_unconfigured");
  }
  const supplied = request.headers.get("x-cron-secret") ?? "";
  if (!secretMatches(expected, supplied)) {
    throw new HttpError(401, "Cleanup authorization failed.", "cron_unauthorized");
  }
}

type Tombstone = { storage_path?: unknown; created_at?: string };

Deno.serve(async (request) => {
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), cleanupDeadlineMilliseconds);
  const leaseId = crypto.randomUUID();
  let acquired = false;
  try {
    requirePost(request);
    requireCronSecret(request);
    const signal = AbortSignal.any([request.signal, deadlineController.signal]);
    const admin = createAdminClient(signal);
    const { data: lease, error: leaseError } = await admin.rpc("acquire_storage_cleanup_lease", {
      p_lease_id: leaseId,
      p_lease_seconds: cleanupLeaseSeconds,
    });
    if (leaseError) throw new Error("Storage cleanup lease failed: " + leaseError.message);
    if (lease !== true) {
      return json(request, { skipped: true, reason: "lease_busy", processed: 0, removed: 0, failed: 0 }, 200, false);
    }
    acquired = true;

    const cutoff = new Date(Date.now() - cleanupGraceMilliseconds).toISOString();
    const { data: rows, error: listError } = await admin.from("deleted_storage_objects")
      .select("storage_path,created_at")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(cleanupBatchSize);
    if (listError) throw new Error("Storage cleanup list failed: " + listError.message);

    let processed = 0;
    let removed = 0;
    let failed = 0;
    for (const row of (rows ?? []) as Tombstone[]) {
      if (signal.aborted) break;
      processed += 1;
      const path = row.storage_path;
      if (typeof path !== "string" || path.length < 1 || path.length > 512) {
        failed += 1;
        console.error("Storage cleanup skipped an invalid tombstone path.");
        continue;
      }
      try {
        const { error: storageError } = await admin.storage.from("documents").remove([path]);
        if (storageError) throw new Error(storageError.message);
        const { error: completeError } = await admin.rpc("complete_storage_cleanup", {
          p_storage_path: path,
        });
        if (completeError) throw new Error("Tombstone finalize failed: " + completeError.message);
        removed += 1;
      } catch (error) {
        failed += 1;
        console.error("Storage cleanup item failed:", error);
      }
    }

    return json(request, {
      skipped: false,
      processed,
      removed,
      failed,
      timed_out: signal.aborted,
    }, 200, false);
  } catch (error) {
    return errorResponse(request, error, false);
  } finally {
    if (acquired) {
      try {
        const releaseAdmin = createAdminClient(AbortSignal.timeout(10000));
        const { error } = await releaseAdmin.rpc("release_storage_cleanup_lease", { p_lease_id: leaseId });
        if (error) console.error("Storage cleanup lease release failed:", error.message);
      } catch (error) {
        console.error("Storage cleanup lease release failed:", error);
      }
    }
    clearTimeout(deadlineTimer);
    deadlineController.abort();
  }
});
