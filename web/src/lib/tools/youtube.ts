import { pickDevice, queueJob, waitForJob } from "../devices.ts";
import { logWatch, searchHistory } from "../youtube/history.ts";
import { channelLatest, resolveVideo, searchVideos, videoIdFrom, type Video } from "../youtube/youtube.ts";
import { bool, num, str, type Tool, type ToolContext } from "./types.ts";

async function playOnDevice(ctx: ToolContext, v: Video, deviceName: string) {
  const device = pickDevice(ctx.devices, "play_youtube", deviceName);
  if (!device) return { error: "No online device can play videos right now. Offer to play it here on screen instead." };
  const job = await queueJob(ctx.sb, {
    deviceId: device.id, tool: "play_youtube", args: { video_id: v.id }, title: `Play "${v.title}"`,
    conversationId: ctx.conversationId,
  });
  const done = await waitForJob(ctx.sb, job.id, 20_000, ctx.signal);
  if (done?.status === "done") return { playing: v.title, channel: v.channel, on: device.name, result: done.result };
  if (done?.status === "failed") return { error: `${device.name} could not play it: ${done.error}` };
  return { error: `${device.name} has not confirmed playback yet (task ${job.id}).` };
}

export const youtubeTools: Tool[] = [
  {
    name: "play_youtube",
    description:
      "Find and play a YouTube video in one step. Give a topic (query), a creator (channel), latest=true for their newest upload, " +
      "from_history=true to replay something already watched, or an exact video link/id. Plays on Sir's screen by default; " +
      "set on='device' (and a device name) to play on a PC or laptop instead.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the video is about, or its title" },
        channel: { type: "string", description: "Creator or channel name, e.g. MKBHD" },
        latest: { type: "boolean", description: "The creator's newest upload" },
        from_history: { type: "boolean", description: "Pick from the watch history" },
        video: { type: "string", description: "A YouTube URL or 11-character id" },
        on: { type: "string", enum: ["screen", "device"], description: "Where to play (default screen)" },
        device: { type: "string", description: "Device name when on='device'" },
      },
    },
    label: (a) => `Finding ${str(a.channel || a.query || a.video, 50) || "a video"}`,
    async run(a, ctx) {
      let video: Video;
      let embeddable = true;
      let alternatives: Video[] = [];
      const direct = videoIdFrom(str(a.video));
      if (direct) {
        video = { id: direct, title: str(a.query) || "YouTube video", channel: str(a.channel) };
      } else if (bool(a.from_history)) {
        const hits = await searchHistory(ctx.sb, { query: [str(a.query), str(a.channel)].join(" "), limit: 5 });
        if (!hits.length) return { error: "Nothing in the watch history matches that. Try other words, or search YouTube instead." };
        video = { id: hits[0].video_id, title: hits[0].title, channel: hits[0].channel };
        alternatives = hits.slice(1).map((h) => ({ id: h.video_id, title: h.title, channel: h.channel }));
      } else {
        if (!str(a.query) && !str(a.channel)) return { error: "Say what to play: a topic, a creator, or a link." };
        const found = await resolveVideo({ query: str(a.query), channel: str(a.channel), latest: bool(a.latest) });
        if (!found.pick) return { error: "YouTube returned nothing playable for that." };
        video = found.pick;
        embeddable = found.pick.embeddable;
        alternatives = found.alternatives;
      }

      await logWatch(ctx.sb, video);
      if (str(a.on) === "device") return playOnDevice(ctx, video, str(a.device));

      ctx.emit({ t: "play", video: { id: video.id, title: video.title, channel: video.channel, embeddable } });
      return {
        playing: video.title,
        channel: video.channel,
        on: "screen",
        note: embeddable ? undefined : "The owner of this video blocks embedding, so it opens on YouTube from the card on screen.",
        alternatives: alternatives.slice(0, 3).map((v) => `${v.title} (${v.channel})`),
      };
    },
  },
  {
    name: "youtube_search",
    description: "List YouTube videos for a topic, or a creator's newest uploads (channel + latest). Use to show options; use play_youtube to play.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        channel: { type: "string" },
        latest: { type: "boolean" },
        limit: { type: "integer", description: "1-10, default 6" },
      },
    },
    label: (a) => `Searching YouTube: ${str(a.channel || a.query, 50)}`,
    async run(a) {
      const limit = num(a.limit, 6, 1, 10);
      const list = str(a.channel) && (bool(a.latest) || !str(a.query))
        ? await channelLatest(str(a.channel))
        : await searchVideos([str(a.channel), str(a.query)].filter(Boolean).join(" "), limit);
      return { videos: list.slice(0, limit) };
    },
  },
  {
    name: "youtube_history",
    description:
      "What Sir has watched, newest first: everything played through Jarvis plus any imported YouTube history. " +
      "Filter by words and/or recent days.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        days: { type: "integer", description: "Only the last N days" },
        limit: { type: "integer", description: "1-30, default 10" },
      },
    },
    label: () => "Checking watch history",
    async run(a, ctx) {
      const rows = await searchHistory(ctx.sb, { query: str(a.query), days: num(a.days, 0, 0, 3650), limit: num(a.limit, 10, 1, 30) });
      return { watched: rows.map((r) => ({ title: r.title, channel: r.channel, when: r.watched_at, video: r.video_id })) };
    },
  },
];
