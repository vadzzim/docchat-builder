import { HttpError } from "./http.ts";
import { createAdminClient } from "./supabase.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";

export async function acquireRateLimit(
  admin: SupabaseClient,
  scopeKey: string,
  maxRequests: number,
  maxConcurrent: number,
): Promise<() => Promise<void>> {
  const { data, error } = await admin.rpc("reserve_rate_limit", {
    p_scope_key: scopeKey,
    p_window_seconds: 60,
    p_max_requests: maxRequests,
    p_max_concurrent: maxConcurrent,
  });
  if (error) throw new Error("Rate limit check failed: " + error.message);
  const result = data as { allowed?: boolean; reason?: string; retry_after_seconds?: number; lease_id?: string } | null;
  if (!result?.allowed) {
    const retry = Math.max(1, Number(result?.retry_after_seconds ?? 1));
    throw new HttpError(
      429,
      result?.reason === "concurrency" ? "Too many requests are running. Try again shortly." : "Too many requests. Try again shortly.",
      result?.reason === "concurrency" ? "concurrency_limited" : "rate_limited",
      { "Retry-After": String(retry) },
    );
  }
  if (!result.lease_id) throw new Error("Rate limit check did not return a lease token.");
  let released = false;
  return async () => {
    if (released) return;
    const releaseClient = createAdminClient(AbortSignal.timeout(10000));
    const { error } = await releaseClient.rpc("release_rate_limit", {
      p_scope_key: scopeKey,
      p_lease_id: result.lease_id,
    });
    if (error) {
      console.error("Rate limit lease release failed");
      throw new Error("Rate limit lease release failed");
    }
    released = true;
  };
}

export async function reserveQuota(admin: SupabaseClient, accountId: string): Promise<{ used: number; limit: number }> {
  const { data, error } = await admin.rpc("reserve_ai_request", { p_account_id: accountId });
  if (error) throw new Error("Quota check failed: " + error.message);
  const result = data as { allowed?: boolean; used?: number; limit?: number } | null;
  if (!result?.allowed) {
    throw new HttpError(
      429,
      "You have used this month's " + Number(result?.limit ?? 100) + " AI request allowance.",
      "monthly_quota_exhausted",
      { "Retry-After": "3600" },
    );
  }
  return { used: Number(result.used ?? 0), limit: Number(result.limit ?? 100) };
}
