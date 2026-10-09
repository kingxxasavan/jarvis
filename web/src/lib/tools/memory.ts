// Explicit memory commands. Most remembering happens on its own after each
// reply (see memory/adapt.ts); these cover "remember that..." and "forget...".
import { addMemories, deleteMemory, KINDS, recall } from "../memory/store.ts";
import { num, str, type Tool } from "./types.ts";

export const memoryTools: Tool[] = [
  {
    name: "remember",
    description: "Save something Sir explicitly asked you to remember, as one clear third-person sentence with absolute dates.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        kind: { type: "string", enum: [...KINDS] },
        importance: { type: "integer", description: "1-5, default 3" },
      },
      required: ["content"],
    },
    label: () => "Saving to memory",
    async run(a, ctx) {
      const content = str(a.content, 1000);
      if (content.length < 3) throw new Error("Nothing to remember.");
      await addMemories(ctx.sb, [{ content, kind: str(a.kind), importance: num(a.importance, 3, 1, 5), source: "chat" }]);
      return { saved: content };
    },
  },
  {
    name: "recall_memories",
    description: "Search long-term memory beyond what is already in your context: people, past decisions, project history, preferences.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", description: "1-20, default 8" } },
      required: ["query"],
    },
    label: (a) => `Recalling ${str(a.query, 50)}`,
    async run(a, ctx) {
      const rows = await recall(ctx.sb, str(a.query, 500), num(a.limit, 8, 1, 20));
      return { memories: rows.map((m) => ({ id: m.id, content: m.content, kind: m.kind, confidence: m.confidence })) };
    },
  },
  {
    name: "forget_memory",
    description: "Delete one memory by id when Sir asks you to forget something. Find the id with recall_memories first.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    label: () => "Forgetting a memory",
    async run(a, ctx) {
      const id = str(a.id, 60);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That is not a memory id. Use recall_memories to find it.");
      await deleteMemory(ctx.sb, id);
      return { deleted: id };
    },
  },
];
