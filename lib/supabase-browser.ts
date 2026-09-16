import { createClient } from "@supabase/supabase-js";

let browserClient: ReturnType<typeof createClient> | undefined;

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
  }
  return browserClient;
}
