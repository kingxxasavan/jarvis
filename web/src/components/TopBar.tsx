"use client";
// The taskbar along the bottom, like a desktop OS: JARVIS on the left, the
// sections in the middle, status, voice and the clock on the right.
import { useEffect, useState } from "react";
import { Icon } from "./Icon";

export type View = "chat" | "apps" | "files" | "code" | "tasks" | "memory" | "settings";

const TABS: { id: View; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "apps", label: "Apps", icon: "grid" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "code", label: "Code", icon: "code" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "settings", label: "Settings", icon: "gear" },
];

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  return (
    <span className="clock" title={now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}>
      <span>{now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
      <span className="muted">{now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
    </span>
  );
}

export function TopBar({ view, onView, online, devicesOnline, voiceReplies, onToggleVoice, onNewChat, pendingApprovals, busy }: {
  view: View;
  onView: (v: View) => void;
  online: boolean;
  devicesOnline: number;
  voiceReplies: boolean;
  onToggleVoice: () => void;
  onNewChat: () => void;
  pendingApprovals: number;
  busy: boolean;
  initial?: string;
}) {
  return (
    <nav className="taskbar" aria-label="JARVIS">
      <button className={`start ${busy ? "busy" : ""}`} onClick={() => onView("chat")} title="JARVIS" aria-label="JARVIS chat">
        <span className="start-core" />
      </button>
      <div className="dock" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={view === t.id} className={view === t.id ? "active" : ""} onClick={() => onView(t.id)} title={t.label}>
            <Icon name={t.icon} size={19} />
            <span className="dock-label">{t.label}</span>
            {t.id === "tasks" && pendingApprovals > 0 && <span className="badge">{pendingApprovals}</span>}
          </button>
        ))}
      </div>
      <div className="tray">
        <span className={`tray-status ${online ? "ok" : "warn"}`} title={online ? "AI online" : "AI degraded: check the provider keys"}>
          <i /> <span className="tray-text">{devicesOnline ? `${devicesOnline} device${devicesOnline > 1 ? "s" : ""}` : "No device"}</span>
        </span>
        <button className="icon-btn tray-new" onClick={onNewChat} title="New conversation" aria-label="New conversation"><Icon name="plus" size={17} /></button>
        <button className={`icon-btn ${voiceReplies ? "on" : ""}`} onClick={onToggleVoice} title={voiceReplies ? "Spoken replies on" : "Spoken replies off"} aria-label="Toggle spoken replies">
          <Icon name={voiceReplies ? "speaker" : "mute"} size={17} />
        </button>
        <Clock />
      </div>
    </nav>
  );
}
