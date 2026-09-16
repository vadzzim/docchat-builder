export type TraceValue = string | number | boolean | null;
export type TraceFields = Record<string, TraceValue | undefined>;

export type RequestTrace = {
  id: string;
  stageStart: (stage: string) => void;
  stageEnd: (stage: string, fields?: TraceFields) => void;
  terminal: (outcome: string, fields?: TraceFields) => boolean;
};

const allowedFields = new Set([
  "stage",
  "status",
  "duration_ms",
  "outcome",
  "error_code",
  "ttft_ms",
  "cleanup_failures",
  "quota_attempted",
  "quota_status",
  "save_attempted",
  "save_status",
  "delivery_status",
  "document_status",
  "chunk_count",
  "bot_id",
  "conversation_id",
  "document_id",
]);

const safeLabelPattern = /^[a-z][a-z0-9_-]{0,48}$/;
const safeRequestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeLabel(value: string): string {
  return safeLabelPattern.test(value) ? value : "unknown";
}

export function safeErrorCode(error: unknown, fallback = "internal_error"): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && safeLabelPattern.test(code)) return code;
  }
  return safeLabelPattern.test(fallback) ? fallback : "internal_error";
}

function emit(endpoint: string, id: string, startedAt: number, event: string, fields: TraceFields = {}): void {
  const safeFields: Record<string, TraceValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key) || value === undefined) continue;
    if (typeof value === "string") {
      if (key.endsWith("_id")) {
        if (safeRequestIdPattern.test(value)) safeFields[key] = value;
      } else if (safeLabelPattern.test(value)) {
        safeFields[key] = value;
      }
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      safeFields[key] = value;
    }
  }
  try {
    console.log(JSON.stringify({
      request_id: id,
      endpoint: safeLabel(endpoint),
      event,
      elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      ...safeFields,
    }));
  } catch {
    // Tracing must never change the request outcome.
  }
}

export function createRequestTrace(endpoint: string, requestedId?: string): RequestTrace {
  const id = requestedId && safeRequestIdPattern.test(requestedId) ? requestedId : crypto.randomUUID();
  const startedAt = performance.now();
  const stageStartedAt = new Map<string, number>();
  let terminalWritten = false;

  return {
    id,
    stageStart(stage) {
      const safeStage = safeLabel(stage);
      stageStartedAt.set(safeStage, performance.now());
      emit(endpoint, id, startedAt, "stage_start", { stage: safeStage });
    },
    stageEnd(stage, fields = {}) {
      const safeStage = safeLabel(stage);
      const stageStartAt = stageStartedAt.get(safeStage);
      stageStartedAt.delete(safeStage);
      emit(endpoint, id, startedAt, "stage_end", {
        ...fields,
        stage: safeStage,
        duration_ms: stageStartAt === undefined ? null : Math.max(0, Math.round(performance.now() - stageStartAt)),
      });
    },
    terminal(outcome, fields = {}) {
      if (terminalWritten) return false;
      terminalWritten = true;
      emit(endpoint, id, startedAt, "terminal", { ...fields, outcome: safeLabel(outcome) });
      return true;
    },
  };
}
