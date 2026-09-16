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
    "Vary": "Origin",
  };
  if (allowOrigin && origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
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

export function sseHeaders(request: Request, allowOrigin = true): Record<string, string> {
  return {
    ...corsHeaders(request, allowOrigin),
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  };
}

export function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

export function errorResponse(request: Request, error: unknown, allowOrigin = true): Response {
  if (error instanceof HttpError) {
    return json(request, { error: error.message, code: error.code }, error.status, allowOrigin, error.headers);
  }
  console.error(error);
  return json(request, { error: "The request could not be completed.", code: "internal_error" }, 500, allowOrigin);
}

export function requirePost(request: Request): void {
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed", "method_not_allowed");
}

