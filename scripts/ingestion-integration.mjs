import { execFileSync } from "node:child_process";

const maxSourceBytes = 102400;
const zeroVector = "[" + new Array(1024).fill("0").join(",") + "]";
const encoder = new TextEncoder();

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
    const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (normalizedKey === normalizedWanted) return value;
  }
  throw new Error("Supabase status did not include " + wanted + ".");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function authHeaders(apiKey, token = apiKey) {
  return {
    apikey: apiKey,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
}

async function readResponse(response) {
  return { response, body: await responseBody(response) };
}

async function createUser(apiUrl, serviceRoleKey, email, password) {
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
  await fetch(apiUrl + "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    method: "DELETE",
    headers: authHeaders(serviceRoleKey),
  });
}

async function adminSelect(apiUrl, serviceRoleKey, table, query) {
  const params = new URLSearchParams(query);
  const result = await readResponse(await fetch(apiUrl + "/rest/v1/" + table + "?" + params, {
    headers: authHeaders(serviceRoleKey),
  }));
  if (!result.response.ok || !Array.isArray(result.body)) throw new Error("Admin read failed for " + table + ".");
  return result.body;
}

async function adminRpc(apiUrl, serviceRoleKey, name, body) {
  return readResponse(await fetch(apiUrl + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify(body),
  }));
}

async function removeStorage(apiUrl, serviceRoleKey, paths) {
  if (paths.length === 0) return;
  await fetch(apiUrl + "/storage/v1/object/remove/documents", {
    method: "POST",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify({ prefixes: paths }),
  });
}

async function callJson(apiUrl, anonKey, path, token, body) {
  const response = await fetch(apiUrl + "/functions/v1/" + path, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
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

async function signIn(apiUrl, anonKey, email, password) {
  const response = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: authHeaders(anonKey),
    body: JSON.stringify({ email, password }),
  });
  const body = await responseBody(response);
  if (!response.ok || !body.access_token) throw new Error("Test account sign-in failed.");
  return body.access_token;
}

function vectorDimension(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return 0;
  return trimmed.slice(1, -1).split(",").filter(Boolean).length;
}

async function main() {
  const runtime = getRuntimeStatus();
  const apiUrl = statusValue(runtime, "API_URL");
  const anonKey = statusValue(runtime, "ANON_KEY");
  const serviceRoleKey = statusValue(runtime, "SERVICE_ROLE_KEY");
  const password = "Local-only-DocChat-2026!";
  const suffix = Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);
  const ownerEmail = "ingestion-owner-" + suffix + "@docchat.example";
  const foreignEmail = "ingestion-foreign-" + suffix + "@docchat.example";
  let ownerId = "";
  let foreignId = "";
  const storagePaths = [];

  try {
    ownerId = await createUser(apiUrl, serviceRoleKey, ownerEmail, password);
    foreignId = await createUser(apiUrl, serviceRoleKey, foreignEmail, password);

    const ownerToken = await signIn(apiUrl, anonKey, ownerEmail, password);
    const foreignToken = await signIn(apiUrl, anonKey, foreignEmail, password);
    const create = await callJson(apiUrl, anonKey, "create-bot", ownerToken, {
      name: "Northstar integration bot",
      greeting: "How can we help?",
      accent_color: "#7064D8",
    });
    assert(create.response.status === 201, "create-bot did not return 201.");
    const botId = create.body.bot?.id;
    assert(typeof botId === "string", "create-bot did not return a bot id.");

    const endFact = "END_FACT: Northstar support is available Monday through Friday from 09:00 to 17:00 UTC.";
    const txtBytes = encoder.encode(
      "Northstar Bikes ships in the contiguous United States. Standard shipping costs $8. " +
      "Orders of $100 or more ship free. " + "多言語の背景情報です。🚲 ".repeat(80) + endFact,
    );
    const txtUpload = await upload(apiUrl, anonKey, ownerToken, botId, "shipping.txt", txtBytes);
    assert(txtUpload.response.status === 201, "valid TXT upload was rejected.");
    const txtDocument = txtUpload.body.document;
    assert(txtDocument?.status === "pending", "valid TXT upload was not pending.");
    storagePaths.push(txtDocument.storage_path);

    const txtProcess = await callJson(apiUrl, anonKey, "process-document", ownerToken, {
      document_id: txtDocument.id,
    });
    assert(txtProcess.response.status === 200 && txtProcess.body.status === "ready", "TXT processing did not finish ready.");

    const readyTxt = (await adminSelect(apiUrl, serviceRoleKey, "documents", {
      select: "id,status,generation,chunk_count",
      id: "eq." + txtDocument.id,
    }))[0];
    assert(readyTxt?.status === "ready", "ready TXT row was not visible.");
    const txtChunks = await adminSelect(apiUrl, serviceRoleKey, "document_chunks", {
      select: "generation,chunk_index,content,embedding",
      document_id: "eq." + txtDocument.id,
      order: "chunk_index.asc",
    });
    assert(txtChunks.length === readyTxt.chunk_count, "TXT has partial or duplicate chunks.");
    assert(txtChunks.every((chunk) => chunk.generation === readyTxt.generation), "TXT has a stale-generation chunk.");
    assert(txtChunks.some((chunk) => chunk.content.includes("END_FACT")), "end-of-document fact was not retained in a chunk.");
    assert(txtChunks.every((chunk) => vectorDimension(chunk.embedding) === 1024), "TXT chunk embedding is not 1024-dimensional.");
    assert(txtChunks.every((chunk) => encoder.encode(chunk.content).byteLength <= 600), "TXT chunk exceeds its UTF-8 byte budget.");

    const mdBytes = encoder.encode("# Returns\nUnused bikes may be returned within 30 days.");
    const mdUpload = await upload(apiUrl, anonKey, ownerToken, botId, "returns.md", mdBytes);
    assert(mdUpload.response.status === 201, "valid Markdown upload was rejected.");
    const mdDocument = mdUpload.body.document;
    storagePaths.push(mdDocument.storage_path);
    const mdProcess = await callJson(apiUrl, anonKey, "process-document", ownerToken, { document_id: mdDocument.id });
    assert(mdProcess.response.status === 200 && mdProcess.body.status === "ready", "Markdown processing did not finish ready.");

    const repeated = await callJson(apiUrl, anonKey, "process-document", ownerToken, { document_id: txtDocument.id });
    assert(repeated.response.status === 200 && repeated.body.status === "ready" && repeated.body.idempotent === true, "ready processing was not idempotent.");
    const repeatedCount = (await adminSelect(apiUrl, serviceRoleKey, "document_chunks", {
      select: "id",
      document_id: "eq." + txtDocument.id,
    })).length;
    assert(repeatedCount === txtChunks.length, "repeated processing duplicated TXT chunks.");

    const invalid = await upload(apiUrl, anonKey, ownerToken, botId, "invalid.txt", new Uint8Array([0xff, 0xfe, 0xfd]));
    assert(invalid.response.status === 400 && invalid.body.code === "invalid_encoding", "invalid UTF-8 was accepted.");
    const empty = await upload(apiUrl, anonKey, ownerToken, botId, "empty.txt", new Uint8Array());
    assert(empty.response.status === 400 && empty.body.code === "empty_document", "empty source was accepted.");
    const oversized = await upload(apiUrl, anonKey, ownerToken, botId, "oversized.txt", new Uint8Array(maxSourceBytes + 1));
    assert(oversized.response.status === 413 && oversized.body.code === "source_too_large", "oversized source was accepted.");
    const failedCount = (await adminSelect(apiUrl, serviceRoleKey, "documents", {
      select: "id",
      bot_id: "eq." + botId,
      file_name: "in.(invalid.txt,empty.txt,oversized.txt)",
    })).length;
    assert(failedCount === 0, "rejected sources left document rows behind.");

    const foreignUpload = await upload(apiUrl, anonKey, foreignToken, botId, "foreign.txt", encoder.encode("foreign"));
    assert(foreignUpload.response.status === 404, "foreign tenant uploaded into another bot.");
    const foreignProcess = await callJson(apiUrl, anonKey, "process-document", foreignToken, { document_id: txtDocument.id });
    assert(foreignProcess.response.status === 404, "foreign tenant processed another tenant's document.");
    const foreignDelete = await callJson(apiUrl, anonKey, "delete-document", foreignToken, { document_id: txtDocument.id });
    assert(foreignDelete.response.status === 404, "foreign tenant deleted another tenant's document.");

    const raceUpload = await upload(apiUrl, anonKey, ownerToken, botId, "race.txt", encoder.encode("race source"));
    assert(raceUpload.response.status === 201, "race fixture upload failed.");
    const raceDocument = raceUpload.body.document;
    storagePaths.push(raceDocument.storage_path);
    const raceLease = crypto.randomUUID();
    const claim = await adminRpc(apiUrl, serviceRoleKey, "claim_document_processing", {
      p_owner_id: ownerId,
      p_document_id: raceDocument.id,
      p_lease_id: raceLease,
      p_lease_seconds: 180,
    });
    assert(claim.response.ok && claim.body?.claimed === true, "race fixture did not acquire a processing lease.");
    const generation = Number(claim.body.generation);
    const deletedRace = await callJson(apiUrl, anonKey, "delete-document", ownerToken, { document_id: raceDocument.id });
    assert(deletedRace.response.status === 200 && deletedRace.body.deleted === true, "race document delete failed.");
    const staleInsert = await adminRpc(apiUrl, serviceRoleKey, "insert_document_chunks", {
      p_document_id: raceDocument.id,
      p_lease_id: raceLease,
      p_generation: generation,
      p_chunks: [{ chunk_index: 0, content: "late worker", embedding: zeroVector }],
    });
    assert(staleInsert.response.ok && staleInsert.body === false, "stale worker recreated chunks after deletion.");
    const staleFinalize = await adminRpc(apiUrl, serviceRoleKey, "finalize_document_processing", {
      p_document_id: raceDocument.id,
      p_lease_id: raceLease,
      p_generation: generation,
      p_chunk_count: 1,
    });
    assert(staleFinalize.response.ok && staleFinalize.body === false, "stale worker finalized a deleted document.");
    const raceRemaining = (await adminSelect(apiUrl, serviceRoleKey, "documents", {
      select: "id",
      id: "eq." + raceDocument.id,
    }))[0];
    assert(!raceRemaining, "deleted race document still exists.");
    const raceChunks = (await adminSelect(apiUrl, serviceRoleKey, "document_chunks", {
      select: "id",
      document_id: "eq." + raceDocument.id,
    })).length;
    assert(raceChunks === 0, "deleted race document has chunks.");
    const raceTombstone = (await adminSelect(apiUrl, serviceRoleKey, "deleted_storage_objects", {
      select: "storage_path",
      storage_path: "eq." + raceDocument.storage_path,
    }))[0];
    assert(raceTombstone?.storage_path === raceDocument.storage_path, "race delete lost its storage tombstone.");

    const deleted = await callJson(apiUrl, anonKey, "delete-document", ownerToken, { document_id: txtDocument.id });
    assert(deleted.response.status === 200 && deleted.body.deleted === true, "TXT delete failed.");
    const deletedDocument = (await adminSelect(apiUrl, serviceRoleKey, "documents", {
      select: "id",
      id: "eq." + txtDocument.id,
    }))[0];
    assert(!deletedDocument, "deleted TXT row remains.");
    const deletedChunks = (await adminSelect(apiUrl, serviceRoleKey, "document_chunks", {
      select: "id",
      document_id: "eq." + txtDocument.id,
    })).length;
    assert(deletedChunks === 0, "deleted TXT chunks remain retrievable.");
    const tombstone = (await adminSelect(apiUrl, serviceRoleKey, "deleted_storage_objects", {
      select: "storage_path",
      storage_path: "eq." + txtDocument.storage_path,
    }))[0];
    assert(tombstone?.storage_path === txtDocument.storage_path, "TXT delete lost its cleanup tombstone.");
    const repeatedDelete = await callJson(apiUrl, anonKey, "delete-document", ownerToken, { document_id: txtDocument.id });
    assert(repeatedDelete.response.status === 200 && repeatedDelete.body.already_deleted === true, "repeated delete was not idempotent.");

    console.log("ingestion integration passed");
  } finally {
    await removeStorage(apiUrl, serviceRoleKey, storagePaths);
    if (foreignId) await deleteUser(apiUrl, serviceRoleKey, foreignId);
    if (ownerId) await deleteUser(apiUrl, serviceRoleKey, ownerId);
  }
}

main().catch((error) => {
  console.error("ingestion integration failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
