// YouTube without an API key: search through YouTube's own web client
// (youtubei.js), a channel's newest uploads through its public RSS feed, and an
// oEmbed check before playing, because oEmbed answers 401 for videos whose
// owner has blocked embedding. That check is what keeps playback from landing
// on a "Video unavailable" screen.
import { Innertube } from "youtubei.js";

export type Video = {
  id: string;
  title: string;
  channel: string;
  channelId?: string;
  duration?: string;
  published?: string;
  views?: string;
};

let client: Promise<Innertube> | null = null;

function yt(): Promise<Innertube> {
  client ??= Innertube.create({ retrieve_player: false, generate_session_locally: true }).catch((err) => {
    client = null;
    throw err;
  });
  return client;
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function videoIdFrom(input: string): string | null {
  const s = String(input || "").trim();
  if (ID_RE.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith("youtu.be")) return ID_RE.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
    const v = u.searchParams.get("v");
    if (v && ID_RE.test(v)) return v;
    const m = /\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

export function sameChannel(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

export async function searchVideos(query: string, limit = 8): Promise<Video[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const res = await (await yt()).search(q, { type: "video" });
  const out: Video[] = [];
  for (const r of res.results ?? []) {
    if (r.type !== "Video") continue;
    const v = r as unknown as {
      video_id: string; title?: { toString(): string }; author?: { name?: string; id?: string };
      duration?: { text?: string }; published?: { text?: string }; view_count?: { text?: string };
    };
    if (!ID_RE.test(v.video_id)) continue;
    out.push({
      id: v.video_id,
      title: v.title?.toString() || "",
      channel: v.author?.name || "",
      channelId: v.author?.id,
      duration: v.duration?.text,
      published: v.published?.text,
      views: v.view_count?.text,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function channelIdFor(name: string): Promise<{ id: string; name: string } | null> {
  if (/^UC[A-Za-z0-9_-]{22}$/.test(name)) return { id: name, name };
  const res = await (await yt()).search(name.replace(/^@/, ""), { type: "channel" });
  for (const r of res.results ?? []) {
    const c = r as unknown as { type: string; author?: { id?: string; name?: string } };
    if (c.type === "Channel" && c.author?.id) return { id: c.author.id, name: c.author.name || name };
  }
  return null;
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// The newest uploads (up to 15) of a channel, newest first.
export async function channelLatest(channel: string): Promise<Video[]> {
  const c = await channelIdFor(channel.trim());
  if (!c) return [];
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const xml = await res.text();
  const out: Video[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const id = /<yt:videoId>([^<]+)</.exec(entry)?.[1];
    const title = /<title>([^<]*)</.exec(entry)?.[1];
    const published = /<published>([^<]+)</.exec(entry)?.[1];
    if (id && ID_RE.test(id)) {
      out.push({ id, title: decodeXml(title || ""), channel: c.name, channelId: c.id, published: published?.slice(0, 10) });
    }
  }
  return out;
}

export type Playability = "ok" | "no-embed" | "missing";

export async function playability(id: string): Promise<Playability> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "no-embed";
    if (res.status === 404 || res.status === 400) return "missing";
    return "ok";
  } catch {
    return "ok"; // unknown: let the player try; it falls back on its own
  }
}

function matchesWords(title: string, query: string): number {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!words.length) return 0;
  const t = title.toLowerCase();
  return words.filter((w) => t.includes(w)).length / words.length;
}

// Finds the single best video for a request, preferring ones that can play
// inside Jarvis. Returns the pick plus a few alternatives.
export async function resolveVideo(req: { query?: string; channel?: string; latest?: boolean }): Promise<{
  pick: (Video & { embeddable: boolean }) | null;
  alternatives: Video[];
}> {
  const query = (req.query || "").trim();
  const channel = (req.channel || "").trim();
  let candidates: Video[] = [];

  if (channel && (req.latest || !query)) {
    const latest = await channelLatest(channel);
    candidates = query
      ? [...latest].sort((a, b) => matchesWords(b.title, query) - matchesWords(a.title, query))
      : latest;
  }
  if (!candidates.length) {
    const found = await searchVideos([channel, query].filter(Boolean).join(" "), 10);
    candidates = channel ? [...found.filter((v) => sameChannel(v.channel, channel)), ...found.filter((v) => !sameChannel(v.channel, channel))] : found;
    if (channel && !candidates.some((v) => sameChannel(v.channel, channel))) {
      // Search found nothing by that creator; their own feed might.
      const latest = await channelLatest(channel).catch(() => []);
      const hit = latest.filter((v) => !query || matchesWords(v.title, query) > 0.5);
      if (hit.length) candidates = [...hit, ...candidates];
    }
  }
  if (!candidates.length) return { pick: null, alternatives: [] };

  // Check the top few in parallel and take the first that can be embedded.
  const head = candidates.slice(0, 4);
  const states = await Promise.all(head.map((v) => playability(v.id)));
  const okIndex = states.findIndex((s) => s === "ok");
  const pickIndex = okIndex >= 0 ? okIndex : states.findIndex((s) => s !== "missing");
  if (pickIndex < 0) return { pick: null, alternatives: candidates.slice(4, 8) };
  const pick = { ...head[pickIndex], embeddable: states[pickIndex] === "ok" };
  return { pick, alternatives: candidates.filter((v) => v.id !== pick.id).slice(0, 4) };
}
