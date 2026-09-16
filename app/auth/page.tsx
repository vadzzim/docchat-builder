"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

type AuthMode = "signin" | "signup" | "forgot";
type Notice = { kind: "error" | "success"; text: string } | null;

const supabase = createSupabaseBrowserClient();
function authMessage(error: { message?: string; code?: string } | null): string {
  const code = error?.code ?? "";
  const message = (error?.message ?? "").toLowerCase();
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "Please confirm your email before signing in.";
  }
  if (message.includes("invalid login credentials")) return "That email or password is incorrect.";
  if (message.includes("rate limit")) return "Too many attempts. Wait a moment and try again.";
  if (message.includes("user already registered")) return "An account with that email already exists. Try signing in.";
  return error?.message || "Something went wrong. Please try again.";
}

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    const requestedMode = new URLSearchParams(window.location.search).get("mode");
    if (requestedMode === "signup" || requestedMode === "forgot") setMode(requestedMode);

    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) {
        router.replace("/dashboard");
        return;
      }
      setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, [router]);

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setNotice(null);
    setPassword("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin + "/auth/callback" },
        });
        if (error) throw error;
        if (data.session) {
          router.replace("/dashboard");
        } else {
          setNotice({ kind: "success", text: "Check your email for a confirmation link. You can sign in after confirming it." });
        }
      } else if (mode === "signin") {
        const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) throw new Error("Email confirmation is required before signing in.");
        router.replace("/dashboard");
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin + "/auth/recovery",
        });
        if (error) throw error;
        setNotice({ kind: "success", text: "If an account exists for that email, a password reset link is on its way." });
      }
    } catch (error) {
      setNotice({ kind: "error", text: authMessage(error as { message?: string; code?: string }) });
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return <main className="flex min-h-screen items-center justify-center px-6 text-sm text-slate-500">Loading DocChat…</main>;
  }

  const isForgot = mode === "forgot";
  const title = mode === "signup" ? "Create your workspace" : isForgot ? "Reset your password" : "Welcome back";
  const description = mode === "signup"
    ? "Start with one bot and your own support documents."
    : isForgot
      ? "We’ll send a secure link to choose a new password."
      : "Sign in to continue building your grounded chatbot.";

  return (
    <main className="min-h-screen px-6 py-8">
      <nav className="mx-auto flex max-w-6xl items-center justify-between">
        <a className="text-lg font-bold tracking-tight text-ink" href="/" aria-label="DocChat home">doc<span className="text-lilac">chat</span></a>
        <a className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" href="/">Back home</a>
      </nav>

      <section className="mx-auto flex min-h-[calc(100vh-7rem)] max-w-md items-center justify-center py-12">
        <Card className="w-full p-6 sm:p-8">
          <div className="mb-7">
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-lilac">DocChat workspace</p>
            <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
          </div>

          {notice && (
            <div className={`mb-5 rounded-xl px-3 py-3 text-sm leading-5 ${notice.kind === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`} role={notice.kind === "error" ? "alert" : "status"} aria-live="polite">
              {notice.text}
            </div>
          )}

          <form className="space-y-4" onSubmit={submit}>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="auth-email">Email address</label>
              <Input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" disabled={busy} />
            </div>
            {!isForgot && (
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="auth-password">Password</label>
                <Input id="auth-password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" disabled={busy} />
              </div>
            )}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? "Working…" : mode === "signup" ? "Create account" : isForgot ? "Send reset link" : "Sign in"}
            </Button>
          </form>

          <div className="mt-6 space-y-3 text-center text-sm">
            {mode === "signin" && <button type="button" className="font-semibold text-lilac hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" onClick={() => switchMode("forgot")}>Forgot your password?</button>}
            {mode !== "signup" && <p className="text-slate-500">New to DocChat? <button type="button" className="font-semibold text-ink hover:text-lilac focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" onClick={() => switchMode("signup")}>Create an account</button></p>}
            {mode !== "signin" && <p className="text-slate-500">Already have an account? <button type="button" className="font-semibold text-ink hover:text-lilac focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" onClick={() => switchMode("signin")}>Sign in</button></p>}
          </div>
        </Card>
      </section>
    </main>
  );
}
