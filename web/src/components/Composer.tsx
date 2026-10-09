"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

const SUGGESTIONS = [
  { label: "What's due this week?", text: "What's due this week?" },
  { label: "Any messages?", text: "Do I have any new messages?" },
  { label: "Play something", text: "Play the latest video from " },
  { label: "Start a project", text: "Start a new project on my PC: " },
  { label: "Build a tool", text: "Build yourself a new tool that can " },
  { label: "Remember this", text: "Remember that " },
];

export function Composer({ onSend, onMic, onStop, busy, listening, interim, canListen, compact }: {
  onSend: (text: string) => void;
  onMic: () => void;
  onStop: () => void;
  busy: boolean;
  listening: boolean;
  interim: string;
  canListen: boolean;
  compact: boolean;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };

  const prefill = (t: string) => {
    if (!t.endsWith(" ")) {
      onSend(t);
      return;
    }
    setText(t);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(t.length, t.length);
    });
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <button
          className={`mic ${listening ? "live" : ""}`}
          onClick={onMic}
          disabled={!canListen}
          title={canListen ? (listening ? "Stop listening" : "Talk") : "Voice input needs Chrome or Edge"}
          aria-label="Talk to Jarvis"
        >
          <Icon name="mic" size={20} />
        </button>
        <textarea
          ref={input}
          rows={1}
          value={listening ? interim : text}
          placeholder={listening ? "Listening..." : "Ask Jarvis anything..."}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          readOnly={listening}
          aria-label="Message"
        />
        {busy ? (
          <button className="send stop" onClick={onStop} title="Stop" aria-label="Stop">
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!text.trim()} title="Send" aria-label="Send">
            <Icon name="send" size={20} />
          </button>
        )}
      </div>
      {!compact && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s.label} onClick={() => prefill(s.text)} disabled={busy}>{s.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
