// Adaptive memory. After every exchange a small background pass decides what,
// if anything, is worth keeping: new facts are added, changed facts replace
// the old wording, and facts the owner has contradicted are removed.
import { completeText } from "../ai/providers.ts";
import type { Supa } from "../supabase/server.ts";
import { addMemories, backfillEmbeddings, cleanKind, deleteMemory, recall, updateMemory } from "./store.ts";

type Op =
  | { op: "add"; content: string; kind?: string; importance?: number }
  | { op: "update"; id: string; content: string }
  | { op: "delete"; id: string };

export function parseOps(text: string): Op[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const ops = JSON.parse(text.slice(start, end + 1))?.ops;
    if (!Array.isArray(ops)) return [];
    return ops.filter((o): o is Op =>
      !!o && typeof o === "object" &&
      ((o.op === "add" && typeof o.content === "string") ||
        (o.op === "update" && typeof o.id === "string" && typeof o.content === "string") ||
        (o.op === "delete" && typeof o.id === "string")),
    ).slice(0, 6);
  } catch {
    return [];
  }
}

function instructions(name: string): string {
  return [
    `You maintain JARVIS's long-term memory about ${name}. Decide what from the latest exchange is worth remembering for months.`,
    "",
    `Keep: stable facts about ${name} (school, work, devices, skills), preferences and dislikes, people in their life and how they relate, projects and their status, goals, routines, and important upcoming events with dates.`,
    `Skip: small talk, one-off requests ("play X", "what's the weather"), anything JARVIS said that ${name} did not confirm, and secrets of any kind (passwords, keys, codes, account numbers).`,
    "",
    `Write each memory as one short third-person sentence that stands alone, e.g. "${name}'s friend Maya is their lab partner in chemistry." Use absolute dates, never "tomorrow".`,
    `If the exchange changes or corrects an existing memory, UPDATE that memory by id instead of adding a duplicate. If ${name} says something is no longer true or asks to forget it, DELETE it.`,
    "",
    "Kinds: identity, preference, person, project, goal, routine, event, fact. Importance 1-5 (5 = core to who they are).",
    'Reply with JSON only: {"ops":[{"op":"add","content":"...","kind":"...","importance":3},{"op":"update","id":"...","content":"..."},{"op":"delete","id":"..."}]}',
    'Reply {"ops":[]} when nothing is worth keeping, which is most of the time.',
  ].join("\n");
}

export async function adaptMemory(sb: Supa, ownerName: string, userText: string, assistantText: string, today: string) {
  const said = userText.trim();
  if (said.length < 8) return;
  const related = await recall(sb, said, 12, false);
  const known = new Set(related.map((m) => m.id));
  const existing = related.length
    ? related.map((m) => `- [${m.id}] (${m.kind}) ${m.content}`).join("\n")
    : "(none)";

  const reply = await completeText([
    { role: "system", content: instructions(ownerName) },
    {
      role: "user",
      content: `Today is ${today}.\n\nExisting related memories:\n${existing}\n\nLatest exchange:\n${ownerName}: ${said.slice(0, 3000)}\nJARVIS: ${assistantText.slice(0, 1500)}`,
    },
  ]);

  const ops = parseOps(reply);
  for (const o of ops) {
    if (o.op === "update" && known.has(o.id)) await updateMemory(sb, o.id, { content: o.content });
    if (o.op === "delete" && known.has(o.id)) await deleteMemory(sb, o.id);
  }
  const adds = ops.filter((o): o is Extract<Op, { op: "add" }> => o.op === "add");
  if (adds.length) {
    await addMemories(sb, adds.map((o) => ({ content: o.content, kind: cleanKind(o.kind), importance: o.importance, source: "chat" })));
  }
  await backfillEmbeddings(sb);
}
