import { errorResponse, HttpError, json, preflight, requirePost } from "../_shared/http.ts";
import { createAdminClient, requireUser } from "../_shared/supabase.ts";
import { botSettingsSchema, parseJson } from "../_shared/validation.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    requirePost(request);
    const { user, admin } = await requireUser(request);
    const input = await parseJson(request, botSettingsSchema);

    const { data: existing, error: fetchError } = await admin.from("bots")
      .select("id,name,greeting,accent_color,public_enabled,allowed_origins,account_id")
      .eq("id", input.bot_id).maybeSingle();
    if (fetchError) throw new Error("Bot lookup failed: " + fetchError.message);
    if (!existing || existing.account_id !== user.id) {
      throw new HttpError(404, "Bot not found.", "not_found");
    }

    const allowedOrigins = input.allowed_origins ?? (existing.allowed_origins as string[] ?? []);
    const publicEnabled = input.public_enabled ?? Boolean(existing.public_enabled);
    if (publicEnabled && allowedOrigins.length === 0) {
      throw new HttpError(400, "Add at least one website origin before publishing.", "origin_required");
    }
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.greeting !== undefined) updates.greeting = input.greeting;
    if (input.accent_color !== undefined) updates.accent_color = input.accent_color;
    if (input.public_enabled !== undefined) updates.public_enabled = input.public_enabled;
    if (input.allowed_origins !== undefined) updates.allowed_origins = input.allowed_origins;

    const { data, error } = await admin.from("bots").update(updates)
      .eq("id", input.bot_id).eq("account_id", user.id).select().single();
    if (error) {
      if (error.code === "23514") {
        throw new HttpError(400, "Add at least one website origin before publishing.", "origin_required");
      }
      throw new Error("Bot settings update failed: " + error.message);
    }
    return json(request, { bot: data });
  } catch (error) {
    return errorResponse(request, error);
  }
});
