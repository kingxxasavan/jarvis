import { connectWithPassword, connectWithRefreshToken, connection, disconnect } from "@/lib/arkia/client.ts";
import { HttpError, readJson, route } from "@/lib/auth.ts";

export const runtime = "nodejs";

export const GET = route(async ({ sb }) => ({ connection: await connection(sb) }));

// Either { email, password } (exchanged once, never stored) or
// { refreshToken, email } from the browser's Google sign-in to arkia.
export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ email?: string; password?: string; refreshToken?: string }>(req);
  const email = String(b.email || "").trim();
  if (b.refreshToken) return { connection: await connectWithRefreshToken(sb, String(b.refreshToken), email) };
  if (!email || !b.password) throw new HttpError(400, "Enter your arkia email and password.");
  return { connection: await connectWithPassword(sb, email, String(b.password)) };
});

export const DELETE = route(async ({ sb, userId }) => {
  await disconnect(sb, userId);
  return { ok: true };
});
