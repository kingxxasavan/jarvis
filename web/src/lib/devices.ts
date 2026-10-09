// Devices (the 24/7 laptop, the home PC) and the job queue between the
// website and their agents. The agent pulls jobs; nothing ever connects in.
import { createHash, randomBytes } from "node:crypto";
import { env } from "./env.ts";
import type { Supa } from "./supabase/server.ts";

export type ManifestTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  long_running?: boolean;
  approval?: boolean;
  hidden?: boolean;
  timeout?: number;
};

export type Device = {
  id: string;
  name: string;
  platform: string;
  agent_version: string;
  manifest: ManifestTool[];
  last_seen: string | null;
  created_at: string;
  stream_url?: string | null;
  stream_info?: { vscode?: string } | null;
};

export type Job = {
  id: string; device_id: string; tool: string; args: Record<string, unknown>; title: string;
  long_running: boolean; status: string; result: unknown; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; updated_at: string;
};

const DEVICE_COLUMNS = "id, name, platform, agent_version, manifest, last_seen, created_at, stream_url, stream_info";
const ONLINE_MS = 45_000;

export const isOnline = (d: Pick<Device, "last_seen">) =>
  !!d.last_seen && Date.now() - Date.parse(d.last_seen) < ONLINE_MS;

export async function listDevices(sb: Supa): Promise<Device[]> {
  const query = (cols: string) => sb.from("devices").select(cols).order("created_at");
  let res = await query(DEVICE_COLUMNS);
  if (res.error && /stream_/.test(res.error.message)) {
    // The app-streaming migration has not been run yet; everything else still works.
    res = await query(DEVICE_COLUMNS.replace(", stream_url, stream_info", ""));
  }
  if (res.error) throw new Error(res.error.message);
  return ((res.data || []) as unknown as Device[]).map((d) => ({ ...d, manifest: Array.isArray(d.manifest) ? d.manifest : [] }));
}

// Creates a device and returns its one-time pairing code. The code carries the
// public Supabase address and key plus the device token; only the token's hash
// is stored, so a lost code means pairing again.
export async function createDevice(sb: Supa, name: string) {
  const clean = name.trim().replace(/[^\w .-]/g, "").slice(0, 40) || "Device";
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await sb.from("devices").insert({ name: clean, token_hash: hash }).select("id").single();
  if (error) throw new Error(error.message);
  const code = Buffer.from(JSON.stringify({ u: env.supabaseUrl(), k: env.supabaseKey(), t: token, n: clean })).toString("base64url");
  return { id: data.id as string, name: clean, code };
}

export async function removeDevice(sb: Supa, id: string) {
  const { error } = await sb.from("devices").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function queueJob(sb: Supa, j: {
  deviceId: string; tool: string; args: Record<string, unknown>; title: string;
  longRunning?: boolean; needsApproval?: boolean; conversationId?: string | null;
}): Promise<Job> {
  const { data, error } = await sb.from("jobs").insert({
    device_id: j.deviceId, tool: j.tool, args: j.args, title: j.title.slice(0, 200),
    long_running: !!j.longRunning, status: j.needsApproval ? "needs_approval" : "queued",
    conversation_id: j.conversationId ?? null,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return data as Job;
}

export async function getJob(sb: Supa, id: string): Promise<Job | null> {
  const { data } = await sb.from("jobs").select("*").eq("id", id).maybeSingle();
  return (data as Job) ?? null;
}

const FINAL = new Set(["done", "failed", "cancelled", "rejected"]);
export const isFinal = (status: string) => FINAL.has(status);

// Waits for a quick job to finish. Returns the job as it stands at the deadline.
export async function waitForJob(sb: Supa, id: string, timeoutMs: number, signal?: AbortSignal): Promise<Job | null> {
  const end = Date.now() + timeoutMs;
  let job = await getJob(sb, id);
  while (job && !isFinal(job.status) && Date.now() < end && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, 600));
    job = await getJob(sb, id);
  }
  return job;
}

export async function setJobStatus(sb: Supa, id: string, from: string[], to: string) {
  const patch: Record<string, unknown> = { status: to, updated_at: new Date().toISOString() };
  if (isFinal(to)) patch.finished_at = new Date().toISOString();
  const { data, error } = await sb.from("jobs").update(patch).eq("id", id).in("status", from).select("id");
  if (error) throw new Error(error.message);
  return (data || []).length > 0;
}

export async function jobEvents(sb: Supa, jobId: string, afterId = 0, limit = 200) {
  const { data, error } = await sb.from("job_events").select("id, kind, text, created_at")
    .eq("job_id", jobId).gt("id", afterId).order("id").limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

// Picks which device runs a tool: the one named, else the most recently seen
// online device that has the tool.
export function pickDevice(devices: Device[], tool: string, wanted?: string): Device | null {
  const able = devices.filter((d) => isOnline(d) && d.manifest.some((t) => t.name === tool));
  if (wanted) {
    const w = wanted.trim().toLowerCase();
    const named = able.find((d) => d.name.toLowerCase() === w) ?? able.find((d) => d.name.toLowerCase().includes(w));
    if (named) return named;
  }
  return able.sort((a, b) => Date.parse(b.last_seen!) - Date.parse(a.last_seen!))[0] ?? null;
}
