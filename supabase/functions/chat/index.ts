import { chatStream, embed, providerError, vectorLiteral } from "../_shared/ai.ts";
import { groundedContext, insufficientAnswer, type Citation, type RetrievalRow } from "../_shared/grounding.ts";
import { errorResponse, HttpError, normalizeHttpOrigin, parseJson, preflight, requestOrigin, requirePost, sseEvent, sseHeaders } from "../_shared/http.ts";
import { acquireRateLimit, reserveQuota } from "../_shared/limits.ts";
import { clientIp, createAdminClient, requireUser, sha256Hex } from "../_shared/supabase.ts";
import { chatSchema } from "../_shared/validation.ts";

const maxChatMilliseconds = 120000;
const conversationRetentionMilliseconds = 30 * 24 * 60 * 60 * 1000;
const widgetOrigin = normalizeHttpOrigin(Deno.env.get("WIDGET_ORIGIN") ?? "http://127.0.0.1:3000") ?? "http://127.0.0.1:3000";

type Actor = {
  ownerUserId: string | null;
  visitorSessionId: string | null;
  rateScope: string;
};

type Bot = {
  id: string;
  account_id: string;
  public_enabled: boolean;
  allowed_origins: unknown;
};

type Conversation = {
  id: string;
  bot_id: string;
  owner_user_id: string | null;
  visitor_session_id: string | null;
  created_at: string;
  last_activity_at: string;
};

function publicAccessAllowed(bot: Pick<Bot, "public_enabled" | "allowed_origins">, origin: string): boolean {
  return bot.public_enabled === true && Array.isArray(bot.allowed_origins) && bot.allowed_origins.includes(origin);
}

function invalidSession(): HttpError {
  return new HttpError(401, "This visitor session is no longer valid.", "invalid_session");
}

function expiredConversation(): HttpError {
  return new HttpError(410, "This conversation has expired. Start a new conversation.", "conversation_expired");
}

function streamError(error: unknown, deadlineSignal: AbortSignal): HttpError {
  if (error instanceof HttpError) return error;
  if (deadlineSignal.aborted) {
    return new HttpError(504, "Chat timed out. Please try again.", "chat_timeout");
  }
  return new HttpError(500, "Chat could not be completed. Please try again.", "chat_failed");
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
  if (request.method === "OPTIONS") {
    return preflight(request);
  }

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), maxChatMilliseconds);
  const cancelController = new AbortController();
  const requestSignal = AbortSignal.any([request.signal, deadlineController.signal, cancelController.signal]);
  let releaseActor: (() => Promise<void>) | undefined;
  let releaseBot: (() => Promise<void>) | undefined;
  let releaseIp: (() => Promise<void>) | undefined;
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await releaseLease(releaseBot, "Chat bot rate");
    await releaseLease(releaseActor, "Chat actor rate");
    await releaseLease(releaseIp, "Chat IP rate");
    clearTimeout(deadlineTimer);
    deadlineController.abort();
    cancelController.abort();
  };

  try {
    requirePost(request);
    const input = await parseJson(request, chatSchema, 20000, requestSignal);
    let admin: ReturnType<typeof createAdminClient>;
    let bot: Bot | null = null;
    let actor: Actor;

    if (input.session_token !== undefined) {
      admin = createAdminClient(requestSignal);
      const ipHash = await sha256Hex(clientIp(request));
      releaseIp = await acquireRateLimit(admin, "chat:ip:" + ipHash, 60, 4);
      if (!input.embed_origin) {
        throw new HttpError(400, "An embedding origin is required for visitor chat.", "origin_required");
      }
      const tokenHash = await sha256Hex(input.session_token);
      const { data: session, error: sessionError } = await admin.from("visitor_sessions")
        .select("id,bot_id,bound_origin,expires_at,revoked_at")
        .eq("token_hash", tokenHash).maybeSingle();
      if (sessionError) throw new Error("Visitor session lookup failed: " + sessionError.message);
      if (!session || session.bot_id !== input.bot_id || session.revoked_at ||
        Date.parse(session.expires_at) <= Date.now() || session.bound_origin !== input.embed_origin) {
        throw invalidSession();
      }
      const origin = requestOrigin(request);
      if (!origin || (origin !== widgetOrigin && origin !== session.bound_origin)) {
        throw new HttpError(403, "The request origin is not allowed for this visitor session.", "origin_mismatch");
      }

      const { data: publicBot, error: botError } = await admin.from("bots")
        .select("id,account_id,public_enabled,allowed_origins")
        .eq("id", input.bot_id).maybeSingle();
      if (botError) throw new Error("Public bot lookup failed: " + botError.message);
      if (!publicBot || !publicAccessAllowed(publicBot, input.embed_origin)) {
        throw new HttpError(404, "Published bot not found.", "not_found");
      }
      bot = publicBot as Bot;
      const { error: seenError } = await admin.from("visitor_sessions")
        .update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);
      if (seenError) throw new Error("Visitor session update failed: " + seenError.message);
      actor = { ownerUserId: null, visitorSessionId: session.id, rateScope: "chat:visitor:" + session.id };
    } else {
      const auth = await requireUser(request, requestSignal);
      admin = auth.admin;
      const { data: ownerBot, error: botError } = await admin.from("bots")
        .select("id,account_id,public_enabled,allowed_origins")
        .eq("id", input.bot_id).eq("account_id", auth.user.id).maybeSingle();
      if (botError) throw new Error("Bot lookup failed: " + botError.message);
      if (!ownerBot) throw new HttpError(404, "Bot not found.", "not_found");
      bot = ownerBot as Bot;
      actor = { ownerUserId: auth.user.id, visitorSessionId: null, rateScope: "chat:owner:" + auth.user.id };
    }

    if (!bot) throw new Error("Bot context was missing.");

    // Charge valid actors for malformed conversation ids and no-document
    // calls too, while keeping the bot and actor keys behind authorization.
    releaseActor = await acquireRateLimit(admin, actor.rateScope, 10, 1);
    releaseBot = await acquireRateLimit(admin, "chat:bot:" + bot.id, 30, 2);

    const { data: readyDocuments, error: documentError } = await admin.from("documents")
      .select("id").eq("bot_id", bot.id).eq("status", "ready").limit(1);
    if (documentError) throw new Error("Ready document lookup failed: " + documentError.message);
    if (!readyDocuments || readyDocuments.length === 0) {
      throw new HttpError(409, "This bot has no ready documents yet.", "no_ready_documents");
    }

    let conversation: Conversation | undefined;
    if (input.conversation_id) {
      let query = admin.from("conversations")
        .select("id,bot_id,owner_user_id,visitor_session_id,created_at,last_activity_at")
        .eq("id", input.conversation_id).eq("bot_id", bot.id);
      query = actor.ownerUserId
        ? query.eq("owner_user_id", actor.ownerUserId).is("visitor_session_id", null)
        : query.eq("visitor_session_id", actor.visitorSessionId).is("owner_user_id", null);
      const { data: existing, error: conversationError } = await query.maybeSingle();
      if (conversationError) throw new Error("Conversation lookup failed: " + conversationError.message);
      if (!existing) throw new HttpError(404, "Conversation not found.", "conversation_not_found");
      conversation = existing as Conversation;
      if (Date.parse(conversation.last_activity_at || conversation.created_at) < Date.now() - conversationRetentionMilliseconds) {
        throw expiredConversation();
      }
    }

    if (!conversation) {
      const { data: created, error: createError } = await admin.from("conversations").insert({
        bot_id: bot.id,
        owner_user_id: actor.ownerUserId,
        visitor_session_id: actor.visitorSessionId,
      }).select("id,bot_id,owner_user_id,visitor_session_id,created_at,last_activity_at").single();
      if (createError || !created) throw new Error("Conversation creation failed: " + (createError?.message ?? "missing row"));
      conversation = created as Conversation;
    }
    const chatConversation = conversation;

    const { data: historyRows, error: historyError } = await admin.from("messages")
      .select("role,content,message_order").eq("conversation_id", chatConversation.id)
      .order("message_order", { ascending: false }).limit(12);
    if (historyError) throw new Error("Conversation history lookup failed: " + historyError.message);
    const history = (historyRows ?? []).reverse()
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));

    let cancelled = request.signal.aborted;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const abortForDisconnect = () => {
          cancelled = true;
          cancelController.abort();
        };
        request.signal.addEventListener("abort", abortForDisconnect, { once: true });

        const send = (event: string, data: unknown): boolean => {
          if (cancelled) return false;
          try {
            controller.enqueue(sseEvent(event, data));
            return true;
          } catch {
            cancelled = true;
            cancelController.abort();
            return false;
          }
        };

        const run = async (): Promise<void> => {
          let providerController: AbortController | undefined;
          let providerSignal: AbortSignal | undefined;
          const abortProvider = () => providerController?.abort();
          try {
            if (!send("meta", { conversation_id: chatConversation.id })) return;
            if (requestSignal.aborted) return;

            // A disconnect must not make a committed quota reservation look
            // undispatched. Once this critical RPC starts, only the request
            // deadline may cancel it; the first provider call follows it.
            const usage = await reserveQuota(createAdminClient(deadlineController.signal), bot.account_id);
            // Once quota is reserved, the first provider request must still be
            // attempted so a disconnect cannot turn a charged request into a
            // silently undispatched one.
            providerController = new AbortController();
            providerSignal = AbortSignal.any([deadlineController.signal, providerController.signal]);
            request.signal.addEventListener("abort", abortProvider, { once: true });
            cancelController.signal.addEventListener("abort", abortProvider, { once: true });

            let answer = "";
            let citations: Citation[] = [];
            let queryEmbedding: number[][];
            try {
              queryEmbedding = await embed(input.message, providerSignal);
            } catch {
              if (deadlineController.signal.aborted) {
                throw new HttpError(504, "Chat timed out. Please try again.", "chat_timeout");
              }
              throw providerError();
            }
            if (queryEmbedding.length !== 1) throw providerError();

            const { data: matches, error: matchError } = await admin.rpc("match_document_chunks", {
              p_bot_id: bot.id,
              p_query_embedding: vectorLiteral(queryEmbedding[0]),
              p_match_count: 3,
              p_min_similarity: 0.35,
            });
            if (matchError) throw new Error("Document retrieval failed: " + matchError.message);
            const rows = (Array.isArray(matches) ? matches : []) as RetrievalRow[];
            if (rows.length === 0) {
              answer = insufficientAnswer;
              citations = [];
              if (!send("token", { token: answer })) return;
            } else {
              const context = groundedContext(input.message, history, rows);
              citations = context.citations;
              try {
                for await (const token of chatStream(context.messages, providerSignal ?? requestSignal)) {
                  answer += token;
                  if (!send("token", { token })) return;
                }
              } catch {
                if (deadlineController.signal.aborted) {
                  throw new HttpError(504, "Chat timed out. Please try again.", "chat_timeout");
                }
                throw providerError();
              }
            }
            if (!answer.trim()) throw providerError();
            if (answer.trim() === insufficientAnswer) citations = [];

            const { data: saved, error: saveError } = await admin.rpc("save_chat_exchange", {
              p_conversation_id: chatConversation.id,
              p_bot_id: bot.id,
              p_owner_user_id: actor.ownerUserId,
              p_visitor_session_id: actor.visitorSessionId,
              p_user_content: input.message,
              p_assistant_content: answer,
              p_citations: citations,
            });
            if (saveError) throw new Error("Chat exchange save failed: " + saveError.message);
            if (saved !== true) throw new HttpError(409, "The conversation changed. Please try again.", "conversation_changed");
            if (!send("done", {
              citations,
              usage: { monthly_used: usage.used, monthly_limit: usage.limit },
            })) return;
          } catch (error) {
            if (cancelled || request.signal.aborted) return;
            const failure = streamError(error, deadlineController.signal);
            send("error", { error: failure.message, code: failure.code });
          } finally {
            request.signal.removeEventListener("abort", abortProvider);
            cancelController.signal.removeEventListener("abort", abortProvider);
            request.signal.removeEventListener("abort", abortForDisconnect);
            await cleanup();
            if (!cancelled) {
              try {
                controller.close();
              } catch {
                // The client may have cancelled the stream while cleanup was running.
              }
            }
          }
        };
        void run();
      },
      cancel() {
        cancelled = true;
        cancelController.abort();
      },
    });
    return new Response(stream, { headers: sseHeaders(request) });
  } catch (error) {
    await cleanup();
    return errorResponse(request, error);
  }
});
