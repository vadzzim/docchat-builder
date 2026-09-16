import { createServer } from "node:http";

const host = process.env.CONTROLLED_PROVIDER_HOST ?? "0.0.0.0";
const port = Number(process.env.CONTROLLED_PROVIDER_PORT ?? 11434);
const embedding = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
const insufficientAnswer = "I couldn't find that in the uploaded documents.";

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 2_000_000) throw new Error("request too large");
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("invalid JSON");
  }
}

export function answerFor(messages) {
  const question = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === "user")?.content ?? "";
  const source = [...(Array.isArray(messages) ? messages : [])]
    .find((message) => message?.role === "system")?.content ?? "";
  const normalized = String(question).toLocaleLowerCase("en-US");
  if (normalized.includes("phone")) return insufficientAnswer;
  const shippingSupported = typeof source === "string" && source.includes("Standard shipping costs $8") && /takes 3\s*[–-]\s*5 business days/.test(source);
  if ((normalized.includes("ship") || normalized.includes("cost")) && shippingSupported) {
    return "Standard shipping costs $8 and takes 3-5 business days.";
  }
  const supportSupported = typeof source === "string" && source.includes("support@northstar.example") && source.includes("Monday through Friday");
  if ((normalized.includes("support") || normalized.includes("email")) && supportSupported) {
    return "Contact support@northstar.example. Support hours are Monday through Friday, 09:00-17:00 UTC.";
  }
  return insufficientAnswer;
}

function streamAnswer(response, answer) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": "application/x-ndjson; charset=utf-8",
  });
  for (const token of answer.match(/.{1,18}/gu) ?? [answer]) {
    response.write(JSON.stringify({ message: { content: token }, done: false }) + "\n");
  }
  response.end(JSON.stringify({ done: true, done_reason: "stop" }) + "\n");
}

function selfTest() {
  const supported = [
    { role: "system", content: "SOURCE BLOCKS:\nStandard shipping costs $8 and takes 3–5 business days." },
    { role: "user", content: "What is the standard shipping cost?" },
  ];
  if (!answerFor(supported).includes("$8")) throw new Error("controlled provider lost a supported source fact");
  const unsupported = [
    { role: "system", content: "SOURCE BLOCKS:\nShipping is not documented here." },
    { role: "user", content: "What is the standard shipping cost?" },
  ];
  if (answerFor(unsupported) !== insufficientAnswer) throw new Error("controlled provider answered without a source fact");
  console.log("Controlled provider contract passed");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && (request.url === "/health" || request.url === "/api/tags")) {
        sendJson(response, 200, { models: [{ name: "ci-controlled" }] });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid request body");
      if (request.url === "/api/embed") {
        const values = Array.isArray(body.input) ? body.input : [body.input];
        if (values.length === 0 || values.some((value) => typeof value !== "string")) throw new Error("invalid embedding input");
        sendJson(response, 200, { embeddings: values.map(() => embedding) });
        return;
      }
      if (request.url === "/api/chat") {
        if (!Array.isArray(body.messages)) throw new Error("invalid chat messages");
        streamAnswer(response, answerFor(body.messages));
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "bad_request" });
    }
  });

  server.listen(port, host, () => console.log(`Controlled provider listening on ${host}:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
