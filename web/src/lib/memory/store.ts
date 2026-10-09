// Long-term memory: one row per durable fact, searched by meaning (NIM
// embeddings) blended with keywords, importance and recent use.
import { embed } from "../ai/providers.ts";
import { env } from "../env.ts";
import type { Supa } from "../supabase/server.ts";

export const KINDS = ["identity", "preference", "person", "project", "goal", "routine", "event", "fact"] as const;
export type Kind = (typeof KINDS)[number];
export type Memory = { id: string; content: string; kind: Kind; importance: number; confidence: number; source: string };
export type NewMemory = { content: string; kind?: string; importance?: number; confidence?: number; source?: string };

const vec = (v: number[] | undefined) => (v ? JSON.stringify(v) : null);

export function cleanKind(k: unknown): Kind {
  return (KINDS as readonly string[]).includes(String(k)) ? (k as Kind) : "fact";
}

const clampImportance = (n: unknown) => Math.max(1, Math.min(5, Math.round(Number(n) || 3)));

export async function recall(sb: Supa, query: string, limit = 8, touch = true): Promise<Memory[]> {
  const q = query.trim().slice(0, 1000);
  if (!q) return [];
  const [embedding] = (await embed([q], "query")) ?? [];
  const { data, error } = await sb.rpc("match_memories", {
    p_query: q, p_embedding: vec(embedding), p_model: embedding ? env.embedModel() : null, p_limit: limit,
  });
  if (error) {
    console.warn("[memory] recall failed:", error.message);
    return [];
  }
  const rows = (data || []) as Memory[];
  if (touch && rows.length) {
    // Used memories rank higher for a while; failure here is harmless.
    void sb.rpc("touch_memories", { p_ids: rows.map((r) => r.id) }).then(() => undefined, () => undefined);
  }
  return rows;
}

// The always-present profile: the most important things, regardless of topic.
export async function core(sb: Supa, limit = 30): Promise<Memory[]> {
  const { data } = await sb.from("memories")
    .select("id, content, kind, importance, confidence, source")
    .gte("importance", 4)
    .order("importance", { ascending: false })
    .order("use_count", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  return (data || []) as Memory[];
}

export async function addMemories(sb: Supa, items: NewMemory[]): Promise<number> {
  const rows = items
    .map((m) => ({ ...m, content: String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 1000) }))
    .filter((m) => m.content.length >= 3);
  if (!rows.length) return 0;
  let added = 0;
  for (let i = 0; i < rows.length; i += 48) {
    const batch = rows.slice(i, i + 48);
    const vectors = await embed(batch.map((m) => m.content), "passage");
    const { error, count } = await sb.from("memories").insert(
      batch.map((m, j) => ({
        content: m.content,
        kind: cleanKind(m.kind),
        importance: clampImportance(m.importance),
        confidence: Math.max(0, Math.min(1, Number(m.confidence ?? 0.9))),
        source: String(m.source || "chat").slice(0, 40),
        embedding: vec(vectors?.[j]),
        embed_model: vectors?.[j] ? env.embedModel() : null,
      })),
      { count: "exact" },
    );
    if (error) throw new Error(error.message);
    added += count ?? batch.length;
  }
  return added;
}

export async function updateMemory(sb: Supa, id: string, patch: { content?: string; kind?: string; importance?: number }) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.content !== undefined) {
    const content = String(patch.content).replace(/\s+/g, " ").trim().slice(0, 1000);
    if (content.length < 3) throw new Error("Memory text is too short.");
    const [v] = (await embed([content], "passage")) ?? [];
    Object.assign(row, { content, embedding: vec(v), embed_model: v ? env.embedModel() : null, confidence: 0.95 });
  }
  if (patch.kind !== undefined) row.kind = cleanKind(patch.kind);
  if (patch.importance !== undefined) row.importance = clampImportance(patch.importance);
  const { error } = await sb.from("memories").update(row).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteMemory(sb: Supa, id: string) {
  const { error } = await sb.from("memories").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// Rows saved while embeddings were unavailable (or under an older model) get
// their vectors later, a batch at a time.
export async function backfillEmbeddings(sb: Supa, max = 48) {
  const model = env.embedModel();
  const { data } = await sb.from("memories").select("id, content")
    .or(`embed_model.is.null,embed_model.neq."${model}"`).limit(max);
  if (!data?.length) return;
  const vectors = await embed(data.map((d) => d.content), "passage");
  if (!vectors) return;
  await Promise.all(data.map((d, i) =>
    sb.from("memories").update({ embedding: vec(vectors[i]), embed_model: model }).eq("id", d.id)));
}
