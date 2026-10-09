// Events streamed from /api/chat to the browser, one JSON object per line.
export type VideoRef = { id: string; title: string; channel: string; embeddable: boolean };
export type JobRef = { id: string; title: string; status: string; tool: string; device: string };

export type StreamEvent =
  | { t: "conv"; id: string }
  | { t: "provider"; id: string }
  | { t: "text"; d: string }
  | { t: "tool"; id: string; name: string; label: string; state: "start" | "done" | "error"; note?: string }
  | { t: "play"; video: VideoRef }
  | { t: "job"; job: JobRef }
  | { t: "error"; message: string }
  | { t: "done"; messageId?: string };
