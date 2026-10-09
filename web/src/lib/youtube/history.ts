// What the owner has watched: every video Jarvis plays, plus an optional
// Takeout import of their full YouTube history.
import type { Supa } from "../supabase/server.ts";
import type { HistoryEntry } from "./takeout.ts";

export type Watched = { video_id: string; title: string; channel: string; watched_at: string };

export async function logWatch(sb: Supa, v: { id: string; title: string; channel: string }) {
  const { error } = await sb.from("watch_history").insert({ video_id: v.id, title: v.title.slice(0, 300), channel: v.channel.slice(0, 120) });
  if (error) console.warn("[youtube] history write failed:", error.message);
}

// LIKE wildcards and the characters PostgREST's or() syntax reserves.
const escapeLike = (s: string) => s.replace(/[%_,()"\\]/g, " ").trim();

// Newest first. Words in `query` must all appear in the title or channel.
export async function searchHistory(sb: Supa, opts: { query?: string; days?: number; limit?: number }): Promise<Watched[]> {
  let q = sb.from("watch_history").select("video_id, title, channel, watched_at")
    .order("watched_at", { ascending: false })
    .limit(Math.max(1, Math.min(opts.limit ?? 10, 50)));
  if (opts.days && opts.days > 0) q = q.gte("watched_at", new Date(Date.now() - opts.days * 86_400_000).toISOString());
  for (const word of (opts.query || "").split(/\s+/).filter((w) => w.length > 1).slice(0, 6)) {
    const w = escapeLike(word);
    if (!w) continue;
    q = q.or(`title.ilike.%${w}%,channel.ilike.%${w}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as Watched[];
}

export async function importHistory(sb: Supa, entries: HistoryEntry[]): Promise<number> {
  const rows = entries.slice(0, 2000).map((e) => ({
    video_id: e.v, title: e.t, channel: e.c, watched_at: e.w, source: "takeout",
  }));
  if (!rows.length) return 0;
  const { error, count } = await sb.from("watch_history")
    .upsert(rows, { onConflict: "owner_id,video_id,watched_at", ignoreDuplicates: true, count: "exact" });
  if (error) throw new Error(error.message);
  return count ?? rows.length;
}
