import { HttpError } from "./http.ts";

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    if (!text.trim() || text.includes("\u0000")) {
      throw new HttpError(400, "The document is empty.", "empty_document");
    }
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The document must be valid UTF-8 text.", "invalid_encoding");
  }
}

export function splitText(input: string, maxCharacters = 1800, overlap = 200): string[] {
  const text = input.replace(/\r\n?/g, "\n").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= maxCharacters) {
      chunks.push(text.slice(start).trim());
      break;
    }
    const target = start + maxCharacters;
    const boundary = Math.max(
      text.lastIndexOf("\n", target),
      text.lastIndexOf(" ", target),
    );
    const end = boundary > start + Math.floor(maxCharacters * 0.55) ? boundary : target;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    const next = Math.max(end - overlap, start + 1);
    start = next;
  }
  return chunks.filter(Boolean);
}

export function safeFileName(name: string): { fileName: string; contentType: "text/plain" | "text/markdown" } {
  const cleaned = name.replace(/[\u0000/\\\\]+/g, "_").trim().slice(0, 120);
  const extension = cleaned.toLowerCase().endsWith(".md") ? "md" :
    cleaned.toLowerCase().endsWith(".txt") ? "txt" : "";
  if (!extension) throw new HttpError(400, "Only .txt and .md files are supported.", "unsupported_file_type");
  return {
    fileName: cleaned,
    contentType: extension === "md" ? "text/markdown" : "text/plain",
  };
}

export function publicError(error: unknown): string {
  if (error instanceof Error && error.message.toLowerCase().includes("ollama")) return "The AI provider is unavailable.";
  return "Document processing failed. You can retry it.";
}

