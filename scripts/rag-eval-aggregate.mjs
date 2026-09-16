import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const projectDirectory = process.cwd();
const laneValues = new Set(["retrieved", "fixed"]);
const resultStatusValues = new Set(["completed", "error"]);
const semanticValues = new Set(["correct_complete", "omission", "contradiction", "unsupported_claim", "mixed", "ungraded"]);
const refusalValues = new Set(["none", "appropriate", "false"]);
const languageValues = new Set(["NA", "match", "mismatch"]);
const injectionValues = new Set(["NA", "ignored", "followed", "unclear"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function option(name) {
  const prefix = name + "=";
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : undefined;
}

function hasFlag(name, args = process.argv.slice(2)) {
  return args.some((value) => value === name || value === name + "=true");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolvePath(value) {
  return isAbsolute(value) ? value : join(projectDirectory, value);
}

function reportKey(result) {
  return [result.case_id, result.lane, result.model].join("\u0000");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nonEmptyString(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, label + " must be a non-empty string.");
  return value;
}

function uniqueStrings(values, label) {
  assert(Array.isArray(values) && values.length > 0, label + " must be a non-empty array.");
  const seen = new Set();
  for (const value of values) {
    nonEmptyString(value, label + " entry");
    assert(!seen.has(value), label + " contains a duplicate: " + value);
    seen.add(value);
  }
  return values;
}

function emptyCounts(values) {
  return Object.fromEntries([...values].map((value) => [value, 0]));
}

function validateReport(report) {
  assert(report?.schema_version === 1 && Array.isArray(report.cases) && Array.isArray(report.results), "The raw evaluation report has an unsupported shape.");
  const cases = new Map();
  for (const testCase of report.cases) {
    assert(testCase && typeof testCase === "object", "The raw evaluation report contains an invalid case.");
    const id = nonEmptyString(testCase.id, "Case ID");
    assert(!cases.has(id), "The raw evaluation report has duplicate case ID: " + id);
    if ("include_injection" in testCase) assert(typeof testCase.include_injection === "boolean", "Case include_injection must be boolean: " + id);
    cases.set(id, testCase);
  }
  assert(cases.size > 0, "The raw evaluation report has no cases.");
  const models = uniqueStrings(report.options?.chat_models, "options.chat_models");
  const lanes = uniqueStrings(report.options?.lanes, "options.lanes");
  for (const lane of lanes) assert(laneValues.has(lane), "options.lanes contains an invalid lane: " + lane);
  const expectedKeys = new Set();
  for (const model of models) for (const lane of lanes) for (const caseId of cases.keys()) expectedKeys.add([caseId, lane, model].join("\u0000"));
  const results = new Map();
  for (const result of report.results) {
    assert(result && typeof result === "object", "Raw evaluation contains an invalid result.");
    nonEmptyString(result.case_id, "Raw result case_id");
    assert(cases.has(result.case_id), "Raw result references an unknown case ID: " + result.case_id);
    assert(laneValues.has(result.lane), "Raw result has an invalid lane: " + result.lane);
    nonEmptyString(result.model, "Raw result model");
    assert(models.includes(result.model), "Raw result model is absent from options.chat_models: " + result.model);
    assert(lanes.includes(result.lane), "Raw result lane is absent from options.lanes: " + result.lane);
    assert(resultStatusValues.has(result.status), "Raw result has an invalid status: " + result.status);
    assert(typeof result.injection_included === "boolean", "Raw result injection_included must be boolean: " + reportKey(result).replaceAll("\u0000", "/"));
    if (!cases.get(result.case_id).include_injection) assert(!result.injection_included, "A non-injection case cannot include an injection: " + reportKey(result).replaceAll("\u0000", "/"));
    const key = reportKey(result);
    assert(!results.has(key), "Raw evaluation has duplicate result ID: " + result.case_id + "/" + result.lane + "/" + result.model);
    results.set(key, result);
  }
  assert(results.size === expectedKeys.size, "Raw evaluation result count does not match options (expected " + expectedKeys.size + ", got " + results.size + ").");
  for (const key of expectedKeys) assert(results.has(key), "Raw evaluation is missing result: " + key.replaceAll("\u0000", "/"));
  return { cases, results, models, lanes, expectedKeys };
}

function validateSourceReportBinding(input, reportHash) {
  assert(typeof input?.source_report_sha256 === "string" && sha256Pattern.test(input.source_report_sha256), "Ratings file must contain a lowercase source_report_sha256.");
  assert(input.source_report_sha256 === reportHash, "Ratings source_report_sha256 does not match the exact raw report bytes.");
}

function validateRating(rating, result, cases) {
  assert(rating && typeof rating === "object", "Each rating must be an object.");
  nonEmptyString(rating.case_id, "Rating case_id");
  assert(laneValues.has(rating.lane), "Rating has an invalid lane: " + rating.lane);
  nonEmptyString(rating.model, "Rating model");
  const key = reportKey(rating);
  assert(cases.has(rating.case_id), "Rating references an unknown case ID: " + rating.case_id);
  assert(result && reportKey(result) === key, "Rating does not match a result in the raw report: " + key.replaceAll("\u0000", "/"));
  assert(semanticValues.has(rating.semantic), "Invalid semantic rating for " + key.replaceAll("\u0000", "/"));
  assert(refusalValues.has(rating.refusal), "Invalid refusal rating for " + key.replaceAll("\u0000", "/"));
  assert(languageValues.has(rating.language), "Invalid language rating for " + key.replaceAll("\u0000", "/"));
  assert(injectionValues.has(rating.injection), "Invalid injection rating for " + key.replaceAll("\u0000", "/"));
  assert(rating.correct_complete === null || typeof rating.correct_complete === "boolean", "correct_complete must be true, false, or null for " + key.replaceAll("\u0000", "/"));
  assert(typeof rating.unsupported_claims === "boolean", "unsupported_claims must be boolean for " + key.replaceAll("\u0000", "/"));
  assert(typeof rating.incorrect_claims === "boolean", "incorrect_claims must be boolean for " + key.replaceAll("\u0000", "/"));
  assert(rating.semantic === "ungraded" ? rating.correct_complete === null : typeof rating.correct_complete === "boolean", "correct_complete must be null only for ungraded results: " + key.replaceAll("\u0000", "/"));
  if (rating.semantic !== "ungraded") {
    assert(rating.correct_complete === (rating.semantic === "correct_complete"), "semantic and correct_complete must agree for " + key.replaceAll("\u0000", "/"));
    if (rating.correct_complete) {
      assert(!rating.unsupported_claims && !rating.incorrect_claims && rating.refusal !== "false", "A correct_complete rating cannot include unsupported/incorrect claims or a false refusal: " + key.replaceAll("\u0000", "/"));
    }
  }
  if (result.status === "error") assert(rating.semantic === "ungraded", "Provider-error results must remain ungraded: " + key.replaceAll("\u0000", "/"));
  const testCase = cases.get(rating.case_id);
  const injectionIncluded = testCase.include_injection === true && result.injection_included;
  if (!injectionIncluded || rating.semantic === "ungraded") {
    assert(rating.injection === "NA", "Injection must be NA when it was not included or was not reviewed: " + key.replaceAll("\u0000", "/"));
  } else {
    assert(rating.injection !== "NA", "An included injection needs ignored/followed/unclear review: " + key.replaceAll("\u0000", "/"));
  }
  return {
    case_id: rating.case_id,
    lane: rating.lane,
    model: rating.model,
    status: result.status,
    semantic: rating.semantic,
    correct_complete: rating.correct_complete,
    unsupported_claims: rating.unsupported_claims,
    incorrect_claims: rating.incorrect_claims,
    refusal: rating.refusal,
    language: rating.language,
    injection: rating.injection,
    notes: typeof rating.notes === "string" ? rating.notes : "",
  };
}

function summaryShape() {
  return {
    raw_results: 0,
    completed_results: 0,
    error_results: 0,
    submitted_ratings: 0,
    missing_ratings: 0,
    graded_results: 0,
    explicit_ungraded_results: 0,
    ungraded_results: 0,
    judgment_denominator: 0,
    semantic: emptyCounts(semanticValues),
    correct_complete: { true: 0, false: 0, ungraded: 0 },
    unsupported_claims: { true: 0, false: 0 },
    incorrect_claims: { true: 0, false: 0 },
    refusal: emptyCounts(refusalValues),
    language: emptyCounts(languageValues),
    injection: emptyCounts(injectionValues),
  };
}

function aggregate(reportData, ratings) {
  const byModelLane = new Map();
  const totals = summaryShape();
  const ratingByKey = new Map(ratings.map((rating) => [reportKey(rating), rating]));
  const getGroup = (model, lane) => {
    const key = model + "\u0000" + lane;
    if (!byModelLane.has(key)) byModelLane.set(key, { model, lane, ...summaryShape() });
    return byModelLane.get(key);
  };
  const add = (summary, result, rating) => {
    summary.raw_results += 1;
    if (result.status === "completed") summary.completed_results += 1;
    else summary.error_results += 1;
    if (!rating) {
      summary.missing_ratings += 1;
      summary.correct_complete.ungraded += 1;
      return;
    }
    summary.submitted_ratings += 1;
    if (result.status !== "completed") {
      summary.correct_complete.ungraded += 1;
      return;
    }
    summary.semantic[rating.semantic] += 1;
    if (rating.semantic === "ungraded") {
      summary.explicit_ungraded_results += 1;
      summary.correct_complete.ungraded += 1;
      return;
    }
    summary.graded_results += 1;
    summary.judgment_denominator += 1;
    summary.correct_complete[String(rating.correct_complete)] += 1;
    summary.unsupported_claims[String(rating.unsupported_claims)] += 1;
    summary.incorrect_claims[String(rating.incorrect_claims)] += 1;
    summary.refusal[rating.refusal] += 1;
    summary.language[rating.language] += 1;
    summary.injection[rating.injection] += 1;
  };

  for (const model of reportData.models) for (const lane of reportData.lanes) getGroup(model, lane);
  for (const result of reportData.results.values()) {
    const rating = ratingByKey.get(reportKey(result));
    add(totals, result, rating);
    add(getGroup(result.model, result.lane), result, rating);
  }
  totals.ungraded_results = totals.raw_results - totals.graded_results;
  for (const group of byModelLane.values()) group.ungraded_results = group.raw_results - group.graded_results;
  return { totals, by_model_lane: [...byModelLane.values()] };
}

function writeOutput(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  console.log("RAG evaluation wrote " + relative(projectDirectory, path));
}

function createTemplate(report, reportPath, reportHash) {
  const reportData = validateReport(report);
  return {
    schema_version: 1,
    results_file: relative(projectDirectory, reportPath),
    source_report_sha256: reportHash,
    ratings: [...reportData.results.values()].map((result) => ({
      case_id: result.case_id,
      lane: result.lane,
      model: result.model,
      semantic: "ungraded",
      correct_complete: null,
      unsupported_claims: false,
      incorrect_claims: false,
      refusal: "none",
      language: "NA",
      injection: "NA",
      notes: "",
    })),
  };
}

function expectFailure(action, fragment) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(fragment), "Expected failure containing '" + fragment + "', got: " + message);
    return;
  }
  throw new Error("Expected a validation failure containing: " + fragment);
}

function selfTestReport() {
  const models = ["model-a", "model-b", "model-c", "model-d"];
  return {
    schema_version: 1,
    cases: [{ id: "h01", include_injection: false }],
    options: { chat_models: models, lanes: ["retrieved"] },
    results: [
      { case_id: "h01", lane: "retrieved", model: "model-a", status: "completed", injection_included: false },
      { case_id: "h01", lane: "retrieved", model: "model-b", status: "completed", injection_included: false },
      { case_id: "h01", lane: "retrieved", model: "model-c", status: "error", injection_included: false },
      { case_id: "h01", lane: "retrieved", model: "model-d", status: "completed", injection_included: false },
    ],
  };
}

function selfTestRating(model, semantic, correctComplete = null) {
  return {
    case_id: "h01",
    lane: "retrieved",
    model,
    semantic,
    correct_complete: correctComplete,
    unsupported_claims: false,
    incorrect_claims: false,
    refusal: "none",
    language: "NA",
    injection: "NA",
    notes: "",
  };
}

function runSelfTest() {
  assert(hasFlag("--template", ["--template"]), "Boolean template flag parsing is broken.");
  const report = selfTestReport();
  const reportData = validateReport(report);
  assert(reportData.results.size === 4, "Self-test report coverage is broken.");

  expectFailure(() => validateSourceReportBinding({ source_report_sha256: "a".repeat(64) }, "b".repeat(64)), "does not match");
  const duplicate = selfTestReport();
  duplicate.results[1] = { ...duplicate.results[0] };
  expectFailure(() => validateReport(duplicate), "duplicate result ID");
  const invalidStatus = selfTestReport();
  invalidStatus.results[0].status = "partial";
  expectFailure(() => validateReport(invalidStatus), "invalid status");
  expectFailure(() => validateRating(selfTestRating("model-a", "not-a-rating", true), reportData.results.get("h01\u0000retrieved\u0000model-a"), reportData.cases), "Invalid semantic rating");
  expectFailure(() => validateRating(selfTestRating("model-a", "correct_complete", false), reportData.results.get("h01\u0000retrieved\u0000model-a"), reportData.cases), "must agree");

  const explicitUngraded = validateRating(selfTestRating("model-b", "ungraded"), reportData.results.get("h01\u0000retrieved\u0000model-b"), reportData.cases);
  const providerError = validateRating(selfTestRating("model-c", "ungraded"), reportData.results.get("h01\u0000retrieved\u0000model-c"), reportData.cases);
  const aggregateOutput = aggregate(reportData, [explicitUngraded, providerError]);
  const groups = new Map(aggregateOutput.by_model_lane.map((group) => [group.model, group]));
  assert(groups.get("model-a").missing_ratings === 1, "Self-test missing-rating denominator is broken.");
  assert(groups.get("model-b").explicit_ungraded_results === 1, "Self-test explicit-ungraded denominator is broken.");
  assert(groups.get("model-c").error_results === 1 && groups.get("model-c").graded_results === 0, "Self-test error denominator is broken.");
  assert(aggregateOutput.totals.ungraded_results === 4 && aggregateOutput.totals.judgment_denominator === 0 && aggregateOutput.totals.semantic.ungraded === 1, "Self-test aggregate denominator is broken.");
  console.log("RAG evaluation aggregator self-test passed");
}

function main() {
  if (hasFlag("--self-test")) {
    runSelfTest();
    return;
  }
  const reportPath = resolvePath(option("--report") ?? "test-results/rag-evaluation-latest.json");
  assert(existsSync(reportPath), "Raw evaluation report was not found: " + reportPath);
  const report = readJson(reportPath);
  const reportHash = sha256File(reportPath);
  const templateMode = hasFlag("--template");
  const outputPath = resolvePath(option("--output") ?? (templateMode ? "test-results/rag-evaluation-ratings.json" : "test-results/rag-evaluation-aggregate.json"));
  if (templateMode) {
    writeOutput(outputPath, createTemplate(report, reportPath, reportHash));
    return;
  }

  const ratingsPath = resolvePath(option("--input") ?? "test-results/rag-evaluation-ratings.json");
  assert(existsSync(ratingsPath), "Ratings file was not found: " + ratingsPath);
  const input = readJson(ratingsPath);
  assert(input?.schema_version === 1 && Array.isArray(input.ratings), "Ratings file has an unsupported shape.");
  validateSourceReportBinding(input, reportHash);
  const reportData = validateReport(report);
  const ratings = [];
  const seen = new Set();
  for (const rating of input.ratings) {
    const key = reportKey(rating);
    assert(!seen.has(key), "Ratings file contains a duplicate ID: " + key.replaceAll("\u0000", "/"));
    const normalized = validateRating(rating, reportData.results.get(key), reportData.cases);
    seen.add(key);
    ratings.push(normalized);
  }
  const aggregateOutput = aggregate(reportData, ratings);
  writeOutput(outputPath, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_report: relative(projectDirectory, reportPath),
    source_report_sha256: reportHash,
    submitted_ratings: ratings.length,
    raw_results: reportData.results.size,
    missing_ratings: aggregateOutput.totals.missing_ratings,
    error_results: aggregateOutput.totals.error_results,
    graded_results: aggregateOutput.totals.graded_results,
    explicit_ungraded_results: aggregateOutput.totals.explicit_ungraded_results,
    ungraded_results: aggregateOutput.totals.ungraded_results,
    ...aggregateOutput,
    ratings,
    note: "Counts come only from explicit reviewer-supplied enum and boolean ratings for completed provider results. Missing, provider-error, and semantic-ungraded rows stay outside judgment counters; no answer text or keyword is inspected.",
  });
}

try {
  main();
} catch (error) {
  console.error("RAG evaluation aggregation failed: " + (error instanceof Error ? error.message : "unknown error"));
  process.exitCode = 1;
}
