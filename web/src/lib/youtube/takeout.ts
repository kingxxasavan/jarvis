// Google Takeout's YouTube watch-history.json, reduced to what Jarvis keeps.
// Runs in the browser so a large export never has to be uploaded whole.
export type HistoryEntry = { v: string; t: string; c: string; w: string };

type TakeoutRow = { title?: string; titleUrl?: string; time?: string; subtitles?: { name?: string }[] };

export function parseTakeout(rows: unknown): HistoryEntry[] {
  if (!Array.isArray(rows)) throw new Error("This is not a watch-history.json file.");
  const out: HistoryEntry[] = [];
  for (const r of rows as TakeoutRow[]) {
    const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(r?.titleUrl || "");
    const when = Date.parse(r?.time || "");
    if (!m || !Number.isFinite(when)) continue;
    out.push({
      v: m[1],
      t: String(r.title || "").replace(/^Watched\s+/, "").slice(0, 300),
      c: String(r.subtitles?.[0]?.name || "").slice(0, 120),
      w: new Date(when).toISOString(),
    });
  }
  return out;
}
