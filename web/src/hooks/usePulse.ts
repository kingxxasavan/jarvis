"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, store } from "@/lib/client/api";

export type Pulse = {
  providers: { id: string; label: string; model: string; role: string }[];
  devices: { id: string; name: string; online: boolean; platform: string }[];
  memoryCount: number;
  toolCount: number;
  arkia: { connected: boolean; error?: string };
  messages: { id: string; conversation: string; from: string; text: string; at: number }[];
  today: { key: string; title: string; type: string; when: string }[];
  reminders: { key: string; title: string; type: string; when: string }[];
  overdue: number;
  jobs: { id: string; title: string; tool: string; status: string; updated_at: string }[];
  brief?: string;
};

export type Alert = { id: string; kind: "message" | "reminder"; title: string; body: string };

const SEEN_KEY = "jarvis.notified";

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(store.get(SEEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

// Polls /api/pulse every 30 s and reports messages and reminders that have not
// been announced yet. Whatever is already waiting at first load is covered by
// the greeting instead of a burst of alerts.
export function usePulse(onAlerts: (alerts: Alert[]) => void) {
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [brief, setBrief] = useState("");
  const first = useRef(true);
  const cb = useRef(onAlerts);
  cb.current = onAlerts;

  const refresh = useCallback(async () => {
    try {
      const p = await api<Pulse>(`/api/pulse${first.current ? "?brief=1" : ""}`);
      setPulse(p);
      if (p.brief) setBrief(p.brief);
      const seen = loadSeen();
      const fresh: Alert[] = [];
      for (const m of p.messages) {
        const id = `m:${m.id}`;
        if (!seen.has(id)) fresh.push({ id, kind: "message", title: `${m.from}${m.conversation !== m.from ? " in " + m.conversation : ""}`, body: m.text });
      }
      for (const r of p.reminders) {
        const id = `r:${r.key}`;
        if (!seen.has(id)) fresh.push({ id, kind: "reminder", title: r.type === "task" ? "Task due" : "Coming up", body: `${r.title}, ${r.when}` });
      }
      fresh.forEach((a) => seen.add(a.id));
      store.set(SEEN_KEY, JSON.stringify([...seen].slice(-400)));
      const announce = first.current ? fresh.filter((a) => a.kind === "reminder") : fresh;
      if (announce.length) cb.current(announce);
      first.current = false;
    } catch {
      // Offline for a moment; the next tick tries again.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 30_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { pulse, brief, refresh };
}
