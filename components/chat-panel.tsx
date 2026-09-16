"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import { readSse, SseStreamError, type SseEvent } from "@/lib/sse-client";

const supabase = createSupabaseBrowserClient();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const maxQuestionBytes = 1000;

export type ChatBot = {
  id: string;
  name: string;
  greeting: string;
  accent_color: string;
};

export type ChatConversation = {
  id: string;
  created_at: string;
  last_activity_at: string;
};

type Citation = {
  document_id: string;
  source: string;
  excerpt: string;
  similarity: number;
  chunk_index: number;
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  message_order?: number;
  created_at: string;
};

type DisplayMessage = StoredMessage & {
  pending?: boolean;
  incomplete?: boolean;
};

type StreamFailure = Error & { code?: string };

class ChatRequestError extends SseStreamError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = "ChatRequestError";
  }
}

function responseError(data: unknown, fallback: string): ChatRequestError {
  if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") {
    return new ChatRequestError(data.error, "code" in data && typeof data.code === "string" ? data.code : undefined);
  }
  return new ChatRequestError(fallback);
}

async function parseErrorResponse(response: Response): Promise<ChatRequestError> {
  const text = await response.text();
  if (text) {
    try {
      return responseError(JSON.parse(text), `Chat request failed (${response.status}).`);
    } catch {
      return new ChatRequestError(`Chat request failed (${response.status}).`);
    }
  }
  return new ChatRequestError(`Chat request failed (${response.status}).`);
}

async function streamChat(
  session: Session,
  body: Record<string, unknown>,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/chat`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChatRequestError("The chat service could not be reached. Try again shortly.");
  }
  if (!response.ok) throw await parseErrorResponse(response);
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    throw await parseErrorResponse(response);
  }
  await readSse(response, onEvent, signal);
}

function messageCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Citation => {
    if (typeof item !== "object" || item === null) return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate.source === "string" && typeof candidate.excerpt === "string";
  });
}

function messageError(error: unknown): { message: string; code?: string } {
  if (error instanceof ChatRequestError) return { message: error.message, code: error.code };
  if (error instanceof DOMException && error.name === "AbortError") return { message: "The response was stopped before it completed.", code: "cancelled" };
  if (error instanceof Error) return { message: error.message, code: (error as StreamFailure).code };
  return { message: "The chat could not be completed. Try again." };
}

function formatConversationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "New conversation";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function bytesUsed(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function ChatPanel({
  session,
  bot,
  conversations,
  hasReadyDocuments,
  onConversationsChange,
  onUsageRefresh,
}: {
  session: Session;
  bot: ChatBot;
  conversations: ChatConversation[];
  hasReadyDocuments: boolean;
  onConversationsChange: (conversations: ChatConversation[]) => void;
  onUsageRefresh: () => Promise<void>;
}) {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [message, setMessage] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!streamingRef.current && selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(null);
      setMessages([]);
    }
  }, [conversations, selectedConversationId]);

  useEffect(() => () => {
    streamController.current?.abort();
    streamingRef.current = false;
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!selectedConversationId || streamingRef.current) {
      if (!selectedConversationId) setMessages([]);
      return;
    }
    let mounted = true;
    setLoadingHistory(true);
    setHistoryError(null);
    void supabase.from("messages")
      .select("id,role,content,citations,message_order,created_at")
      .eq("conversation_id", selectedConversationId)
      .order("message_order", { ascending: true })
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          setHistoryError("Conversation history could not be loaded. Try selecting it again.");
          setMessages([]);
        } else {
          setMessages(((data ?? []) as unknown[]).map((row) => {
            const item = row as Record<string, unknown>;
            return {
              id: String(item.id),
              role: item.role as "user" | "assistant",
              content: String(item.content),
              citations: messageCitations(item.citations),
              message_order: typeof item.message_order === "number" ? item.message_order : undefined,
              created_at: String(item.created_at),
            };
          }));
        }
        setLoadingHistory(false);
      });
    return () => {
      mounted = false;
    };
  }, [selectedConversationId]);

  function startNewChat() {
    if (sending) return;
    setSelectedConversationId(null);
    setMessages([]);
    setChatNotice(null);
    setHistoryError(null);
  }

  async function refreshConversations() {
    const { data, error } = await supabase.from("conversations")
      .select("id,created_at,last_activity_at")
      .eq("bot_id", bot.id)
      .order("last_activity_at", { ascending: false });
    if (!error) onConversationsChange((data ?? []) as ChatConversation[]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    if (bytesUsed(trimmed) > maxQuestionBytes) {
      setChatNotice("Keep your question under 1,000 UTF-8 bytes.");
      return;
    }
    if (!hasReadyDocuments) {
      setChatNotice("Upload and process a document before starting a chat.");
      return;
    }

    const sentMessage = trimmed;
    const now = new Date().toISOString();
    const userId = `local-user-${Date.now()}`;
    const assistantId = `local-assistant-${Date.now()}`;
    setMessage("");
    setChatNotice(null);
    setHistoryError(null);
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: sentMessage, citations: [], created_at: now },
      { id: assistantId, role: "assistant", content: "", citations: [], created_at: now, pending: true },
    ]);
    setSending(true);
    streamingRef.current = true;
    const controller = new AbortController();
    streamController.current = controller;
    let sawDone = false;
    let conversationId = selectedConversationId;
    try {
      await streamChat(session, {
        bot_id: bot.id,
        ...(selectedConversationId ? { conversation_id: selectedConversationId } : {}),
        message: sentMessage,
      }, (event) => {
        const data = event.data as Record<string, unknown> | null;
        if (event.event === "meta" && typeof data?.conversation_id === "string") {
          conversationId = data.conversation_id;
          setSelectedConversationId(conversationId);
        } else if (event.event === "token" && typeof data?.token === "string") {
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: item.content + data.token, pending: true } : item));
        } else if (event.event === "done") {
          sawDone = true;
          const citations = messageCitations(data?.citations);
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, citations, pending: false, incomplete: false } : item));
        } else if (event.event === "error") {
          throw responseError(data, "The chat could not be completed. Try again.");
        }
      }, controller.signal);
      if (!sawDone) throw new ChatRequestError("The chat stream ended before the answer was complete.");
      await refreshConversations();
      if (conversationId) {
        const { data, error } = await supabase.from("messages")
          .select("id,role,content,citations,message_order,created_at")
          .eq("conversation_id", conversationId)
          .order("message_order", { ascending: true });
        if (!error) {
          setMessages(((data ?? []) as unknown[]).map((row) => {
            const item = row as Record<string, unknown>;
            return {
              id: String(item.id), role: item.role as "user" | "assistant", content: String(item.content),
              citations: messageCitations(item.citations), message_order: typeof item.message_order === "number" ? item.message_order : undefined,
              created_at: String(item.created_at),
            };
          }));
        }
      }
    } catch (error) {
      const failure = messageError(error);
      setMessages((current) => current.map((item) => item.id === assistantId ? {
        ...item,
        pending: false,
        incomplete: true,
        content: item.content || "No completed answer was saved.",
      } : item));
      setChatNotice(failure.message);
    } finally {
      streamingRef.current = false;
      streamController.current = null;
      setSending(false);
      try {
        await onUsageRefresh();
      } catch {
        setChatNotice((current) => current ?? "Usage could not be refreshed. Reload the workspace to check it.");
      }
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <aside aria-label="Owner conversations">
        <div className="flex items-center justify-between gap-2 lg:block">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">History</p>
            <p className="mt-1 text-xs text-slate-400">Kept for 30 days</p>
          </div>
          <Button className="mt-2 whitespace-nowrap lg:mt-4" variant="secondary" type="button" onClick={startNewChat} disabled={sending}>New chat</Button>
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible" role="list">
          {conversations.length === 0 ? (
            <p className="text-xs leading-5 text-slate-400">Your completed conversations will appear here.</p>
          ) : conversations.map((conversation) => (
            <div key={conversation.id} role="listitem">
              <button
                type="button"
                className={`shrink-0 rounded-xl px-3 py-2 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac lg:block lg:w-full ${selectedConversationId === conversation.id ? "bg-white font-semibold text-ink ring-1 ring-lilac/40" : "text-slate-500 hover:bg-white hover:text-ink"}`}
                onClick={() => {
                  if (sending) return;
                  setChatNotice(null);
                  setSelectedConversationId(conversation.id);
                }}
                aria-current={selectedConversationId === conversation.id ? "page" : undefined}
                aria-label={`Conversation from ${formatConversationDate(conversation.last_activity_at || conversation.created_at)}`}
              >
                {formatConversationDate(conversation.last_activity_at || conversation.created_at)}
              </button>
            </div>
          ))}
        </div>
      </aside>

      <Card className="flex min-h-[30rem] min-w-0 flex-col p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink">{bot.name}</p>
            <p className="text-xs text-slate-400">Answers use ready documents and include sources.</p>
          </div>
          {sending && <Button variant="ghost" type="button" onClick={() => streamController.current?.abort()}>Stop</Button>}
        </div>

        {!hasReadyDocuments ? (
          <div className="flex flex-1 items-center justify-center px-4 py-16 text-center">
            <div>
              <p className="font-semibold text-ink">Your chat is waiting for knowledge</p>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Upload and process a TXT or Markdown document in Knowledge, then come back to test an answer.</p>
            </div>
          </div>
        ) : (
          <>
            <div ref={transcriptRef} className="min-h-0 max-h-[34rem] flex-1 space-y-4 overflow-y-auto py-6" role="log" aria-live="polite" aria-label="Chat transcript">
              {loadingHistory ? (
                <p className="text-center text-sm text-slate-400" role="status">Loading conversation…</p>
              ) : historyError ? (
                <p className="rounded-xl bg-rose-50 px-3 py-3 text-sm text-rose-700" role="alert">{historyError}</p>
              ) : messages.length === 0 ? (
                <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm leading-6 text-slate-700">{bot.greeting}</div>
              ) : messages.map((item) => (
                <div key={item.id} className={item.role === "user" ? "ml-auto max-w-[88%]" : "max-w-[92%]"}>
                  <div className={item.role === "user" ? "rounded-2xl rounded-br-md bg-lilac px-4 py-3 text-sm leading-6 text-white" : "rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm leading-6 text-slate-700"}>
                    <p className="whitespace-pre-wrap break-words">{item.content}</p>
                  </div>
                  {item.pending && <p className="mt-1 px-1 text-xs text-slate-400" role="status">Writing…</p>}
                  {item.incomplete && <p className="mt-1 px-1 text-xs text-rose-600" role="status">Incomplete response. Nothing was saved as a completed answer.</p>}
                  {item.role === "assistant" && !item.pending && !item.incomplete && item.citations.length > 0 && (
                    <details className="mt-2 rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
                      <summary className="cursor-pointer font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac">Sources ({item.citations.length})</summary>
                      <div className="mt-2 space-y-3">
                        {item.citations.map((citation, index) => (
                          <div key={`${citation.document_id}-${citation.chunk_index}-${index}`}>
                            <p className="font-semibold text-slate-700">{citation.source}</p>
                            <p className="mt-1 whitespace-pre-wrap leading-5 text-slate-500">{citation.excerpt}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
            {chatNotice && <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-sm leading-5 text-rose-700" role="alert">{chatNotice}</p>}
            <form className="border-t border-slate-100 pt-4" onSubmit={submit}>
              <label className="sr-only" htmlFor="chat-message">Ask a question</label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <textarea
                  id="chat-message"
                  className="min-h-12 flex-1 resize-y rounded-xl border-0 bg-slate-50 px-3 py-2.5 text-sm leading-6 text-ink outline-none ring-1 ring-slate-200 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-lilac disabled:cursor-not-allowed disabled:opacity-60"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Ask about your documents…"
                  maxLength={1000}
                  rows={2}
                  disabled={sending}
                />
                <Button type="submit" disabled={sending || !message.trim()}>{sending ? "Answering…" : "Send"}</Button>
              </div>
              <p className={`mt-2 text-right text-xs ${bytesUsed(message) > maxQuestionBytes ? "text-rose-600" : "text-slate-400"}`}>{bytesUsed(message)} / {maxQuestionBytes} UTF-8 bytes</p>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}
