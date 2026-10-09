import { HttpError, readJson, route } from "@/lib/auth.ts";
import { isOnline, listDevices, queueJob } from "@/lib/devices.ts";

export const runtime = "nodejs";

// Tools JARVIS built for itself, kept in the database.
export const GET = route(async ({ sb }) => {
  const { data, error } = await sb.from("plugins").select("id, name, description, code, valid, problem, device_id, job_id, created_at, updated_at")
    .order("updated_at", { ascending: false });
  if (error) {
    if (/plugins/.test(error.message)) throw new HttpError(409, "Saved tools need the latest supabase/schema.sql.");
    throw new Error(error.message);
  }
  const devices = await listDevices(sb);
  return {
    plugins: (data || []).map((p) => {
      const on = devices.filter((d) => d.manifest.some((t) => t.name === p.name)).map((d) => d.name);
      return { ...p, enabled_on: on };
    }),
  };
});

// { name, action: "enable" | "disable", device? }: installs the saved code on a
// device and switches it on (or off). Enabling is always Sir's own click.
export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ name?: string; action?: string; device?: string }>(req);
  const { data: plugin } = await sb.from("plugins").select("name, code, valid, device_id").eq("name", String(b.name || "")).maybeSingle();
  if (!plugin) throw new HttpError(404, "No saved tool with that name.");
  if (b.action === "enable" && !plugin.valid) throw new HttpError(400, "That tool did not load cleanly when it was built, so it cannot be enabled.");
  const online = (await listDevices(sb)).filter(isOnline);
  const device = online.find((d) => d.id === b.device) ?? online.find((d) => d.id === plugin.device_id) ?? online[0];
  if (!device) throw new HttpError(409, "No device is online.");
  const tool = b.action === "disable" ? "disable_plugin" : "enable_plugin";
  const job = await queueJob(sb, {
    deviceId: device.id, tool, args: tool === "enable_plugin" ? { name: plugin.name, code: plugin.code } : { name: plugin.name },
    title: `${tool.replace("_", " ")}: ${plugin.name}`,
  });
  return { ok: true, job: job.id, device: device.name };
});

export const DELETE = route(async ({ sb }, req) => {
  const name = new URL(req.url).searchParams.get("name") || "";
  const { error } = await sb.from("plugins").delete().eq("name", name);
  if (error) throw new Error(error.message);
  return { ok: true };
});
