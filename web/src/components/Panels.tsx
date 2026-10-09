"use client";
import { useEffect, useRef, type MutableRefObject } from "react";
import type { Pulse } from "@/hooks/usePulse";
import { timeAgo } from "@/lib/client/api";
import { Icon } from "./Icon";

export type Activity = { id: string; icon: string; text: string; at: number; state?: "ok" | "err" | "run" };

function Waveform({ level }: { level: MutableRefObject<number> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    let raf = 0;
    const bars = 46;
    const draw = (t: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w0 = Math.round(el.clientWidth * dpr);
      const h0 = Math.round(el.clientHeight * dpr);
      if (el.width !== w0 || el.height !== h0) {
        el.width = w0;
        el.height = h0;
      }
      g.clearRect(0, 0, el.width, el.height);
      const mid = el.height / 2;
      const w = el.width / bars;
      for (let i = 0; i < bars; i++) {
        const idle = 0.08 + 0.06 * Math.sin(t / 400 + i * 0.7);
        const live = level.current * (0.35 + 0.65 * Math.abs(Math.sin(t / 90 + i * 1.3)));
        const h = Math.max(idle, live) * mid * (1 - Math.abs(i - bars / 2) / (bars * 0.75));
        g.fillStyle = `rgba(80,200,255,${0.35 + Math.min(0.6, live)})`;
        g.fillRect(i * w + w * 0.3, mid - h, w * 0.4, h * 2);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [level]);
  return <canvas ref={ref} className="waveform" />;
}

export function StatusPanel({ pulse, level, voice, activeProvider, toolCount }: {
  pulse: Pulse | null;
  level: MutableRefObject<number>;
  voice: { listen: boolean; state: string };
  activeProvider: string;
  toolCount: number;
}) {
  const online = pulse?.devices.filter((d) => d.online).length ?? 0;
  const rows: { icon: string; label: string; value: string; tone: string }[] = [
    { icon: "mic", label: "Voice", value: voice.listen ? voice.state : "Typing only", tone: voice.listen ? "ok" : "muted" },
    { icon: "memory", label: "Memory", value: pulse ? `${pulse.memoryCount} facts` : "...", tone: "ok" },
    { icon: "spark", label: "Tools", value: `${toolCount} ready`, tone: "ok" },
    { icon: "device", label: "Devices", value: pulse ? `${online}/${pulse.devices.length} online` : "...", tone: online ? "ok" : "muted" },
    {
      icon: "calendar", label: "arkia.buzz",
      value: !pulse ? "..." : pulse.arkia.error ? "Error" : pulse.arkia.connected ? "Linked" : "Not linked",
      tone: pulse?.arkia.error ? "err" : pulse?.arkia.connected ? "ok" : "muted",
    },
  ];
  return (
    <aside className="side left">
      <section className="panel">
        <h2>AI status</h2>
        <Waveform level={level} />
        <ul className="rows">
          {(pulse?.providers || []).map((p) => (
            <li key={p.id} title={p.model}>
              <span className={`dot ${activeProvider ? (activeProvider === p.id ? "ok" : "idle") : p.role === "primary" ? "ok" : "idle"}`} />
              <span className="grow">{p.label}</span>
              <span className="muted">{activeProvider === p.id ? "Active" : p.role === "primary" ? "Primary" : "Standby"}</span>
            </li>
          ))}
          {pulse && !pulse.providers.length && <li className="err">No AI key configured</li>}
        </ul>
      </section>
      <section className="panel">
        <h2>Systems</h2>
        <ul className="rows">
          {rows.map((r) => (
            <li key={r.label} title={r.label === "arkia.buzz" ? pulse?.arkia.error : undefined}>
              <Icon name={r.icon} />
              <span className="grow">{r.label}</span>
              <span className={r.tone}>{r.value}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

const QUICK = [
  { id: "youtube", label: "YouTube", icon: "youtube" },
  { id: "browser", label: "Browser", icon: "globe" },
  { id: "vscode", label: "VS Code", icon: "code" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
];

export function ActivityPanel({ activity, onQuick }: { activity: Activity[]; onQuick: (id: string) => void }) {
  return (
    <aside className="side right">
      <section className="panel">
        <h2>Recent activity</h2>
        {activity.length ? (
          <ul className="rows activity">
            {activity.slice(0, 6).map((a) => (
              <li key={a.id}>
                <Icon name={a.icon} />
                <span className={`grow clip ${a.state === "err" ? "err" : ""}`}>{a.text}</span>
                <span className="muted small">{timeAgo(a.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Nothing yet this session.</p>
        )}
      </section>
      <section className="panel">
        <h2>Quick apps</h2>
        <div className="quick">
          {QUICK.map((q) => (
            <button key={q.id} onClick={() => onQuick(q.id)}>
              <span className={`qicon ${q.id}`}>
                <Icon name={q.icon} size={20} />
              </span>
              {q.label}
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
