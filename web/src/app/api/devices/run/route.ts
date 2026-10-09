import { HttpError, readJson, route } from "@/lib/auth.ts";
import { listDevices, pickDevice, queueJob, waitForJob } from "@/lib/devices.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

// Direct device actions from the UI (the quick-app buttons), without asking
// the model. Only quick tools that need no approval can be run this way.
export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ tool?: string; args?: Record<string, unknown>; device?: string }>(req);
  const tool = String(b.tool || "");
  const devices = await listDevices(sb);
  const device = pickDevice(devices, tool, b.device);
  if (!device) throw new HttpError(409, "No online device can do that right now.");
  const spec = device.manifest.find((t) => t.name === tool);
  if (!spec || spec.hidden || spec.approval || spec.long_running) throw new HttpError(400, "That action cannot be run directly.");
  const job = await queueJob(sb, { deviceId: device.id, tool, args: b.args || {}, title: `${tool.replace(/_/g, " ")} (quick action)` });
  const done = await waitForJob(sb, job.id, 20_000, req.signal);
  if (done?.status === "done") return { ok: true, device: device.name, result: done.result };
  if (done?.status === "failed") throw new HttpError(502, done.error || "The device reported a failure.");
  throw new HttpError(504, `${device.name} has not answered yet.`);
});
