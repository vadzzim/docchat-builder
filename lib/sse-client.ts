export type SseEvent = {
  event: string;
  data: unknown;
};

export class SseStreamError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SseStreamError";
    this.code = code;
  }
}

/** Read a small server-sent event stream without treating EOF as success. */
export async function readSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new SseStreamError("The chat stream did not include a response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      throw new SseStreamError("The chat returned malformed streaming data.");
    }
    onEvent({ event: eventName, data });
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
  } finally {
    reader.releaseLock();
  }
}
