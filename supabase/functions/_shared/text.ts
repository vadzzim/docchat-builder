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

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function nextCodePointIndex(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function previousCodePointIndex(text: string, index: number): number {
  const previous = text.charCodeAt(index - 1);
  if (previous >= 0xdc00 && previous <= 0xdfff && index >= 2) return index - 2;
  return index - 1;
}

function takeUtf8Bytes(text: string, start: number, maxBytes: number): number {
  let index = start;
  let bytes = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    const width = utf8Width(codePoint);
    if (bytes + width > maxBytes) break;
    bytes += width;
    index = nextCodePointIndex(text, index);
  }
  return index;
}

function overlapStart(text: string, end: number, start: number, maxBytes: number): number {
  let index = end;
  let bytes = 0;
  while (index > start) {
    const previous = previousCodePointIndex(text, index);
    const codePoint = text.codePointAt(previous) ?? 0;
    const width = utf8Width(codePoint);
    if (bytes + width > maxBytes) break;
    bytes += width;
    index = previous;
  }
  return index;
}

/** Split at complete Unicode code points while keeping each chunk within the UTF-8 byte budget. */
export function splitText(input: string, maxBytes = 600, overlapBytes = 80): string[] {
  const text = input.replace(/\r\n?/g, "\n").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const endByBytes = takeUtf8Bytes(text, start, maxBytes);
    if (endByBytes <= start) throw new Error("Text chunk byte budget is too small.");
    if (endByBytes >= text.length) {
      chunks.push(text.slice(start).trim());
      break;
    }
    let end = endByBytes;
    let boundary = endByBytes;
    while (boundary > start) {
      const previous = previousCodePointIndex(text, boundary);
      const value = text.slice(previous, boundary);
      if (value === "\n" || value === " " || value === "\t") {
        const boundaryBytes = new TextEncoder().encode(text.slice(start, previous)).byteLength;
        if (boundaryBytes >= Math.floor(maxBytes * 0.55)) end = previous;
        break;
      }
      boundary = previous;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    const next = Math.max(overlapStart(text, end, start, overlapBytes), nextCodePointIndex(text, start));
    start = next;
  }
  return chunks.filter(Boolean);
}

export function safeFileName(name: string): { fileName: string; contentType: "text/plain" | "text/markdown" } {
  const cleaned = name.replace(/[\u0000-\u001F\u007F/\\\\]+/g, "_").trim().slice(0, 120);
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
