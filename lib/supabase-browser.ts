import { createClient, type Session } from "@supabase/supabase-js";

let browserClient: ReturnType<typeof createClient> | undefined;
let recoveryLinkAccessToken = readRecoveryLinkAccessToken();
let recoverySession: Session | null = null;
const recoveryListeners = new Set<() => void>();

function readRecoveryLinkAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const type = hash.get("type") ?? search.get("type");
  const accessToken = hash.get("access_token") ?? search.get("access_token");
  const refreshToken = hash.get("refresh_token") ?? search.get("refresh_token");
  const expiresIn = hash.get("expires_in") ?? search.get("expires_in");
  const tokenType = hash.get("token_type") ?? search.get("token_type");
  return type === "recovery" && accessToken && refreshToken && expiresIn && tokenType ? accessToken : null;
}

function notifyRecoveryListeners(): void {
  for (const listener of recoveryListeners) listener();
}

function clearRecoveryState(): void {
  recoveryLinkAccessToken = null;
  recoverySession = null;
}

export function getRecoverySession(): Session | null {
  return recoverySession;
}

export function hasRecoveryAttempt(): boolean {
  return Boolean(recoveryLinkAccessToken || recoverySession);
}

export function onRecoveryStateChange(listener: () => void): () => void {
  recoveryListeners.add(listener);
  return () => recoveryListeners.delete(listener);
}

export function clearRecoveryProof(): void {
  clearRecoveryState();
}

function observeRecoveryAuth(client: ReturnType<typeof createClient>): void {
  client.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      if (session && recoveryLinkAccessToken === session.access_token) {
        recoverySession = session;
      } else {
        clearRecoveryState();
      }
      notifyRecoveryListeners();
      return;
    }
    if (event === "SIGNED_IN") {
      const matchesRecovery = Boolean(
        session &&
        (session.access_token === recoveryLinkAccessToken ||
          session.access_token === recoverySession?.access_token),
      );
      if (!matchesRecovery) clearRecoveryState();
      notifyRecoveryListeners();
      return;
    }
    if (event === "TOKEN_REFRESHED") {
      if (recoverySession && session && session.user.id === recoverySession.user.id) {
        recoverySession = session;
      } else {
        clearRecoveryState();
      }
      notifyRecoveryListeners();
      return;
    }
    if (event === "SIGNED_OUT") {
      clearRecoveryState();
      notifyRecoveryListeners();
    } else if (event === "USER_UPDATED" && recoverySession) {
      clearRecoveryState();
    }
  });
}

export function createSupabaseBrowserClient() {
  if (!browserClient) {
    browserClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          autoRefreshToken: true,
          detectSessionInUrl: true,
          persistSession: true,
        },
      },
    );
    observeRecoveryAuth(browserClient);
  }
  return browserClient;
}

export async function awaitRecoveryInitialization(): Promise<void> {
  const { error } = await createSupabaseBrowserClient().auth.initialize();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  if (error) throw error;
}
