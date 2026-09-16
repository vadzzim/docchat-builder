import { errorResponse, json, preflight, requirePost } from "../_shared/http.ts";
import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { createBotSchema, parseJson } from "../_shared/validation.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    requirePost(request);
    const { user, admin } = await requireUser(request);
    const input = await parseJson(request, createBotSchema);
    await admin.from("accounts").upsert({ id: user.id }, { onConflict: "id" });

    const { data, error } = await admin.from("bots").insert({
      account_id: user.id,
      name: input.name,
      greeting: input.greeting,
      accent_color: input.accent_color,
      public_enabled: false,
      allowed_origins: [],
    }).select().single();

    if (error) {
      if (error.code === "23505") {
        return json(request, { error: "Your account already has a bot.", code: "bot_limit_reached" }, 409);
      }
      throw new Error("Bot creation failed: " + error.message);
    }
    return json(request, { bot: data }, 201);
  } catch (error) {
    return errorResponse(request, error);
  }
});

