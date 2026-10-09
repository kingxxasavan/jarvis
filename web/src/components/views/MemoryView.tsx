"use client";
import { useCallback, useEffect, useState } from "react";
import { api, timeAgo } from "@/lib/client/api";
import { Icon } from "../Icon";

type Memory = {
  id: string; content: string; kind: string; importance: number; confidence: number; source: string;
  use_count?: number; updated_at?: string;
};

const KINDS = ["all", "identity", "preference", "person", "project", "goal", "routine", "event", "fact"];
const SOURCE: Record<string, string> = { chat: "learned in chat", manual: "added by you", about_me: "imported profile" };

export function MemoryView({ notify }: { notify: (title: string, body?: string, tone?: "ok" | "err") => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (q = "") => {
    setLoading(true);
    try {
      const { memories } = await api<{ memories: Memory[] }>(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      setMemories(memories);
    } catch (err) {
      notify("Could not load memory", (err as Error).message, "err");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    try {
      await api("/api/memory", { method: "PATCH", json: { id: editing.id, content: editing.text } });
      setEditing(null);
      await load(query);
    } catch (err) {
      notify("Not saved", (err as Error).message, "err");
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/memory?id=${id}`, { method: "DELETE" });
      setMemories((m) => m.filter((x) => x.id !== id));
    } catch (err) {
      notify("Not deleted", (err as Error).message, "err");
    }
  };

  const add = async () => {
    if (!draft.trim()) return;
    try {
      await api("/api/memory", { method: "POST", json: { content: draft, kind: kind === "all" ? "fact" : kind, importance: 3 } });
      setDraft("");
      await load(query);
    } catch (err) {
      notify("Not saved", (err as Error).message, "err");
    }
  };

  const shown = memories.filter((m) => kind === "all" || m.kind === kind);

  return (
    <div className="view">
      <section className="panel">
        <div className="row wrap">
          <h2 className="grow">Memory <span className="muted">({memories.length}{query ? " matches" : ""})</span></h2>
          <form className="search" onSubmit={(e) => { e.preventDefault(); void load(query.trim()); }}>
            <Icon name="search" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by meaning" aria-label="Search memory" />
          </form>
        </div>
        <div className="filters">
          {KINDS.map((k) => (
            <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>
        <div className="add-memory">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Teach Jarvis something, e.g. My robotics club meets Tuesdays at 4"
            onKeyDown={(e) => e.key === "Enter" && add()} aria-label="New memory" />
          <button className="btn" onClick={add} disabled={!draft.trim()}><Icon name="plus" size={14} /> Add</button>
        </div>
        {loading ? <p className="empty">Loading...</p> : !shown.length ? (
          <p className="empty">Nothing here yet. Jarvis learns as you talk, or import your profile in Settings.</p>
        ) : (
          <ul className="memories">
            {shown.map((m) => (
              <li key={m.id}>
                <span className={`kind ${m.kind}`}>{m.kind}</span>
                {editing?.id === m.id ? (
                  <div className="grow edit">
                    <textarea value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} rows={2} autoFocus />
                    <div className="row">
                      <button className="btn small primary" onClick={save}>Save</button>
                      <button className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="grow">
                    <div>{m.content}</div>
                    <div className="muted small">
                      {SOURCE[m.source] || m.source}
                      {m.confidence < 0.8 ? " · unconfirmed" : ""}
                      {m.updated_at ? ` · ${timeAgo(m.updated_at)}` : ""}
                      {" · "}{"●".repeat(m.importance)}
                    </div>
                  </div>
                )}
                {editing?.id !== m.id && (
                  <span className="row-actions">
                    <button className="icon-btn" onClick={() => setEditing({ id: m.id, text: m.content })} aria-label="Edit"><Icon name="edit" size={14} /></button>
                    <button className="icon-btn" onClick={() => remove(m.id)} aria-label="Forget"><Icon name="trash" size={14} /></button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
