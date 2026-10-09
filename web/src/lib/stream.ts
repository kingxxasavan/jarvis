// Short-lived passes for a device's stream server. The device publishes a fresh
// secret every time its agent starts; the server signs passes with it, and the
// agent checks them (agent/jarvis_agent/stream/auth.py uses the same format).
import { createHmac, randomBytes } from "node:crypto";

const b64 = (buf: Buffer) => buf.toString("base64url");

export function mintPass(secret: string, scope: "stream" | "files", ttlSeconds = 600): string {
  const payload = b64(Buffer.from(JSON.stringify({ s: scope, e: Math.floor(Date.now() / 1000) + ttlSeconds, n: randomBytes(6).toString("hex") })));
  const mac = b64(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${mac}`;
}
