import { HttpError, route } from "@/lib/auth.ts";
import { isOnline } from "@/lib/devices.ts";
import { mintPass } from "@/lib/stream.ts";

export const runtime = "nodejs";

// Short-lived passes to one device's streamed apps.
export const GET = route(async ({ sb }, req) => {
  const wanted = new URL(req.url).searchParams.get("device");
  let q = sb.from("devices").select("id, name, last_seen, stream_url, stream_secret, stream_info")
    .not("stream_url", "is", null).order("last_seen", { ascending: false });
  if (wanted) q = q.eq("id", wanted);
  const { data, error } = await q.limit(5);
  if (error) throw new Error(error.message);
  const device = (data || []).find((d) => isOnline(d)) ?? null;
  if (!device) {
    throw new HttpError(409, data?.length
      ? "That device is offline. Apps come back when its agent is running."
      : "No device is streaming apps yet. Run the agent on your laptop with Chrome and cloudflared installed.");
  }
  const base = String(device.stream_url);
  return {
    device: { id: device.id, name: device.name },
    base,
    ws: `${base.replace(/^https:/, "wss:")}/ws?t=${mintPass(device.stream_secret, "stream", 120)}`,
    desktop: `${base.replace(/^https:/, "wss:")}/ws?mode=desktop&t=${mintPass(device.stream_secret, "stream", 120)}`,
    files: mintPass(device.stream_secret, "files", 3600),
    vscode: (device.stream_info as { vscode?: string } | null)?.vscode || "",
  };
});
