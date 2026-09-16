export class HttpError extends Error {
  status: number;
  code: string;
  headers: Record<string, string>;

  constructor(status: number, message: string, code = "request_error", headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function corsHeaders(request: Request, allowOrigin = true): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "X-Request-Id",
    "Vary": "Origin",
  };
  if (allowOrigin && origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function normalizeHttpOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

export function requestOrigin(request: Request): string | null {
  return normalizeHttpOrigin(request.headers.get("origin"));
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function json(
  request: Request,
  payload: unknown,
  status = 200,
  allowOrigin = true,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(request, allowOrigin),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function sseHeaders(request: Request, allowOrigin = true, requestId?: string): Record<string, string> {
  return {
    ...corsHeaders(request, allowOrigin),
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    ...(requestId ? { "X-Request-Id": requestId } : {}),
  };
}

export function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

export function errorResponse(
  request: Request,
  error: unknown,
  allowOrigin = true,
  extraHeaders: Record<string, string> = {},
): Response {
  if (error instanceof HttpError) {
    return json(request, { error: error.message, code: error.code }, error.status, allowOrigin, {
      ...error.headers,
      ...extraHeaders,
    });
  }
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(error.name) ? error.name : "UnknownError";
  const errorCode = error && typeof error === "object" && "code" in error &&
      typeof (error as { code?: unknown }).code === "string" && /^[a-z][a-z0-9_]{0,48}$/.test((error as { code: string }).code)
    ? (error as { code: string }).code
    : "internal_error";
  console.error(JSON.stringify({ event: "request_error", error_name: errorName, error_code: errorCode }));
  return json(request, { error: "The request could not be completed.", code: "internal_error" }, 500, allowOrigin, extraHeaders);
}

export function requirePost(request: Request): void {
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed", "method_not_allowed");
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
  timeoutMilliseconds = 30000,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "Upload request is too large.", "payload_too_large");
  }
  if (signal?.aborted) throw new HttpError(408, "Upload request timed out.", "request_timeout");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel("request body timeout");
  }, timeoutMilliseconds);
  const abort = () => void reader.cancel(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal?.aborted) throw new HttpError(408, "Upload request timed out.", "request_timeout");
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Upload request is too large.", "payload_too_large");
      }
      chunks.push(value);
    }
    if (timedOut || signal?.aborted) {
      throw new HttpError(408, "Upload request timed out.", "request_timeout");
    }
  } catch (error) {
    if (timedOut || signal?.aborted) {
      throw new HttpError(408, "Upload request timed out.", "request_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function parseJson<T>(
  request: Request,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message?: string }> } } },
  maxBytes = 20000,
  signal?: AbortSignal,
): Promise<T> {
  const body = await readBoundedBody(request, maxBytes, signal, 30000);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new HttpError(400, "Request body must be valid UTF-8.", "invalid_body");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, issue?.message ?? "Request fields are invalid.", "validation_error");
  }
  return parsed.data;
}
