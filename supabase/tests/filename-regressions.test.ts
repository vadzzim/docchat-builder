import { safeFileName } from "../functions/_shared/text.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("safe filenames preserve supported extensions and Unicode boundaries", () => {
  const longTxt = safeFileName("a".repeat(117) + ".txt");
  assert(longTxt.fileName.length === 120 && longTxt.fileName.endsWith(".txt"), "long TXT filename lost its extension");
  assert(longTxt.contentType === "text/plain", "TXT filename returned the wrong content type");
  const longMarkdown = safeFileName("a".repeat(118) + ".md");
  assert(longMarkdown.fileName.length === 120 && longMarkdown.fileName.endsWith(".md"), "long Markdown filename lost its extension");
  const emojiName = safeFileName("a".repeat(115) + "😀.txt");
  assert(Array.from(emojiName.fileName).length === 120 && emojiName.fileName.includes("😀") && emojiName.fileName.endsWith(".txt"), "filename shortening split a Unicode code point");
});
