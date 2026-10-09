// The model behind Jarvis: NVIDIA NIM first, Ollama Cloud when NIM fails.
// Both speak the OpenAI chat-completions protocol, so one client covers both.
//
// Failover rule: a provider that fails before producing any output is skipped
// for the rest of the turn and the next one answers. A failure after text has
// already streamed is not retried, because that text has been shown to the user.
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { env } from "../env.ts";
import { ToolTextGate } from "./toolText.ts";

export type ProviderId = "nvidia" | "ollama";
export type Message = ChatCompletionMessageParam;
export type ToolSpec = ChatCompletionTool;
export type ToolCall = { id: string; name: string; arguments: string };
export type Completion = { text: string; toolCalls: ToolCall[]; provider: ProviderId };

type Provider = { id: ProviderId; label: string; model: string; client: OpenAI };

export function providers(): Provider[] {
  const out: Provider[] = [];
  if (env.nvidiaKey()) {
    out.push({
      id: "nvidia", label: "NVIDIA NIM", model: env.nvidiaModel(),
      client: new OpenAI({ apiKey: env.nvidiaKey(), baseURL: "https://integrate.api.nvidia.com/v1", maxRetries: 0 }),
    });
  }
  if (env.ollamaKey()) {
    out.push({
      id: "ollama", label: "Ollama Cloud", model: env.ollamaModel(),
      client: new OpenAI({ apiKey: env.ollamaKey(), baseURL: "https://ollama.com/v1", maxRetries: 0 }),
    });
  }
  return out;
}

export function providerSummary() {
  return providers().map((p, i) => ({ id: p.id, label: p.label, model: p.model, role: i === 0 ? "primary" : "fallback" }));
}

// Remembers, per server instance, which provider just failed so the next few
// turns go straight to the fallback instead of waiting on a dead endpoint.
const benched = new Map<ProviderId, number>();
const BENCH_MS = 60_000;

function order(list: Provider[]): Provider[] {
  const now = Date.now();
  const ok = list.filter((p) => (benched.get(p.id) || 0) < now);
  const bad = list.filter((p) => (benched.get(p.id) || 0) >= now);
  return [...ok, ...bad];
}

class StreamStarted extends Error {}

// One streamed completion. onText receives text as it arrives.
export async function complete(opts: {
  messages: Message[];
  tools?: ToolSpec[];
  onText?: (delta: string) => void;
  onProvider?: (id: ProviderId) => void;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}): Promise<Completion> {
  const list = order(providers());
  if (!list.length) throw new Error("No AI provider configured. Set NVIDIA_API_KEY or OLLAMA_API_KEY.");
  let lastError: unknown;
  for (const p of list) {
    try {
      const out = await streamOnce(p, opts);
      benched.delete(p.id);
      return out;
    } catch (err) {
      if (err instanceof StreamStarted) throw err.cause ?? err;
      if (opts.signal?.aborted) throw err;
      lastError = err;
      benched.set(p.id, Date.now() + BENCH_MS);
      console.warn(`[ai] ${p.label} failed, trying the next provider:`, describe(err));
    }
  }
  throw new Error(`Every AI provider failed. Last error: ${describe(lastError)}`);
}

function describe(err: unknown): string {
  if (err instanceof OpenAI.APIError) return `${err.status ?? ""} ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

async function streamOnce(p: Provider, opts: Parameters<typeof complete>[0]): Promise<Completion> {
  // Abort if the provider goes quiet: 45 s to the first chunk, 30 s between chunks.
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(new Error(`${p.label} timed out`)), 45_000);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`${p.label} stalled`)), 30_000);
  };
  const signal = opts.signal ? AbortSignal.any([opts.signal, idle.signal]) : idle.signal;

  let text = "";
  let started = false;
  const calls = new Map<number, ToolCall>();
  const gate = new ToolTextGate();
  const show = (piece: string) => {
    if (!piece) return;
    if (!started) {
      started = true;
      opts.onProvider?.(p.id);
    }
    text += piece;
    opts.onText?.(piece);
  };
  try {
    const stream = await p.client.chat.completions.create(
      {
        model: p.model,
        messages: opts.messages,
        tools: opts.tools?.length ? opts.tools : undefined,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 4096,
        stream: true,
      },
      { signal },
    );
    for await (const chunk of stream) {
      bump();
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) show(gate.push(delta.content));
      for (const tc of delta.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        calls.set(tc.index, slot);
      }
    }
  } catch (err) {
    if (started) {
      const wrapped = new StreamStarted("stream interrupted");
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const leftover = gate.finish();
  show(leftover.rest);
  if (!started) opts.onProvider?.(p.id);
  const toolCalls = [...calls.values()]
    .filter((c) => c.name)
    .map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }))
    .concat(opts.tools?.length ? leftover.calls : []);
  if (!text.trim() && !toolCalls.length) throw new Error(`${p.label} returned an empty answer`);
  return { text, toolCalls, provider: p.id };
}

// A plain, non-streamed completion for background jobs (memory upkeep).
export async function completeText(messages: Message[], maxTokens = 2500): Promise<string> {
  const out = await complete({ messages, maxTokens, temperature: 0.1 });
  return out.text;
}

// Embeddings from NIM. Returns null when unavailable; memory then falls back
// to full-text search, so a missing or changed embedding model never breaks chat.
export async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][] | null> {
  if (!env.nvidiaKey() || !texts.length) return null;
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.nvidiaKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.embedModel(), input: texts.map((t) => t.slice(0, 2000)), input_type: kind, truncate: "END" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn("[ai] embeddings unavailable:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (err) {
    console.warn("[ai] embeddings failed:", describe(err));
    return null;
  }
}
