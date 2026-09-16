import { execFileSync } from "node:child_process";

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

function headers(apiKey, token) {
  return {
    apikey: apiKey,
    ...(token ? { Authorization: "Bearer " + token } : {}),
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
    headers: headers(serviceRoleKey, serviceRoleKey),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await responseBody(response);
  if (!response.ok || !body.id) throw new Error("Billing test account creation failed.");
  return body.id;
}

async function deleteUser(apiUrl, serviceRoleKey, userId) {
  if (!userId) return;
  const response = await fetch(apiUrl + "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    method: "DELETE",
    headers: headers(serviceRoleKey, serviceRoleKey),
  });
  if (!response.ok && response.status !== 404) throw new Error("Billing test account cleanup failed.");
}

async function signIn(apiUrl, anonKey, email) {
  const response = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: headers(anonKey),
    body: JSON.stringify({ email, password }),
  });
  const body = await responseBody(response);
  if (!response.ok || !body.access_token) throw new Error("Billing test account sign-in failed.");
  return body.access_token;
}

async function callJson(apiUrl, anonKey, path, token, body) {
  const response = await fetch(apiUrl + "/functions/v1/" + path, {
    method: "POST",
    headers: headers(anonKey, token),
    body: JSON.stringify(body),
  });
  return { response, body: await responseBody(response) };
}

async function adminSelect(apiUrl, serviceRoleKey, table, query) {
  const params = new URLSearchParams(query);
  const response = await fetch(apiUrl + "/rest/v1/" + table + "?" + params, {
    headers: headers(serviceRoleKey, serviceRoleKey),
  });
  const body = await responseBody(response);
  if (!response.ok || !Array.isArray(body)) throw new Error("Billing admin read failed for " + table + ".");
  return body;
}

async function adminRpc(apiUrl, apiKey, name, body, token = apiKey) {
  const response = await fetch(apiUrl + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: headers(apiKey, token),
    body: JSON.stringify(body),
  });
  return { response, body: await responseBody(response) };
}

async function setUsage(apiUrl, serviceRoleKey, accountId, reservedRequests) {
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const response = await fetch(apiUrl + "/rest/v1/monthly_usage?on_conflict=account_id%2Cmonth_start", {
    method: "POST",
    headers: {
      ...headers(serviceRoleKey, serviceRoleKey),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([{ account_id: accountId, month_start: monthStart, reserved_requests: reservedRequests }]),
  });
  if (!response.ok) throw new Error("Unable to seed billing test usage.");
  await response.arrayBuffer();
}

async function readAccount(apiUrl, serviceRoleKey, accountId) {
  const rows = await adminSelect(apiUrl, serviceRoleKey, "accounts", {
    select: "id,plan",
    id: "eq." + accountId,
  });
  return rows[0] ?? null;
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

async function readDocuments(apiUrl, serviceRoleKey, botId) {
  return adminSelect(apiUrl, serviceRoleKey, "documents", {
    select: "id,file_name,status,source_size_bytes,storage_path",
    bot_id: "eq." + botId,
    order: "created_at.asc",
  });
}

async function upload(apiUrl, anonKey, token, botId, fileName, content) {
  const form = new FormData();
  form.append("bot_id", botId);
  form.append("file", new Blob([content]), fileName);
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
    headers: headers(serviceRoleKey, serviceRoleKey),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!response.ok) throw new Error("Billing test storage cleanup failed.");
  await response.arrayBuffer();
}

async function main() {
  const runtime = getRuntimeStatus();
  const apiUrl = statusValue(runtime, "API_URL");
  const anonKey = statusValue(runtime, "ANON_KEY");
  const serviceRoleKey = statusValue(runtime, "SERVICE_ROLE_KEY");
  const suffix = Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);
  const ownerEmail = "billing-owner-" + suffix + "@docchat.example";
  const foreignEmail = "billing-foreign-" + suffix + "@docchat.example";
  let ownerId = "";
  let foreignId = "";
  let ownerToken = "";
  let botId = "";
  const storagePaths = new Set();
  let storageCleaned = false;

  try {
    ownerId = await createUser(apiUrl, serviceRoleKey, ownerEmail);
    foreignId = await createUser(apiUrl, serviceRoleKey, foreignEmail);
    ownerToken = await signIn(apiUrl, anonKey, ownerEmail);
    const foreignToken = await signIn(apiUrl, anonKey, foreignEmail);

    const unauthenticated = await callJson(apiUrl, anonKey, "mock-billing", null, { plan: "pro" });
    assert(unauthenticated.response.status === 401, "Unauthenticated mock billing changed a plan.");

    const created = await callJson(apiUrl, anonKey, "create-bot", ownerToken, {
      name: "Billing integration bot",
      greeting: "How can we help?",
      accent_color: "#7064D8",
    });
    assert(created.response.status === 201 && typeof created.body.bot?.id === "string", "Billing fixture bot creation failed.");
    botId = created.body.bot.id;

    const directPatchResponse = await fetch(apiUrl + "/rest/v1/accounts?id=eq." + ownerId, {
      method: "PATCH",
      headers: { ...headers(anonKey, ownerToken), Prefer: "return=representation" },
      body: JSON.stringify({ plan: "pro" }),
    });
    const directPatch = await responseBody(directPatchResponse);
    assert(!directPatchResponse.ok || (Array.isArray(directPatch) && directPatch.length === 0), "Direct browser account plan write was accepted.");

    const directRpc = await adminRpc(apiUrl, anonKey, "set_mock_account_plan", { p_account_id: ownerId, p_plan: "pro" }, ownerToken);
    assert(!directRpc.response.ok, "An authenticated browser role could execute the mock plan RPC.");
    assert((await readAccount(apiUrl, serviceRoleKey, ownerId))?.plan === "free", "Direct plan write changed the owner account.");

    const spoofed = await callJson(apiUrl, anonKey, "mock-billing", ownerToken, { plan: "pro", account_id: foreignId });
    assert(spoofed.response.status === 400 && spoofed.body.code === "validation_error", "Caller-supplied account_id was accepted by mock billing.");
    assert((await readAccount(apiUrl, serviceRoleKey, ownerId))?.plan === "free", "Account spoof changed the owner plan.");
    assert((await readAccount(apiUrl, serviceRoleKey, foreignId))?.plan === "free", "Account spoof changed the foreign plan.");

    await setUsage(apiUrl, serviceRoleKey, ownerId, 37);
    const upgraded = await callJson(apiUrl, anonKey, "mock-billing", ownerToken, { plan: "pro" });
    assert(upgraded.response.status === 200 && upgraded.body.mock === true && upgraded.body.charged === false && upgraded.body.plan === "pro", "Mock upgrade failed.");
    assert((await readAccount(apiUrl, serviceRoleKey, ownerId))?.plan === "pro", "Mock upgrade did not persist Pro.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === 37, "Mock upgrade reset monthly usage.");

    for (let index = 1; index <= 6; index += 1) {
      const result = await upload(apiUrl, anonKey, ownerToken, botId, `plan-source-${index}.txt`, `Source ${index}`);
      assert(result.response.status === 201 && typeof result.body.document?.id === "string", `Pro upload ${index} failed.`);
      assert(typeof result.body.document.storage_path === "string", `Pro upload ${index} returned no storage path.`);
      storagePaths.add(result.body.document.storage_path);
    }
    assert((await readDocuments(apiUrl, serviceRoleKey, botId)).length === 6, "Pro did not allow six documents.");

    const downgraded = await callJson(apiUrl, anonKey, "mock-billing", ownerToken, { plan: "free" });
    assert(downgraded.response.status === 200 && downgraded.body.mock === true && downgraded.body.charged === false && downgraded.body.plan === "free", "Mock downgrade failed.");
    assert((await readAccount(apiUrl, serviceRoleKey, ownerId))?.plan === "free", "Mock downgrade did not persist Free.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === 37, "Mock downgrade reset monthly usage.");
    assert((await readDocuments(apiUrl, serviceRoleKey, botId)).length === 6, "Downgrade deleted Pro documents.");

    const blockedUpload = await upload(apiUrl, anonKey, ownerToken, botId, "blocked-free-upload.txt", "Blocked");
    assert(blockedUpload.response.status === 409 && blockedUpload.body.code === "document_limit_reached", "Free plan accepted a seventh document.");
    assert((await readDocuments(apiUrl, serviceRoleKey, botId)).length === 6, "Rejected Free upload left a document row.");

    await setUsage(apiUrl, serviceRoleKey, ownerId, 99);
    const [racedPlan, racedQuota] = await Promise.all([
      callJson(apiUrl, anonKey, "mock-billing", ownerToken, { plan: "pro" }),
      adminRpc(apiUrl, serviceRoleKey, "reserve_ai_request", { p_account_id: ownerId }),
    ]);
    assert(racedPlan.response.status === 200 && racedPlan.body.mock === true && racedPlan.body.charged === false && racedPlan.body.plan === "pro", "Concurrent mock plan change failed.");
    assert(racedQuota.response.ok && racedQuota.body.allowed === true && racedQuota.body.used === 100 && [100, 1000].includes(racedQuota.body.limit), "Concurrent quota reservation was not serialized with the plan change.");
    assert(["free", "pro"].includes((await readAccount(apiUrl, serviceRoleKey, ownerId))?.plan), "Concurrent plan/quota check returned an invalid plan.");

    const restoreFree = await callJson(apiUrl, anonKey, "mock-billing", ownerToken, { plan: "free" });
    assert(restoreFree.response.status === 200 && restoreFree.body.plan === "free", "Unable to restore Free for the document limit check.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === 100, "Concurrent plan change reset quota usage.");
    const freeExhausted = await adminRpc(apiUrl, serviceRoleKey, "reserve_ai_request", { p_account_id: ownerId });
    assert(freeExhausted.response.ok && freeExhausted.body.allowed === false && freeExhausted.body.used === 100 && freeExhausted.body.limit === 100, "Free quota boundary exceeded its plan limit.");

    const documentsBeforeDelete = await readDocuments(apiUrl, serviceRoleKey, botId);
    assert(documentsBeforeDelete.length === 6, "Billing fixture did not retain six documents after downgrade.");
    for (const document of documentsBeforeDelete.slice(0, 2)) {
      const deleted = await callJson(apiUrl, anonKey, "delete-document", ownerToken, { document_id: document.id });
      assert(deleted.response.status === 200 && deleted.body.deleted === true, "Free document removal failed.");
    }
    const remainingAfterDelete = await readDocuments(apiUrl, serviceRoleKey, botId);
    assert(remainingAfterDelete.length === 4, "Free document removal did not release two slots.");

    const recoveredUpload = await upload(apiUrl, anonKey, ownerToken, botId, "free-slot-recovered.txt", "Recovered");
    assert(recoveredUpload.response.status === 201 && typeof recoveredUpload.body.document?.storage_path === "string", "Free upload did not work after a slot was released.");
    storagePaths.add(recoveredUpload.body.document.storage_path);
    assert((await readDocuments(apiUrl, serviceRoleKey, botId)).length === 5, "Free slot accounting was incorrect after recovery upload.");
    const blockedAtFreeCap = await upload(apiUrl, anonKey, ownerToken, botId, "blocked-at-free-cap.txt", "Blocked");
    assert(blockedAtFreeCap.response.status === 409 && blockedAtFreeCap.body.code === "document_limit_reached", "Free plan accepted a sixth document after reaching its cap.");

    const upgradedAgain = await callJson(apiUrl, anonKey, "mock-billing", ownerToken, { plan: "pro" });
    assert(upgradedAgain.response.status === 200 && upgradedAgain.body.plan === "pro" && upgradedAgain.body.charged === false, "Second mock upgrade failed.");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === 100, "Plan change did not preserve quota usage after a reservation.");
    const proAllowance = await adminRpc(apiUrl, serviceRoleKey, "reserve_ai_request", { p_account_id: ownerId });
    assert(proAllowance.response.ok && proAllowance.body.allowed === true && proAllowance.body.used === 101 && proAllowance.body.limit === 1000, "Pro quota did not use the upgraded limit.");

    const foreignWrite = await callJson(apiUrl, anonKey, "mock-billing", foreignToken, { plan: "pro" });
    assert(foreignWrite.response.status === 200 && foreignWrite.body.plan === "pro", "Foreign fixture plan change failed unexpectedly.");
    assert((await readAccount(apiUrl, serviceRoleKey, ownerId))?.plan === "pro", "Foreign plan change touched the owner account.");

    console.log("billing integration passed");
  } finally {
    let cleanupFailed = false;
    try {
      await removeStorage(apiUrl, serviceRoleKey, [...storagePaths]);
      storageCleaned = true;
    } catch (error) {
      cleanupFailed = true;
      console.error("billing integration storage cleanup failed:", error instanceof Error ? error.message : "unknown error");
    }
    for (const [label, id] of [["foreign", foreignId], ["owner", ownerId]]) {
      try {
        await deleteUser(apiUrl, serviceRoleKey, id);
      } catch (error) {
        cleanupFailed = true;
        console.error(`billing integration ${label}-user cleanup failed:`, error instanceof Error ? error.message : "unknown error");
      }
    }
    if (storageCleaned) {
      for (const storagePath of storagePaths) {
        try {
          const cleanup = await adminRpc(apiUrl, serviceRoleKey, "complete_storage_cleanup", { p_storage_path: storagePath });
          if (!cleanup.response.ok) throw new Error("cleanup RPC was rejected");
        } catch (error) {
          cleanupFailed = true;
          console.error("billing integration tombstone cleanup failed:", error instanceof Error ? error.message : "unknown error");
        }
      }
    }
    if (cleanupFailed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("billing integration failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
