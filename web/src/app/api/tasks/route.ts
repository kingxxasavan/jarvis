import { HttpError, readJson, route } from "@/lib/auth.ts";
import { getJob, jobEvents, listDevices, queueJob, setJobStatus } from "@/lib/devices.ts";

export const runtime = "nodejs";

// Recent tasks, or one task with its log (pass id and after=<last event id>).
export const GET = route(async ({ sb }, req) => {
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (id) {
    const job = await getJob(sb, id);
    if (!job) throw new HttpError(404, "No such task.");
    return { job, events: await jobEvents(sb, id, Number(params.get("after")) || 0) };
  }
  const { data, error } = await sb.from("jobs")
    .select("id, device_id, tool, args, title, status, error, result, long_running, created_at, started_at, finished_at, updated_at")
    .order("created_at", { ascending: false }).limit(40);
  if (error) throw new Error(error.message);
  const names = Object.fromEntries((await listDevices(sb)).map((d) => [d.id, d.name]));
  const jobs = (data || []).map((j) => ({ ...j, device: names[j.device_id] || "removed device" }));
  return { jobs };
});

// approve | reject | cancel | enable_plugin | disable_plugin
export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ id?: string; action?: string; plugin?: string }>(req);
  const action = String(b.action || "");
  if (action === "enable_plugin" || action === "disable_plugin") {
    const job = b.id ? await getJob(sb, b.id) : null;
    if (!job || job.tool !== "create_plugin" || job.status !== "done") throw new HttpError(400, "Pick a finished plugin build.");
    const name = String((job.result as { name?: string } | null)?.name || "");
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) throw new HttpError(400, "That build did not produce a valid plugin.");
    const devices = await listDevices(sb);
    if (!devices.some((d) => d.id === job.device_id)) throw new HttpError(409, "That device was removed.");
    const tool = action === "enable_plugin" ? "enable_plugin" : "disable_plugin";
    const next = await queueJob(sb, { deviceId: job.device_id, tool, args: { name }, title: `${tool.replace("_", " ")}: ${name}` });
    return { ok: true, job: next.id };
  }
  if (!b.id) throw new HttpError(400, "Which task?");
  const transitions: Record<string, [string[], string]> = {
    approve: [["needs_approval"], "queued"],
    reject: [["needs_approval"], "rejected"],
    cancel: [["needs_approval", "queued", "running"], "cancelled"],
  };
  const t = transitions[action];
  if (!t) throw new HttpError(400, "Unknown action.");
  const changed = await setJobStatus(sb, b.id, t[0], t[1]);
  if (!changed) throw new HttpError(409, "That task has already moved on.");
  return { ok: true };
});
