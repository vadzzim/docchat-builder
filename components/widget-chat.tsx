"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { readSse, SseStreamError, type SseEvent } from "@/lib/sse-client";

const maxQuestionBytes = 1000;

type WidgetBot = {
  name: string;
  greeting: string;
  accent_color: string;
};

type Citation = {
  document_id?: string;
  source: string;
  excerpt: string;
  similarity?: number;
  chunk_index?: number;
};

type WidgetMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  pending?: boolean;
  incomplete?: boolean;
};

function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

function safeBot(value: unknown): WidgetBot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.greeting !== "string" || typeof candidate.accent_color !== "string") return null;
  return {
    name: candidate.name,
    greeting: candidate.greeting,
    accent_color: /^#[0-9a-f]{6}$/i.test(candidate.accent_color) ? candidate.accent_color : "#7064D8",
  };
}

function accentTextColor(value: string): "#ffffff" | "#000000" {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset + 1, offset + 3), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const backgroundLuminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  return whiteContrast >= 4.5 ? "#ffffff" : "#000000";
}

function citations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Citation => {
    if (typeof item !== "object" || item === null) return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate.source === "string" && typeof candidate.excerpt === "string";
  });
}

function streamError(value: unknown, fallback: string): SseStreamError {
  if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") {
    return new SseStreamError(value.error, "code" in value && typeof value.code === "string" ? value.code : undefined);
  }
  return new SseStreamError(fallback);
}

async function parseHttpError(response: Response): Promise<SseStreamError> {
  const text = await response.text();
  if (text) {
    try {
      return streamError(JSON.parse(text), `Chat request failed (${response.status}).`);
    } catch {
      return new SseStreamError(`Chat request failed (${response.status}).`);
    }
  }
  return new SseStreamError(`Chat request failed (${response.status}).`);
}

async function streamVisitor(
  apiOrigin: string,
  botId: string,
  token: string,
  parentOrigin: string,
  conversationId: string | null,
  message: string,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiOrigin}/functions/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({
        bot_id: botId,
        session_token: token,
        embed_origin: parentOrigin,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        message,
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SseStreamError("The chat service could not be reached. Try again shortly.");
  }
  if (!response.ok) throw await parseHttpError(response);
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) throw await parseHttpError(response);
  await readSse(response, onEvent, signal);
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "The response was stopped before it completed.";
  if (error instanceof Error) return error.message;
  return "The chat could not be completed. Try again.";
}

export function WidgetChat({ botId, parentOrigin }: { botId: string; parentOrigin: string }) {
  const [bot, setBot] = useState<WidgetBot | null>(null);
  const [apiOrigin, setApiOrigin] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const parent = safeOrigin(parentOrigin);

  useEffect(() => {
    if (!parent) {
      setConnectionError("This widget has an invalid embedding origin.");
      return;
    }
    let mounted = true;
    const onMessage = (event: MessageEvent) => {
      if (!mounted || event.source !== window.parent || event.origin !== parent || typeof event.data !== "object" || event.data === null) return;
      const data = event.data as Record<string, unknown>;
      if (data.bot_id !== botId || data.parent_origin !== parent) return;
      if (data.type === "docchat:session_error") {
        sessionTokenRef.current = null;
        setSessionToken(null);
        setConnectionError(typeof data.message === "string" ? data.message : "This chat is unavailable right now.");
        return;
      }
      if (data.type !== "docchat:session" || typeof data.session_token !== "string") return;
      const nextApiOrigin = safeOrigin(data.api_origin);
      const nextBot = safeBot(data.bot);
      if (!nextApiOrigin || !nextBot) {
        setConnectionError("This chat could not be configured safely.");
        return;
      }
      const previousToken = sessionTokenRef.current;
      if (previousToken === null || previousToken !== data.session_token) {
        setConversationId(null);
        setMessages([]);
        setNotice(null);
      }
      setApiOrigin(nextApiOrigin);
      setBot(nextBot);
      sessionTokenRef.current = data.session_token;
      setSessionToken(data.session_token);
      setConnectionError(null);
      setNotice(null);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "docchat:ready", bot_id: botId, parent_origin: parent }, parent);
    const timeout = window.setTimeout(() => {
      if (mounted && !sessionTokenRef.current) setConnectionError("This chat could not connect. Try again shortly.");
    }, 15000);
    return () => {
      mounted = false;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [botId, parent, parentOrigin]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  useEffect(() => () => {
    streamController.current?.abort();
  }, []);

  function sendParentMessage(type: "docchat:close" | "docchat:retry") {
    if (parent) window.parent.postMessage({ type, bot_id: botId, parent_origin: parent }, parent);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") sendParentMessage("docchat:close");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [botId, parent]);

  function newChat() {
    if (sending) return;
    setConversationId(null);
    setMessages([]);
    setNotice(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || sending || !sessionToken || !apiOrigin || !parent) return;
    if (new TextEncoder().encode(trimmed).byteLength > maxQuestionBytes) {
      setNotice("Keep your question under 1,000 UTF-8 bytes.");
      return;
    }
    const now = Date.now();
    const userId = `visitor-user-${now}`;
    const assistantId = `visitor-assistant-${now}`;
    setMessage("");
    setNotice(null);
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: trimmed, citations: [] },
      { id: assistantId, role: "assistant", content: "", citations: [], pending: true },
    ]);
    setSending(true);
    const controller = new AbortController();
    streamController.current = controller;
    let sawDone = false;
    try {
      await streamVisitor(apiOrigin, botId, sessionToken, parent, conversationId, trimmed, (event) => {
        const data = event.data as Record<string, unknown> | null;
        if (event.event === "meta" && typeof data?.conversation_id === "string") {
          setConversationId(data.conversation_id);
        } else if (event.event === "token" && typeof data?.token === "string") {
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: item.content + data.token } : item));
        } else if (event.event === "done") {
          sawDone = true;
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, pending: false, citations: citations(data?.citations) } : item));
        } else if (event.event === "error") {
          throw streamError(data, "The chat could not be completed. Try again.");
        }
      }, controller.signal);
      if (!sawDone) throw new SseStreamError("The chat stream ended before the answer was complete.");
    } catch (error) {
      if (error instanceof SseStreamError && error.code === "invalid_session") {
        sessionTokenRef.current = null;
        setSessionToken(null);
        setApiOrigin(null);
        setConversationId(null);
        setMessages([]);
        setNotice(null);
        setConnectionError("Your chat session expired. Try again to start a new chat.");
      } else {
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, pending: false, incomplete: true, content: item.content || "No completed answer was saved." } : item));
        setNotice(errorMessage(error));
      }
    } finally {
      setSending(false);
      streamController.current = null;
    }
  }

  if (!parent) {
    return <main className="flex min-h-screen items-center justify-center bg-white px-5 text-center text-sm text-slate-600">This widget has an invalid embedding origin.</main>;
  }

  return (
    <main className="flex h-screen max-h-screen min-h-0 flex-col overflow-hidden bg-white text-ink">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3" style={{ borderTopWidth: 3, borderTopStyle: "solid", borderTopColor: bot?.accent_color ?? "#7064D8" }}>
        <div className="min-w-0"><p className="truncate text-sm font-bold">{bot?.name ?? "DocChat"}</p><p className="text-[11px] text-slate-500">Answers from uploaded documents</p></div>
        <div className="flex shrink-0 items-center gap-1">{sending && <button type="button" className="rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" onClick={() => streamController.current?.abort()}>Stop</button>}<button type="button" className="rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" onClick={newChat} disabled={sending || !sessionToken}>New chat</button><button type="button" aria-label="Close chat" className="rounded-lg px-2 py-1.5 text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" onClick={() => sendParentMessage("docchat:close")}>×</button></div>
      </header>

      {connectionError ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12 text-center"><div><p className="font-semibold text-ink">Chat unavailable</p><p className="mt-2 text-sm leading-6 text-slate-500">{connectionError}</p><Button className="mt-5" variant="secondary" type="button" onClick={() => { setConnectionError(null); sendParentMessage("docchat:retry"); }}>Try again</Button></div></div>
      ) : !sessionToken || !bot ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12 text-sm text-slate-500" role="status">Connecting…</div>
      ) : (
        <>
          <div ref={transcriptRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5" role="log" aria-live="polite" aria-label="Visitor chat transcript">
            {messages.length === 0 ? <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-3 text-sm leading-6 text-slate-700">{bot.greeting}</div> : messages.map((item) => <div key={item.id} className={item.role === "user" ? "ml-auto max-w-[90%]" : "max-w-[94%]"}><div className={item.role === "user" ? "rounded-2xl rounded-br-md bg-lilac px-3.5 py-3 text-sm leading-6 text-white" : "rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-3 text-sm leading-6 text-slate-700"}><p className="whitespace-pre-wrap break-words">{item.content}</p></div>{item.pending && <p className="mt-1 px-1 text-[11px] text-slate-500" role="status">Writing…</p>}{item.incomplete && <p className="mt-1 px-1 text-[11px] text-rose-600" role="status">Incomplete response. Try again.</p>}{item.role === "assistant" && !item.pending && !item.incomplete && item.citations.length > 0 && <details className="mt-2 rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200"><summary className="cursor-pointer font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac">Sources ({item.citations.length})</summary><div className="mt-2 space-y-3">{item.citations.map((citation, index) => <div key={`${citation.document_id ?? citation.source}-${citation.chunk_index ?? index}`}><p className="font-semibold text-slate-700">{citation.source}</p><p className="mt-1 whitespace-pre-wrap leading-5 text-slate-500">{citation.excerpt}</p></div>)}</div></details>}</div>) }
          </div>
          {notice && <p className="mx-4 mb-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700" role="alert">{notice}</p>}
          <form className="shrink-0 border-t border-slate-100 px-4 py-3" onSubmit={submit}>
            <label className="sr-only" htmlFor="widget-message">Ask a question</label>
            <div className="flex items-end gap-2"><textarea id="widget-message" className="min-h-11 min-w-0 flex-1 resize-y rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm leading-5 text-ink outline-none ring-1 ring-slate-200 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-lilac disabled:cursor-not-allowed disabled:opacity-60" rows={2} maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask a question…" disabled={sending} /><Button type="submit" style={{ backgroundColor: bot.accent_color, color: accentTextColor(bot.accent_color) }} disabled={sending || !message.trim()}>{sending ? "…" : "Send"}</Button></div>
            <p className={`mt-1 text-right text-[11px] ${new TextEncoder().encode(message).byteLength > maxQuestionBytes ? "text-rose-600" : "text-slate-500"}`}>{new TextEncoder().encode(message).byteLength} / {maxQuestionBytes} bytes</p>
          </form>
        </>
      )}
    </main>
  );
}
