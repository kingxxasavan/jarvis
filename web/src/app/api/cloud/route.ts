import { randomUUID } from "node:crypto";
import { HttpError, readJson, route } from "@/lib/auth.ts";
import { listDevices, pickDevice, queueJob } from "@/lib/devices.ts";

export const runtime = "nodejs";

const BUCKET = "jarvis-files";
const MAX = 50 * 2 ** 20;

type Row = { id: string; name: string; path: string; size: number; content_type: string; status: string; source: string; created_at: string; device_id: string | null };

// Cloud files: downloads the laptop copied up, and files uploaded from any browser.
export const GET = route(async ({ sb }) => {
  const { data, error } = await sb.from("cloud_files").select("id, name, path, size, content_type, status, source, created_at, device_id")
    .neq("status", "failed").order("created_at", { ascending: false }).limit(200);
  if (error) {
    if (/cloud_files/.test(error.message)) throw new HttpError(409, "Cloud files need the latest supabase/schema.sql. Run it once in the Supabase SQL editor.");
    throw new Error(error.message);
  }
  const rows = (data || []) as Row[];
  const ready = rows.filter((r) => r.status === "ready");
  const signed = ready.length
    ? (await sb.storage.from(BUCKET).createSignedUrls(ready.map((r) => r.path), 3600, { download: true })).data || []
    : [];
  const urls = new Map(signed.map((s) => [s.path, s.signedUrl]));
  return { files: rows.map((r) => ({ ...r, url: urls.get(r.path) || null })) };
});

// { name, size, type } -> a signed upload slot; { done: id } -> mark uploaded;
// { toDevice: id } -> download that file onto the laptop.
export const POST = route(async ({ sb, userId }, req) => {
  const b = await readJson<{ name?: string; size?: number; type?: string; done?: string; failed?: string; toDevice?: string; device?: string }>(req);
  if (b.done || b.failed) {
    const { error } = await sb.from("cloud_files").update({ status: b.done ? "ready" : "failed" }).eq("id", b.done || b.failed!);
    if (error) throw new Error(error.message);
    return { ok: true };
  }
  if (b.toDevice) {
    const { data: row } = await sb.from("cloud_files").select("name, path").eq("id", b.toDevice).maybeSingle();
    if (!row) throw new HttpError(404, "No such file.");
    const { data: link } = await sb.storage.from(BUCKET).createSignedUrl(row.path, 3600);
    if (!link?.signedUrl) throw new HttpError(502, "Could not make a download link.");
    const device = pickDevice(await listDevices(sb), "download_file", b.device);
    if (!device) throw new HttpError(409, "No device is online to receive it.");
    const job = await queueJob(sb, {
      deviceId: device.id, tool: "download_file", args: { url: link.signedUrl, filename: row.name, cloud: false },
      title: `download file: ${row.name}`, longRunning: true,
    });
    return { ok: true, job: job.id, device: device.name };
  }
  const name = String(b.name || "").replace(/[^\w .()-]/g, "_").slice(0, 150) || "file";
  const size = Number(b.size) || 0;
  if (size > MAX) throw new HttpError(413, "Cloud files are limited to 50 MB each.");
  const path = `${userId}/${randomUUID()}/${name}`;
  const { data: row, error } = await sb.from("cloud_files").insert({
    name: String(b.name || name).slice(0, 200), path, size, content_type: String(b.type || "application/octet-stream").slice(0, 120),
    status: "uploading", source: "browser",
  }).select("id").single();
  if (error) throw new Error(error.message);
  const { data: slot, error: e2 } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (e2 || !slot) throw new Error(e2?.message || "Could not open an upload slot.");
  return { id: row.id, path, token: slot.token };
});

export const DELETE = route(async ({ sb }, req) => {
  const id = new URL(req.url).searchParams.get("id");
  const { data: row } = await sb.from("cloud_files").select("path").eq("id", id || "").maybeSingle();
  if (!row) throw new HttpError(404, "No such file.");
  await sb.storage.from(BUCKET).remove([row.path]);
  await sb.from("cloud_files").delete().eq("id", id!);
  return { ok: true };
});
