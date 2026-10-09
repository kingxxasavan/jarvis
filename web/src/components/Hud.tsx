"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat, type ToolChip } from "@/hooks/useChat";
import { usePulse, type Alert } from "@/hooks/usePulse";
import { useVoice } from "@/hooks/useVoice";
import type { JobRef, VideoRef } from "@/lib/ai/events";
import { api, store } from "@/lib/client/api";
import { installErrorReporter } from "@/lib/client/report";
import { Composer } from "./Composer";
import { ErrorBoundary } from "./ErrorBoundary";
import { Orb, type OrbState } from "./Orb";
import { ActivityPanel, StatusPanel, type Activity } from "./Panels";
import { Player } from "./Player";
import { Toasts, type Toast } from "./Toasts";
import { TopBar, type View } from "./TopBar";
import { Transcript, type JobInfo } from "./Transcript";
import { AppsView, type AppCommand } from "./views/AppsView";
import { CodeView } from "./views/CodeView";
import { FilesView } from "./views/FilesView";
import { MemoryView } from "./views/MemoryView";
import { SettingsView } from "./views/SettingsView";
import { TasksView } from "./views/TasksView";

const SPEAK_KEY = "jarvis.speak";
const VIEW_KEY = "jarvis.view";
const VIEWS: View[] = ["chat", "apps", "files", "code", "tasks", "memory", "settings"];
const FINAL = new Set(["done", "failed", "cancelled", "rejected"]);
const QUICK_APPS: Record<string, string> = { vscode: "vscode", terminal: "terminal", files: "files" };
const TOOL_ICON: Record<string, string> = {
  play_youtube: "youtube", youtube_search: "youtube", youtube_history: "youtube", web_search: "globe", read_webpage: "globe",
  remember: "memory", recall_memories: "memory", forget_memory: "memory",
  arkia_agenda: "calendar", arkia_add: "calendar", arkia_complete: "calendar", arkia_messages: "calendar",
};

export function Hud({ initial }: { initial: string }) {
  const [view, setView] = useState<View>("chat");
  const [focusJob, setFocusJob] = useState<string | null>(null);
  const [video, setVideo] = useState<VideoRef | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [provider, setProvider] = useState("");
  const [jobStatus, setJobStatus] = useState<Record<string, string>>({});
  const [jobInfo, setJobInfo] = useState<Record<string, JobInfo>>({});
  const [appCommand, setAppCommand] = useState<AppCommand | null>(null);
  const viaVoice = useRef(false);
  const clearCommand = useCallback(() => setAppCommand(null), []);
  const interacted = useRef(false);

  useEffect(() => {
    installErrorReporter();
    const saved = store.get(VIEW_KEY) as View | null;
    if (saved && VIEWS.includes(saved)) setView(saved);
  }, []);

  const go = useCallback((v: View) => {
    setView(v);
    store.set(VIEW_KEY, v);
  }, []);

  useEffect(() => {
    setVoiceReplies(store.get(SPEAK_KEY) !== "0");
    const mark = () => {
      interacted.current = true;
    };
    window.addEventListener("pointerdown", mark, { once: true });
    window.addEventListener("keydown", mark, { once: true });
    return () => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
    };
  }, []);

  const notify = useCallback((title: string, body?: string, tone: Toast["tone"] = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, title, body, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "err" ? 9000 : 6000);
  }, []);

  const log = useCallback((icon: string, text: string, state?: Activity["state"]) => {
    setActivity((a) => [{ id: Math.random().toString(36).slice(2), icon, text, at: Date.now(), state }, ...a].slice(0, 20));
  }, []);

  const send = useRef<(t: string) => void>(() => undefined);
  const voice = useVoice((text) => {
    viaVoice.current = true;
    send.current(text);
  });

  const chat = useChat({
    onPlay: (v) => {
      setVideo(v);
      setPlayerOpen(true);
      log("youtube", `Playing: ${v.title}`, "ok");
    },
    onJob: (j: JobRef) => {
      setJobStatus((s) => ({ ...s, [j.id]: j.status }));
      log("tasks", j.title, "run");
    },
    onTool: (c: ToolChip) => {
      if (c.name === "pc_browser_open" && c.state === "done") {
        setAppCommand({ url: "", n: Date.now() });
        go("apps");
      }
      if (c.state !== "start") log(TOOL_ICON[c.name] || (c.name.startsWith("pc_") ? "device" : "spark"), c.label, c.state === "done" ? "ok" : "err");
    },
    onProvider: setProvider,
    onReply: (text) => {
      if (text && (viaVoice.current || voiceReplies) && interacted.current) voice.speak(text);
      viaVoice.current = false;
    },
  });
  send.current = chat.send;

  const onAlerts = useCallback((alerts: Alert[]) => {
    for (const a of alerts) {
      notify(a.title, a.body, a.kind === "message" ? "message" : "info");
      log(a.kind === "message" ? "chat" : "calendar", `${a.title}: ${a.body}`);
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        new Notification(`JARVIS: ${a.title}`, { body: a.body, tag: a.id });
      }
    }
    if (voiceReplies && interacted.current && alerts.length) {
      const first = alerts[0];
      const line = first.kind === "message"
        ? `Sir, a message from ${first.title}: ${first.body}`
        : `Sir, a reminder: ${first.body}`;
      voice.speak(alerts.length > 1 ? `${line}. And ${alerts.length - 1} more.` : line);
    }
  }, [notify, log, voiceReplies, voice]);

  const { pulse, brief, refresh } = usePulse(onAlerts);

  useEffect(() => {
    if (!pulse) return;
    setJobStatus((s) => ({ ...s, ...Object.fromEntries(pulse.jobs.map((j) => [j.id, j.status])) }));
  }, [pulse]);

  // Tasks shown in the chat are followed every few seconds until they finish;
  // when one does, its result appears on its card and is announced.
  const chatJobs = useMemo(() => chat.items.flatMap((it) => it.jobs.map((j) => j.id)), [chat.items]);
  const watching = useMemo(
    () => chatJobs.filter((id) => !FINAL.has(jobStatus[id] || "queued") || (FINAL.has(jobStatus[id]) && !jobInfo[id])),
    [chatJobs, jobStatus, jobInfo],
  );
  const watchKey = watching.join(",");
  useEffect(() => {
    if (!watchKey) return;
    let stop = false;
    const tick = async () => {
      try {
        const { jobs } = await api<{ jobs: { id: string; status: string; outcome: string; plugin?: JobInfo["plugin"] }[] }>(`/api/tasks?ids=${watchKey}`);
        if (stop) return;
        setJobStatus((s) => {
          for (const j of jobs) {
            if (FINAL.has(j.status) && s[j.id] && !FINAL.has(s[j.id])) {
              notify(j.status === "done" ? "Task finished" : "Task failed", j.outcome.slice(0, 160), j.status === "done" ? "ok" : "err");
            }
          }
          return { ...s, ...Object.fromEntries(jobs.map((j) => [j.id, j.status])) };
        });
        const gone = watchKey.split(",").filter((id) => !jobs.some((j) => j.id === id));
        setJobInfo((s) => ({
          ...s,
          ...Object.fromEntries(gone.map((id) => [id, { outcome: "This task was removed." }])),
          ...Object.fromEntries(jobs.filter((j) => FINAL.has(j.status)).map((j) => [j.id, { ...s[j.id], outcome: j.outcome, plugin: j.plugin }])),
        }));
      } catch {
        // the next tick tries again
      }
    };
    void tick();
    const id = setInterval(tick, document.hidden ? 10_000 : 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [watchKey, notify]);

  const enablePlugin = useCallback(async (name: string) => {
    try {
      const r = await api<{ device: string }>("/api/plugins", { method: "POST", json: { name, action: "enable" } });
      notify(`Enabling ${name}`, `On ${r.device}. Jarvis can use it in a few seconds.`, "ok");
      setJobInfo((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.plugin?.name === name ? { ...v, enabled: true } : v])));
    } catch (err) {
      notify("Could not enable it", (err as Error).message, "err");
    }
  }, [notify]);

  const orbState: OrbState = voice.listening ? "listening" : voice.speaking ? "speaking" : chat.busy ? "thinking" : "idle";
  const pendingApprovals = Object.values(jobStatus).filter((s) => s === "needs_approval").length;
  const online = !!pulse && pulse.providers.length > 0;

  const decide = async (id: string, action: "approve" | "reject") => {
    try {
      await api("/api/tasks", { method: "POST", json: { id, action } });
      setJobStatus((s) => ({ ...s, [id]: action === "approve" ? "queued" : "rejected" }));
      notify(action === "approve" ? "Approved" : "Declined", action === "approve" ? "The device will start shortly." : undefined, "ok");
    } catch (err) {
      notify("Could not update the task", (err as Error).message, "err");
    }
  };

  const quick = async (id: string) => {
    if (id === "youtube") return setPlayerOpen(true);
    if (id === "tasks") return go("tasks");
    if (id === "browser") return go("apps");
    if (id === "spotify") {
      setAppCommand({ url: "https://open.spotify.com", n: Date.now(), match: "open.spotify.com" });
      return go("apps");
    }
    try {
      const res = await api<{ device: string; result: unknown }>("/api/devices/run", { method: "POST", json: { tool: "open_app", args: { name: QUICK_APPS[id] } } });
      const result = (res.result || {}) as { opened?: string };
      notify(`Opened on ${res.device}`, result.opened, "ok");
      log("device", `Opened ${result.opened || id} on ${res.device}`, "ok");
    } catch (err) {
      notify("Could not open it", (err as Error).message, "err");
    }
  };

  const onOrb = () => {
    interacted.current = true;
    if (voice.speaking) voice.stopSpeaking();
    else if (voice.supported.listen) voice.listen();
  };

  const compact = chat.items.length > 0;
  const subtitle = useMemo(() => {
    if (voice.listening) return "Listening...";
    if (chat.busy) return "Working on it...";
    return brief || "At your service, Sir.";
  }, [voice.listening, chat.busy, brief]);

  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true" />

      <ErrorBoundary key={view} name={view}>
      {view === "chat" ? (
        <main className="hud">
          <StatusPanel
            pulse={pulse}
            level={voice.level}
            voice={{ listen: voice.supported.listen, state: voice.listening ? "Listening" : voice.speaking ? "Speaking" : "Ready" }}
            activeProvider={provider}
            toolCount={pulse?.toolCount ?? 0}
          />
          <section className={`center ${compact ? "compact" : ""}`}>
            <div className="hero">
              <Orb state={orbState} level={voice.level} size={compact ? 132 : 300} onClick={onOrb} />
              {!compact && (
                <>
                  <h1 className="wordmark big">J.A.R.V.I.S.</h1>
                  <p className="subtitle">{subtitle}</p>
                </>
              )}
            </div>
            {compact && (
              <Transcript
                items={chat.items}
                jobStatus={jobStatus}
                jobInfo={jobInfo}
                onEnablePlugin={enablePlugin}
                onPlay={(v) => {
                  setVideo(v);
                  setPlayerOpen(true);
                }}
                onDecide={decide}
                onOpenJob={(id) => {
                  setFocusJob(id);
                  go("tasks");
                }}
              />
            )}
            {voice.error && <p className="err small center-text">{voice.error}</p>}
            <Composer
              onSend={(t) => {
                interacted.current = true;
                viaVoice.current = false;
                chat.send(t);
              }}
              onMic={onOrb}
              onStop={chat.stop}
              busy={chat.busy}
              listening={voice.listening}
              interim={voice.interim}
              canListen={voice.supported.listen}
              compact={compact}
            />
          </section>
          <ActivityPanel activity={activity} onQuick={quick} />
        </main>
      ) : view === "apps" ? (
        <AppsView
          command={appCommand}
          onCommand={(url, match) => setAppCommand({ url, n: Date.now(), match })}
          onView={go}
          onCommandDone={clearCommand}
          onYouTube={() => setPlayerOpen(true)}
          notify={notify}
        />
      ) : view === "files" ? (
        <FilesView notify={notify} />
      ) : view === "code" ? (
        <CodeView notify={notify} />
      ) : view === "tasks" ? (
        <TasksView focusId={focusJob} onFocus={setFocusJob} onChanged={refresh} notify={notify} />
      ) : view === "memory" ? (
        <MemoryView notify={notify} />
      ) : (
        <SettingsView notify={notify} onChange={refresh} />
      )}
      </ErrorBoundary>
      <TopBar
        view={view}
        onView={go}
        online={online}
        voiceReplies={voiceReplies}
        onToggleVoice={() => {
          const next = !voiceReplies;
          setVoiceReplies(next);
          store.set(SPEAK_KEY, next ? "1" : "0");
          if (!next) voice.stopSpeaking();
        }}
        onNewChat={() => {
          chat.reset();
          go("chat");
        }}
        pendingApprovals={pendingApprovals}
        devicesOnline={pulse?.devices.filter((d) => d.online).length ?? 0}
        busy={chat.busy}
      />
      {playerOpen && <Player video={video} onPlay={setVideo} onClose={() => setPlayerOpen(false)} />}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
