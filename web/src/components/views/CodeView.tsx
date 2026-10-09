"use client";
// Code: talk to Claude Code on the laptop directly. Pick a folder (JARVIS's own
// code, a project, or any path), type what to change, and watch it work. Each
// follow-up continues the same Claude Code conversation until "New chat".
import { useCallback, useEffect, useRef, useState } from "react";
import { api, store, timeAgo } from "@/lib/client/api";
import { Icon } from "../Icon";

type Notify = (title: string, body?: string, tone?: "ok" | "err") => void;
type Folder = { label: string; path: string };
type Run = { job: string; text: string; at: number };
type Event = { id: number; kind: string; text: string };
type Job = { status: string; error: string | null; result: { summary?: string; session_id?: string; files_changed?: string[]; commit?: string; pushed?: boolean } | null };

const STATE_KEY = "jarvis.code";
const FINAL = new Set(["done", "failed", "cancelled", "rejected"]);

type Saved = { folder: string; agent: string; runs: Run[]; session: string; commit: boolean; push: boolean };

function load(): Saved {
  try {
    return { folder: "jarvis", agent: "claude", runs: [], session: "", commit: true, push: false, ...JSON.parse(store.get(STATE_KEY) || "{}") };
  } catch {
    return { folder: "jarvis", agent: "claude", runs: [], session: "", commit: true, push: false };
  }
}

function RunCard({ run, onSession, onCancel }: { run: Run; onSession: (id: string) => void; onCancel: (id: string) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [open, setOpen] = useState(true);
  const after = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const sessionCb = useRef(onSession);
  sessionCb.current = onSession;

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const res = await api<{ job: Job; events: Event[] }>(`/api/tasks?id=${run.job}&after=${after.current}`);
        if (stop) return;
        if (res.events.length) {
          after.current = res.events[res.events.length - 1].id;
          setEvents((e) => [...e, ...res.events].slice(-600));
        }
        setJob(res.job);
        if (FINAL.has(res.job.status)) {
          if (res.job.result?.session_id) sessionCb.current(res.job.result.session_id);
          setOpen(false);
          return;
        }
      } catch {
        // try again on the next tick
      }
      if (!stop) timer = window.setTimeout(tick, document.hidden ? 6000 : 1500);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [run.job]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events.length]);

  const status = job?.status || "queued";
  const running = !FINAL.has(status);
  const r = job?.result;
  return (
    <div className="code-run">
      <div className="msg user"><div className="bubble">{run.text}</div></div>
      <div className={`code-out ${status}`}>
        <div className="row">
          {running ? <i className="spin" /> : <Icon name={status === "done" ? "check" : "close"} size={14} />}
          <span className="grow small muted">{running ? (status === "queued" ? "Waiting for the laptop..." : "Claude Code is working...") : status === "done" ? "Finished" : status} · {timeAgo(run.at)}</span>
          {events.length > 0 && <button className="btn small ghost" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} log ({events.length})</button>}
          {running && <button className="btn small ghost" onClick={() => onCancel(run.job)}>Stop</button>}
        </div>
        {open && events.length > 0 && (
          <div className="log" ref={box}>
            {events.map((e) => <div key={e.id} className={`log-line ${e.kind}`}>{e.text}</div>)}
          </div>
        )}
        {r?.summary && <div className="bubble code-summary">{r.summary}</div>}
        {job?.error && <p className="err small">{job.error}</p>}
        {r?.files_changed && r.files_changed.length > 0 && (
          <details>
            <summary className="small">{r.files_changed.length} files changed{r.commit ? `, commit ${r.commit}` : ""}{r.pushed ? ", pushed" : ""}</summary>
            <pre className="code">{r.files_changed.join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

export function CodeView({ notify }: { notify: Notify }) {
  const [state, setState] = useState<Saved>(load);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [device, setDevice] = useState("");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const save = useCallback((patch: Partial<Saved>) => {
    setState((s) => {
      const next = { ...s, ...patch };
      store.set(STATE_KEY, JSON.stringify({ ...next, runs: next.runs.slice(-30) }));
      return next;
    });
  }, []);

  useEffect(() => {
    api<{ device: { name: string }; folders: Folder[]; agents: string[] }>("/api/code")
      .then((r) => {
        setFolders(r.folders);
        setAgents(r.agents);
        setDevice(r.device.name);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [state.runs.length]);

  const send = async () => {
    const instructions = text.trim();
    if (!instructions || sending) return;
    setSending(true);
    try {
      const r = await api<{ job: string; device: string }>("/api/code", {
        method: "POST",
        json: { instructions, folder: state.folder, agent: state.agent, resume: state.session, commit: state.commit, push: state.push },
      });
      setText("");
      save({ runs: [...state.runs, { job: r.job, text: instructions, at: Date.now() }] });
    } catch (err) {
      notify("Could not start Claude Code", (err as Error).message, "err");
    } finally {
      setSending(false);
    }
  };

  const restart = async (update: boolean) => {
    if (update && !confirm("Pull the latest JARVIS code from GitHub onto the laptop and restart the agent?")) return;
    try {
      await api("/api/code", { method: "POST", json: { restart: true, update } });
      notify(update ? "Updating the laptop" : "Restarting the agent", "It is back in about 20 seconds.", "ok");
    } catch (err) {
      notify("Could not restart", (err as Error).message, "err");
    }
  };

  const cancel = async (id: string) => {
    await api("/api/tasks", { method: "POST", json: { id, action: "cancel" } }).catch((err) => notify("Could not stop it", (err as Error).message, "err"));
  };

  const known = folders.find((f) => f.path === state.folder || (state.folder === "jarvis" && f.label.startsWith("JARVIS")));

  return (
    <div className="view code-view">
      <section className="panel code-head">
        <div className="row wrap">
          <h2 className="grow"><Icon name="code" /> Claude Code{device ? ` on ${device}` : ""}</h2>
          <button className="btn small ghost" onClick={() => restart(false)} title="Restart the laptop agent so code changes load">Restart agent</button>
          <button className="btn small ghost" onClick={() => restart(true)} title="git pull the JARVIS repo on the laptop, then restart">Update from GitHub</button>
        </div>
        {error && <p className="err small">{error}</p>}
        <div className="row wrap code-opts">
          <select value={known ? known.path : "__custom"} onChange={(e) => {
            if (e.target.value !== "__custom") save({ folder: e.target.value, session: "", runs: [] });
          }} aria-label="Folder">
            {state.folder === "jarvis" && !known && <option value="jarvis">JARVIS (this app&apos;s code)</option>}
            {folders.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
            <option value="__custom">Another folder...</option>
          </select>
          <input className="grow" value={state.folder} onChange={(e) => save({ folder: e.target.value, session: "" })}
            placeholder="Folder, e.g. Desktop/School/site" aria-label="Folder path" spellCheck={false} />
          <select value={state.agent} onChange={(e) => save({ agent: e.target.value, session: "" })} aria-label="Coding agent">
            <option value="claude">Claude Code</option>
            <option value="codex" disabled={agents.length > 0 && !agents.includes("codex")}>Codex</option>
          </select>
          <label className="small row"><input type="checkbox" checked={state.commit} onChange={(e) => save({ commit: e.target.checked })} /> Commit</label>
          <label className="small row"><input type="checkbox" checked={state.push} onChange={(e) => save({ push: e.target.checked })} /> Push to GitHub</label>
          <button className="btn small" onClick={() => save({ session: "", runs: [] })} title="Start a fresh Claude Code conversation"><Icon name="plus" size={14} /> New chat</button>
        </div>
        <p className="muted small">
          Runs as you, with no approval step. It can edit files and run builds, tests and git in this folder. For JARVIS itself:
          tick Push so the website redeploys, then press Restart agent (or Update from GitHub) to load laptop changes.
        </p>
      </section>
      <section className="code-thread">
        {!state.runs.length && <p className="empty">Tell Claude Code what to build or fix. For example: &quot;the Apps tab scrolls slowly on my phone, find out why and fix it&quot;.</p>}
        {state.runs.map((r) => <RunCard key={r.job} run={r} onSession={(s) => save({ session: s })} onCancel={cancel} />)}
        <div ref={end} />
      </section>
      <div className="composer code-composer">
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={state.session ? "Follow up (same conversation)..." : "What should Claude Code do?"}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} aria-label="Instructions for Claude Code" />
        <button className="send" onClick={send} disabled={!text.trim() || sending} title="Send (Ctrl+Enter)" aria-label="Send">
          {sending ? <i className="spin" /> : <Icon name="send" size={20} />}
        </button>
      </div>
    </div>
  );
}
