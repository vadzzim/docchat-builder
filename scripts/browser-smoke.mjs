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

async function signIn(apiUrl, anonKey, email, userPassword = password) {
  const result = await restJson(apiUrl, "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: authHeaders(anonKey),
    body: JSON.stringify({ email, password: userPassword }),
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

async function recoveryLink(apiUrl, serviceRoleKey, email, redirectTo) {
  const result = await restJson(apiUrl, "/auth/v1/admin/generate_link", {
    method: "POST",
    headers: authHeaders(serviceRoleKey),
    body: JSON.stringify({ type: "recovery", email, redirect_to: redirectTo }),
  });
  if (!result.response.ok || typeof result.body?.action_link !== "string") {
    throw new Error("Recovery link could not be generated.");
  }
  return result.body.action_link;
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
  let recoveryContext;
  let unauthRecoveryContext;

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
    await waitForVisible(ownerLog.getByText(/Retrieved excerpts \(\d+\)/, { exact: false }), "owner answer did not show retrieved excerpts", maxProcessingMilliseconds);
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
    let visitorSessionRequestCount = 0;
    externalPage.on("request", (request) => {
      if (request.url().includes("/functions/v1/public-session")) visitorSessionRequestCount += 1;
      if (!request.url().includes("/functions/v1/chat")) return;
      visitorAuthorization = request.headers().authorization;
      visitorChatUrl = request.url();
      try { visitorChatBody = request.postDataJSON(); } catch { /* request body may be unavailable */ }
    });
    await externalPage.goto(demoUrl + "/?bot_id=" + encodeURIComponent(botId), { waitUntil: "domcontentloaded" });
    await externalPage.waitForTimeout(100);
    const launcher = externalPage.locator('button[aria-label="Open DocChat"]');
    await waitForVisible(launcher, "external demo did not load");
    assert(visitorSessionRequestCount === 0, "visitor session was requested before opening the widget");
    assert(await externalPage.locator('iframe[title="DocChat support chat"]').count() === 0, "widget iframe loaded before opening the widget");
    const sessionResponsePromise = externalPage.waitForResponse(
      (response) => response.url().includes("/functions/v1/public-session"),
      { timeout: networkTimeoutMilliseconds },
    );
    await launcher.click();
    const sessionResponse = await sessionResponsePromise;
    const sessionBody = await responseBody(sessionResponse);
    const visitorSessionToken = typeof sessionBody.session_token === "string" ? sessionBody.session_token : "";
    assert(sessionResponse.status() === 201 && visitorSessionToken.length >= 40, "visitor session was not created");
    assert(!externalPage.url().includes(visitorSessionToken), "visitor session token leaked into the demo URL");
    const widgetFrame = externalPage.locator('iframe[title="DocChat support chat"]');
    const widgetFrameSource = await widgetFrame.getAttribute("src");
    assert(!String(widgetFrameSource ?? "").includes(visitorSessionToken), "visitor session token leaked into the iframe URL");
    const widget = externalPage.frameLocator('iframe[title="DocChat support chat"]');
    const widgetInput = widget.locator("#widget-message");
    await widgetInput.waitFor({ state: "visible", timeout: 30000 });
    await launcher.click();
    await launcher.click();
    await externalPage.waitForTimeout(100);
    assert(visitorSessionRequestCount === 1, "widget reopen requested another visitor session");
    assert(await widgetFrame.count() === 1, "widget reopen created another iframe");
    await widgetInput.fill("What does standard shipping cost and how long does it take?");
    await widget.getByRole("button", { name: "Send" }).click();
    const widgetLog = widget.getByRole("log", { name: "Visitor chat transcript" });
    await waitForVisible(widgetLog.locator("p").filter({ hasText: "$8" }).first(), "visitor answer did not include the shipping cost", maxProcessingMilliseconds);
    await waitForVisible(widgetLog.getByText(/Retrieved excerpts \(\d+\)/, { exact: false }), "visitor answer did not show retrieved excerpts", maxProcessingMilliseconds);
    await waitFor("visitor session token in chat body", () => visitorChatBody?.session_token === visitorSessionToken ? true : 0, networkTimeoutMilliseconds);
    assert(!visitorChatUrl.includes(visitorSessionToken), "visitor session token leaked into the chat URL");
    assert(visitorChatBody?.session_token === visitorSessionToken, "visitor chat did not use its scoped session token");
    assert(visitorAuthorization === undefined, "visitor chat sent an owner Authorization header");
    await waitFor("shared owner and visitor usage", async () => (await readUsage(apiUrl, serviceRoleKey, ownerId)) === 2 ? 2 : 0, 30000);

    const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const interruptedMessage = "What is the standard shipping cost? Please include the delivery time.";
    let interruptedConversationId = "";
    let interruptedRequestId = "";
    let interruptedMetaRequestId = "";
    await externalPage.route("**/functions/v1/chat", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.continue();
        return;
      }
      const actual = await route.fetch();
      const body = (await actual.body()).toString("utf8");
      const metaMatch = body.match(/event: meta\r?\ndata: ([^\r\n]+)/);
      if (metaMatch) {
        try {
          const meta = JSON.parse(metaMatch[1]);
          interruptedConversationId = typeof meta.conversation_id === "string" ? meta.conversation_id : "";
          interruptedMetaRequestId = typeof meta.request_id === "string" ? meta.request_id : "";
        } catch {
          interruptedConversationId = "";
          interruptedMetaRequestId = "";
        }
      }
      interruptedRequestId = actual.headers()["x-request-id"] ?? "";
      assert(requestIdPattern.test(interruptedRequestId), "saved chat response did not return a UUID request ID");
      assert(interruptedMetaRequestId === interruptedRequestId, "saved chat SSE metadata did not match its HTTP request ID");
      const eventBlocks = body.split(/\r?\n\r?\n/);
      assert(eventBlocks.some((block) => /^event: done\r?\n/m.test(block)), "saved chat upstream response did not contain done before the test stripped it");
      const interruptedBody = eventBlocks.filter((block) => !/^event: done\r?\n/m.test(block)).join("\n\n");
      await route.fulfill({ response: actual, body: interruptedBody });
    });
    await widgetInput.fill(interruptedMessage);
    await widget.getByRole("button", { name: "Send" }).click();
    const interruptedAlert = widget.locator('p[role="alert"]').filter({ hasText: "ended before the answer was complete" }).first();
    await waitForVisible(interruptedAlert, "saved chat with a stripped done event did not surface", maxProcessingMilliseconds);
    await waitForVisible(widgetLog.getByText("Incomplete response. Save status is unknown.", { exact: true }), "saved chat was not marked with neutral unknown-save copy", 30000);
    assert((await textOf(interruptedAlert)).includes(interruptedRequestId), "interrupted saved chat did not show its request ID");
    assert(requestIdPattern.test(interruptedRequestId) && requestIdPattern.test(interruptedConversationId), "interrupted saved chat metadata was incomplete");
    await waitFor("interrupted chat persisted despite lost done event", async () => {
      const rows = await adminSelect(apiUrl, serviceRoleKey, "messages", {
        select: "role,content",
        conversation_id: "eq." + interruptedConversationId,
        order: "message_order.asc",
      });
      const userIndex = rows.findIndex((row) => row.role === "user" && row.content === interruptedMessage);
      return userIndex >= 0 && rows[userIndex + 1]?.role === "assistant" && String(rows[userIndex + 1].content).trim().length > 0 ? 1 : 0;
    }, maxProcessingMilliseconds);
    await externalPage.unroute("**/functions/v1/chat");

    await externalPage.route("**/functions/v1/chat", async (route) => {
      const corsHeaders = {
        "Access-Control-Allow-Origin": appOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Expose-Headers": "X-Request-Id",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Request-Id": "33333333-3333-4333-8333-333333333333" },
        body: "event: meta\ndata: {\"conversation_id\":\"00000000-0000-4000-8000-000000000001\",\"request_id\":\"33333333-3333-4333-8333-333333333333\"}\n\nevent: token\ndata: {\"token\":\"Partial response\"}\n\n",
      });
    });
    await widgetInput.fill("What are support hours?");
    await widget.getByRole("button", { name: "Send" }).click();
    const transportAlert = widget.locator('p[role="alert"]').filter({ hasText: "The chat stream ended before" }).first();
    await waitForVisible(transportAlert, "visitor transport failure did not surface", 30000);
    assert((await textOf(transportAlert)).includes("ended before the answer was complete"), "truncated visitor stream error was unclear");
    await waitForVisible(widgetLog.locator("p").filter({ hasText: "Partial response" }).first(), "truncated visitor token was not rendered", 30000);
    await waitForVisible(widgetLog.getByText("Incomplete response. Save status is unknown.", { exact: true }).last(), "truncated visitor stream was marked complete", 30000);
    assert((await textOf(transportAlert)).includes("33333333-3333-4333-8333-333333333333"), "truncated visitor stream did not show its request ID");
    await externalPage.unroute("**/functions/v1/chat");

    await setPublicToggle(ownerPage, false);
    await ownerPage.getByRole("button", { name: "Save settings" }).click();
    await waitForVisible(ownerPage.getByText("Public chat is off", { exact: false }), "unpublish did not complete");
    await externalPage.reload({ waitUntil: "domcontentloaded" });
    await externalPage.waitForTimeout(100);
    await waitForVisible(externalPage.locator('button[aria-label="Open DocChat"]'), "unpublished demo did not load");
    assert(await externalPage.locator('iframe[title="DocChat support chat"]').count() === 0, "unpublished widget iframe loaded before opening the widget");
    const blockedResponse = externalPage.waitForResponse((response) => response.url().includes("/functions/v1/public-session"));
    await externalPage.locator('button[aria-label="Open DocChat"]').click();
    assert((await blockedResponse).status() === 404, "unpublished bot issued a new visitor session");
    await waitForVisible(externalPage.locator('[data-docchat-widget]').locator(".status-title"), "unpublished widget did not show an error");

    await ownerPage.bringToFront();
    await acceptNextDialog(ownerPage);
    await ownerPage.getByRole("button", { name: "Delete bot" }).click();
    await waitForVisible(ownerPage.getByRole("heading", { name: "Create your bot" }), "delete bot did not return to the create state");
    assert(await userExists(apiUrl, serviceRoleKey, ownerId), "deleting the bot removed the owner account");
    assert((await adminSelect(apiUrl, serviceRoleKey, "bots", { select: "id", account_id: "eq." + ownerId })).length === 0, "deleted bot remains in the database");
    assert((await adminSelect(apiUrl, serviceRoleKey, "documents", { select: "id", bot_id: "eq." + botId })).length === 0, "deleted bot documents remain");
    botId = "";

    await ownerPage.goto(appUrl + "/auth/recovery?type=recovery", { waitUntil: "domcontentloaded" });
    await waitForVisible(ownerPage.getByRole("alert").filter({ hasText: "reset link" }), "ordinary session accepted a bare recovery link", 30000);
    assert(await ownerPage.locator("#new-password").count() === 0, "ordinary session exposed the recovery form for a bare link");

    const callbackRecoveryLink = await recoveryLink(apiUrl, serviceRoleKey, ownerEmail, appUrl + "/auth/callback");
    recoveryContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    recoveryContext.setDefaultTimeout(30000);
    const recoveryPage = await recoveryContext.newPage();
    await recoveryPage.route("**/auth/v1/user", async (route) => {
      await wait(6000);
      await route.continue();
    });
    await recoveryPage.goto(callbackRecoveryLink, { waitUntil: "domcontentloaded" });
    await waitForVisible(recoveryPage.locator("#new-password"), "valid recovery callback did not expose the password form", 30000);

    const recoveryControlPage = await recoveryContext.newPage();
    await recoveryControlPage.goto(appUrl + "/dashboard", { waitUntil: "domcontentloaded" });
    await waitForVisible(recoveryControlPage.getByRole("button", { name: "Sign out" }), "recovery control session did not load", 30000);
    await recoveryControlPage.getByRole("button", { name: "Sign out" }).click();
    await waitForVisible(recoveryPage.getByRole("alert").filter({ hasText: "reset link" }), "signed-out recovery session kept the form available", 30000);
    assert(await recoveryPage.locator("#new-password").count() === 0, "signed-out recovery session still exposed the form");

    const directRecoveryLink = await recoveryLink(apiUrl, serviceRoleKey, ownerEmail, appUrl + "/auth/recovery");
    await recoveryPage.goto(directRecoveryLink, { waitUntil: "domcontentloaded" });
    await waitForVisible(recoveryPage.locator("#new-password"), "valid recovery link did not expose the password form", 30000);
    const recoveryPassword = "Recovered-only-DocChat-2026!";
    await recoveryPage.locator("#new-password").fill(recoveryPassword);
    await recoveryPage.locator("#confirm-password").fill(recoveryPassword);
    await recoveryPage.getByRole("button", { name: "Update password" }).click();
    await waitForVisible(recoveryPage.getByRole("status").filter({ hasText: "password has been updated" }), "password recovery did not complete", 30000);
    assert(Boolean(await signIn(apiUrl, anonKey, ownerEmail, recoveryPassword)), "recovered password could not sign in");

    await ownerPage.evaluate(() => localStorage.clear());
    await ownerPage.goto(appUrl + "/auth", { waitUntil: "domcontentloaded" });
    await ownerPage.locator("#auth-email").fill(ownerEmail);
    await ownerPage.locator("#auth-password").fill(recoveryPassword);
    await ownerPage.getByRole("button", { name: "Sign in" }).click();
    await ownerPage.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 30000 });
    await ownerPage.goto(directRecoveryLink, { waitUntil: "domcontentloaded" });
    await waitForVisible(ownerPage.getByRole("alert").filter({ hasText: "reset link" }), "reused recovery link did not show an error", 30000);
    assert(await ownerPage.locator("#new-password").count() === 0, "reused recovery link exposed the form to an ordinary session");

    unauthRecoveryContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    unauthRecoveryContext.setDefaultTimeout(30000);
    const unauthRecoveryPage = await unauthRecoveryContext.newPage();
    await unauthRecoveryPage.goto(appUrl + "/auth/recovery?type=recovery", { waitUntil: "domcontentloaded" });
    await waitForVisible(unauthRecoveryPage.getByRole("alert").filter({ hasText: "reset link" }), "invalid recovery link without a session did not show an error", 30000);
    assert(await unauthRecoveryPage.locator("#new-password").count() === 0, "invalid recovery link without a session exposed the form");

    console.log("browser smoke passed");
  } finally {
    let cleanupFailed = false;
    try {
      if (recoveryContext) await recoveryContext.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (unauthRecoveryContext) await unauthRecoveryContext.close();
    } catch {
      cleanupFailed = true;
    }
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

function safeFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split(/\r?\n/, 1)[0];
  return firstLine
    .replace(/https?:\/\/\S+/g, (value) => {
      try {
        const url = new URL(value);
        return url.origin + url.pathname;
      } catch {
        return "[url]";
      }
    })
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
}

main().catch((error) => {
  console.error("browser smoke failed: " + safeFailureMessage(error));
  process.exitCode = 1;
});
