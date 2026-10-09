"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, timeAgo } from "@/lib/client/api";
import { Icon } from "../Icon";

type Job = {
  id: string; tool: string; title: string; status: string; error: string | null; result: unknown; args: unknown;
  device: string; created_at: string; finished_at: string | null; long_running: boolean;
};
type Event = { id: number; kind: string; text: string; created_at: string };

const LABEL: Record<string, string> = {
  needs_approval: "Needs approval", queued: "Queued", running: "Running", done: "Done",
  failed: "Failed", cancelled: "Cancelled", rejected: "Declined",
};

function Result({ job, onPlugin }: { job: Job; onPlugin: (action: "enable_plugin" | "disable_plugin") => void }) {
  const r = (job.result || {}) as Record<string, unknown>;
  if (job.status !== "done") return null;
  if (job.tool === "create_plugin") {
    return (
      <div className="result">
        <div className="row">
          <span className="strong">Plugin: {String(r.name || "")}</span>
          <span className={r.valid ? "ok" : "err"}>{r.valid ? "Loads cleanly" : `Problem: ${String(r.problem || "invalid")}`}</span>
        </div>
        <p className="muted small">Read the code before enabling it. It runs on {job.device} with the agent&apos;s permissions.</p>
        <pre className="code">{String(r.code || "(no code returned)")}</pre>
        {Boolean(r.valid) && (
          <div className="row">
            <button className="btn primary" onClick={() => onPlugin("enable_plugin")}><Icon name="check" size={14} /> Enable plugin</button>
            <button className="btn ghost" onClick={() => onPlugin("disable_plugin")}>Disable</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="result">
      {r.summary ? <p>{String(r.summary)}</p> : null}
      {r.path ? <p className="muted small">Folder: <code>{String(r.path)}</code></p> : null}
      {r.commit ? <p className="muted small">Saved as commit <code>{String(r.commit)}</code></p> : null}
      {r.repo_url ? <p className="small"><a href={String(r.repo_url)} target="_blank" rel="noreferrer noopener">{String(r.repo_url)}</a></p> : null}
      {Array.isArray(r.files_changed) && r.files_changed.length > 0 && (
        <details>
          <summary className="small">{r.files_changed.length} files changed</summary>
          <pre className="code">{(r.files_changed as string[]).join("\n")}</pre>
        </details>
      )}
      {!r.summary && !r.path && <pre className="code">{JSON.stringify(job.result, null, 2)}</pre>}
    </div>
  );
}

export function TasksView({ focusId, onFocus, onChanged, notify }: {
  focusId: string | null;
  onFocus: (id: string | null) => void;
  onChanged: () => void;
  notify: (title: string, body?: string, tone?: "ok" | "err") => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loaded, setLoaded] = useState(false);
  const lastEvent = useRef(0);
  const logEnd = useRef<HTMLDivElement>(null);
  const selected = jobs.find((j) => j.id === focusId) || null;

  const loadList = useCallback(async () => {
    try {
      const { jobs } = await api<{ jobs: Job[] }>("/api/tasks");
      setJobs(jobs);
    } catch {
      // keep the last list
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadList();
    const id = setInterval(loadList, 4000);
    return () => clearInterval(id);
  }, [loadList]);

  useEffect(() => {
    setEvents([]);
    lastEvent.current = 0;
    if (!focusId) return;
    let stop = false;
    const tick = async () => {
      try {
        const { events: fresh } = await api<{ events: Event[] }>(`/api/tasks?id=${focusId}&after=${lastEvent.current}`);
        if (stop || !fresh.length) return;
        lastEvent.current = fresh[fresh.length - 1].id;
        setEvents((e) => [...e, ...fresh].slice(-800));
      } catch {
        // retried on the next tick
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [focusId]);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [events.length]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!selected) return;
    try {
      await api("/api/tasks", { method: "POST", json: { id: selected.id, action, ...extra } });
      notify(action === "enable_plugin" ? "Enabling plugin" : action === "approve" ? "Approved" : "Done", undefined, "ok");
      await loadList();
      onChanged();
    } catch (err) {
      notify("Could not do that", (err as Error).message, "err");
    }
  };

  return (
    <div className="view split">
      <section className="panel list">
        <h2>Tasks</h2>
        {!loaded ? <p className="empty">Loading...</p> : !jobs.length ? (
          <p className="empty">No tasks yet. Ask Jarvis to build a project or a new tool.</p>
        ) : (
          <ul className="job-list">
            {jobs.map((j) => (
              <li key={j.id}>
                <button className={j.id === focusId ? "active" : ""} onClick={() => onFocus(j.id)}>
                  <span className={`pill ${j.status}`}>{LABEL[j.status] || j.status}</span>
                  <span className="grow clip">{j.title}</span>
                  <span className="muted small">{timeAgo(j.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel detail">
        {!selected ? (
          <p className="empty">Pick a task to see its progress.</p>
        ) : (
          <>
            <div className="row">
              <h2 className="grow">{selected.title}</h2>
              <span className={`pill ${selected.status}`}>{LABEL[selected.status] || selected.status}</span>
            </div>
            <p className="muted small">{selected.device} · {selected.tool} · started {timeAgo(selected.created_at)}</p>
            {selected.status === "needs_approval" && (
              <div className="approval">
                <p>Jarvis wants to run this on <strong>{selected.device}</strong>:</p>
                <pre className="code">{JSON.stringify(selected.args ?? {}, null, 2)}</pre>
                <div className="row">
                  <button className="btn primary" onClick={() => act("approve")}><Icon name="check" size={14} /> Approve</button>
                  <button className="btn ghost" onClick={() => act("reject")}>Decline</button>
                </div>
              </div>
            )}
            {(selected.status === "queued" || selected.status === "running") && (
              <button className="btn ghost small" onClick={() => act("cancel")}>Cancel task</button>
            )}
            {selected.error && <p className="err">{selected.error}</p>}
            <Result job={selected} onPlugin={(a) => act(a)} />
            {events.length > 0 && (
              <div className="log">
                {events.map((e) => (
                  <div key={e.id} className={`log-line ${e.kind}`}>{e.text}</div>
                ))}
                <div ref={logEnd} />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
