import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "../env.ts";

// A Supabase client acting as the signed-in user. Row-level security applies,
// so every query is limited to the owner's own rows.
export async function serverClient() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Called from a server component, where cookies are read-only. The
          // proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

export type Supa = Awaited<ReturnType<typeof serverClient>>;
