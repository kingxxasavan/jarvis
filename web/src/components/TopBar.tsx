"use client";
import { Icon } from "./Icon";

export type View = "chat" | "apps" | "files" | "code" | "tasks" | "memory" | "settings";

const TABS: { id: View; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "apps", label: "Apps" },
  { id: "files", label: "Files" },
  { id: "code", label: "Code" },
  { id: "tasks", label: "Tasks" },
  { id: "memory", label: "Memory" },
  { id: "settings", label: "Settings" },
];

export function TopBar({ view, onView, online, voiceReplies, onToggleVoice, onNewChat, pendingApprovals, initial }: {
  view: View;
  onView: (v: View) => void;
  online: boolean;
  voiceReplies: boolean;
  onToggleVoice: () => void;
  onNewChat: () => void;
  pendingApprovals: number;
  initial: string;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="wordmark">J.A.R.V.I.S.</span>
        <span className={`status ${online ? "ok" : "warn"}`}>
          <i />
          {online ? "Online" : "Degraded"}
        </span>
      </div>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} className={view === t.id ? "active" : ""} onClick={() => onView(t.id)}>
            {t.label}
            {t.id === "tasks" && pendingApprovals > 0 && <span className="badge">{pendingApprovals}</span>}
          </button>
        ))}
      </nav>
      <div className="actions">
        <button className="icon-btn" onClick={onNewChat} title="New conversation" aria-label="New conversation">
          <Icon name="plus" />
        </button>
        <button
          className={`icon-btn ${voiceReplies ? "on" : ""}`}
          onClick={onToggleVoice}
          title={voiceReplies ? "Spoken replies on" : "Spoken replies off"}
          aria-label="Toggle spoken replies"
        >
          <Icon name={voiceReplies ? "speaker" : "mute"} />
        </button>
        <button className="avatar" onClick={() => onView("settings")} title="Settings" aria-label="Settings">
          {initial}
        </button>
      </div>
    </header>
  );
}
