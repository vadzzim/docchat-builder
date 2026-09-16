import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const projectDirectory = process.cwd();
const ollamaUrl = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const embeddingModel = "bge-m3";
const chatModels = ["qwen3:0.6b", "qwen2.5:1.5b"];
const demoDocuments = ["shipping.md", "returns.txt", "support.md"];
const maxEmbeddingMilliseconds = 120000;
const maxChatMilliseconds = 120000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cosine(left, right) {
  assert(left.length === right.length && left.length > 0, "Embedding dimensions did not match.");
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

async function readJson(response, message) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(message);
  }
  if (!response.ok) throw new Error(message + " (" + response.status + ").");
  return body;
}

function validateEmbeddings(body, expectedCount) {
  const embeddings = body?.embeddings;
  assert(Array.isArray(embeddings) && embeddings.length === expectedCount, "Ollama returned the wrong embedding count.");
  for (const embedding of embeddings) {
    assert(Array.isArray(embedding) && embedding.length === 1024 &&
      embedding.every((value) => typeof value === "number" && Number.isFinite(value)),
    "Ollama returned an invalid 1024-dimensional embedding.");
  }
  return embeddings;
}

async function embed(values) {
  assert(values.length > 0, "Cannot embed an empty batch.");
  const response = await fetch(ollamaUrl + "/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: embeddingModel,
      input: values,
      truncate: false,
      keep_alive: "5m",
    }),
    signal: AbortSignal.timeout(maxEmbeddingMilliseconds),
  });
  return validateEmbeddings(await readJson(response, "Ollama embedding request failed"), values.length);
}

async function streamChat(model, messages) {
  const started = Date.now();
  const response = await fetch(ollamaUrl + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      think: false,
      keep_alive: "5m",
      options: { temperature: 0.1, num_ctx: 4096, num_predict: 500 },
    }),
    signal: AbortSignal.timeout(maxChatMilliseconds),
  });
  assert(response.ok && response.body, "Ollama chat request failed.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let sawDone = false;
  try {
    while (!sawDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let body;
        try {
          body = JSON.parse(line);
        } catch {
          throw new Error("Ollama returned malformed streaming data.");
        }
        if (body.error) throw new Error("Ollama provider returned an error.");
        answer += String(body.message?.content ?? body.response ?? "");
        if (body.done) {
          if (body.done_reason === "length") throw new Error("Ollama answer was truncated by the response length limit.");
          sawDone = true;
          break;
        }
      }
    }
    buffer += decoder.decode();
    if (!sawDone && buffer.trim()) {
      let body;
      try {
        body = JSON.parse(buffer);
      } catch {
        throw new Error("Ollama returned an incomplete streaming response.");
      }
      if (body.error) throw new Error("Ollama provider returned an error.");
      answer += String(body.message?.content ?? body.response ?? "");
      if (body.done && body.done_reason === "length") throw new Error("Ollama answer was truncated by the response length limit.");
      sawDone = Boolean(body.done);
    }
    assert(sawDone, "Ollama stream ended before completion.");
  } finally {
    reader.releaseLock();
  }
  return { answer, elapsedMs: Date.now() - started };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function loadHelpers() {
  // The production helpers are Deno-compatible. Give their configurable AI module
  // an empty environment so this runner can use the host Ollama URL directly.
  if (!globalThis.Deno) globalThis.Deno = { env: { get: () => undefined } };
  const [{ groundedContext }, { splitText }] = await Promise.all([
    import(new URL("../supabase/functions/_shared/grounding.ts", import.meta.url)),
    import(new URL("../supabase/functions/_shared/text.ts", import.meta.url)),
  ]);
  return { groundedContext, splitText };
}

async function main() {
  const { groundedContext, splitText } = await loadHelpers();
  const evaluation = JSON.parse(readFileSync(join(projectDirectory, "docs", "model-evaluation.json"), "utf8"));
  const questions = evaluation.questions;
  assert(Array.isArray(questions) && questions.length === 15, "Canonical evaluation must contain exactly 15 questions.");

  const chunks = [];
  for (const fileName of demoDocuments) {
    const source = readFileSync(join(projectDirectory, "demo", fileName), "utf8");
    splitText(source, 600, 80).forEach((excerpt, chunkIndex) => {
      chunks.push({
        document_id: "demo-" + fileName,
        document_name: fileName,
        chunk_index: chunkIndex,
        excerpt,
      });
    });
  }
  assert(chunks.length > 0, "Demo fixtures produced no chunks.");
  const vectors = await embed(chunks.map((chunk) => chunk.excerpt));
  const queryVectors = await embed(questions);
  const contexts = questions.map((question, questionIndex) => {
    const selected = chunks
      .map((chunk, chunkIndex) => ({ ...chunk, similarity: cosine(queryVectors[questionIndex], vectors[chunkIndex]) }))
      .filter((chunk) => chunk.similarity >= 0.35)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 3);
    const context = groundedContext(question, [], selected);
    return {
      question,
      retrieval: selected.map((chunk) => ({
        source: chunk.document_name,
        chunk: chunk.chunk_index,
        similarity: Number(chunk.similarity.toFixed(4)),
      })),
      messages: context.messages,
      citations: context.citations,
    };
  });

  const models = [];
  for (const model of chatModels) {
    const answers = [];
    for (const context of contexts) {
      const result = await streamChat(model, context.messages);
      answers.push({ question: context.question, elapsedMs: result.elapsedMs, answer: result.answer });
    }
    models.push({
      model,
      totalMs: answers.reduce((sum, result) => sum + result.elapsedMs, 0),
      medianMs: median(answers.map((result) => result.elapsedMs)),
      answers,
    });
  }

  const outputDirectory = join(projectDirectory, "test-results");
  mkdirSync(outputDirectory, { recursive: true });
  const fileName = "model-comparison-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  const outputPath = join(outputDirectory, fileName);
  const report = {
    generatedAt: new Date().toISOString(),
    method: "Fresh direct Ollama comparison using production splitText and groundedContext helpers.",
    embeddingModel,
    chatModels,
    options: { temperature: 0.1, num_ctx: 4096, num_predict: 500, think: false },
    documents: demoDocuments,
    chunkCount: chunks.length,
    retrieval: contexts.map(({ question, retrieval }) => ({ question, retrieval })),
    models,
    note: "Raw provider evidence only; answers and timing are not automated accuracy claims.",
  };
  const serialized = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(outputPath, serialized, "utf8");
  writeFileSync(join(outputDirectory, "model-comparison-latest.json"), serialized, "utf8");
  console.log("Model comparison wrote " + relative(projectDirectory, outputPath));
}

main().catch((error) => {
  console.error("Model comparison failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
