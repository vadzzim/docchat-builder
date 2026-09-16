import { createRequestTrace, safeErrorCode } from "../functions/_shared/trace.ts";
import { HttpError } from "../functions/_shared/http.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("request trace emits allowlisted fields and redacts arbitrary values", () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => {
    lines.push(args.join(" "));
  }) as typeof console.log;
  try {
    const trace = createRequestTrace("chat", "11111111-1111-4111-8111-111111111111");
    trace.stageStart("provider");
    trace.stageEnd("provider", {
      status: "completed",
      prompt: "do not emit this prompt" as unknown as null,
    });
    trace.terminal("failed", {
      error_code: safeErrorCode(new Error("secret document and prompt")),
      status: "completed",
    });
  } finally {
    console.log = originalLog;
  }

  assert(lines.length === 3, "trace did not emit stage start, stage end, and terminal events");
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(events[0].event === "stage_start" && events[1].event === "stage_end" && events[2].event === "terminal", "trace event order changed");
  assert(events.every((event) => event.request_id === "11111111-1111-4111-8111-111111111111"), "trace request ID changed between events");
  assert(!lines.some((line) => line.includes("do not emit") || line.includes("secret document")), "trace emitted sensitive text");
  assert(events[1].prompt === undefined && events[2].error_code === "internal_error", "trace field allowlist or error redaction failed");
});

Deno.test("request trace emits only one terminal event", () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => {
    lines.push(args.join(" "));
  }) as typeof console.log;
  try {
    const trace = createRequestTrace("process-document", "22222222-2222-4222-8222-222222222222");
    assert(trace.terminal("completed", { document_status: "ready" }), "first terminal event was rejected");
    assert(!trace.terminal("failed", { error_code: "late_error" }), "duplicate terminal event was accepted");
  } finally {
    console.log = originalLog;
  }
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(events.filter((event) => event.event === "terminal").length === 1, "trace emitted more than one terminal event");
  assert(safeErrorCode(new HttpError(422, "invalid", "invalid_source")) === "invalid_source", "safe error code lost a public code");
});
