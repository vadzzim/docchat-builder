import { execFileSync } from "node:child_process";

const encoder = new TextEncoder();
const widgetOrigin = "http://127.0.0.1:3000";
const embedOrigin = "http://localhost:3001";
const password = "Local-only-DocChat-2026!";

function getRuntimeStatus() {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npx.cmd --yes supabase@2.117.0 status -o json"]
    : ["--yes", "supabase@2.117.0", "status", "-o", "json"];
  const raw = execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Supabase status did not return JSON.");
  return JSON.parse(raw.slice(start, end + 1));
}

function statusValue(status, wanted) {
  const normalizedWanted = wanted.replace(/[^a-z]/gi, "").toLowerCase();
  for (const [key, value] of Object.entries(status)) {
    if (typeof value !== "string") continue;
    if (key.replace(/[^a-z]/gi, "").toLowerCase() === normalizedWanted) return value;
  }
  throw new Error("Supabase status did not include " + wanted + ".");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function authHeaders(apiKey, token = apiKey) {
  return {
    apikey: apiKey,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function createUser(apiUrl, serviceRoleKey, email) {
  const response = await fetch(apiUrl + "/auth/v1/admin/users", {
    method: "POST",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await responseBody(response);
  if (!response.ok || !body.id) throw new Error("Test account creation failed.");
  return body.id;
}

async function deleteUser(apiUrl, serviceRoleKey, userId) {
  if (!userId) return;
  const response = await fetch(apiUrl + "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    method: "DELETE",
    headers: authHeaders(serviceRoleKey),
  });
  if (!response.ok && response.status !== 404) throw new Error("Test account cleanup failed.");
}

async function signIn(apiUrl, anonKey, email) {
  const response = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: authHeaders(anonKey),
    body: JSON.stringify({ email, password }),
  });
  const body = await responseBody(response);
  if (!response.ok || !body.access_token) throw new Error("Test account sign-in failed.");
  return body.access_token;
}

async function adminSelect(apiUrl, serviceRoleKey, table, query) {
  const params = new URLSearchParams(query);
  const response = await fetch(apiUrl + "/rest/v1/" + table + "?" + params, {
    headers: authHeaders(serviceRoleKey),
  });
  const body = await responseBody(response);
  if (!response.ok || !Array.isArray(body)) throw new Error("Admin read failed for " + table + ".");
  return body;
}

async function adminRpc(apiUrl, serviceRoleKey, name, body) {
  const response = await fetch(apiUrl + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify(body),
  });
  return { response, body: await responseBody(response) };
}

async function setUsage(apiUrl, serviceRoleKey, accountId, reservedRequests) {
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const response = await fetch(apiUrl + "/rest/v1/monthly_usage?on_conflict=account_id%2Cmonth_start", {
    method: "POST",
    headers: {
      ...authHeaders(serviceRoleKey),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([{ account_id: accountId, month_start: monthStart, reserved_requests: reservedRequests }]),
  });
  if (!response.ok) throw new Error("Unable to seed monthly usage.");
}

async function readUsage(apiUrl, serviceRoleKey, accountId) {
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const rows = await adminSelect(apiUrl, serviceRoleKey, "monthly_usage", {
    select: "reserved_requests",
    account_id: "eq." + accountId,
    month_start: "eq." + monthStart,
  });
  return Number(rows[0]?.reserved_requests ?? 0);
}

async function callJson(apiUrl, anonKey, path, token, body, origin) {
  const headers = authHeaders(anonKey, token || anonKey);
  if (origin) headers.Origin = origin;
  const response = await fetch(apiUrl + "/functions/v1/" + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await responseBody(response) };
}

function parseSse(text) {
  const events = [];
  let eventName = "message";
  let data = [];
  const flush = () => {
    if (data.length === 0) return;
    try {
      events.push({ event: eventName, data: JSON.parse(data.join("\n")) });
    } catch {
      throw new Error("Chat returned malformed SSE data.");
    }
    eventName = "message";
    data = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
    } else if (line.startsWith("event: ")) {
      eventName = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data.push(line.slice(6));
    }
  }
  flush();
  return events;
}

async function callChat(apiUrl, anonKey, token, body, origin) {
  const headers = authHeaders(anonKey, token || anonKey);
  if (origin) headers.Origin = origin;
  const response = await fetch(apiUrl + "/functions/v1/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return { response, events: parseSse(await response.text()) };
  }
  return { response, body: await responseBody(response) };
}

async function upload(apiUrl, anonKey, token, botId, name, bytes) {
  const form = new FormData();
  form.append("bot_id", botId);
  form.append("file", new Blob([bytes]), name);
  const response = await fetch(apiUrl + "/functions/v1/upload-document", {
    method: "POST",
    headers: { apikey: anonKey, Authorization: "Bearer " + token },
    body: form,
  });
  return { response, body: await responseBody(response) };
}

async function removeStorage(apiUrl, serviceRoleKey, paths) {
  if (paths.length === 0) return;
  const response = await fetch(apiUrl + "/storage/v1/object/documents", {
    method: "DELETE",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!response.ok) throw new Error("Storage cleanup failed.");
}

function doneEvent(result) {
  const done = result.events?.find((event) => event.event === "done");
  assert(result.response.status === 200 && done, "Chat did not finish with a done event.");
  return done.data;
}

function tokenText(result) {
  return (result.events ?? [])
    .filter((event) => event.event === "token")
    .map((event) => event.data?.token ?? "")
    .join("");
}

async function main() {
  const runtime = getRuntimeStatus();
  const apiUrl = statusValue(runtime, "API_URL");
  const anonKey = statusValue(runtime, "ANON_KEY");
  const serviceRoleKey = statusValue(runtime, "SERVICE_ROLE_KEY");
  const suffix = Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);
  const ownerEmail = "chat-owner-" + suffix + "@docchat.example";
  const foreignEmail = "chat-foreign-" + suffix + "@docchat.example";
  let ownerId = "";
  let foreignId = "";
  let documentId = "";
  const storagePaths = new Set();
  const concurrencyLeases = [];
  let concurrencyScope = "";

  try {
    ownerId = await createUser(apiUrl, serviceRoleKey, ownerEmail);
    foreignId = await createUser(apiUrl, serviceRoleKey, foreignEmail);
    const ownerToken = await signIn(apiUrl, anonKey, ownerEmail);
    const foreignToken = await signIn(apiUrl, anonKey, foreignEmail);

    const created = await callJson(apiUrl, anonKey, "create-bot", ownerToken, {
      name: "Northstar chat integration",
      greeting: "How can we help?",
      accent_color: "#7064D8",
    });
    assert(created.response.status === 201, "Chat fixture bot creation failed.");
    const botId = created.body.bot?.id;
    assert(typeof botId === "string", "Chat fixture bot id is missing.");

    const privateSession = await callJson(apiUrl, anonKey, "public-session", null, {
      bot_id: botId,
      embed_origin: embedOrigin,
    }, embedOrigin);
    assert(privateSession.response.status === 404, "A private bot issued a visitor session.");

    const published = await callJson(apiUrl, anonKey, "bot-settings", ownerToken, {
      bot_id: botId,
      public_enabled: true,
      allowed_origins: [embedOrigin],
    });
    assert(published.response.status === 200, "Bot publish failed.");

    const mismatchedOrigin = await callJson(apiUrl, anonKey, "public-session", null, {
      bot_id: botId,
      embed_origin: embedOrigin,
    }, "http://other.example");
    assert(mismatchedOrigin.response.status === 403 && mismatchedOrigin.body.code === "origin_mismatch", "Public session accepted a mismatched HTTP origin.");

    const sessionResults = [];
    for (let index = 0; index < 3; index += 1) {
      sessionResults.push(await callJson(apiUrl, anonKey, "public-session", null, {
        bot_id: botId,
        embed_origin: embedOrigin,
      }, embedOrigin));
    }
    for (const result of sessionResults) assert(result.response.status === 201, "Published bot did not issue a visitor session.");
    const visitorA = sessionResults[0].body.session_token;
    const visitorB = sessionResults[1].body.session_token;
    const visitorC = sessionResults[2].body.session_token;
    assert([visitorA, visitorB, visitorC].every((token) => typeof token === "string" && token.length >= 43), "Visitor tokens were not high entropy.");

    const source = encoder.encode([
      "# Northstar Bikes",
      "Shipping is available only in the contiguous United States. Standard shipping costs $8 and takes 3-5 business days. Orders of $100 or more ship free. Expedited and international shipping are unavailable.",
      "Returns are accepted for unused bikes and accessories within 30 days. Contact support first. Refunds take 5-10 business days. Customers pay non-defective return shipping; defective returns ship free.",
      "Support is support@northstar.example, Monday through Friday, 09:00-17:00 UTC. Bikes have a two-year manufacturing warranty, excluding wear and crash damage.",
    ].join("\n\n"));
    const uploaded = await upload(apiUrl, anonKey, ownerToken, botId, "northstar.md", source);
    assert(uploaded.response.status === 201, "Chat fixture source upload failed.");
    documentId = uploaded.body.document?.id;
    assert(typeof documentId === "string", "Chat fixture document id is missing.");
    assert(typeof uploaded.body.document.storage_path === "string", "Chat fixture storage path is missing.");
    storagePaths.add(uploaded.body.document.storage_path);
    const processed = await callJson(apiUrl, anonKey, "process-document", ownerToken, { document_id: documentId });
    assert(processed.response.status === 200 && processed.body.status === "ready", "Chat fixture source did not become ready.");

    const ownerAnswer = await callChat(apiUrl, anonKey, ownerToken, {
      bot_id: botId,
      message: "What is the standard shipping cost?",
    });
    const ownerDone = doneEvent(ownerAnswer);
    assert(tokenText(ownerAnswer).includes("$8"), "Grounded owner answer omitted the source fact.");
    assert(Array.isArray(ownerDone.citations) && ownerDone.citations.length > 0, "Grounded owner answer did not include citations.");
    const ownerConversationId = ownerAnswer.events.find((event) => event.event === "meta")?.data?.conversation_id;
    assert(typeof ownerConversationId === "string", "Owner chat did not return a conversation id.");
    const ownerMessages = await adminSelect(apiUrl, serviceRoleKey, "messages", {
      select: "role,content,citations,message_order",
      conversation_id: "eq." + ownerConversationId,
      order: "message_order.asc",
    });
    assert(ownerMessages.length === 2 && ownerMessages[0].role === "user" && ownerMessages[1].role === "assistant", "Owner chat history was not persisted in order.");
    assert(Array.isArray(ownerMessages[1].citations) && ownerMessages[1].citations.length > 0, "Persisted owner answer lost citations.");

    const missing = await callChat(apiUrl, anonKey, ownerToken, {
      bot_id: botId,
      conversation_id: ownerConversationId,
      message: "What is Northstar's phone number?",
    });
    const missingDone = doneEvent(missing);
    assert(tokenText(missing) === "I couldn't find that in the uploaded documents.", "Missing information did not use the insufficient-information answer.");
    assert(Array.isArray(missingDone.citations) && missingDone.citations.length === 0, "Missing information unexpectedly returned citations.");

    const visitorAnswer = await callChat(apiUrl, anonKey, null, {
      bot_id: botId,
      session_token: visitorA,
      embed_origin: embedOrigin,
      message: "How long do standard shipments take?",
    }, widgetOrigin);
    const visitorDone = doneEvent(visitorAnswer);
    const visitorConversationId = visitorAnswer.events.find((event) => event.event === "meta")?.data?.conversation_id;
    assert(typeof visitorConversationId === "string" && visitorDone.citations.length > 0, "Visitor chat did not return grounded citations.");

    const crossVisitor = await callChat(apiUrl, anonKey, null, {
      bot_id: botId,
      session_token: visitorB,
      embed_origin: embedOrigin,
      conversation_id: visitorConversationId,
      message: "Can I return an unused accessory?",
    }, widgetOrigin);
    assert(crossVisitor.response.status === 404 && crossVisitor.body.code === "conversation_not_found", "Visitor B reused visitor A's conversation.");

    const foreignOwner = await callChat(apiUrl, anonKey, foreignToken, {
      bot_id: botId,
      message: "What is the shipping cost?",
    });
    assert(foreignOwner.response.status === 404 && foreignOwner.body.code === "not_found", "A foreign owner accessed the bot.");

    const usageBeforeInvalid = await readUsage(apiUrl, serviceRoleKey, ownerId);
    const invalid = await callChat(apiUrl, anonKey, ownerToken, {
      bot_id: botId,
      message: "x".repeat(1001),
    });
    assert(invalid.response.status === 400 && invalid.body.code === "validation_error", "An overlong chat question was accepted.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === usageBeforeInvalid, "Rejected chat input consumed quota.");

    concurrencyScope = "chat:bot:" + botId;
    for (let index = 0; index < 2; index += 1) {
      const lease = await adminRpc(apiUrl, serviceRoleKey, "reserve_rate_limit", {
        p_scope_key: concurrencyScope,
        p_window_seconds: 60,
        p_max_requests: 30,
        p_max_concurrent: 2,
        p_lease_seconds: 180,
      });
      assert(lease.response.ok && lease.body?.allowed && lease.body.lease_id, "Could not seed a bot concurrency lease.");
      concurrencyLeases.push(lease.body.lease_id);
    }
    const usageBeforeConcurrent = await readUsage(apiUrl, serviceRoleKey, ownerId);
    const concurrentRejected = await callChat(apiUrl, anonKey, null, {
      bot_id: botId,
      session_token: visitorC,
      embed_origin: embedOrigin,
      message: "What is the return window?",
    }, widgetOrigin);
    assert(concurrentRejected.response.status === 429 && concurrentRejected.body.code === "concurrency_limited", "Bot concurrency limit did not reject a seeded boundary request.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === usageBeforeConcurrent, "Concurrency-rejected chat consumed quota.");
    for (const leaseId of concurrencyLeases.splice(0)) {
      const released = await adminRpc(apiUrl, serviceRoleKey, "release_rate_limit", { p_scope_key: concurrencyScope, p_lease_id: leaseId });
      assert(released.response.ok, "Seeded concurrency lease cleanup failed.");
    }

    await setUsage(apiUrl, serviceRoleKey, ownerId, 99);
    const finalOwner = await callChat(apiUrl, anonKey, ownerToken, {
      bot_id: botId,
      conversation_id: ownerConversationId,
      message: "What email address can I use for support?",
    });
    assert(doneEvent(finalOwner).usage.monthly_used === 100, "The final free monthly request was not reserved.");
    const quotaVisitor = await callChat(apiUrl, anonKey, null, {
      bot_id: botId,
      session_token: visitorA,
      embed_origin: embedOrigin,
      conversation_id: visitorConversationId,
      message: "What is the return period?",
    }, widgetOrigin);
    assert(quotaVisitor.response.status === 200 && quotaVisitor.events.some((event) => event.event === "error" && event.data.code === "monthly_quota_exhausted"), "Visitor chat did not share the exhausted owner quota.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === 100, "Exhausted quota changed unexpectedly.");

    const disabled = await callJson(apiUrl, anonKey, "bot-settings", ownerToken, { bot_id: botId, public_enabled: false });
    assert(disabled.response.status === 200, "Bot unpublish failed.");
    const disabledSession = await callChat(apiUrl, anonKey, null, {
      bot_id: botId,
      session_token: visitorA,
      embed_origin: embedOrigin,
      message: "Are bikes covered by a warranty?",
    }, widgetOrigin);
    assert(disabledSession.response.status === 404 && disabledSession.body.code === "not_found", "Disabling publication did not invalidate an existing visitor token.");
    const disabledNewSession = await callJson(apiUrl, anonKey, "public-session", null, { bot_id: botId, embed_origin: embedOrigin }, embedOrigin);
    assert(disabledNewSession.response.status === 404, "A disabled bot issued a new visitor session.");

    const deleted = await callJson(apiUrl, anonKey, "delete-document", ownerToken, { document_id: documentId });
    assert(deleted.response.status === 200 && deleted.body.deleted === true, "Chat fixture document deletion failed.");
    const usageBeforeNoDocs = await readUsage(apiUrl, serviceRoleKey, ownerId);
    const noDocs = await callChat(apiUrl, anonKey, ownerToken, { bot_id: botId, message: "What is the shipping cost?" });
    assert(noDocs.response.status === 409 && noDocs.body.code === "no_ready_documents", "Chat proceeded without ready documents.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === usageBeforeNoDocs, "No-document rejection consumed quota.");

    console.log("chat integration passed");
  } finally {
    let cleanupFailed = false;
    for (const leaseId of concurrencyLeases) {
      try {
        const released = await adminRpc(apiUrl, serviceRoleKey, "release_rate_limit", { p_scope_key: concurrencyScope, p_lease_id: leaseId });
        if (!released.response.ok) throw new Error("lease release was rejected");
      } catch (error) {
        cleanupFailed = true;
        console.error("chat integration cleanup failed for concurrency lease:", error instanceof Error ? error.message : "unknown error");
      }
    }
    try {
      await removeStorage(apiUrl, serviceRoleKey, [...storagePaths]);
    } catch (error) {
      cleanupFailed = true;
      console.error("chat integration storage cleanup failed:", error instanceof Error ? error.message : "unknown error");
    }
    try {
      await deleteUser(apiUrl, serviceRoleKey, foreignId);
    } catch (error) {
      cleanupFailed = true;
      console.error("chat integration foreign-user cleanup failed:", error instanceof Error ? error.message : "unknown error");
    }
    try {
      await deleteUser(apiUrl, serviceRoleKey, ownerId);
    } catch (error) {
      cleanupFailed = true;
      console.error("chat integration owner-user cleanup failed:", error instanceof Error ? error.message : "unknown error");
    }
    if (cleanupFailed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("chat integration failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
