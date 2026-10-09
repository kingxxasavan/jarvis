// One conversational turn: gather context, let the model call tools until the
// job is done, stream everything to the browser, save the exchange, and then
// let memory learn from it.
import { connection as arkiaConnection } from "../arkia/client.ts";
import type { Owner } from "../auth.ts";
import { listDevices } from "../devices.ts";
import { env } from "../env.ts";
import { adaptMemory } from "../memory/adapt.ts";
import { core, recall } from "../memory/store.ts";
import { describeNow } from "../time.ts";
import { toolbox } from "../tools/index.ts";
import type { ToolContext } from "../tools/types.ts";
import type { JobRef, StreamEvent, VideoRef } from "./events.ts";
import { systemPrompt } from "./persona.ts";
import { complete, type Message, type ToolCall } from "./providers.ts";

const MAX_ROUNDS = 8;
const HISTORY = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ToolNote = { name: string; label: string; state: "done" | "error"; note?: string };

async function openConversation(owner: Owner, wanted: string | undefined, firstLine: string): Promise<string> {
  if (wanted && UUID.test(wanted)) {
    const { data } = await owner.sb.from("conversations").select("id").eq("id", wanted).maybeSingle();
    if (data) return data.id as string;
  }
  const title = firstLine.replace(/\s+/g, " ").trim().slice(0, 60) || "Conversation";
  const { data, error } = await owner.sb.from("conversations").insert({ title }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function loadHistory(owner: Owner, conversationId: string): Promise<Message[]> {
  const { data } = await owner.sb.from("messages").select("role, content")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(HISTORY);
  return ((data || []) as { role: "user" | "assistant"; content: string }[])
    .reverse()
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
}

export async function runTurn(
  owner: Owner,
  input: { message: string; conversationId?: string },
  emit: (e: StreamEvent) => void,
  signal: AbortSignal,
) {
  const sb = owner.sb;
  const message = input.message.trim().slice(0, 8000);
  const tz = env.timezone();
  const ownerName = env.ownerName();
  const now = describeNow(tz);

  const conversationId = await openConversation(owner, input.conversationId, message);
  emit({ t: "conv", id: conversationId });

  const [history, coreMemories, relevant, devices, arkia] = await Promise.all([
    loadHistory(owner, conversationId),
    core(sb),
    recall(sb, message, 8),
    listDevices(sb),
    arkiaConnection(sb).catch(() => null),
  ]);
  await sb.from("messages").insert({ conversation_id: conversationId, role: "user", content: message });

  const box = toolbox(devices, { arkia: !!arkia });
  const messages: Message[] = [
    { role: "system", content: systemPrompt({ ownerName, now, core: coreMemories, relevant, devices, arkiaConnected: !!arkia }) },
    ...history,
    { role: "user", content: message },
  ];

  let text = "";
  let needsBreak = false;
  let provider = "";
  let play: VideoRef | undefined;
  const jobs: JobRef[] = [];
  const notes: ToolNote[] = [];

  const ctx: ToolContext = {
    sb, ownerId: owner.userId, ownerName, tz, conversationId, devices, signal,
    emit: (e) => {
      if (e.t === "play") play = e.video;
      if (e.t === "job") jobs.push(e.job);
      emit(e);
    },
  };

  const runTool = async (call: ToolCall): Promise<string> => {
    const tool = box.byName.get(call.name);
    if (!tool) {
      return JSON.stringify({ error: `There is no tool called ${call.name}.`, available: [...box.byName.keys()] });
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch {
      return JSON.stringify({ error: "The arguments were not valid JSON. Call the tool again with a JSON object." });
    }
    const label = tool.label(args);
    emit({ t: "tool", id: call.id, name: call.name, label, state: "start" });
    try {
      const result = await tool.run(args, ctx);
      const failed = !!result && typeof result === "object" && "error" in result;
      const note = failed ? String((result as { error: unknown }).error) : undefined;
      emit({ t: "tool", id: call.id, name: call.name, label, state: failed ? "error" : "done", note });
      notes.push({ name: call.name, label, state: failed ? "error" : "done", note });
      return JSON.stringify(result ?? { ok: true }).slice(0, 9000);
    } catch (err) {
      const note = err instanceof Error ? err.message : "It failed.";
      emit({ t: "tool", id: call.id, name: call.name, label, state: "error", note });
      notes.push({ name: call.name, label, state: "error", note });
      return JSON.stringify({ error: note });
    }
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // The last round has no tools, so the model must answer with what it has.
    const lastRound = round === MAX_ROUNDS - 1;
    const out = await complete({
      messages,
      tools: lastRound ? undefined : box.specs,
      signal,
      onProvider: (id) => {
        if (id !== provider) {
          provider = id;
          emit({ t: "provider", id });
        }
      },
      onText: (d) => {
        const chunk = needsBreak && text.trim() ? "\n\n" + d : d;
        needsBreak = false;
        text += chunk;
        emit({ t: "text", d: chunk });
      },
    });
    if (!out.toolCalls.length) break;
    messages.push({
      role: "assistant",
      content: out.text || null,
      tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments || "{}" } })),
    });
    const results = await Promise.all(out.toolCalls.map(runTool));
    out.toolCalls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i] }));
    needsBreak = true;
  }

  const { data: saved } = await sb.from("messages").insert({
    conversation_id: conversationId, role: "assistant", content: text.trim(),
    meta: { provider, tools: notes, play, jobs },
  }).select("id").single();
  await sb.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  emit({ t: "done", messageId: saved?.id });

  // Learning happens after the reply is complete, so it never delays it.
  try {
    await adaptMemory(sb, ownerName, message, text, now);
  } catch (err) {
    console.warn("[memory] adapt failed:", err instanceof Error ? err.message : err);
  }
}
