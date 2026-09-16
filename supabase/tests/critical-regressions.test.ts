import { chatStream } from "../functions/_shared/ai.ts";
import { HttpError } from "../functions/_shared/http.ts";
import { safeFileName } from "../functions/_shared/text.ts";
import { readSse } from "../../lib/sse-client.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectSameError(task: () => Promise<unknown>, expected: Error, message: string): Promise<void> {
  try {
    await task();
  } catch (error) {
    assert(error === expected, message + " (different error was thrown)");
    return;
  }
  throw new Error(message + " (no error was thrown)");
}

function ollamaResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function sseResponse(text: string, cancel: (reason: unknown) => Promise<void>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel,
  });
  return new Response(stream);
}

Deno.test("critical stream and filename regressions", async () => {
  const truncatedWithNewline = JSON.stringify({ message: { content: "partial" } }) + "\n" +
    JSON.stringify({ done: true, done_reason: "length" }) + "\n";
  const truncatedWithoutNewline = JSON.stringify({ message: { content: "partial" } }) + "\n" +
    JSON.stringify({ done: true, done_reason: "length" });
  for (const text of [truncatedWithNewline, truncatedWithoutNewline]) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ollamaResponse(text);
    try {
      let error: unknown;
      try {
        for await (const _token of chatStream([{ role: "user", content: "question" }])) {
          // Consume the generator until its terminal chunk is validated.
        }
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof HttpError && error.code === "answer_truncated", "length-limited NDJSON was accepted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  let malformedCancelled = false;
  let malformedThrown: unknown;
  try {
    await readSse(
      sseResponse("event: token\ndata: {bad}\n\n", async () => {
        malformedCancelled = true;
        throw new Error("cancel failed");
      }),
      () => undefined,
      new AbortController().signal,
    );
  } catch (error) {
    malformedThrown = error;
  }
  assert(malformedThrown instanceof Error && malformedThrown.message.includes("malformed"), "malformed SSE error was not preserved");
  assert(malformedCancelled, "malformed SSE did not cancel its source");

  const callbackError = new Error("callback failed");
  let callbackCancelled = false;
  await expectSameError(() => readSse(
    sseResponse("event: token\ndata: {\"token\":\"x\"}\n\n", async () => {
      callbackCancelled = true;
      throw new Error("cancel failed");
    }),
    () => { throw callbackError; },
    new AbortController().signal,
  ), callbackError, "SSE callback failure was not preserved");
  assert(callbackCancelled, "SSE callback failure did not cancel its source");

  const longTxt = safeFileName("a".repeat(117) + ".txt");
  assert(longTxt.fileName.length === 120 && longTxt.fileName.endsWith(".txt"), "long TXT filename lost its extension");
  assert(longTxt.contentType === "text/plain", "TXT filename returned the wrong content type");
  const longMarkdown = safeFileName("a".repeat(118) + ".md");
  assert(longMarkdown.fileName.length === 120 && longMarkdown.fileName.endsWith(".md"), "long Markdown filename lost its extension");
  const emojiName = safeFileName("a".repeat(115) + "😀.txt");
  assert(Array.from(emojiName.fileName).length === 120 && emojiName.fileName.includes("😀") && emojiName.fileName.endsWith(".txt"), "filename shortening split a Unicode code point");
});
