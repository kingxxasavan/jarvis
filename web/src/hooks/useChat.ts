"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobRef, StreamEvent, VideoRef } from "@/lib/ai/events";
import { api, store } from "@/lib/client/api";

export type ToolChip = { id: string; name: string; label: string; state: "start" | "done" | "error"; note?: string };
export type ChatItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  jobs: JobRef[];
  play?: VideoRef;
  provider?: string;
  pending?: boolean;
  error?: string;
};

type Saved = { id: string; role: "user" | "assistant"; content: string | null; meta?: { tools?: (Omit<ToolChip, "id"> & { id?: string })[]; jobs?: JobRef[]; play?: VideoRef; provider?: string } };

const CONV_KEY = "jarvis.conversation";
const uid = () => Math.random().toString(36).slice(2);

export function useChat(handlers: {
  onPlay?: (v: VideoRef) => void;
  onJob?: (j: JobRef) => void;
  onTool?: (chip: ToolChip) => void;
  onReply?: (text: string) => void;
  onProvider?: (id: string) => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const conversation = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    const saved = store.get(CONV_KEY);
    if (!saved) return;
    api<{ conversation: { id: string } | null; messages: Saved[] }>(`/api/conversations?id=${encodeURIComponent(saved)}`)
      .then(({ conversation: c, messages }) => {
        if (!c) return store.set(CONV_KEY, null);
        conversation.current = c.id;
        setItems(messages.map((m) => ({
          id: m.id, role: m.role, text: m.content || "", jobs: m.meta?.jobs || [],
          // saved tool notes carry no id; the list needs one per chip
          tools: (m.meta?.tools || []).map((c, i) => ({ ...c, id: c.id || `${m.id}-${i}` })),
          play: m.meta?.play, provider: m.meta?.provider,
        })));
      })
      .catch(() => undefined);
  }, []);

  const patch = (id: string, fn: (it: ChatItem) => ChatItem) =>
    setItems((list) => list.map((it) => (it.id === id ? fn(it) : it)));

  const send = useCallback(async (message: string) => {
    const text = message.trim();
    if (!text || abort.current) return;
    const replyId = uid();
    setItems((list) => [
      ...list,
      { id: uid(), role: "user", text, tools: [], jobs: [] },
      { id: replyId, role: "assistant", text: "", tools: [], jobs: [], pending: true },
    ]);
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    let reply = "";
    let finished = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: conversation.current }),
        signal: ctrl.signal,
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handle = (e: StreamEvent) => {
        switch (e.t) {
          case "conv":
            conversation.current = e.id;
            store.set(CONV_KEY, e.id);
            break;
          case "provider":
            patch(replyId, (it) => ({ ...it, provider: e.id }));
            h.current.onProvider?.(e.id);
            break;
          case "text":
            reply += e.d;
            patch(replyId, (it) => ({ ...it, text: it.text + e.d }));
            break;
          case "tool": {
            const chip: ToolChip = { id: e.id, name: e.name, label: e.label, state: e.state, note: e.note };
            patch(replyId, (it) => ({ ...it, tools: [...it.tools.filter((c) => c.id !== e.id), chip] }));
            h.current.onTool?.(chip);
            break;
          }
          case "play":
            patch(replyId, (it) => ({ ...it, play: e.video }));
            h.current.onPlay?.(e.video);
            break;
          case "job":
            patch(replyId, (it) => ({ ...it, jobs: [...it.jobs, e.job] }));
            h.current.onJob?.(e.job);
            break;
          case "error":
            patch(replyId, (it) => ({ ...it, error: e.message }));
            break;
          case "done":
            finished = true;
            patch(replyId, (it) => ({ ...it, pending: false }));
            setBusy(false);
            abort.current = null;
            h.current.onReply?.(reply);
            break;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            handle(JSON.parse(line) as StreamEvent);
          } catch {
            // a malformed line is skipped rather than ending the turn
          }
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        patch(replyId, (it) => ({ ...it, error: err instanceof Error ? err.message : "Connection lost." }));
      }
    } finally {
      if (!finished) {
        patch(replyId, (it) => ({ ...it, pending: false, text: it.text || (ctrl.signal.aborted ? "Stopped." : it.text) }));
        setBusy(false);
        abort.current = null;
      }
    }
  }, []);

  const stop = useCallback(() => abort.current?.abort(), []);

  const reset = useCallback(() => {
    abort.current?.abort();
    conversation.current = null;
    store.set(CONV_KEY, null);
    setItems([]);
  }, []);

  return { items, busy, send, stop, reset };
}
