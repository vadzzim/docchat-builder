"use client";

import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { ChatPanel, type ChatBot, type ChatConversation } from "@/components/chat-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { callEdgeFunction, edgeCode, edgeError } from "@/lib/edge-client";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

const supabase = createSupabaseBrowserClient();
const maxFileBytes = 102400;
const processingPollMilliseconds = 2000;
const processingPollWindowMilliseconds = 180000;

type Plan = "free" | "pro";
type Tab = "knowledge" | "chat";
type Notice = { kind: "error" | "success"; text: string } | null;

type Bot = ChatBot & {
  public_enabled: boolean;
  allowed_origins: string[];
};

type DocumentRow = {
  id: string;
  file_name: string;
  source_size_bytes: number;
  status: "pending" | "processing" | "ready" | "error" | "deleting";
  process_error: string | null;
  chunk_count: number;
  process_attempts: number;
  created_at: string;
  updated_at: string;
};

type Usage = {
  plan: Plan;
  used: number;
  limit: number;
};

type BotResponse = { bot?: Bot };
type ProcessResponse = { document_id?: string; status?: DocumentRow["status"]; chunk_count?: number; idempotent?: boolean };

function monthStartUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KiB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown date";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function documentStatus(status: DocumentRow["status"]): { label: string; className: string } {
  switch (status) {
    case "ready": return { label: "Ready", className: "bg-emerald-50 text-emerald-700" };
    case "processing": return { label: "Processing", className: "bg-amber-50 text-amber-700" };
    case "pending": return { label: "Waiting to process", className: "bg-slate-100 text-slate-600" };
    case "deleting": return { label: "Deleting", className: "bg-slate-100 text-slate-600" };
    default: return { label: "Needs attention", className: "bg-rose-50 text-rose-700" };
  }
}

function normalizedDocument(value: Partial<DocumentRow> & { id: string; file_name: string }): DocumentRow {
  return {
    id: value.id,
    file_name: value.file_name,
    source_size_bytes: Number(value.source_size_bytes ?? 0),
    status: (value.status ?? "pending") as DocumentRow["status"],
    process_error: value.process_error ?? null,
    chunk_count: Number(value.chunk_count ?? 0),
    process_attempts: Number(value.process_attempts ?? 0),
    created_at: String(value.created_at ?? new Date().toISOString()),
    updated_at: String(value.updated_at ?? new Date().toISOString()),
  };
}

function planLimits(plan: Plan) {
  return plan === "pro"
    ? { documents: 25, sourceBytes: 2560000, monthly: 1000 }
    : { documents: 5, sourceBytes: 512000, monthly: 100 };
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [bot, setBot] = useState<Bot | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [usage, setUsage] = useState<Usage>({ plan: "free", used: 0, limit: 100 });
  const [tab, setTab] = useState<Tab>("knowledge");
  const [botName, setBotName] = useState("");
  const [botGreeting, setBotGreeting] = useState("Hi! How can I help?");
  const [botAccent, setBotAccent] = useState("#7064D8");
  const [creatingBot, setCreatingBot] = useState(false);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);

  const loadUsage = useCallback(async (activeSession: Session) => {
    const [accountResult, usageResult] = await Promise.all([
      supabase.from("accounts").select("plan").eq("id", activeSession.user.id).maybeSingle(),
      supabase.from("monthly_usage").select("reserved_requests").eq("account_id", activeSession.user.id).eq("month_start", monthStartUtc()).maybeSingle(),
    ]);
    if (accountResult.error) throw new Error("Account settings could not be loaded.");
    if (usageResult.error) throw new Error("Usage could not be loaded.");
    const account = accountResult.data as { plan?: string } | null;
    const usageRow = usageResult.data as { reserved_requests?: number } | null;
    const plan = account?.plan === "pro" ? "pro" : "free";
    const limits = planLimits(plan);
    setUsage({ plan, used: Number(usageRow?.reserved_requests ?? 0), limit: limits.monthly });
  }, []);

  const loadDashboard = useCallback(async (activeSession: Session) => {
    setRefreshing(true);
    setDashboardError(null);
    try {
      const [botResult] = await Promise.all([
        supabase.from("bots").select("id,name,greeting,accent_color,public_enabled,allowed_origins").eq("account_id", activeSession.user.id).maybeSingle(),
        loadUsage(activeSession),
      ]);
      if (botResult.error) throw new Error("Your bot could not be loaded.");
      const loadedBot = botResult.data as unknown as Bot | null;
      setBot(loadedBot);
      if (!loadedBot) {
        setDocuments([]);
        setConversations([]);
        return;
      }
      const [documentResult, conversationResult] = await Promise.all([
        supabase.from("documents").select("id,file_name,source_size_bytes,status,process_error,chunk_count,process_attempts,created_at,updated_at").eq("bot_id", loadedBot.id).order("created_at", { ascending: false }),
        supabase.from("conversations").select("id,created_at,last_activity_at").eq("bot_id", loadedBot.id).order("last_activity_at", { ascending: false }),
      ]);
      if (documentResult.error) throw new Error("Your documents could not be loaded.");
      if (conversationResult.error) throw new Error("Your conversations could not be loaded.");
      setDocuments((documentResult.data ?? []).map((row) => normalizedDocument(row as Partial<DocumentRow> & { id: string; file_name: string })));
      setConversations((conversationResult.data ?? []) as ChatConversation[]);
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "The dashboard could not be loaded.");
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [loadUsage]);

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (!data.session) {
        router.replace("/auth");
        return;
      }
      setSession(data.session);
    });
    const subscription = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      if (!nextSession) {
        router.replace("/auth");
      } else {
        setSession(nextSession);
      }
    });
    return () => {
      mounted = false;
      subscription.data.subscription.unsubscribe();
    };
  }, [router]);

  useEffect(() => {
    if (session) void loadDashboard(session);
  }, [session, loadDashboard]);

  const limits = planLimits(usage.plan);
  const totalSourceBytes = useMemo(() => documents.reduce((total, document) => total + document.source_size_bytes, 0), [documents]);
  const readyDocuments = useMemo(() => documents.filter((document) => document.status === "ready"), [documents]);
  const hasActiveProcessing = Boolean(activeDocumentId || documents.some((document) => document.status === "processing"));

  async function refreshDocuments(activeSession: Session, botId: string): Promise<DocumentRow[]> {
    const { data, error } = await supabase.from("documents")
      .select("id,file_name,source_size_bytes,status,process_error,chunk_count,process_attempts,created_at,updated_at")
      .eq("bot_id", botId)
      .order("created_at", { ascending: false });
    if (error) throw new Error("Your documents could not be loaded.");
    const rows = (data ?? []).map((row) => normalizedDocument(row as Partial<DocumentRow> & { id: string; file_name: string }));
    setDocuments(rows);
    void activeSession;
    return rows;
  }

  async function refreshUsage() {
    if (!session) return;
    try {
      await loadUsage(session);
    } catch {
      setDashboardError("Usage could not be refreshed.");
    }
  }

  async function createBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || creatingBot) return;
    setCreatingBot(true);
    setNotice(null);
    try {
      const result = await callEdgeFunction<BotResponse>("create-bot", session, {
        name: botName.trim(),
        greeting: botGreeting.trim(),
        accent_color: botAccent,
      });
      if (!result.response.ok || !result.data.bot) throw new Error(edgeError(result.data, "Your bot could not be created."));
      setBot(result.data.bot);
      setNotice({ kind: "success", text: "Your bot is ready. Add a document to start testing it." });
      await loadDashboard(session);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Your bot could not be created." });
    } finally {
      setCreatingBot(false);
    }
  }

  async function pollDocument(documentId: string, activeSession: Session, botId: string): Promise<DocumentRow | null> {
    const deadline = Date.now() + processingPollWindowMilliseconds;
    while (Date.now() < deadline) {
      const { data, error } = await supabase.from("documents")
        .select("id,file_name,source_size_bytes,status,process_error,chunk_count,process_attempts,created_at,updated_at")
        .eq("id", documentId).eq("bot_id", botId).maybeSingle();
      if (error) throw new Error("Processing status could not be checked.");
      if (!data) return null;
      const current = normalizedDocument(data as Partial<DocumentRow> & { id: string; file_name: string });
      setDocuments((documentsNow) => documentsNow.map((document) => document.id === documentId ? current : document));
      if (current.status === "ready" || current.status === "error" || current.status === "deleting") return current;
      await new Promise((resolve) => setTimeout(resolve, processingPollMilliseconds));
    }
    const rows = await refreshDocuments(activeSession, botId);
    return rows.find((document) => document.id === documentId) ?? null;
  }

  async function processDocument(documentId: string, allowWhenActive = false, knownFileName?: string) {
    if (!session || !bot || (activeDocumentId && !allowWhenActive)) return;
    setActiveDocumentId(documentId);
    setNotice({ kind: "success", text: "Processing started. Larger documents can take up to two minutes." });
    setDocuments((current) => current.map((document) => document.id === documentId ? { ...document, status: "processing", process_error: null } : document));
    try {
      const result = await callEdgeFunction<ProcessResponse>("process-document", session, { document_id: documentId }, AbortSignal.timeout(125000));
      if (!result.response.ok && result.response.status !== 202) {
        throw new Error(edgeError(result.data, "Document processing failed. You can retry it."));
      }
      const processed = result.data.status === "ready"
        ? normalizedDocument({ id: documentId, file_name: knownFileName ?? documents.find((document) => document.id === documentId)?.file_name ?? "Document", status: "ready", chunk_count: result.data.chunk_count ?? 0 })
        : await pollDocument(documentId, session, bot.id);
      if (!processed) {
        setNotice({ kind: "error", text: "This document is no longer available. Refresh the page and try again." });
      } else if (processed.status === "ready") {
        setNotice({ kind: "success", text: `${processed.file_name} is ready for chat.` });
      } else if (processed.status === "error") {
        setNotice({ kind: "error", text: processed.process_error ?? "Document processing failed. You can retry it." });
      } else {
        setNotice({ kind: "error", text: "Processing is taking longer than expected. Refresh the status or retry after it expires." });
      }
      await refreshDocuments(session, bot.id);
    } catch (error) {
      try {
        await refreshDocuments(session, bot.id);
      } catch {
        // Keep the original processing error visible when a refresh also fails.
      }
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Document processing failed. You can retry it." });
    } finally {
      setActiveDocumentId(null);
    }
  }

  async function uploadDocument(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !session || !bot || hasActiveProcessing) return;
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".txt") && !lowerName.endsWith(".md")) {
      setNotice({ kind: "error", text: "Only .txt and .md files are supported." });
      return;
    }
    if (file.size < 1) {
      setNotice({ kind: "error", text: "That document is empty." });
      return;
    }
    if (file.size > maxFileBytes) {
      setNotice({ kind: "error", text: "Source files must be 100 KiB or smaller." });
      return;
    }
    setActiveDocumentId("uploading");
    setNotice(null);
    const form = new FormData();
    form.append("bot_id", bot.id);
    form.append("file", file, file.name);
    try {
      const result = await callEdgeFunction<{ document?: Partial<DocumentRow> & { id: string; file_name: string } }>("upload-document", session, form);
      if (!result.response.ok || !result.data.document) throw new Error(edgeError(result.data, "The document could not be uploaded."));
      const uploaded = normalizedDocument(result.data.document);
      setDocuments((current) => [uploaded, ...current.filter((document) => document.id !== uploaded.id)]);
      setActiveDocumentId(null);
      await processDocument(uploaded.id, true, uploaded.file_name);
    } catch (error) {
      setActiveDocumentId(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The document could not be uploaded." });
      try {
        await refreshDocuments(session, bot.id);
      } catch {
        // Keep the upload error visible if the status refresh is unavailable.
      }
    }
  }

  async function deleteDocument(document: DocumentRow) {
    if (!session || !bot || deletingDocumentId) return;
    if (!window.confirm(`Delete ${document.file_name}? Existing chat history will remain, but this source will no longer be used for retrieval.`)) return;
    setDeletingDocumentId(document.id);
    setNotice(null);
    try {
      const result = await callEdgeFunction<{ deleted?: boolean }>("delete-document", session, { document_id: document.id });
      if (!result.response.ok || result.data.deleted !== true) throw new Error(edgeError(result.data, "The document could not be deleted."));
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setNotice({ kind: "success", text: `${document.file_name} was removed from your knowledge.` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The document could not be deleted." });
      try {
        await refreshDocuments(session, bot.id);
      } catch {
        // Keep the delete error visible if the refresh also fails.
      }
    } finally {
      setDeletingDocumentId(null);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/auth");
  }

  if (loading || !session) {
    return <main className="flex min-h-screen items-center justify-center px-6 text-sm text-slate-500">Loading your workspace…</main>;
  }

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6 sm:py-8">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <a className="text-lg font-bold tracking-tight text-ink" href="/" aria-label="DocChat home">doc<span className="text-lilac">chat</span></a>
        <div className="flex items-center gap-3">
          <span className="hidden max-w-52 truncate text-sm text-slate-500 sm:inline" title={session.user.email ?? undefined}>{session.user.email}</span>
          <Button variant="ghost" type="button" onClick={signOut}>Sign out</Button>
        </div>
      </header>

      <section className="mx-auto max-w-6xl py-8 sm:py-12">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-lilac">Owner workspace</p>
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Build your support chat</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Keep your source files private, test grounded answers, and review the citations before you publish later.</p>
          </div>
          {refreshing && <p className="text-sm text-slate-400" role="status">Refreshing…</p>}
        </div>

        {dashboardError && <div className="mb-6 rounded-xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700" role="alert">{dashboardError}</div>}
        {notice && <div className={`mb-6 rounded-xl px-4 py-3 text-sm leading-6 ${notice.kind === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}

        {!bot ? (
          <Card className="mx-auto max-w-xl p-6 sm:p-8">
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-lilac">First step</p>
            <h2 className="text-2xl font-bold tracking-tight text-ink">Create your bot</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">Give your assistant a name and a friendly opening message. You can add documents right after this.</p>
            <form className="mt-6 space-y-4" onSubmit={createBot}>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="bot-name">Bot name</label>
                <Input id="bot-name" required maxLength={80} value={botName} onChange={(event) => setBotName(event.target.value)} placeholder="Northstar support" disabled={creatingBot} />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="bot-greeting">Greeting</label>
                <textarea id="bot-greeting" required maxLength={500} rows={3} value={botGreeting} onChange={(event) => setBotGreeting(event.target.value)} className="w-full resize-y rounded-xl border-0 bg-slate-50 px-3 py-2.5 text-sm leading-6 text-ink outline-none ring-1 ring-slate-200 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-lilac disabled:cursor-not-allowed disabled:opacity-60" disabled={creatingBot} />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="bot-accent">Accent color</label>
                <div className="flex items-center gap-3"><input id="bot-accent" type="color" value={botAccent} onChange={(event) => setBotAccent(event.target.value)} className="h-10 w-14 cursor-pointer rounded-lg border-0 bg-transparent" disabled={creatingBot} /><span className="text-sm text-slate-500">Used for future widget accents.</span></div>
              </div>
              <Button type="submit" disabled={creatingBot || !botName.trim()}>{creatingBot ? "Creating…" : "Create bot"}</Button>
            </form>
          </Card>
        ) : (
          <>
            <div className="mb-5 flex flex-col justify-between gap-4 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80 sm:flex-row sm:items-center sm:p-6">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Your bot</p>
                <h2 className="mt-1 truncate text-xl font-bold text-ink">{bot.name}</h2>
                <p className="mt-1 truncate text-sm text-slate-500">{bot.greeting}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:min-w-72">
                <div className="rounded-2xl bg-slate-50 px-3 py-3"><p className="text-xs text-slate-400">Knowledge</p><p className="mt-1 font-semibold text-ink">{readyDocuments.length} ready</p></div>
                <div className="rounded-2xl bg-slate-50 px-3 py-3"><p className="text-xs text-slate-400">AI this month</p><p className="mt-1 font-semibold text-ink">{usage.used} / {usage.limit}</p></div>
              </div>
            </div>

            <div className="mb-6 flex gap-2 border-b border-slate-200" role="tablist" aria-label="Workspace sections">
              <button type="button" role="tab" aria-selected={tab === "knowledge"} className={`border-b-2 px-3 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac ${tab === "knowledge" ? "border-lilac text-ink" : "border-transparent text-slate-500 hover:text-ink"}`} onClick={() => setTab("knowledge")}>Knowledge</button>
              <button type="button" role="tab" aria-selected={tab === "chat"} className={`border-b-2 px-3 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac ${tab === "chat" ? "border-lilac text-ink" : "border-transparent text-slate-500 hover:text-ink"}`} onClick={() => setTab("chat")}>Chat</button>
            </div>

            {tab === "knowledge" ? (
              <section role="tabpanel" aria-label="Knowledge">
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
                  <Card className="p-5 sm:p-6">
                    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                      <div><h2 className="text-xl font-bold text-ink">Source documents</h2><p className="mt-1 text-sm leading-6 text-slate-500">Upload UTF-8 TXT or Markdown files. The server checks every limit before storing them.</p></div>
                      <label className={`inline-flex cursor-pointer items-center justify-center rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 focus-within:outline-none focus-within:ring-2 focus-within:ring-lilac focus-within:ring-offset-2 ${hasActiveProcessing ? "cursor-not-allowed opacity-50" : ""}`}>
                        <span>{hasActiveProcessing ? "Processing…" : "Upload document"}</span>
                        <input className="sr-only" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={uploadDocument} disabled={hasActiveProcessing} />
                      </label>
                    </div>
                    <div className="mt-6 space-y-3">
                      {documents.length === 0 ? (
                        <div className="rounded-2xl bg-slate-50 px-4 py-8 text-center"><p className="font-semibold text-ink">No documents yet</p><p className="mt-1 text-sm text-slate-500">Upload a support policy, FAQ, or product guide to test your bot.</p></div>
                      ) : documents.map((document) => {
                        const status = documentStatus(document.status);
                        const canProcess = document.status === "pending" || document.status === "error" || (document.status === "processing" && !activeDocumentId);
                        return <div key={document.id} className="rounded-2xl bg-slate-50 px-4 py-4">
                          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                            <div className="min-w-0"><p className="truncate font-semibold text-ink">{document.file_name}</p><p className="mt-1 text-xs text-slate-400">{formatBytes(document.source_size_bytes)} · added {formatDate(document.created_at)}</p></div>
                            <span className={`w-fit rounded-full px-2.5 py-1 text-xs font-semibold ${status.className}`}>{status.label}</span>
                          </div>
                          {document.process_error && <p className="mt-3 rounded-xl bg-white px-3 py-2 text-sm leading-5 text-rose-700">{document.process_error}</p>}
                          <div className="mt-3 flex flex-wrap items-center gap-3">
                            {canProcess && <Button type="button" variant="secondary" onClick={() => void processDocument(document.id)} disabled={Boolean(activeDocumentId)}>{document.status === "error" ? "Retry processing" : "Process"}</Button>}
                            {document.status === "processing" && <span className="text-xs text-amber-700">Embedding source text… this can take up to two minutes.</span>}
                            <Button type="button" variant="ghost" onClick={() => void deleteDocument(document)} disabled={deletingDocumentId === document.id || Boolean(activeDocumentId)}>{deletingDocumentId === document.id ? "Deleting…" : "Delete"}</Button>
                          </div>
                        </div>;
                      })}
                    </div>
                  </Card>

                  <aside className="space-y-5">
                    <Card className="p-5"><h2 className="font-semibold text-ink">Plan limits</h2><p className="mt-1 text-sm font-semibold text-lilac">{usage.plan === "pro" ? "Pro" : "Free"}</p><dl className="mt-4 space-y-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-slate-500">Documents</dt><dd className="font-semibold text-ink">{documents.length} / {limits.documents}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Source text</dt><dd className="font-semibold text-ink">{formatBytes(totalSourceBytes)} / {formatBytes(limits.sourceBytes)}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Each file</dt><dd className="font-semibold text-ink">100 KiB max</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">AI requests</dt><dd className="font-semibold text-ink">{usage.used} / {usage.limit}</dd></div></dl><p className="mt-4 text-xs leading-5 text-slate-400">Your server plan controls these limits. Usage counts owner and visitor chats together.</p></Card>
                    <Card className="p-5"><h2 className="font-semibold text-ink">Private by default</h2><p className="mt-2 text-sm leading-6 text-slate-500">Your original files stay private while you test. Publishing and allowed website origins will be available after the owner flow is verified.</p></Card>
                  </aside>
                </div>
              </section>
            ) : (
              <section role="tabpanel" aria-label="Chat">
                <ChatPanel session={session} bot={bot} conversations={conversations} hasReadyDocuments={readyDocuments.length > 0} onConversationsChange={setConversations} onUsageRefresh={refreshUsage} />
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}
