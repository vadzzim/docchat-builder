(function () {
  "use strict";

  var script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;

  function originOf(value) {
    try {
      var url = new URL(value);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
        url.search || url.hash) return null;
      return url.origin;
    } catch (_error) {
      return null;
    }
  }

  function safeOrigin(value) {
    var origin = originOf(value);
    if (!origin) return null;
    try {
      var url = new URL(value);
      return url.pathname === "/" ? origin : null;
    } catch (_error) {
      return null;
    }
  }

  var appOrigin = originOf(script.src);
  var apiOrigin = safeOrigin(script.dataset.apiUrl || "");
  var botId = (script.dataset.botId || "").trim();
  var parentOrigin = safeOrigin(window.location.origin);
  if (!appOrigin || !apiOrigin || !parentOrigin || !botId || botId.length > 100) return;

  function mount() {
  var shadowHost = document.createElement("div");
  shadowHost.setAttribute("data-docchat-widget", "");
  document.body.appendChild(shadowHost);
  var root = shadowHost.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent = "*{box-sizing:border-box}button{font:inherit}.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:999px;background:#172033;color:#fff;box-shadow:0 8px 30px rgba(23,32,51,.22);padding:13px 18px;font-size:14px;font-weight:700;cursor:pointer}.launcher:hover{background:#39445a}.launcher:focus-visible,.retry:focus-visible{outline:3px solid #7064d8;outline-offset:3px}.panel{position:fixed;right:20px;bottom:78px;z-index:2147483000;width:min(390px,calc(100vw - 32px));height:min(680px,calc(100vh - 110px));overflow:hidden;border-radius:20px;background:#fff;box-shadow:0 18px 55px rgba(23,32,51,.25);border:1px solid #e2e6ef}.panel[hidden],.status[hidden]{display:none}.frame{display:block;width:100%;height:100%;border:0;background:#fff}.status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(255,255,255,.97);color:#172033;text-align:center;font:14px/1.5 Arial,Helvetica,sans-serif}.status-card{max-width:280px}.status-title{font-weight:700;font-size:16px}.status-copy{margin:8px 0 16px;color:#596579}.retry{border:1px solid #d7dce8;border-radius:10px;background:#fff;color:#172033;padding:9px 13px;font-weight:700;cursor:pointer}.retry:hover{background:#f7f8fc}@media(max-width:480px){.launcher{right:16px;bottom:16px}.panel{right:16px;bottom:70px;width:calc(100vw - 32px);height:calc(100vh - 92px);border-radius:16px}}";
  root.appendChild(style);

  var launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.type = "button";
  launcher.textContent = "Chat with us";
  launcher.setAttribute("aria-label", "Open DocChat");
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "docchat-widget-panel");
  root.appendChild(launcher);

  var panel = document.createElement("section");
  panel.className = "panel";
  panel.id = "docchat-widget-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "DocChat");
  var iframe = document.createElement("iframe");
  iframe.className = "frame";
  iframe.title = "DocChat support chat";
  iframe.referrerPolicy = "no-referrer";
  iframe.src = appOrigin + "/widget?bot_id=" + encodeURIComponent(botId) + "&parent_origin=" + encodeURIComponent(parentOrigin);
  panel.appendChild(iframe);

  var status = document.createElement("div");
  status.className = "status";
  status.hidden = true;
  var statusCard = document.createElement("div");
  statusCard.className = "status-card";
  var statusTitle = document.createElement("div");
  statusTitle.className = "status-title";
  statusTitle.textContent = "Chat unavailable";
  var statusCopy = document.createElement("div");
  statusCopy.className = "status-copy";
  var retry = document.createElement("button");
  retry.className = "retry";
  retry.type = "button";
  retry.textContent = "Try again";
  statusCard.appendChild(statusTitle);
  statusCard.appendChild(statusCopy);
  statusCard.appendChild(retry);
  status.appendChild(statusCard);
  panel.appendChild(status);
  root.appendChild(panel);

  var open = false;
  var iframeReady = false;
  var sessionPayload = null;
  var sessionError = null;
  var requestInFlight = false;
  var requestController = null;

  function setOpen(nextOpen) {
    open = nextOpen;
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    if (open) iframe.focus();
    else launcher.focus();
  }

  function showError(message) {
    sessionError = message;
    statusCopy.textContent = message;
    status.hidden = false;
    if (iframeReady && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: "docchat:session_error", bot_id: botId, parent_origin: parentOrigin, message: message }, appOrigin);
    }
  }

  function sendSession() {
    if (!iframeReady || !iframe.contentWindow) return;
    if (sessionPayload) iframe.contentWindow.postMessage(sessionPayload, appOrigin);
    else if (sessionError) iframe.contentWindow.postMessage({ type: "docchat:session_error", bot_id: botId, parent_origin: parentOrigin, message: sessionError }, appOrigin);
  }

  function requestSession() {
    if (requestInFlight) return;
    requestInFlight = true;
    var controller = new AbortController();
    requestController = controller;
    var timeout = window.setTimeout(function () { controller.abort(); }, 15000);
    sessionError = null;
    status.hidden = true;
    fetch(apiOrigin + "/functions/v1/public-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ bot_id: botId, embed_origin: parentOrigin }),
      signal: controller.signal,
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = {}; }
        if (!response.ok || typeof data.session_token !== "string") {
          throw new Error(typeof data.error === "string" ? data.error : "This chat is unavailable right now.");
        }
        return data;
      });
    }).then(function (data) {
      sessionPayload = {
        type: "docchat:session",
        bot_id: botId,
        parent_origin: parentOrigin,
        api_origin: apiOrigin,
        session_token: data.session_token,
        bot: data.bot,
      };
      status.hidden = true;
      sendSession();
    }).catch(function (error) {
      sessionPayload = null;
      var timedOut = error && (error.name === "AbortError" || error.name === "TimeoutError");
      showError(timedOut ? "This chat could not connect. Try again shortly." : error instanceof Error ? error.message : "This chat is unavailable right now.");
    }).finally(function () {
      window.clearTimeout(timeout);
      requestInFlight = false;
      if (requestController === controller) requestController = null;
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== iframe.contentWindow || event.origin !== appOrigin || typeof event.data !== "object" || event.data === null) return;
    var data = event.data;
    if (data.bot_id !== botId || data.parent_origin !== parentOrigin) return;
    if (data.type === "docchat:ready") {
      iframeReady = true;
      sendSession();
    } else if (data.type === "docchat:close") {
      setOpen(false);
    } else if (data.type === "docchat:retry") {
      requestSession();
    }
  });

  launcher.addEventListener("click", function () { setOpen(!open); });
  retry.addEventListener("click", function () { requestSession(); });
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && open) setOpen(false);
  });
  requestSession();
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}());
