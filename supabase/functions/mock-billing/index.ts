import { errorResponse, HttpError, json, preflight, requirePost } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";
import { mockBillingSchema, parseJson } from "../_shared/validation.ts";

type Plan = "free" | "pro";

function planLimits(plan: Plan) {
  return plan === "pro"
    ? { documents: 25, source_bytes: 2560000, monthly_requests: 1000 }
    : { documents: 5, source_bytes: 512000, monthly_requests: 100 };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    requirePost(request);
    const { user, admin } = await requireUser(request);
    const input = await parseJson(request, mockBillingSchema);
    const { data, error } = await admin.rpc("set_mock_account_plan", {
      p_account_id: user.id,
      p_plan: input.plan,
    });
    if (error) {
      if (error.code === "42501") throw new HttpError(404, "Account not found.", "not_found");
      throw new Error("Mock plan update failed: " + error.message);
    }
    const result = data as { account_id?: string; plan?: Plan } | null;
    if (!result || result.account_id !== user.id || (result.plan !== "free" && result.plan !== "pro")) {
      throw new Error("Mock plan update returned an invalid account.");
    }
    return json(request, {
      mock: true,
      charged: false,
      plan: result.plan,
      limits: planLimits(result.plan),
      message: "Mock plan changed. No charge was made.",
    });
  } catch (error) {
    return errorResponse(request, error);
  }
});

