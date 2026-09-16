import { errorResponse, HttpError, json, parseJson, preflight, requestOrigin, requirePost } from "../_shared/http.ts";
import { acquireRateLimit } from "../_shared/limits.ts";
import { clientIp, createAdminClient, randomToken, sha256Hex } from "../_shared/supabase.ts";
import { publicSessionSchema } from "../_shared/validation.ts";

const sessionLifetimeMilliseconds = 24 * 60 * 60 * 1000;
const maxSessionMilliseconds = 20000;

function publicAccessAllowed(bot: { public_enabled: boolean; allowed_origins: unknown }, origin: string): boolean {
  return bot.public_enabled === true && Array.isArray(bot.allowed_origins) && bot.allowed_origins.includes(origin);
}

async function releaseLease(release: (() => Promise<void>) | undefined, label: string): Promise<void> {
  if (!release) return;
  try {
    await release();
  } catch (error) {
    console.error(label + " lease release failed:", error);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), maxSessionMilliseconds);
  let releaseBot: (() => Promise<void>) | undefined;
  let releaseIp: (() => Promise<void>) | undefined;
  try {
    requirePost(request);
    const signal = AbortSignal.any([request.signal, deadlineController.signal]);
    const input = await parseJson(request, publicSessionSchema, 20000, signal);
    const admin = createAdminClient(signal);
    const ipHash = await sha256Hex(clientIp(request));
    // Reserve both public-entry leases before looking up the bot. This keeps
    // invalid origins and random bot ids inside the same abuse budget.
    releaseIp = await acquireRateLimit(admin, "public-session:ip:" + ipHash, 20, 2);
    releaseBot = await acquireRateLimit(admin, "public-session:bot:" + input.bot_id, 60, 4);
    const origin = requestOrigin(request);
    if (!origin || origin !== input.embed_origin) {
      throw new HttpError(403, "The request origin does not match the embedding origin.", "origin_mismatch");
    }
    const { data: bot, error: botError } = await admin.from("bots")
      .select("id,name,greeting,accent_color,public_enabled,allowed_origins")
      .eq("id", input.bot_id).maybeSingle();
    if (botError) throw new Error("Public bot lookup failed: " + botError.message);
    if (!bot || !publicAccessAllowed(bot, input.embed_origin)) {
      throw new HttpError(404, "Published bot not found.", "not_found");
    }

    const sessionToken = randomToken(32);
    const expiresAt = new Date(Date.now() + sessionLifetimeMilliseconds).toISOString();
    const { error: sessionError } = await admin.from("visitor_sessions").insert({
      bot_id: input.bot_id,
      token_hash: await sha256Hex(sessionToken),
      bound_origin: input.embed_origin,
      expires_at: expiresAt,
    });
    if (sessionError) throw new Error("Visitor session creation failed: " + sessionError.message);

    return json(request, {
      session_token: sessionToken,
      expires_at: expiresAt,
      bot: {
        name: bot.name,
        greeting: bot.greeting,
        accent_color: bot.accent_color,
      },
    }, 201);
  } catch (error) {
    return errorResponse(request, error);
  } finally {
    await releaseLease(releaseIp, "Public IP rate");
    await releaseLease(releaseBot, "Public bot rate");
    clearTimeout(deadlineTimer);
    deadlineController.abort();
  }
});
