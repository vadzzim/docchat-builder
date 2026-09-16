import { decodeOllamaStream } from "../functions/_shared/ollama-stream.ts";
import { HttpError } from "../functions/_shared/http.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function* chunksOf(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function collect(text: string, chunks = [new TextEncoder().encode(text)]): Promise<string> {
  let answer = "";
  for await (const token of decodeOllamaStream(chunksOf(chunks))) answer += token;
  return answer;
}

async function expectError(task: () => Promise<unknown>, check: (error: unknown) => boolean, message: string): Promise<void> {
  try {
    await task();
  } catch (error) {
    assert(check(error), message + " (wrong error)");
    return;
  }
  throw new Error(message + " (no error)");
}

Deno.test("Ollama decoder rejects malformed NDJSON", async () => {
  await expectError(
    () => collect("{bad}\n"),
    (error) => error instanceof Error && error.message.includes("malformed"),
    "malformed Ollama data was accepted",
  );
});

Deno.test("Ollama decoder preserves provider errors", async () => {
  await expectError(
    () => collect(JSON.stringify({ error: "model unavailable" }) + "\n"),
    (error) => error instanceof Error && error.message.includes("provider returned an error"),
    "Ollama provider error was not preserved",
  );
});

Deno.test("Ollama decoder rejects a stream without done", async () => {
  await expectError(
    () => collect(JSON.stringify({ message: { content: "partial" } }) + "\n"),
    (error) => error instanceof Error && error.message.includes("ended before completion"),
    "an incomplete Ollama stream was accepted",
  );
});

Deno.test("Ollama decoder requires a boolean done marker", async () => {
  await expectError(
    () => collect(JSON.stringify({ done: "false" }) + "\n"),
    (error) => error instanceof Error && error.message.includes("malformed"),
    "a non-boolean Ollama done marker was accepted",
  );
});

Deno.test("Ollama decoder rejects length-limited answers", async () => {
  await expectError(
    () => collect(JSON.stringify({ message: { content: "partial" } }) + "\n" + JSON.stringify({ done: true, done_reason: "length" })),
    (error) => error instanceof HttpError && error.code === "answer_truncated" && error.status === 502,
    "a length-limited Ollama answer was accepted",
  );
});

Deno.test("Ollama decoder joins fragmented UTF-8 and final lines", async () => {
  const text = JSON.stringify({ message: { content: "Привет 🚲" } }) + "\n" + JSON.stringify({ done: true });
  const bytes = new TextEncoder().encode(text);
  const chunks = Array.from({ length: bytes.length }, (_, index) => bytes.slice(index, index + 1));
  assert(await collect(text, chunks) === "Привет 🚲", "fragmented UTF-8 answer was corrupted");
});
