import type { Session } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export type EdgeResult<T = unknown> = {
  response: Response;
  data: T;
};

export async function callEdgeFunction<T = unknown>(
  path: string,
  session: Session,
  body: Record<string, unknown> | FormData,
  signal?: AbortSignal,
): Promise<EdgeResult<T>> {
  const isFormData = body instanceof FormData;
  const response = await fetch(`${supabaseUrl}/functions/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.access_token}`,
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
    },
    body: isFormData ? body : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { response, data: data as T };
}

export function edgeError(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") {
    return data.error;
  }
  return fallback;
}

export function edgeCode(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && "code" in data && typeof data.code === "string") {
    return data.code;
  }
  return undefined;
}
