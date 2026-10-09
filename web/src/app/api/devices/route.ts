import { HttpError, readJson, route } from "@/lib/auth.ts";
import { createDevice, isOnline, listDevices, removeDevice } from "@/lib/devices.ts";

export const runtime = "nodejs";

export const GET = route(async ({ sb }) => {
  const devices = await listDevices(sb);
  return {
    devices: devices.map((d) => ({
      id: d.id, name: d.name, platform: d.platform, version: d.agent_version, last_seen: d.last_seen,
      online: isOnline(d), tools: d.manifest.filter((t) => !t.hidden).map((t) => t.name),
      apps: !!d.stream_url, vscode: d.stream_info?.vscode || "",
    })),
  };
});

export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ name?: string }>(req);
  if (!b.name?.trim()) throw new HttpError(400, "Name the device, e.g. Laptop or Home PC.");
  return await createDevice(sb, b.name);
});

export const DELETE = route(async ({ sb }, req) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw new HttpError(400, "Which device?");
  await removeDevice(sb, id);
  return { ok: true };
});
