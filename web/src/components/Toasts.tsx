"use client";
import { Icon } from "./Icon";

export type Toast = { id: string; title: string; body?: string; tone?: "info" | "ok" | "err" | "message" };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone || "info"}`}>
          <div className="grow">
            <div className="strong">{t.title}</div>
            {t.body && <div className="small clip2">{t.body}</div>}
          </div>
          <button className="icon-btn" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
