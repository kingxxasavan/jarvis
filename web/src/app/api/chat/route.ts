import { NextResponse } from "next/server";
import { runTurn } from "@/lib/ai/brain.ts";
import type { StreamEvent } from "@/lib/ai/events.ts";
import { HttpError, readJson, requireOwner } from "@/lib/auth.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

// Streams one turn as newline-delimited JSON events (see lib/ai/events.ts).
export async function POST(req: Request) {
  let owner;
  try {
    owner = await requireOwner();
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }
  const body = await readJson<{ message?: string; conversationId?: string }>(req, 40_000).catch(() => null);
  const message = String(body?.message || "").trim();
  if (!message) return NextResponse.json({ error: "Say something first." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const emit = (e: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false;
        }
      };
      try {
        await runTurn(owner, { message, conversationId: body?.conversationId }, emit, req.signal);
      } catch (err) {
        if (!req.signal.aborted) {
          console.error("[chat]", err);
          emit({ t: "error", message: err instanceof Error ? err.message : "Something went wrong." });
        }
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // already closed by a disconnect
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
