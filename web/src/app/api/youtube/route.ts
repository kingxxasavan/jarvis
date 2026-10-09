import { HttpError, readJson, route } from "@/lib/auth.ts";
import { importHistory, logWatch } from "@/lib/youtube/history.ts";
import type { HistoryEntry } from "@/lib/youtube/takeout.ts";
import { searchVideos, videoIdFrom } from "@/lib/youtube/youtube.ts";

export const runtime = "nodejs";

// Search from the player's own search box.
export const GET = route(async (_owner, req) => {
  const q = new URL(req.url).searchParams.get("q")?.trim() || "";
  if (!q) return { videos: [] };
  return { videos: await searchVideos(q, 12) };
});

// { played: {id,title,channel} } logs a video picked by hand;
// { history: HistoryEntry[] } imports one chunk of a Takeout export.
export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ played?: { id?: string; title?: string; channel?: string }; history?: HistoryEntry[] }>(req, 3_000_000);
  if (b.played) {
    const id = videoIdFrom(String(b.played.id || ""));
    if (!id) throw new HttpError(400, "Not a YouTube video.");
    await logWatch(sb, { id, title: String(b.played.title || ""), channel: String(b.played.channel || "") });
    return { ok: true };
  }
  if (Array.isArray(b.history)) {
    const clean = b.history.filter((e) =>
      e && /^[A-Za-z0-9_-]{11}$/.test(String(e.v)) && Number.isFinite(Date.parse(String(e.w))));
    return { imported: await importHistory(sb, clean) };
  }
  throw new HttpError(400, "Nothing to do.");
});
