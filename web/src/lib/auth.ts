// The owner gate for API routes. The proxy already redirects strangers away
// from pages; this repeats the check where data is actually touched.
import { NextResponse } from "next/server";
import { env } from "./env.ts";
import { serverClient, type Supa } from "./supabase/server.ts";

export type Owner = { sb: Supa; userId: string; email: string; aal: string };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireOwner(opts: { strongAuth?: boolean } = {}): Promise<Owner> {
  const sb = await serverClient();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Sign in first.");
  const email = (data.user.email || "").toLowerCase();
  if (email !== env.ownerEmail()) throw new HttpError(403, "This JARVIS belongs to someone else.");
  const { data: level } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  const aal = level?.currentLevel || "aal1";
  if (level?.nextLevel === "aal2" && aal !== "aal2") throw new HttpError(401, "Two-factor check required.");
  if (opts.strongAuth && aal !== "aal2") {
    throw new HttpError(403, "Turn on two-factor authentication in Settings first. Device control requires it.");
  }
  return { sb, userId: data.user.id, email, aal };
}

// Wraps a route handler: owner check, JSON errors, never a stack trace.
export function route<T>(handler: (owner: Owner, req: Request) => Promise<T>, opts: { strongAuth?: boolean } = {}) {
  return async (req: Request) => {
    try {
      const owner = await requireOwner(opts);
      const out = await handler(owner, req);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : "Something went wrong.";
      if (status === 500) console.error(err);
      return NextResponse.json({ error: message }, { status });
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 1_000_000): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large.");
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}
