import { NextResponse } from "next/server";
import { readJson, requireOwner } from "@/lib/auth.ts";

export const runtime = "nodejs";

// Browser crashes, written to the server log so they can be read in Vercel > Logs.
export async function POST(req: Request) {
  try {
    await requireOwner();
    const b = await readJson<Record<string, unknown>>(req, 10_000);
    console.error("[client-error]", JSON.stringify({
      where: String(b.where || "").slice(0, 40), message: String(b.message || "").slice(0, 500),
      url: String(b.url || "").slice(0, 100), agent: String(b.agent || "").slice(0, 200), stack: String(b.stack || "").slice(0, 3000),
    }));
  } catch {
    // never fail loudly for a report
  }
  return NextResponse.json({ ok: true });
}
