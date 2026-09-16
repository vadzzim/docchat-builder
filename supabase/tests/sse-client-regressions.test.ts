import { readSse, SseStreamError } from "../../lib/sse-client.ts";

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

function sseResponse(text: string, cancel: (reason: unknown) => Promise<void>, requestId?: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel,
  });
  return new Response(stream, requestId ? { headers: { "X-Request-Id": requestId } } : undefined);
}

Deno.test("SSE parser preserves malformed-data errors and cancels", async () => {
  let cancelled = false;
  let thrown: unknown;
  try {
    await readSse(
      sseResponse("event: token\ndata: {bad}\n\n", async () => {
        cancelled = true;
        throw new Error("cancel failed");
      }),
      () => undefined,
      new AbortController().signal,
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error && thrown.message.includes("malformed"), "malformed SSE error was not preserved");
  assert(cancelled, "malformed SSE did not cancel its source");
});

Deno.test("SSE parser preserves callback errors and cancels", async () => {
  const callbackError = new Error("callback failed");
  let cancelled = false;
  await expectSameError(() => readSse(
    sseResponse("event: token\ndata: {\"token\":\"x\"}\n\n", async () => {
      cancelled = true;
      throw new Error("cancel failed");
    }),
    () => { throw callbackError; },
    new AbortController().signal,
  ), callbackError, "SSE callback failure was not preserved");
  assert(cancelled, "SSE callback failure did not cancel its source");
});

Deno.test("SSE parser attaches the response request ID to parser failures", async () => {
  const requestId = "44444444-4444-4444-8444-444444444444";
  const parserError = new Error("callback failed");
  let thrown: unknown;
  try {
    await readSse(
      sseResponse("event: token\ndata: {\"token\":\"x\"}\n\n", async () => undefined, requestId),
      () => { throw parserError; },
      new AbortController().signal,
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown === parserError, "request ID annotation replaced the parser error");
  assert((parserError as Error & { requestId?: string }).requestId === requestId, "parser failure lost the response request ID");
});

Deno.test("SSE parser keeps the request ID when the response has no body", async () => {
  const requestId = "55555555-5555-4555-8555-555555555555";
  let thrown: unknown;
  try {
    await readSse(
      new Response(null, { headers: { "X-Request-Id": requestId } }),
      () => undefined,
      new AbortController().signal,
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof SseStreamError && thrown.requestId === requestId, "empty stream lost its request ID");
});
