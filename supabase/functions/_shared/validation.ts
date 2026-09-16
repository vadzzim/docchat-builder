import { z } from "https://esm.sh/zod@4.1.5";

export { parseJson } from "./http.ts";

export const uuidSchema = z.string().uuid();

export const createBotSchema = z.object({
  name: z.string().trim().min(1).max(80),
  greeting: z.string().trim().min(1).max(500).default("Hi! How can I help?"),
  accent_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#7064D8"),
});

export const originSchema = z.string().trim().max(2048).url().transform((value, ctx) => {
  try {
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) {
      ctx.addIssue({ code: "custom", message: "Origins must be plain http(s) origins." });
      return z.NEVER;
    }
    return origin.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: "Origin is invalid." });
    return z.NEVER;
  }
});

export const botSettingsSchema = z.object({
  bot_id: uuidSchema,
  name: z.string().trim().min(1).max(80).optional(),
  greeting: z.string().trim().min(1).max(500).optional(),
  accent_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  public_enabled: z.boolean().optional(),
  allowed_origins: z.array(originSchema).max(20).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== "bot_id"), {
  message: "At least one setting is required.",
});

export const documentIdSchema = z.object({ document_id: uuidSchema });

export const publicSessionSchema = z.object({ bot_id: uuidSchema, embed_origin: originSchema });

export const chatSchema = z.object({
  bot_id: uuidSchema,
  conversation_id: uuidSchema.optional(),
  session_token: z.string().min(32).max(256).optional(),
  embed_origin: originSchema.optional(),
  message: z.string().trim().min(1).max(1000).refine(
    (value) => new TextEncoder().encode(value).byteLength <= 1000,
    { message: "Message must be at most 1000 UTF-8 bytes." },
  ),
});
