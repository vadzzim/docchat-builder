import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const password = "Local-only-DocChat-2026!";
const cliVersion = "2.117.0";
const tempDirectory = join(process.cwd(), "supabase", ".temp");
const cleanupUrl = "/functions/v1/cleanup-storage";
const databaseContainer = "supabase_db_docchat-local";

function runCli(args) {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `npx.cmd --yes supabase@${cliVersion} ${args.join(" ")}`]
    : ["--yes", `supabase@${cliVersion}`, ...args];
  return execFileSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function runtimeStatus() {
  const raw = runCli(["status", "-o", "json"]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Supabase status did not return JSON.");
  return JSON.parse(raw.slice(start, end + 1));
}

function statusValue(status, wanted) {
  const normalized = wanted.replace(/[^a-z]/gi, "").toLowerCase();
  for (const [key, value] of Object.entries(status)) {
    if (typeof value !== "string") continue;
    if (key.replace(/[^a-z]/gi, "").toLowerCase() === normalized) return value;
  }
  throw new Error("Supabase status did not include " + wanted + ".");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function dockerPsql(sql) {
  const command = process.platform === "win32" ? "docker.exe" : "docker";
  return execFileSync(command, [
    "exec", databaseContainer, "psql", "-X", "-q", "-U", "postgres", "-d", "postgres", "-At", "-c", sql,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function openPsqlSession() {
  const command = process.platform === "win32" ? "docker.exe" : "docker";
  const child = spawn(command, [
    "exec", "-i", databaseContainer, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At",
  ], { stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  let closed = false;
  let closeError = null;
  const waiters = new Set();
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    for (const waiter of [...waiters]) {
      const index = output.indexOf(waiter.marker, waiter.start);
      if (index < 0) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(output.slice(waiter.start, index));
    }
  });
  child.on("error", (error) => {
    closed = true;
    closeError = error;
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  child.on("exit", (code) => {
    closed = true;
    if (code !== 0) closeError = new Error("The temporary database session exited.");
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(closeError ?? new Error("The temporary database session exited."));
    }
  });

  function run(sql) {
    if (closed) return Promise.reject(closeError ?? new Error("The temporary database session is closed."));
    const marker = "DOCCHAT_SQL_" + randomUUID().replaceAll("-", "");
    const start = output.length;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("The temporary database session timed out."));
      }, 10000);
      const waiter = { marker, start, resolve, reject, timer };
      waiters.add(waiter);
      child.stdin.write(sql + "\nselect '" + marker + "';\n");
    });
  }

  async function close() {
    if (closed) return;
    child.stdin.write("\\q\n");
    await new Promise((resolve) => child.once("exit", resolve));
  }

  return { run, close };
}

async function waitForDeleteLock(isSettled) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !isSettled()) {
    const result = dockerPsql("select count(*) from pg_stat_activity where pid <> pg_backend_pid() and wait_event is not null and query ilike '%delete_bot%';");
    if (Number(result.trim()) > 0) return true;
    await waitMilliseconds(100);
  }
  return false;
}

async function deleteBotWhileDocumentLocked(apiUrl, anonKey, ownerToken, ownerId, botId, documentId) {
  const database = openPsqlSession();
  let committed = false;
  let deletion;
  let settled = false;
  try {
    await database.run(`begin; select id from public.documents where id = '${documentId}' for update;`);
    deletion = callJson(apiUrl, anonKey, "delete-bot", ownerToken, { bot_id: botId })
      .then((result) => { settled = true; return result; }, (error) => { settled = true; throw error; });
    const blocked = await waitForDeleteLock(() => settled);
    assert(blocked, "delete_bot did not wait on the held document lock.");
    await database.run(`select public.begin_document_delete('${ownerId}', '${documentId}'); commit;`);
    committed = true;
    return await deletion;
  } catch (error) {
    if (!committed) {
      try { await database.run("rollback;"); } catch { /* the database session will roll back on close */ }
    }
    if (deletion) await deletion.catch(() => undefined);
    throw error;
  } finally {
    await database.close();
  }
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

function authHeaders(apiKey, token = apiKey) {
  return {
    apikey: apiKey,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
}

async function createUser(apiUrl, serviceRoleKey, email) {
  const response = await fetch(apiUrl + "/auth/v1/admin/users", {
    method: "POST",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await responseBody(response);
  if (!response.ok || !body.id) throw new Error("Cleanup test account creation failed.");
  return body.id;
}

async function deleteUser(apiUrl, serviceRoleKey, userId) {
  if (!userId) return;
  const response = await fetch(apiUrl + "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    method: "DELETE",
    headers: authHeaders(serviceRoleKey),
  });
  if (!response.ok && response.status !== 404) throw new Error("Cleanup test account removal failed.");
}

async function signIn(apiUrl, anonKey, email) {
  const response = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: authHeaders(anonKey),
    body: JSON.stringify({ email, password }),
  });
  const body = await responseBody(response);
  if (!response.ok || !body.access_token) throw new Error("Cleanup test account sign-in failed.");
  return body.access_token;
}

async function callJson(apiUrl, anonKey, path, token, body, extraHeaders = {}) {
  const headers = {
    apikey: anonKey,
    ...(token ? { Authorization: "Bearer " + token } : {}),
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  const response = await fetch(apiUrl + "/functions/v1/" + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await responseBody(response) };
}

async function callCleanup(apiUrl, cronSecret, includeSecret = true) {
  const response = await fetch(apiUrl + cleanupUrl, {
    method: "POST",
    headers: includeSecret ? { "Content-Type": "application/json", "x-cron-secret": cronSecret } : { "Content-Type": "application/json" },
    body: "{}",
  });
  return { response, body: await responseBody(response) };
}

async function adminSelect(apiUrl, serviceRoleKey, table, query) {
  const params = new URLSearchParams(query);
  const response = await fetch(apiUrl + "/rest/v1/" + table + "?" + params, {
    headers: authHeaders(serviceRoleKey),
  });
  const body = await responseBody(response);
  if (!response.ok || !Array.isArray(body)) throw new Error("Cleanup admin read failed for " + table + ".");
  return body;
}

async function adminInsert(apiUrl, serviceRoleKey, table, row) {
  const response = await fetch(apiUrl + "/rest/v1/" + table, {
    method: "POST",
    headers: { ...authHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify([row]),
  });
  const body = await responseBody(response);
  if (!response.ok || !Array.isArray(body) || body.length !== 1) throw new Error("Cleanup admin insert failed for " + table + ".");
  return body[0];
}

async function adminPatch(apiUrl, serviceRoleKey, table, query, row) {
  const params = new URLSearchParams(query);
  const response = await fetch(apiUrl + "/rest/v1/" + table + "?" + params, {
    method: "PATCH",
    headers: { ...authHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const body = await responseBody(response);
  if (!response.ok || !Array.isArray(body)) throw new Error("Cleanup admin update failed for " + table + ".");
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

async function removeStorage(apiUrl, serviceRoleKey, paths) {
  if (paths.length === 0) return;
  const response = await fetch(apiUrl + "/storage/v1/object/documents", {
    method: "DELETE",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!response.ok) throw new Error("Cleanup test Storage removal failed.");
  await response.arrayBuffer();
}

async function storageExists(apiUrl, serviceRoleKey, path) {
  const encodedPath = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await fetch(apiUrl + "/storage/v1/object/documents/" + encodedPath, {
    headers: authHeaders(serviceRoleKey),
  });
  await response.arrayBuffer();
  return response.ok;
}

async function uploadStorage(apiUrl, serviceRoleKey, path, content) {
  const response = await fetch(apiUrl + "/storage/v1/object/documents/" + path.split("/").map((part) => encodeURIComponent(part)).join("/"), {
    method: "POST",
    headers: { ...authHeaders(serviceRoleKey), "Content-Type": "text/plain", "x-upsert": "false" },
    body: content,
  });
  if (!response.ok) throw new Error("Cleanup test sentinel upload failed.");
  await response.arrayBuffer();
}

function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(new RegExp("^" + key + "=(.*)$"));
    if (!match) continue;
    const value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"');
    return value;
  }
  return "";
}

function runCronAssertion() {
  mkdirSync(tempDirectory, { recursive: true });
  const sqlPath = join(tempDirectory, `docchat-cron-check-${process.pid}.sql`);
  const sql = "select jobname, schedule, command from cron.job where jobname in ('docchat-cleanup', 'docchat-storage-cleanup') order by jobname;\n";
  writeFileSync(sqlPath, sql, "utf8");
  try {
    const fileArgument = sqlPath.slice(process.cwd().length + 1).replaceAll("\\", "/");
    const output = runCli(["db", "query", "--local", "--file", fileArgument]);
    assert(output.includes("docchat-cleanup"), "The daily cleanup cron job is not scheduled.");
    assert(output.includes("0 3 * * *"), "The daily cleanup cron schedule is incorrect.");
    assert(output.includes("docchat-storage-cleanup"), "The storage cleanup cron job is not scheduled.");
    assert(output.includes("* * * * *"), "The storage cleanup cron schedule is not every minute.");
    assert(output.includes("enqueue_storage_cleanup"), "The storage cleanup cron command is incorrect.");
  } finally {
    try { unlinkSync(sqlPath); } catch { /* best-effort ignored temp file cleanup */ }
  }
}

async function main() {
  const runtime = runtimeStatus();
  const apiUrl = statusValue(runtime, "API_URL");
  const anonKey = statusValue(runtime, "ANON_KEY");
  const serviceRoleKey = statusValue(runtime, "SERVICE_ROLE_KEY");
  const cronSecret = envValue(readFileSync(join(process.cwd(), ".env.functions.local"), "utf8"), "CRON_SECRET");
  assert(cronSecret.length >= 32, "A configured CRON_SECRET is required; run setup:local first.");
  runCronAssertion();

  const suffix = Date.now().toString(36) + "-" + randomUUID().slice(0, 8);
  const ownerEmail = "cleanup-owner-" + suffix + "@docchat.example";
  const foreignEmail = "cleanup-foreign-" + suffix + "@docchat.example";
  let ownerId = "";
  let foreignId = "";
  let ownerToken = "";
  let foreignToken = "";
  let botId = "";
  let retentionBotId = "";
  let processingDocumentId = "";
  let processingLeaseId = "";
  let processingGeneration = 0;
  const storagePaths = new Set();
  const sentinelPath = "cleanup-integration/" + suffix + ".txt";
  let sentinelUploaded = false;
  let cleanupFailed = false;

  try {
    ownerId = await createUser(apiUrl, serviceRoleKey, ownerEmail);
    foreignId = await createUser(apiUrl, serviceRoleKey, foreignEmail);
    ownerToken = await signIn(apiUrl, anonKey, ownerEmail);
    foreignToken = await signIn(apiUrl, anonKey, foreignEmail);

    const created = await callJson(apiUrl, anonKey, "create-bot", ownerToken, {
      name: "Cleanup integration bot",
      greeting: "How can we help?",
      accent_color: "#7064D8",
    });
    assert(created.response.status === 201 && typeof created.body.bot?.id === "string", "Cleanup fixture bot creation failed.");
    botId = created.body.bot.id;

    const foreignDelete = await callJson(apiUrl, anonKey, "delete-bot", foreignToken, { bot_id: botId });
    assert(foreignDelete.response.status === 404 && foreignDelete.body.code === "not_found", "A foreign owner could delete the bot.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "bots", { select: "id", id: "eq." + botId })).length === 1, "Foreign delete changed the bot.");

    const form = new FormData();
    form.append("bot_id", botId);
    form.append("file", new Blob(["A source used to verify bot deletion."]), "delete-race.txt");
    const uploadResponse = await fetch(apiUrl + "/functions/v1/upload-document", {
      method: "POST",
      headers: { apikey: anonKey, Authorization: "Bearer " + ownerToken },
      body: form,
    });
    const uploadBody = await responseBody(uploadResponse);
    assert(uploadResponse.status === 201 && typeof uploadBody.document?.id === "string", "Cleanup source upload failed.");
    processingDocumentId = uploadBody.document.id;
    storagePaths.add(uploadBody.document.storage_path);

    processingLeaseId = randomUUID();
    const claimed = await adminRpc(apiUrl, serviceRoleKey, "claim_document_processing", {
      p_owner_id: ownerId,
      p_document_id: processingDocumentId,
      p_lease_id: processingLeaseId,
      p_lease_seconds: 180,
    });
    assert(claimed.response.ok && claimed.body.claimed === true, "Cleanup worker fixture was not claimed.");
    processingGeneration = Number(claimed.body.generation);

    const published = await callJson(apiUrl, anonKey, "bot-settings", ownerToken, {
      bot_id: botId,
      public_enabled: true,
      allowed_origins: ["http://127.0.0.1:3001"],
    });
    assert(published.response.ok && published.body.bot?.public_enabled === true, "Cleanup public-session fixture could not be published.");
    const session = await callJson(apiUrl, anonKey, "public-session", null, {
      bot_id: botId,
      embed_origin: "http://127.0.0.1:3001",
    }, { Origin: "http://127.0.0.1:3001" });
    assert(session.response.status === 201 && typeof session.body.session_token === "string", "Cleanup visitor session fixture failed.");

    const deleted = await deleteBotWhileDocumentLocked(apiUrl, anonKey, ownerToken, ownerId, botId, processingDocumentId);
    assert(deleted.response.status === 200 && deleted.body.deleted === true, "Owner bot deletion failed.");
    assert(deleted.body.cleanup_pending === true, "Bot deletion did not retain durable storage cleanup state.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "bots", { select: "id", id: "eq." + botId })).length === 0, "Deleted bot row remains.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "documents", { select: "id", bot_id: "eq." + botId })).length === 0, "Deleted bot documents remain.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "document_chunks", { select: "id", bot_id: "eq." + botId })).length === 0, "Deleted bot chunks remain.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "visitor_sessions", { select: "id", bot_id: "eq." + botId })).length === 0, "Deleted bot visitor sessions remain.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "deleted_storage_objects", { select: "storage_path", storage_path: "eq." + storagePaths.values().next().value })).length === 1, "Deleted source tombstone was not retained.");
    assert((await storageExists(apiUrl, serviceRoleKey, [...storagePaths][0])) === false, "Bot deletion left a source object behind.");
    const repeatedDelete = await callJson(apiUrl, anonKey, "delete-bot", ownerToken, { bot_id: botId });
    assert(repeatedDelete.response.status === 200 && repeatedDelete.body.deleted === true && repeatedDelete.body.already_deleted === true, "Repeated bot deletion was not idempotent.");
    assert(repeatedDelete.body.storage_removed === null && repeatedDelete.body.cleanup_pending === true, "Repeated deletion falsely reported storage cleanup complete.");
    const staleFinalize = await adminRpc(apiUrl, serviceRoleKey, "finalize_document_processing", {
      p_document_id: processingDocumentId,
      p_lease_id: processingLeaseId,
      p_generation: processingGeneration,
      p_chunk_count: 1,
    });
    assert(staleFinalize.response.ok && staleFinalize.body === false, "A stale processing worker resurrected a deleted bot document.");
    const oldSession = await callJson(apiUrl, anonKey, "public-session", null, {
      bot_id: botId,
      embed_origin: "http://127.0.0.1:3001",
    }, { Origin: "http://127.0.0.1:3001" });
    assert(oldSession.response.status === 404, "A deleted bot still issued visitor sessions.");

    // Simulate a worker that committed the DB deletion and lost its response:
    // the retry cannot claim Storage was removed when the object is still there.
    const retryBot = await callJson(apiUrl, anonKey, "create-bot", ownerToken, {
      name: "Repeated delete integration bot",
      greeting: "Retry fixture",
      accent_color: "#7064D8",
    });
    assert(retryBot.response.status === 201 && typeof retryBot.body.bot?.id === "string", "Repeated-delete bot creation failed.");
    const retryBotId = retryBot.body.bot.id;
    const retryForm = new FormData();
    retryForm.append("bot_id", retryBotId);
    retryForm.append("file", new Blob(["A source kept for the DB-only delete retry test."]), "retry-delete.txt");
    const retryUploadResponse = await fetch(apiUrl + "/functions/v1/upload-document", {
      method: "POST",
      headers: { apikey: anonKey, Authorization: "Bearer " + ownerToken },
      body: retryForm,
    });
    const retryUploadBody = await responseBody(retryUploadResponse);
    assert(retryUploadResponse.status === 201 && typeof retryUploadBody.document?.storage_path === "string", "Repeated-delete source upload failed.");
    const retryPath = retryUploadBody.document.storage_path;
    storagePaths.add(retryPath);
    const dbOnlyDelete = await adminRpc(apiUrl, serviceRoleKey, "delete_bot", { p_owner_id: ownerId, p_bot_id: retryBotId });
    assert(dbOnlyDelete.response.ok && dbOnlyDelete.body.deleted === true, "DB-only bot deletion fixture failed.");
    assert(await storageExists(apiUrl, serviceRoleKey, retryPath), "DB-only deletion unexpectedly removed the Storage object before the retry.");
    const endpointRetry = await callJson(apiUrl, anonKey, "delete-bot", ownerToken, { bot_id: retryBotId });
    assert(endpointRetry.response.status === 200 && endpointRetry.body.deleted === true && endpointRetry.body.already_deleted === true, "Endpoint retry after DB-only deletion failed.");
    assert(endpointRetry.body.storage_removed === null && endpointRetry.body.cleanup_pending === true, "Endpoint retry falsely reported DB-only Storage cleanup complete.");

    const missingSecret = await callCleanup(apiUrl, cronSecret, false);
    assert(missingSecret.response.status === 401 && missingSecret.body.code === "cron_unauthorized", "Cleanup accepted a missing cron secret.");
    const wrongSecret = await callCleanup(apiUrl, "wrong-secret-" + randomBytes(32).toString("hex"));
    assert(wrongSecret.response.status === 401 && wrongSecret.body.code === "cron_unauthorized", "Cleanup accepted a wrong cron secret.");
    const young = await callCleanup(apiUrl, cronSecret);
    assert(young.response.ok, "Young cleanup request failed.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "deleted_storage_objects", { select: "storage_path", storage_path: "eq." + [...storagePaths][0] })).length === 1, "Young tombstone was removed.");

    // A late upload can complete after the bot row has been deleted. The
    // tombstone must still remove that object once its grace period passes.
    await uploadStorage(apiUrl, serviceRoleKey, [...storagePaths][0], "A late worker upload.");
    const oldDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    for (const path of storagePaths) {
      await adminPatch(apiUrl, serviceRoleKey, "deleted_storage_objects", { storage_path: "eq." + path }, { created_at: oldDate });
    }
    await uploadStorage(apiUrl, serviceRoleKey, sentinelPath, "This unrelated object must survive cleanup.");
    sentinelUploaded = true;
    const aged = await callCleanup(apiUrl, cronSecret);
    assert(aged.response.ok, "Aged cleanup request failed.");
    for (const path of storagePaths) {
      assert((await adminSelect(apiUrl, serviceRoleKey, "deleted_storage_objects", { select: "storage_path", storage_path: "eq." + path })).length === 0, "Aged tombstone was not drained.");
      assert((await storageExists(apiUrl, serviceRoleKey, path)) === false, "Aged cleanup left a late or DB-only source object behind.");
    }
    assert((await storageExists(apiUrl, serviceRoleKey, sentinelPath)) === true, "Cleanup removed an untracked Storage object.");
    await removeStorage(apiUrl, serviceRoleKey, [sentinelPath]);
    sentinelUploaded = false;

    const retentionBot = await callJson(apiUrl, anonKey, "create-bot", ownerToken, {
      name: "Retention integration bot",
      greeting: "Retention fixture",
      accent_color: "#7064D8",
    });
    assert(retentionBot.response.status === 201 && typeof retentionBot.body.bot?.id === "string", "Retention bot creation failed.");
    retentionBotId = retentionBot.body.bot.id;
    const visitorSessionId = randomUUID();
    const visitorSession = await adminInsert(apiUrl, serviceRoleKey, "visitor_sessions", {
      id: visitorSessionId,
      bot_id: retentionBotId,
      token_hash: randomBytes(32).toString("hex"),
      bound_origin: "http://127.0.0.1:3001",
      expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const conversation = await adminInsert(apiUrl, serviceRoleKey, "conversations", {
      bot_id: retentionBotId,
      owner_user_id: null,
      visitor_session_id: visitorSession.id,
      created_at: recentDate,
      last_activity_at: recentDate,
    });
    const recentMessage = await adminInsert(apiUrl, serviceRoleKey, "messages", {
      conversation_id: conversation.id,
      role: "user",
      content: "A retained recent message.",
      citations: [],
      created_at: recentDate,
    });
    const recentCleanup = await adminRpc(apiUrl, serviceRoleKey, "cleanup_expired_data", {});
    assert(recentCleanup.response.ok, "Recent retention cleanup failed.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "visitor_sessions", { select: "id", id: "eq." + visitorSession.id })).length === 1, "Expired session with a recent conversation was deleted.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "conversations", { select: "id", id: "eq." + conversation.id })).length === 1, "Recent visitor conversation was deleted.");
    const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await adminPatch(apiUrl, serviceRoleKey, "conversations", { id: "eq." + conversation.id }, { created_at: staleDate, last_activity_at: staleDate });
    await adminPatch(apiUrl, serviceRoleKey, "messages", { id: "eq." + recentMessage.id }, { created_at: staleDate });
    const staleCleanup = await adminRpc(apiUrl, serviceRoleKey, "cleanup_expired_data", {});
    assert(staleCleanup.response.ok, "Stale retention cleanup failed.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "messages", { select: "id", id: "eq." + recentMessage.id })).length === 0, "31-day-old message was retained.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "conversations", { select: "id", id: "eq." + conversation.id })).length === 0, "31-day-old conversation was retained.");
    assert((await adminSelect(apiUrl, serviceRoleKey, "visitor_sessions", { select: "id", id: "eq." + visitorSession.id })).length === 0, "Expired session without a retained conversation was retained.");

    console.log("cleanup integration passed");
  } finally {
    if (sentinelUploaded) {
      try { await removeStorage(apiUrl, serviceRoleKey, [sentinelPath]); } catch (error) { cleanupFailed = true; console.error("cleanup integration sentinel removal failed:", error instanceof Error ? error.message : "unknown error"); }
    }
    if (storagePaths.size > 0) {
      try { await removeStorage(apiUrl, serviceRoleKey, [...storagePaths]); } catch (error) { cleanupFailed = true; console.error("cleanup integration source removal failed:", error instanceof Error ? error.message : "unknown error"); }
      for (const path of storagePaths) {
        try {
          const completed = await adminRpc(apiUrl, serviceRoleKey, "complete_storage_cleanup", { p_storage_path: path });
          if (!completed.response.ok) throw new Error("cleanup RPC was rejected");
        } catch (error) {
          cleanupFailed = true;
          console.error("cleanup integration tombstone cleanup failed:", error instanceof Error ? error.message : "unknown error");
        }
      }
    }
    for (const [label, id] of [["foreign", foreignId], ["owner", ownerId]]) {
      try { await deleteUser(apiUrl, serviceRoleKey, id); } catch (error) { cleanupFailed = true; console.error(`cleanup integration ${label}-user cleanup failed:`, error instanceof Error ? error.message : "unknown error"); }
    }
    if (cleanupFailed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("cleanup integration failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
