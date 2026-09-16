export type SseEvent = {
  event: string;
  data: unknown;
};

export class SseStreamError extends Error {
  code?: string;
  requestId?: string;

  constructor(message: string, code?: string, requestId?: string) {
    super(message);
    this.name = "SseStreamError";
    this.code = code;
    this.requestId = requestId;
  }
}

function attachRequestId(error: unknown, requestId: string | undefined): unknown {
  if (!requestId || (typeof error !== "object" && typeof error !== "function") || error === null) return error;
  try {
    if (error instanceof SseStreamError) {
      error.requestId ??= requestId;
    } else {
      Object.defineProperty(error, "requestId", { value: requestId, configurable: true });
    }
  } catch {
    // Preserve the original parser or callback error if it cannot be annotated.
  }
  return error;
}

/** Read a small server-sent event stream without treating EOF as success. */
export async function readSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
  requestId = response.headers.get("x-request-id") ?? undefined,
): Promise<void> {
  if (!response.body) throw new SseStreamError("The chat stream did not include a response body.", undefined, requestId);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let completed = false;
  let sawDone = false;

  const dispatch = () => {
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      throw new SseStreamError("The chat returned malformed streaming data.");
    }
    const event = { event: eventName, data };
    if (event.event === "done") sawDone = true;
    onEvent(event);
    eventName = "message";
    dataLines = [];
  };

  const readLine = (line: string) => {
    if (line === "") {
      dispatch();
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  };

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("The chat request was cancelled.", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) readLine(line);
    }
    buffer += decoder.decode();
    if (buffer) readLine(buffer);
    dispatch();
    if (!sawDone) throw new SseStreamError("The chat stream ended before the answer was complete.", undefined, requestId);
    completed = true;
  } catch (error) {
    throw attachRequestId(error, requestId);
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Keep the original parser or callback error.
      }
    }
    reader.releaseLock();
  }
}
