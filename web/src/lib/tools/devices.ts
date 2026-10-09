// Device tools. Every tool a device agent advertises in its manifest (built-in
// or a plugin Jarvis wrote) becomes a "pc_<name>" tool here, so new device
// abilities appear without changing or redeploying the website.
import { getJob, isOnline, jobEvents, pickDevice, queueJob, waitForJob, type Device, type ManifestTool } from "../devices.ts";
import { str, type Args, type Tool } from "./types.ts";

export const PREFIX = "pc_";

function describeDevices(devices: Device[]) {
  return devices.map((d) => ({
    name: d.name,
    online: isOnline(d),
    platform: d.platform || "unknown",
    last_seen: d.last_seen,
    abilities: d.manifest.filter((t) => !t.hidden).map((t) => t.name),
  }));
}

export const deviceInfoTools: Tool[] = [
  {
    name: "device_status",
    description: "Which of Sir's PCs and laptops are online, and what each can do.",
    parameters: { type: "object", properties: {} },
    label: () => "Checking devices",
    async run(_a, ctx) {
      return { devices: describeDevices(ctx.devices) };
    },
  },
  {
    name: "task_status",
    description: "Progress and results of device tasks (coding projects, plugin builds). Without an id, lists the most recent tasks.",
    parameters: { type: "object", properties: { id: { type: "string" } } },
    label: () => "Checking tasks",
    async run(a, ctx) {
      const id = str(a.id, 60);
      if (id) {
        const job = await getJob(ctx.sb, id);
        if (!job) return { error: "No task with that id." };
        const events = await jobEvents(ctx.sb, id, 0, 400);
        return { ...job, recent_log: events.slice(-15).map((e) => e.text) };
      }
      const { data } = await ctx.sb.from("jobs").select("id, title, tool, status, error, created_at, finished_at")
        .order("created_at", { ascending: false }).limit(8);
      return { tasks: data || [] };
    },
  },
];

function deviceTool(spec: ManifestTool, owners: Device[]): Tool {
  const names = owners.map((d) => d.name);
  const properties = { ...(spec.parameters?.properties as Record<string, unknown> | undefined) };
  if (names.length > 1) properties.device = { type: "string", enum: names, description: "Which device (default: most recently active)" };
  return {
    name: PREFIX + spec.name,
    description: `${spec.description} [Runs on ${names.join(" or ")}${spec.approval ? "; Sir must approve it on screen first" : ""}]`,
    parameters: { type: "object", properties, required: (spec.parameters?.required as string[] | undefined) ?? [] },
    label: (a) => `${spec.name.replace(/_/g, " ")}${a.device ? " on " + str(a.device, 30) : ""}`,
    async run(a: Args, ctx) {
      const device = pickDevice(ctx.devices, spec.name, str(a.device));
      if (!device) return { error: `No online device offers ${spec.name} right now.` };
      const args = { ...a };
      delete args.device;
      const title = str(a.title || a.instructions || a.name || a.query || spec.name, 120) || spec.name;
      const job = await queueJob(ctx.sb, {
        deviceId: device.id, tool: spec.name, args, title: `${spec.name.replace(/_/g, " ")}: ${title}`,
        longRunning: !!spec.long_running, needsApproval: !!spec.approval, conversationId: ctx.conversationId,
      });
      const ref = { id: job.id, title: job.title, status: job.status, tool: spec.name, device: device.name };
      if (spec.approval) {
        ctx.emit({ t: "job", job: ref });
        return { status: "awaiting_approval", task_id: job.id, note: "An approval card is on screen. Tell Sir it is waiting for a go-ahead." };
      }
      if (spec.long_running) {
        ctx.emit({ t: "job", job: ref });
        return { status: "started", task_id: job.id, note: "Running in the background; progress is in Tasks." };
      }
      const done = await waitForJob(ctx.sb, job.id, Math.min((spec.timeout ?? 20) * 1000, 60_000), ctx.signal);
      if (done?.status === "done") return { device: device.name, result: done.result };
      if (done?.status === "failed") return { device: device.name, error: done.error || "It failed." };
      return { device: device.name, status: done?.status ?? "unknown", note: `Not finished yet; task ${job.id} is still ${done?.status}.` };
    },
  };
}

// One pc_ tool per advertised ability across the online devices.
export function deviceTools(devices: Device[]): Tool[] {
  const byName = new Map<string, { spec: ManifestTool; owners: Device[] }>();
  for (const d of devices.filter(isOnline)) {
    for (const t of d.manifest) {
      if (t.hidden || !/^[a-z][a-z0-9_]{1,50}$/.test(t.name)) continue;
      const slot = byName.get(t.name) ?? { spec: t, owners: [] };
      slot.owners.push(d);
      byName.set(t.name, slot);
    }
  }
  return [...byName.values()].map(({ spec, owners }) => deviceTool(spec, owners));
}
