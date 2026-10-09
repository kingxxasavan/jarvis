import { HttpError, readJson, route } from "@/lib/auth.ts";
import { addMemories, deleteMemory, recall, updateMemory } from "@/lib/memory/store.ts";

export const runtime = "nodejs";

// List (newest first) or search (by meaning) memories.
export const GET = route(async ({ sb }, req) => {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (q) return { memories: await recall(sb, q, 30, false) };
  const { data, error } = await sb.from("memories")
    .select("id, content, kind, importance, confidence, source, use_count, updated_at")
    .order("updated_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return { memories: data };
});

export const POST = route(async ({ sb }, req) => {
  const b = await readJson<{ content?: string; kind?: string; importance?: number }>(req);
  if (!b.content?.trim()) throw new HttpError(400, "Write the memory first.");
  await addMemories(sb, [{ content: b.content, kind: b.kind, importance: b.importance, source: "manual", confidence: 1 }]);
  return { ok: true };
});

export const PATCH = route(async ({ sb }, req) => {
  const b = await readJson<{ id?: string; content?: string; kind?: string; importance?: number }>(req);
  if (!b.id) throw new HttpError(400, "Which memory?");
  await updateMemory(sb, b.id, b);
  return { ok: true };
});

export const DELETE = route(async ({ sb }, req) => {
  const id = new URL(req.url).searchParams.get("id");
  if (id === "all") {
    const { error } = await sb.from("memories").delete().not("id", "is", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  }
  if (!id) throw new HttpError(400, "Which memory?");
  await deleteMemory(sb, id);
  return { ok: true };
});
