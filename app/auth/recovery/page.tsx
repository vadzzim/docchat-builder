"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  awaitRecoveryInitialization,
  clearRecoveryProof,
  createSupabaseBrowserClient,
  getRecoverySession,
  hasRecoveryAttempt,
  onRecoveryStateChange,
} from "@/lib/supabase-browser";

type Notice = { kind: "error" | "success"; text: string } | null;

const supabase = createSupabaseBrowserClient();

function linkError(): string | null {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const error = search.get("error") ?? hash.get("error");
  if (!error) return null;
  if (error === "access_denied" || error === "otp_expired") return "This reset link has expired or was already used.";
  return search.get("error_description") ?? hash.get("error_description") ?? "This reset link could not be verified.";
}

export default function RecoveryPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    const initialError = linkError();
    const showError = (text: string) => {
      if (!mounted) return;
      setHasSession(false);
      setNotice({ kind: "error", text });
      setChecking(false);
    };
    const syncRecovery = () => {
      if (!mounted || initialError || completedRef.current) return;
      const session = getRecoverySession();
      if (session) {
        setHasSession(true);
        setNotice(null);
        setChecking(false);
      } else if (!hasRecoveryAttempt()) {
        showError("This reset link is invalid or expired.");
      }
    };
    const unsubscribe = onRecoveryStateChange(syncRecovery);
    syncRecovery();
    if (initialError) {
      clearRecoveryProof();
      showError(initialError);
    } else if (!getRecoverySession() && !hasRecoveryAttempt()) {
      showError("This reset link is missing or expired.");
    } else if (!getRecoverySession()) {
      void awaitRecoveryInitialization()
        .then(() => {
          if (mounted && !completedRef.current && !getRecoverySession()) {
            clearRecoveryProof();
            showError("This reset link is invalid or expired.");
          }
        })
        .catch(() => {
          if (!mounted || completedRef.current) return;
          clearRecoveryProof();
          showError("This reset link is invalid or expired.");
        });
    }
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setNotice({ kind: "error", text: "Use at least 8 characters for your new password." });
      return;
    }
    if (password !== confirmation) {
      setNotice({ kind: "error", text: "The passwords do not match." });
      return;
    }
    if (!getRecoverySession()) {
      setHasSession(false);
      setNotice({ kind: "error", text: "This reset link is invalid or expired." });
      return;
    }
    setBusy(true);
    setNotice(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setNotice({ kind: "error", text: error.message || "The password could not be updated." });
    } else {
      setPassword("");
      setConfirmation("");
      completedRef.current = true;
      clearRecoveryProof();
      setNotice({ kind: "success", text: "Your password has been updated. You can now open your workspace." });
    }
    setBusy(false);
  }

  return (
    <main className="min-h-screen px-6 py-8">
      <nav className="mx-auto flex max-w-6xl items-center justify-between">
        <a className="text-lg font-bold tracking-tight text-ink" href="/" aria-label="DocChat home">doc<span className="text-lilac">chat</span></a>
        <a className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" href="/auth">Back to sign in</a>
      </nav>
      <section className="mx-auto flex min-h-[calc(100vh-7rem)] max-w-md items-center justify-center py-12">
        <Card className="w-full p-6 sm:p-8">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-lilac">Account recovery</p>
          <h1 className="text-3xl font-bold tracking-tight text-ink">Choose a new password</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">Set a new password for your DocChat workspace.</p>

          {checking ? (
            <p className="mt-8 text-sm text-slate-500" role="status">Checking your reset link…</p>
          ) : !hasSession ? (
            <div className="mt-6 rounded-xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700" role="alert">
              {notice?.text ?? "This reset link is invalid or expired."}
              <a className="mt-3 block font-semibold underline" href="/auth?mode=forgot">Request another reset link</a>
            </div>
          ) : (
            <>
              {notice && <div className={`mt-6 rounded-xl px-4 py-3 text-sm leading-6 ${notice.kind === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
              <form className="mt-6 space-y-4" onSubmit={submit}>
                <div>
                  <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="new-password">New password</label>
                  <Input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} placeholder="At least 8 characters" />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="confirm-password">Confirm new password</label>
                  <Input id="confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} placeholder="Repeat your new password" />
                </div>
                <Button className="w-full" type="submit" disabled={busy}>{busy ? "Updating…" : "Update password"}</Button>
              </form>
              {notice?.kind === "success" && <Button className="mt-3 w-full" variant="secondary" onClick={() => router.push("/dashboard")}>Open workspace</Button>}
            </>
          )}
        </Card>
      </section>
    </main>
  );
}
