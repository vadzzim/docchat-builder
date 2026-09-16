import { HttpError } from "./http.ts";

type OllamaResponse = {
  error?: unknown;
  done?: unknown;
  done_reason?: unknown;
  message?: { content?: unknown };
  response?: unknown;
};

function parseLine(line: string): { content: string; done: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Ollama returned malformed streaming data.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ollama returned malformed streaming data.");
  }
  const body = value as OllamaResponse;
  if ((body.done !== undefined && typeof body.done !== "boolean") ||
    (body.done_reason !== undefined && typeof body.done_reason !== "string")) {
    throw new Error("Ollama returned malformed streaming data.");
  }
  if (body.error) throw new Error("Ollama provider returned an error.");
  if (body.done === true && body.done_reason === "length") {
    throw new HttpError(502, "The AI answer was truncated by the response length limit. Please try again.", "answer_truncated");
  }
  const messageContent = body.message?.content;
  const content = typeof messageContent === "string"
    ? messageContent
    : typeof body.response === "string" ? body.response : "";
  return { content, done: body.done === true };
}

/** Decode Ollama's newline-delimited JSON without coupling parsing to HTTP transport. */
export async function* decodeOllamaStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (parsed.content) yield parsed.content;
      if (parsed.done) {
        sawDone = true;
        break;
      }
    }
    if (sawDone) break;
  }

  buffer += decoder.decode();
  if (!sawDone && buffer.trim()) {
    const parsed = parseLine(buffer);
    if (parsed.content) yield parsed.content;
    sawDone = parsed.done;
  }
  if (!sawDone) throw new Error("Ollama stream ended before completion.");
}
