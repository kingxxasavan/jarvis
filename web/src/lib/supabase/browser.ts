"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseOrigin } from "./url";

let client: SupabaseClient | null = null;

export function browserClient(): SupabaseClient {
  client ??= createBrowserClient(
    supabaseOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL),
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
  return client;
}
