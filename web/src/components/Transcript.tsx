"use client";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatItem } from "@/hooks/useChat";
import type { JobRef, VideoRef } from "@/lib/ai/events";
import { Icon } from "./Icon";

// A tiny, safe formatter: paragraphs, lists, **bold**, `code`, and links.
// Text is never inserted as HTML.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={m.index}>{t.slice(1, -1)}</code>);
    else out.push(<a key={m.index} href={t} target="_blank" rel="noreferrer noopener">{t.replace(/^https?:\/\//, "").slice(0, 48)}</a>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy-btn" onClick={() => {
      void navigator.clipboard?.writeText(text).then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }).catch(() => undefined);
    }} title={label} aria-label={label}>
      <Icon name={done ? "check" : "copy"} size={13} /> {done ? "Copied" : label}
    </button>
  );
}

function Table({ lines }: { lines: string[] }) {
  const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const [head, ...body] = rows;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{head.map((c, i) => <th key={i}>{inline(c)}</th>)}</tr></thead>
        <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function RichText({ text }: { text: string }) {
  // Split out fenced code first so blank lines inside code stay in the block.
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g).filter((p) => p.trim());
  return (
    <>
      {parts.map((part, pi) => {
        if (part.startsWith("```")) {
          const m = part.match(/^```([\w+-]*)\n?([\s\S]*?)(?:```)?$/);
          const lang = m?.[1] || "";
          const code = (m?.[2] ?? part).replace(/\n$/, "");
          return (
            <div key={pi} className="codeblock">
              <div className="codeblock-bar"><span>{lang || "code"}</span><CopyButton text={code} /></div>
              <pre>{code}</pre>
            </div>
          );
        }
        return part.split(/\n{2,}/).map((b, i) => {
          const key = `${pi}-${i}`;
          const lines = b.split("\n").filter((l) => l.trim());
          if (!lines.length) return null;
          if (lines.length >= 2 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) return <Table key={key} lines={lines} />;
          if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
            const ordered = /^\s*\d/.test(lines[0]);
            const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>);
            return ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          return (
            <p key={key}>
              {lines.map((l, j) => {
                const h = l.match(/^#{1,4}\s+(.*)$/);
                return <Fragment key={j}>{j > 0 && <br />}{h ? <strong>{inline(h[1])}</strong> : inline(l)}</Fragment>;
              })}
            </p>
          );
        });
      })}
    </>
  );
}

function VideoCard({ video, onPlay }: { video: VideoRef; onPlay: (v: VideoRef) => void }) {
  return (
    <div className="video-card">
      <img src={`https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`} alt="" loading="lazy" />
      <div className="grow">
        <div className="clip strong">{video.title}</div>
        <div className="muted small">{video.channel}</div>
      </div>
      {video.embeddable ? (
        <button className="btn small" onClick={() => onPlay(video)}><Icon name="play" size={14} /> Play</button>
      ) : (
        <a className="btn small" href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noreferrer noopener">
          <Icon name="external" size={14} /> YouTube
        </a>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  needs_approval: "Waiting for approval", queued: "Queued", running: "Running", done: "Done",
  failed: "Failed", cancelled: "Cancelled", rejected: "Declined",
};

export type JobInfo = { outcome?: string; plugin?: { name: string; valid: boolean; enabled?: boolean }; enabled?: boolean };

function JobCard({ job, status, info, onDecide, onOpen, onEnable }: {
  job: JobRef; status: string; info?: JobInfo;
  onEnable: (name: string) => void;
  onDecide: (id: string, action: "approve" | "reject") => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={`job-card ${status}`}>
      <Icon name={job.tool === "create_plugin" ? "spark" : "code"} />
      <div className="grow">
        <div className="clip strong">{job.title}</div>
        <div className="muted small">
          {(status === "running" || status === "queued") && <i className="spin" />} {job.device} · {STATUS_TEXT[status] || status}
        </div>
        {info?.outcome && (status === "done" || status === "failed") && (
          <div className={`job-outcome ${status === "failed" ? "err" : ""}`}><RichText text={info.outcome} /></div>
        )}
        {info?.plugin?.valid && (
          <div className="row job-actions">
            {info.enabled || info.plugin.enabled ? <span className="ok small"><Icon name="check" size={12} /> Enabled</span> : (
              <button className="btn small primary" onClick={() => onEnable(info.plugin!.name)}><Icon name="check" size={14} /> Enable {info.plugin.name}</button>
            )}
            <button className="btn small ghost" onClick={() => onOpen(job.id)}>Read the code</button>
          </div>
        )}
      </div>
      {status === "needs_approval" ? (
        <>
          <button className="btn small primary" onClick={() => onDecide(job.id, "approve")}><Icon name="check" size={14} /> Approve</button>
          <button className="btn small ghost" onClick={() => onDecide(job.id, "reject")}>Decline</button>
        </>
      ) : (
        <button className="btn small ghost" onClick={() => onOpen(job.id)}>Open</button>
      )}
    </div>
  );
}

export function Transcript({ items, jobStatus, jobInfo, onPlay, onDecide, onOpenJob, onEnablePlugin }: {
  items: ChatItem[];
  jobStatus: Record<string, string>;
  jobInfo: Record<string, JobInfo>;
  onEnablePlugin: (name: string) => void;
  onPlay: (v: VideoRef) => void;
  onDecide: (id: string, action: "approve" | "reject") => void;
  onOpenJob: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const frame = useRef(0);
  const last = items[items.length - 1];

  useEffect(() => {
    stick.current = true;
  }, [items.length]);

  // Follow new text only while the reader is at the bottom; scrolling up to
  // read stays put. One instant jump per frame: a smooth scroll restarted on
  // every streamed word is what made scrolling lag.
  useEffect(() => {
    const el = box.current;
    if (!el || !stick.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [items.length, last?.text, last?.tools.length, last?.jobs.length, jobInfo]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <div
      className="transcript"
      aria-live="polite"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {items.map((it) => (
        <div key={it.id} className={`msg ${it.role}`}>
          {it.role === "assistant" && it.tools.length > 0 && (
            <div className="chips">
              {it.tools.map((c) => (
                <span key={c.id} className={`chip ${c.state}`} title={c.note}>
                  {c.state === "start" ? <i className="spin" /> : <Icon name={c.state === "done" ? "check" : "close"} size={12} />}
                  {c.label}
                </span>
              ))}
            </div>
          )}
          {it.role === "assistant" && it.tools.some((c) => c.state === "error" && c.note) && (
            <div className="tool-errors">
              {it.tools.filter((c) => c.state === "error" && c.note).map((c) => (
                <div key={c.id} className="small"><strong>{c.label}:</strong> {c.note}</div>
              ))}
            </div>
          )}
          {it.text ? (
            <div className="bubble">
              <RichText text={it.text} />
              {it.role === "assistant" && !it.pending && it.text.length > 40 && <div className="bubble-actions"><CopyButton text={it.text} /></div>}
            </div>
          ) : it.pending && !it.tools.some((c) => c.state === "start") ? (
            <div className="bubble thinking"><i /><i /><i /></div>
          ) : null}
          {it.play && <VideoCard video={it.play} onPlay={onPlay} />}
          {it.jobs.map((j) => (
            <JobCard key={j.id} job={j} status={jobStatus[j.id] || j.status} info={jobInfo[j.id]} onEnable={onEnablePlugin} onDecide={onDecide} onOpen={onOpenJob} />
          ))}
          {it.error && <div className="bubble error">{it.error}</div>}
        </div>
      ))}
    </div>
  );
}
