"use client";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
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

function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.startsWith("```")) return <pre key={i}>{b.replace(/^```\w*\n?|```$/g, "")}</pre>;
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>;
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

export type JobInfo = { outcome?: string; plugin?: { name: string; valid: boolean }; enabled?: boolean };

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
            {info.enabled ? <span className="ok small"><Icon name="check" size={12} /> Enabled</span> : (
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
          {it.text ? (
            <div className="bubble"><RichText text={it.text} /></div>
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
