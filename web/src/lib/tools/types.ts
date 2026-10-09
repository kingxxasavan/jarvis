import type { StreamEvent } from "../ai/events.ts";
import type { Device } from "../devices.ts";
import type { Supa } from "../supabase/server.ts";

export type ToolContext = {
  sb: Supa;
  ownerId: string;
  ownerName: string;
  tz: string;
  conversationId: string;
  devices: Device[];
  emit: (e: StreamEvent) => void;
  signal?: AbortSignal;
};

export type Args = Record<string, unknown>;

export type Tool = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  label: (args: Args) => string;
  run: (args: Args, ctx: ToolContext) => Promise<unknown>;
};

// Models send null for strings, "20" for numbers and "true" for booleans.
export const str = (v: unknown, max = 2000) => (v === null || v === undefined ? "" : String(v)).trim().slice(0, max);
export const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = v === null || v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
export const bool = (v: unknown) => v === true || v === "true" || v === 1 || v === "1" || v === "yes";
