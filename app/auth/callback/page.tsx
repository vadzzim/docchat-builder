"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

type CallbackState = {
  kind: "error" | "success";
  text: string;
};

const supabase = createSupabaseBrowserClient();

function callbackError(search: URLSearchParams, hash: URLSearchParams): string | null {
  const error = search.get("error") ?? hash.get("error");
  if (!error) return null;
  const description = search.get("error_description") ?? hash.get("error_description");
  if (error === "access_denied" || error === "otp_expired") {
    return "This email link has expired or was already used. Request a new one and try again.";
  }
  return description || "The email link could not be verified. Request a new one and try again.";
}

function tokenType(value: string | null): "signup" | "invite" | "magiclink" | "recovery" | null {
  if (value === "signup" || value === "invite" || value === "magiclink" || value === "recovery") return value;
  return null;
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [state, setState] = useState<CallbackState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const type = tokenType(search.get("type") ?? hash.get("type"));
    const code = search.get("code");
    const tokenHash = search.get("token_hash") ?? hash.get("token_hash");
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    const hasLinkProof = Boolean(code || tokenHash || accessToken || refreshToken);

    // Recovery links must always land on the password form, even when the
    // singleton has already restored a session from the URL hash.
    if (type === "recovery") {
      router.replace("/auth/recovery");
      return () => {
        mounted = false;
      };
    }

    const run = async () => {
      const linkError = callbackError(search, hash);
      if (linkError) {
        if (mounted) {
          setState({ kind: "error", text: linkError });
          setLoading(false);
        }
        return;
      }

      let verifiedByRequest = false;
      if (code) {
        const { data: exchanged, error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          if (mounted) {
            setState({ kind: "error", text: "This email link has expired or was already used. Request a new one and try again." });
            setLoading(false);
          }
          return;
        }
        verifiedByRequest = Boolean(exchanged.session);
      } else {
        if (tokenHash && type) {
          const { data: verified, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error) {
            if (mounted) {
              setState({ kind: "error", text: "This email link has expired or was already used. Request a new one and try again." });
              setLoading(false);
            }
            return;
          }
          verifiedByRequest = Boolean(verified.session);
        }
      }

      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!hasLinkProof) {
        setState({ kind: "error", text: "This email link is missing or invalid. Request a new one and try again." });
        setLoading(false);
        return;
      }
      if (data.session) {
        router.replace("/dashboard");
        return;
      }
      if (!verifiedByRequest) {
        setState({ kind: "error", text: "This email link is invalid or expired. Request a new one and try again." });
        setLoading(false);
        return;
      }
      setState({ kind: "success", text: "Your email is confirmed. Sign in to open your workspace." });
      setLoading(false);
    };

    void run().catch(() => {
      if (!mounted) return;
      setState({ kind: "error", text: "The email link could not be verified. Request a new one and try again." });
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <Card className="w-full max-w-md p-6 text-center sm:p-8">
        <a className="text-lg font-bold tracking-tight text-ink" href="/" aria-label="DocChat home">
          doc<span className="text-lilac">chat</span>
        </a>
        {loading ? (
          <p className="mt-8 text-sm text-slate-500" role="status">Verifying your email…</p>
        ) : (
          <>
            <div className={`mt-8 rounded-xl px-4 py-3 text-sm leading-6 ${state?.kind === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`} role={state?.kind === "error" ? "alert" : "status"}>
              {state?.text}
            </div>
            <Button className="mt-6 w-full" onClick={() => router.push("/auth")}>Continue to sign in</Button>
          </>
        )}
      </Card>
    </main>
  );
}
