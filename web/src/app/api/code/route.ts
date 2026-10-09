import { HttpError, readJson, route } from "@/lib/auth.ts";
import { listDevices, pickDevice, queueJob, waitForJob } from "@/lib/devices.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

// The Code tab: Sir types to Claude Code directly. These run without an
// approval card because Sir is the one asking, not the model.
async function device(sb: Parameters<typeof listDevices>[0], tool: string, wanted?: string | null) {
  const d = pickDevice(await listDevices(sb), tool, wanted || undefined);
  if (!d) throw new HttpError(409, "No online device can run Claude Code. Start the agent on your laptop (and update it with git pull).");
  return d;
}

export const GET = route(async ({ sb }, req) => {
  const d = await device(sb, "code_folders", new URL(req.url).searchParams.get("device"));
  const job = await queueJob(sb, { deviceId: d.id, tool: "code_folders", args: {}, title: "code folders (quick action)" });
  const done = await waitForJob(sb, job.id, 20_000, req.signal);
  if (done?.status !== "done") throw new HttpError(504, done?.error || `${d.name} has not answered yet.`);
  return { device: { id: d.id, name: d.name }, ...(done.result as Record<string, unknown>) };
});

export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ instructions?: string; folder?: string; agent?: string; resume?: string; commit?: boolean; push?: boolean; device?: string; restart?: boolean; update?: boolean }>(req, 100_000);
  if (b.restart) {
    const d = await device(sb, "restart_agent", b.device);
    const job = await queueJob(sb, { deviceId: d.id, tool: "restart_agent", args: { update: !!b.update }, title: b.update ? "update and restart agent" : "restart agent" });
    return { job: job.id, device: d.name };
  }
  const instructions = String(b.instructions || "").trim();
  if (!instructions) throw new HttpError(400, "Type what Claude Code should do.");
  const d = await device(sb, "code_session", b.device);
  const job = await queueJob(sb, {
    deviceId: d.id, tool: "code_session", longRunning: true,
    args: { instructions, folder: String(b.folder || "jarvis"), agent: b.agent || "claude", resume: b.resume || "", commit: !!b.commit, push: !!b.push },
    title: `Claude Code: ${instructions.replace(/\s+/g, " ").slice(0, 80)}`,
  });
  return { job: job.id, device: d.name };
});
