import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const projectDirectory = process.cwd();
const appUrl = process.env.DOCCHAT_APP_URL ?? "http://127.0.0.1:3000";
const demoUrl = process.env.DOCCHAT_DEMO_URL ?? "http://127.0.0.1:3001";
const mailpitUrl = process.env.DOCCHAT_MAILPIT_URL ?? "http://127.0.0.1:55324";
const appOrigin = new URL(appUrl).origin;
const password = "Local-only-DocChat-2026!";
const maxProcessingMilliseconds = 180000;
const networkTimeoutMilliseconds = 30000;
const testFiles = ["shipping.md", "returns.txt", "support.md"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fetchWithTimeout(url, options = {}, timeoutMilliseconds = networkTimeoutMilliseconds) {
  return fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMilliseconds) });
}

async function waitFor(description, operation, timeoutMilliseconds = 30000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch {
      // The page or local service may still be loading.
    }
    await wait(250);
  }
  throw new Error(description);
}

function getRuntimeStatus() {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npx.cmd --yes supabase@2.117.0 status -o json"]
    : ["--yes", "supabase@2.117.0", "status", "-o", "json"];
  try {
    const raw = execFileSync(command, args, {
      cwd: projectDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: networkTimeoutMilliseconds,
      windowsHide: true,
    });
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("status");
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error("Supabase local status could not be read.");
  }
}

function statusValue(status, wanted) {
  const normalizedWanted = wanted.replace(/[^a-z]/gi, "").toLowerCase();
  for (const [key, value] of Object.entries(status)) {
    if (typeof value !== "string") continue;
    if (key.replace(/[^a-z]/gi, "").toLowerCase() === normalizedWanted) return value;
  }
  throw new Error("Supabase local status is missing a required value.");
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

async function restJson(apiUrl, path, options = {}) {
  const response = await fetchWithTimeout(apiUrl + path, options);
  return { response, body: await responseBody(response) };
}

async function adminSelect(apiUrl, serviceRoleKey, table, query) {
  const params = new URLSearchParams(query);
  const result = await restJson(apiUrl, "/rest/v1/" + table + "?" + params, {
    headers: authHeaders(serviceRoleKey),
  });
  if (!result.response.ok || !Array.isArray(result.body)) throw new Error("Admin read failed.");
  return result.body;
}

async function findUserId(apiUrl, serviceRoleKey, email) {
  const result = await restJson(apiUrl, "/auth/v1/admin/users?page=1&per_page=1000", {
    headers: authHeaders(serviceRoleKey),
  });
  const users = Array.isArray(result.body?.users) ? result.body.users : [];
  const user = users.find((candidate) => candidate.email === email);
  if (!result.response.ok || !user?.id) throw new Error("Browser smoke user was not found.");
  return user.id;
}

async function userExists(apiUrl, serviceRoleKey, userId) {
  const result = await restJson(apiUrl, "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    headers: authHeaders(serviceRoleKey),
  });
  return result.response.ok;
}

async function deleteUser(apiUrl, serviceRoleKey, userId) {
  if (!userId) return;
  const result = await restJson(apiUrl, "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    method: "DELETE",
    headers: authHeaders(serviceRoleKey),
  });
  if (!result.response.ok && result.response.status !== 404) throw new Error("Browser smoke user cleanup failed.");
}

async function removeStorage(apiUrl, serviceRoleKey, paths) {
  if (paths.length === 0) return;
  const response = await fetchWithTimeout(apiUrl + "/storage/v1/object/documents", {
    method: "DELETE",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!response.ok) throw new Error("Browser smoke storage cleanup failed.");
  await response.arrayBuffer();
}

async function signIn(apiUrl, anonKey, email) {
  const result = await restJson(apiUrl, "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: authHeaders(anonKey),
    body: JSON.stringify({ email, password }),
  });
  if (!result.response.ok || typeof result.body.access_token !== "string") throw new Error("Browser smoke sign-in failed.");
  return result.body.access_token;
}

async function callEdge(apiUrl, anonKey, path, token, body) {
  const result = await restJson(apiUrl, "/functions/v1/" + path, {
    method: "POST",
    headers: authHeaders(anonKey, token),
    body: JSON.stringify(body),
  });
  return result;
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

async function readBot(apiUrl, serviceRoleKey, accountId) {
  const rows = await adminSelect(apiUrl, serviceRoleKey, "bots", {
    select: "id,name,public_enabled,allowed_origins",
    account_id: "eq." + accountId,
  });
  return rows[0] ?? null;
}

async function readDocuments(apiUrl, serviceRoleKey, botId) {
  return adminSelect(apiUrl, serviceRoleKey, "documents", {
    select: "id,file_name,status,storage_path",
    bot_id: "eq." + botId,
    order: "created_at.asc",
  });
}

async function browserSession(page) {
  return page.evaluate(() => {
    for (const value of Object.values(localStorage)) {
      try {
        const candidate = JSON.parse(value);
        if (candidate && typeof candidate.access_token === "string") {
          return { accessToken: candidate.access_token, userId: candidate.user?.id ?? null };
        }
      } catch {
        // Ignore unrelated local storage values.
      }
    }
    return null;
  });
}

async function confirmationLink(email) {
  const result = await restJson(mailpitUrl, "/api/v1/messages?limit=100");
  if (!result.response.ok || !Array.isArray(result.body?.messages)) throw new Error("Mailpit messages could not be read.");
  const messages = result.body.messages.filter((message) => message.To?.some((recipient) => recipient.Address === email));
  for (const message of messages) {
    const detail = await restJson(mailpitUrl, "/api/v1/message/" + encodeURIComponent(message.ID));
    const source = String(detail.body?.HTML ?? "") + "\n" + String(detail.body?.Text ?? "");
    const htmlLink = source.match(/href=["']([^"']+\/auth\/v1\/verify[^"']*)["']/i);
    const textLink = source.match(/(https?:\/\/[^\s)<>]+\/auth\/v1\/verify[^\s)<>]*)/i);
    const rawLink = htmlLink?.[1] ?? textLink?.[1];
    if (!rawLink) continue;
    const link = rawLink.replaceAll("&amp;", "&");
    try {
      const parsed = new URL(link);
      if (parsed.pathname === "/auth/v1/verify") return parsed.toString();
    } catch {
      // Ignore unrelated message content.
    }
  }
  return null;
}

async function waitForConfirmationLink(email) {
  return waitFor("confirmation email", () => confirmationLink(email), 60000);
}

async function waitForVisible(locator, description, timeoutMilliseconds = 30000) {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMilliseconds });
  } catch {
    throw new Error(description);
  }
  return locator;
}

async function textOf(locator) {
  return String(await locator.textContent() ?? "");
}

async function acceptNextDialog(page) {
  page.once("dialog", (dialog) => void dialog.accept());
}

async function setPublicToggle(page, enabled) {
  const checkbox = page.getByRole("checkbox", { name: "Enable public chat" });
  const checked = await checkbox.isChecked();
  if (checked === enabled) return;
  await checkbox.focus();
  await page.keyboard.press("Space");
}

function browserExecutablePath() {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const bundled = join(localAppData, "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe");
  return existsSync(bundled) ? bundled : undefined;
}

async function main() {
  const runtime = getRuntimeStatus();
  const apiUrl = statusValue(runtime, "API_URL");
  const anonKey = statusValue(runtime, "ANON_KEY");
  const serviceRoleKey = statusValue(runtime, "SERVICE_ROLE_KEY");
  const suffix = Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);
  const ownerEmail = "browser-smoke-" + suffix + "@docchat.example";
  let ownerId = "";
  let ownerToken = "";
  let botId = "";
  const storagePaths = new Set();
  let browser;
  let context;
  let ownerPage;
  let externalPage;

  try {
    browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    context.setDefaultTimeout(20000);
    ownerPage = await context.newPage();

    await ownerPage.goto(appUrl, { waitUntil: "domcontentloaded" });
    await waitForVisible(ownerPage.getByRole("link", { name: "Try DocChat free" }), "landing page did not load");
    await ownerPage.getByRole("link", { name: "Try DocChat free" }).click();
    await ownerPage.waitForURL(/\/auth(?:\?|$)/, { timeout: 30000 });
    await ownerPage.goto(appUrl + "/auth?mode=signup", { waitUntil: "domcontentloaded" });
    await ownerPage.locator("#auth-email").fill(ownerEmail);
    await ownerPage.locator("#auth-password").fill(password);
    await ownerPage.getByRole("button", { name: "Create account" }).click();
    await waitForVisible(ownerPage.getByRole("status").filter({ hasText: "Check your email" }), "signup confirmation state did not appear");

    const link = await waitForConfirmationLink(ownerEmail);
    await ownerPage.goto(link, { waitUntil: "domcontentloaded" });
    try {
      await ownerPage.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 30000 });
    } catch {
      if (ownerPage.url().includes("/auth/callback")) {
        await waitForVisible(ownerPage.getByRole("button", { name: "Continue to sign in" }), "confirmation callback did not complete");
        await ownerPage.getByRole("button", { name: "Continue to sign in" }).click();
        await ownerPage.waitForURL(/\/auth(?:\?|$)/, { timeout: 30000 });
        await ownerPage.locator("#auth-email").fill(ownerEmail);
        await ownerPage.locator("#auth-password").fill(password);
        await ownerPage.getByRole("button", { name: "Sign in" }).click();
        await ownerPage.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 30000 });
      } else {
        throw new Error("confirmation did not reach the workspace");
      }
    }

    const storedSession = await browserSession(ownerPage);
    ownerToken = storedSession?.accessToken ?? await signIn(apiUrl, anonKey, ownerEmail);
    ownerId = storedSession?.userId ?? await findUserId(apiUrl, serviceRoleKey, ownerEmail);
    await waitForVisible(ownerPage.getByRole("heading", { name: "Create your bot" }), "workspace create-bot state did not appear");
    await ownerPage.locator("#bot-name").fill("Northstar browser smoke");
    await ownerPage.locator("#bot-greeting").fill("How can Northstar help?");
    await ownerPage.getByRole("button", { name: "Create bot" }).click();
    await waitForVisible(ownerPage.getByText("Your bot", { exact: true }), "bot creation did not complete");
    botId = (await readBot(apiUrl, serviceRoleKey, ownerId))?.id ?? "";
    assert(Boolean(botId), "browser smoke bot id is missing");

    await ownerPage.getByRole("button", { name: "Knowledge" }).click();
    const fileInput = ownerPage.locator('input[type="file"]');
    for (const fileName of testFiles) {
      await fileInput.setInputFiles(join(projectDirectory, "demo", fileName));
      const row = ownerPage.locator("div.rounded-2xl.bg-slate-50").filter({ hasText: fileName }).last();
      await waitForVisible(row.getByText("Ready", { exact: true }), fileName + " did not become ready", maxProcessingMilliseconds);
      for (const document of await readDocuments(apiUrl, serviceRoleKey, botId)) {
        if (document.storage_path) storagePaths.add(document.storage_path);
      }
    }
    const readyDocuments = await readDocuments(apiUrl, serviceRoleKey, botId);
    assert(readyDocuments.length === 3 && readyDocuments.every((document) => document.status === "ready"), "browser smoke documents were not ready");

    await ownerPage.getByRole("button", { name: "Chat" }).click();
    const ownerLog = ownerPage.getByRole("log", { name: "Chat transcript" });
    await ownerPage.locator("#chat-message").fill("What does standard shipping cost and how long does it take?");
    await ownerPage.getByRole("button", { name: "Send" }).click();
    await waitForVisible(ownerLog.locator("p").filter({ hasText: "$8" }).first(), "owner answer did not include the shipping cost", maxProcessingMilliseconds);
    await waitForVisible(ownerLog.getByText(/Sources \(\d+\)/, { exact: false }), "owner answer did not show sources", maxProcessingMilliseconds);
    const ownerConversation = ownerPage.getByRole("button", { name: /Conversation from/ }).first();
    await waitForVisible(ownerConversation, "owner conversation was not added to history", maxProcessingMilliseconds);
    const usageAfterOwner = await waitFor("owner usage reservation", async () => (await readUsage(apiUrl, serviceRoleKey, ownerId)) === 1 ? 1 : 0, 30000);
    assert(usageAfterOwner === 1, "owner usage was not reserved once");

    await ownerPage.reload({ waitUntil: "domcontentloaded" });
    await ownerPage.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 30000 });
    await ownerPage.getByRole("button", { name: "Chat" }).click();
    const restoredConversation = ownerPage.getByRole("button", { name: /Conversation from/ }).first();
    await waitForVisible(restoredConversation, "owner conversation history did not reload", 30000);
    await restoredConversation.click();
    const restoredLog = ownerPage.getByRole("log", { name: "Chat transcript" });
    await waitForVisible(restoredLog.locator("p").filter({ hasText: "$8" }).first(), "owner history did not restore the answer", 30000);

    await ownerPage.getByRole("button", { name: "Billing" }).click();
    await waitForVisible(ownerPage.getByRole("heading", { name: "Choose your plan" }), "billing section did not load");
    await acceptNextDialog(ownerPage);
    await ownerPage.getByRole("button", { name: "Upgrade to Pro" }).click();
    await waitForVisible(ownerPage.getByText("Pro is active.", { exact: false }), "mock Pro upgrade did not complete");
    await acceptNextDialog(ownerPage);
    await ownerPage.getByRole("button", { name: "Downgrade to Free" }).click();
    await waitForVisible(ownerPage.getByText("Free is active.", { exact: false }), "mock Free downgrade did not complete");
    assert(await readUsage(apiUrl, serviceRoleKey, ownerId) === 1, "mock plan change reset usage");
    assert((await readDocuments(apiUrl, serviceRoleKey, botId)).length === 3, "mock plan change removed documents");

    await ownerPage.getByRole("button", { name: "Settings" }).click();
    await ownerPage.locator("#settings-origins").fill("http://127.0.0.1:3001");
    await acceptNextDialog(ownerPage);
    await setPublicToggle(ownerPage, true);
    await ownerPage.getByRole("button", { name: "Save settings" }).click();
    await waitForVisible(ownerPage.getByText("Public chat is enabled", { exact: false }), "publishing did not complete");
    const snippet = await ownerPage.getByLabel("Embed snippet").inputValue();
    assert(snippet.includes("data-bot-id=\"" + botId + "\"") && snippet.includes("/widget.js"), "embed snippet is incomplete");

    externalPage = await context.newPage();
    let visitorAuthorization;
    let visitorChatBody;
    let visitorChatUrl = "";
    externalPage.on("request", (request) => {
      if (!request.url().includes("/functions/v1/chat")) return;
      visitorAuthorization = request.headers().authorization;
      visitorChatUrl = request.url();
      try { visitorChatBody = request.postDataJSON(); } catch { /* request body may be unavailable */ }
    });
    const sessionResponsePromise = externalPage.waitForResponse(
      (response) => response.url().includes("/functions/v1/public-session"),
      { timeout: networkTimeoutMilliseconds },
    );
    await externalPage.goto(demoUrl + "/?bot_id=" + encodeURIComponent(botId), { waitUntil: "domcontentloaded" });
    const sessionResponse = await sessionResponsePromise;
    const sessionBody = await responseBody(sessionResponse);
    const visitorSessionToken = typeof sessionBody.session_token === "string" ? sessionBody.session_token : "";
    assert(sessionResponse.status() === 201 && visitorSessionToken.length >= 40, "visitor session was not created");
    assert(!externalPage.url().includes(visitorSessionToken), "visitor session token leaked into the demo URL");
    await waitForVisible(externalPage.locator('button[aria-label="Open DocChat"]'), "external demo did not load");
    await externalPage.locator('button[aria-label="Open DocChat"]').click();
    const widgetFrame = externalPage.locator('iframe[title="DocChat support chat"]');
    const widgetFrameSource = await widgetFrame.getAttribute("src");
    assert(!String(widgetFrameSource ?? "").includes(visitorSessionToken), "visitor session token leaked into the iframe URL");
    const widget = externalPage.frameLocator('iframe[title="DocChat support chat"]');
    const widgetInput = widget.locator("#widget-message");
    await widgetInput.waitFor({ state: "visible", timeout: 30000 });
    await widgetInput.fill("What does standard shipping cost and how long does it take?");
    await widget.getByRole("button", { name: "Send" }).click();
    const widgetLog = widget.getByRole("log", { name: "Visitor chat transcript" });
    await waitForVisible(widgetLog.locator("p").filter({ hasText: "$8" }).first(), "visitor answer did not include the shipping cost", maxProcessingMilliseconds);
    await waitForVisible(widgetLog.getByText(/Sources \(\d+\)/, { exact: false }), "visitor answer did not show sources", maxProcessingMilliseconds);
    await waitFor("visitor session token in chat body", () => visitorChatBody?.session_token === visitorSessionToken ? true : 0, networkTimeoutMilliseconds);
    assert(!visitorChatUrl.includes(visitorSessionToken), "visitor session token leaked into the chat URL");
    assert(visitorChatBody?.session_token === visitorSessionToken, "visitor chat did not use its scoped session token");
    assert(visitorAuthorization === undefined, "visitor chat sent an owner Authorization header");
    await waitFor("shared owner and visitor usage", async () => (await readUsage(apiUrl, serviceRoleKey, ownerId)) === 2 ? 2 : 0, 30000);

    await externalPage.route("**/functions/v1/chat", async (route) => {
      const corsHeaders = {
        "Access-Control-Allow-Origin": appOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
        body: "event: meta\ndata: {\"conversation_id\":\"00000000-0000-0000-0000-000000000001\"}\n\nevent: token\ndata: {\"token\":\"Partial response\"}\n\n",
      });
    });
    await widgetInput.fill("What are support hours?");
    await widget.getByRole("button", { name: "Send" }).click();
    const transportAlert = widget.locator('p[role="alert"]').filter({ hasText: "The chat stream ended before" }).first();
    await waitForVisible(transportAlert, "visitor transport failure did not surface", 30000);
    assert((await textOf(transportAlert)).includes("ended before the answer was complete"), "truncated visitor stream error was unclear");
    await waitForVisible(widgetLog.locator("p").filter({ hasText: "Partial response" }).first(), "truncated visitor token was not rendered", 30000);
    await waitForVisible(widgetLog.getByText("Incomplete response. Try again.", { exact: true }), "truncated visitor stream was marked complete", 30000);
    await externalPage.unroute("**/functions/v1/chat");

    await setPublicToggle(ownerPage, false);
    await ownerPage.getByRole("button", { name: "Save settings" }).click();
    await waitForVisible(ownerPage.getByText("Public chat is off", { exact: false }), "unpublish did not complete");
    const blockedResponse = externalPage.waitForResponse((response) => response.url().includes("/functions/v1/public-session"));
    await externalPage.reload({ waitUntil: "domcontentloaded" });
    assert((await blockedResponse).status() === 404, "unpublished bot issued a new visitor session");
    await externalPage.locator('button[aria-label="Open DocChat"]').click();
    await waitForVisible(externalPage.locator('[data-docchat-widget]').locator(".status-title"), "unpublished widget did not show an error");

    await ownerPage.bringToFront();
    await acceptNextDialog(ownerPage);
    await ownerPage.getByRole("button", { name: "Delete bot" }).click();
    await waitForVisible(ownerPage.getByRole("heading", { name: "Create your bot" }), "delete bot did not return to the create state");
    assert(await userExists(apiUrl, serviceRoleKey, ownerId), "deleting the bot removed the owner account");
    assert((await adminSelect(apiUrl, serviceRoleKey, "bots", { select: "id", account_id: "eq." + ownerId })).length === 0, "deleted bot remains in the database");
    assert((await adminSelect(apiUrl, serviceRoleKey, "documents", { select: "id", bot_id: "eq." + botId })).length === 0, "deleted bot documents remain");

    console.log("browser smoke passed");
  } finally {
    let cleanupFailed = false;
    try {
      if (externalPage) await externalPage.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (ownerPage) await ownerPage.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (context) await context.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (browser) await browser.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (!ownerId) {
        try { ownerId = await findUserId(apiUrl, serviceRoleKey, ownerEmail); } catch { /* signup may not have completed */ }
      }
      if (botId) {
        try {
          for (const document of await readDocuments(apiUrl, serviceRoleKey, botId)) {
            if (document.storage_path) storagePaths.add(document.storage_path);
          }
        } catch { /* the bot may already have been deleted */ }
      }
      if (!ownerToken && ownerId) ownerToken = await signIn(apiUrl, anonKey, ownerEmail);
      if (ownerToken && botId) {
        const deleted = await callEdge(apiUrl, anonKey, "delete-bot", ownerToken, { bot_id: botId });
        if (!deleted.response.ok && deleted.response.status !== 404) throw new Error("bot cleanup");
      }
    } catch {
      cleanupFailed = true;
    }
    try {
      await removeStorage(apiUrl, serviceRoleKey, [...storagePaths]);
    } catch {
      cleanupFailed = true;
    }
    try {
      await deleteUser(apiUrl, serviceRoleKey, ownerId);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("browser smoke failed");
  process.exitCode = 1;
});
