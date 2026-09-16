import { createServer } from "node:http";

const port = Number(process.env.DEMO_PORT ?? 3001);
const host = "127.0.0.1";
const appUrl = process.env.DOCCHAT_APP_URL ?? "http://127.0.0.1:3000";
const apiUrl = process.env.DOCCHAT_API_URL ?? "http://127.0.0.1:55321";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function originFrom(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const appOrigin = originFrom(appUrl);
const apiOrigin = originFrom(apiUrl);

function page(botId) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Northstar Bikes support</title>
    <style>
      :root{font-family:Arial,Helvetica,sans-serif;color:#172033;background:#f7f8fc}*{box-sizing:border-box}body{margin:0}main{max-width:760px;margin:0 auto;padding:64px 24px}article{border-radius:24px;background:#fff;padding:32px;box-shadow:0 12px 40px rgba(23,32,51,.08)}h1{margin:0;font-size:clamp(2rem,6vw,3.5rem);letter-spacing:-.04em}p{color:#596579;line-height:1.7}small{color:#8a94a6}@media(max-width:520px){main{padding:28px 16px}article{padding:24px}}
    </style>
    <script src="${escapeHtml(appOrigin ?? appUrl)}/widget.js" data-bot-id="${escapeHtml(botId)}" data-api-url="${escapeHtml(apiOrigin ?? apiUrl)}"></script>
  </head>
  <body>
    <main>
      <article>
        <small>Northstar Bikes · local widget demo</small>
        <h1>Ride farther with the right support.</h1>
        <p>We build practical bikes and accessories for everyday rides. Ask our support assistant about shipping, returns, or warranty coverage.</p>
        <p><strong>Try the chat button in the corner.</strong> This page contains only synthetic Northstar Bikes content for local testing.</p>
      </article>
    </main>
  </body>
</html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  if (request.method !== "GET" || (url.pathname !== "/" && url.pathname !== "/index.html")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Not found");
    return;
  }
  const botId = url.searchParams.get("bot_id") ?? process.env.DOCCHAT_BOT_ID ?? "";
  if (!botId) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Set DOCCHAT_BOT_ID or provide ?bot_id=... for the demo.");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(page(botId));
});

server.listen(port, host, () => {
  console.log(`Northstar demo listening at http://${host}:${port}/?bot_id=<your-bot-id>`);
});
