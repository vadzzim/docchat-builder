import { HttpError } from "./http.ts";

const baseUrl = (Deno.env.get("OLLAMA_BASE_URL") ?? "http://host.docker.internal:11434").replace(/\/+$/, "");
const chatModel = Deno.env.get("OLLAMA_CHAT_MODEL") ?? "qwen3:0.6b";
const embedModel = Deno.env.get("OLLAMA_EMBED_MODEL") ?? "bge-m3";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function validateEmbeddings(value: unknown): number[][] {
  const embeddings = (value as { embeddings?: unknown })?.embeddings;
  if (!Array.isArray(embeddings)) throw new Error("Ollama embedding response was invalid.");
  const result = embeddings.map((embedding) => {
    if (!Array.isArray(embedding) || embedding.length !== 1024 ||
      embedding.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new Error("Ollama embedding dimension was invalid.");
    }
    return embedding as number[];
  });
  return result;
}

export async function embed(input: string | string[], parentSignal?: AbortSignal): Promise<number[][]> {
  const values = Array.isArray(input) ? input : [input];
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(baseUrl + "/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: embedModel, input, truncate: false, keep_alive: "5m" }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Ollama embedding request failed (" + response.status + ").");
    const result = validateEmbeddings(await readJson(response));
    if (result.length !== values.length) throw new Error("Ollama returned the wrong embedding count.");
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function* chatStream(messages: ChatMessage[], parentSignal?: AbortSignal): AsyncGenerator<string> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), 90000);
  let sawDone = false;
  let response: Response;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await fetch(baseUrl + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: chatModel,
        messages,
        stream: true,
        think: false,
        keep_alive: "5m",
        options: { temperature: 0.1, num_ctx: 4096, num_predict: 500 },
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error("Ollama chat request failed (" + response.status + ").");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let body: { error?: string; done?: boolean; message?: { content?: string }; response?: string };
        try {
          body = JSON.parse(line);
        } catch {
          throw new Error("Ollama returned malformed streaming data.");
        }
        if (body.error) throw new Error("Ollama provider returned an error.");
        const content = body.message?.content ?? body.response ?? "";
        if (content) yield content;
        if (body.done) {
          sawDone = true;
          break;
        }
      }
      if (sawDone) break;
    }
    if (!sawDone && buffer.trim()) {
      let body: { error?: string; done?: boolean; message?: { content?: string }; response?: string };
      try {
        body = JSON.parse(buffer);
      } catch {
        throw new Error("Ollama returned an incomplete streaming response.");
      }
      if (body.error) throw new Error("Ollama provider returned an error.");
      const content = body.message?.content ?? body.response ?? "";
      if (content) yield content;
      sawDone = Boolean(body.done);
    }
    if (!sawDone) throw new Error("Ollama stream ended before completion.");
  } finally {
    clearTimeout(timer);
    controller.abort();
    parentSignal?.removeEventListener("abort", abortFromParent);
    reader?.releaseLock();
  }
}

export function vectorLiteral(values: number[]): string {
  return "[" + values.join(",") + "]";
}

export function providerError(): HttpError {
  return new HttpError(502, "The AI provider is unavailable. Try again shortly.", "provider_unavailable");
}
