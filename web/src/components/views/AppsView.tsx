"use client";
// Apps: a home screen of icons. Web apps open in the laptop's Chrome, laptop
// apps open on the laptop's screen (Desktop), JARVIS sections switch tabs.
// Each opens in a window with a Home button; downloads sit underneath and can
// come straight to this device.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, store, timeAgo } from "@/lib/client/api";
import { Icon } from "../Icon";
import { RemoteBrowser, type StreamConn, type StreamMode } from "../RemoteBrowser";
import type { View } from "../TopBar";

type Notify = (title: string, body?: string, tone?: "ok" | "err") => void;
type FileRow = { name: string; size: number; modified: number };
type Win = { mode: StreamMode; title: string; icon: string };
export type AppCommand = { url: string; n: number; match?: string };

const AUTOSAVE_KEY = "jarvis.autosave";

const WEB_APPS: { label: string; url: string; domain: string }[] = [
  { label: "Google", url: "https://www.google.com", domain: "google.com" },
  { label: "YouTube", url: "https://www.youtube.com", domain: "youtube.com" },
  { label: "Spotify", url: "https://open.spotify.com", domain: "open.spotify.com" },
  { label: "YT Music", url: "https://music.youtube.com", domain: "music.youtube.com" },
  { label: "Gmail", url: "https://mail.google.com", domain: "mail.google.com" },
  { label: "Drive", url: "https://drive.google.com", domain: "drive.google.com" },
  { label: "Docs", url: "https://docs.google.com", domain: "docs.google.com" },
  { label: "Classroom", url: "https://classroom.google.com", domain: "classroom.google.com" },
  { label: "Calendar", url: "https://calendar.google.com", domain: "calendar.google.com" },
  { label: "Claude", url: "https://claude.ai", domain: "claude.ai" },
  { label: "ChatGPT", url: "https://chatgpt.com", domain: "chatgpt.com" },
  { label: "Canva", url: "https://www.canva.com", domain: "canva.com" },
  { label: "GitHub", url: "https://github.com", domain: "github.com" },
  { label: "Discord", url: "https://discord.com/app", domain: "discord.com" },
  { label: "WhatsApp", url: "https://web.whatsapp.com", domain: "web.whatsapp.com" },
  { label: "Netflix", url: "https://www.netflix.com", domain: "netflix.com" },
  { label: "Twitch", url: "https://www.twitch.tv", domain: "twitch.tv" },
  { label: "Vercel", url: "https://vercel.com/dashboard", domain: "vercel.com" },
];

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

function size(n: number) {
  return n > 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : n > 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// A lettered tile in a colour picked from the name, for apps without an icon.
function Letter({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span className="tile-letter" style={{ background: `linear-gradient(135deg, hsl(${h} 65% 45%), hsl(${(h + 40) % 360} 70% 32%))` }}>{name.trim().charAt(0).toUpperCase()}</span>;
}

function Tile({ label, img, icon, onClick, busy, title }: { label: string; img?: string; icon?: string; onClick: () => void; busy?: boolean; title?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <button className="tile" onClick={onClick} title={title || label} disabled={busy}>
      <span className="tile-icon">
        {busy ? <i className="spin" /> : img && !broken ? <img src={img} alt="" loading="lazy" onError={() => setBroken(true)} />
          : icon ? <Icon name={icon} size={26} /> : <Letter name={label} />}
      </span>
      <span className="tile-label">{label}</span>
    </button>
  );
}

function Downloads({ conn, refreshKey, autosave, onAutosave }: { conn: StreamConn; refreshKey: number; autosave: boolean; onAutosave: (on: boolean) => void }) {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${conn.base}/files?t=${encodeURIComponent(conn.files)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Link expired. Reopen Apps." : `Error ${res.status}`);
      setFiles(((await res.json()) as { files: FileRow[] }).files);
      setError("");
    } catch (err) {
      setError((err as Error).message || "Could not reach the laptop.");
    }
  }, [conn]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section className="panel home-downloads">
      <div className="row wrap">
        <h2 className="grow"><Icon name="download" /> Downloads on {conn.device.name}</h2>
        <label className="small row switch" title="When the laptop's browser finishes a download, save it on this device too">
          <input type="checkbox" checked={autosave} onChange={(e) => onAutosave(e.target.checked)} /> Also save to this device
        </label>
        <button className="icon-btn" onClick={load} aria-label="Refresh downloads" title="Refresh"><Icon name="reload" size={14} /></button>
      </div>
      {error && <p className="err small">{error}</p>}
      {!files ? (!error && <p className="empty small">Loading...</p>) : !files.length ? (
        <p className="empty small">Nothing yet. Downloads from the laptop&apos;s browser, or ones you ask Jarvis for, appear here and in cloud files.</p>
      ) : (
        <ul className="rows">
          {files.slice(0, 12).map((f) => (
            <li key={f.name}>
              <Icon name="download" size={15} />
              <span className="grow">
                <span className="clip">{f.name}</span>
                <span className="muted small">{size(f.size)} · {timeAgo(f.modified)}</span>
              </span>
              <a className="btn small" href={`${conn.base}/files/${encodeURIComponent(f.name)}?t=${encodeURIComponent(conn.files)}`}
                aria-label={`Save ${f.name} to this device`}><Icon name="download" size={13} /> Save</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AppsView({ command, onCommand, onCommandDone, onView, notify }: {
  command: AppCommand | null;
  onCommand: (url: string, match?: string) => void;
  onCommandDone: () => void;
  onYouTube?: () => void;
  onView: (v: View) => void;
  notify: Notify;
}) {
  const [conn, setConn] = useState<StreamConn | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [win, setWin] = useState<Win | null>(null);
  const [laptopApps, setLaptopApps] = useState<string[] | null>(null);
  const [tools, setTools] = useState<{ name: string; description: string }[]>([]);
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState("");
  const [autosave, setAutosave] = useState(true);

  useEffect(() => {
    setAutosave(store.get(AUTOSAVE_KEY) !== "0");
    api<{ plugins: { name: string; description: string; enabled_on: string[] }[] }>("/api/plugins")
      .then((r) => setTools(r.plugins.filter((p) => p.enabled_on.length)))
      .catch(() => undefined);
  }, []);

  const connect = useCallback(async () => {
    setError("");
    try {
      const next = await api<StreamConn>("/api/stream");
      setConn({ ...next }); // always a new object, so the stream reconnects
    } catch (err) {
      setConn(null);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  // The laptop's installed apps, from its stream server (fast), or the job queue (older agents).
  useEffect(() => {
    if (!conn) return;
    let stop = false;
    fetch(`${conn.base}/apps?t=${encodeURIComponent(conn.files)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { apps: string[] }) => !stop && setLaptopApps(d.apps))
      .catch(() => api<{ result: { apps: string[] } }>("/api/devices/run", { method: "POST", json: { tool: "list_apps", args: { all: true } } })
        .then((r) => !stop && setLaptopApps(r.result.apps || []))
        .catch(() => !stop && setLaptopApps([])));
    return () => {
      stop = true;
    };
  }, [conn?.base]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jarvis opening a page (pc_browser_open, Spotify...) shows the browser window.
  useEffect(() => {
    if (!command) return;
    if (!command.url) {
      // Jarvis already opened the page on the laptop; just show the browser.
      setWin({ mode: "browser", title: "Browser", icon: favicon("google.com") });
      onCommandDone();
      return;
    }
    let host = "google.com";
    try {
      host = new URL(command.url).hostname;
    } catch {
      // a search phrase rather than an address
    }
    setWin({ mode: "browser", title: host.replace(/^www\./, ""), icon: favicon(host) });
  }, [command, onCommandDone]);

  const openWeb = (a: (typeof WEB_APPS)[number]) => {
    setWin({ mode: "browser", title: a.label, icon: favicon(a.domain) });
    onCommand(a.url, a.domain);
  };

  const openLaptop = async (name: string) => {
    if (!conn) return;
    setOpening(name);
    try {
      const res = await fetch(`${conn.base}/apps/open?t=${encodeURIComponent(conn.files)}&name=${encodeURIComponent(name)}`, { method: "POST" });
      if (res.status === 404 && !(await res.clone().json().catch(() => null))?.error) {
        await api("/api/devices/run", { method: "POST", json: { tool: "open_app", args: { name } } }); // older agent
      } else if (!res.ok) {
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Error ${res.status}`);
      }
      setWin({ mode: "desktop", title: name, icon: `${conn.base}/apps/icon?t=${encodeURIComponent(conn.files)}&name=${encodeURIComponent(name)}` });
    } catch (err) {
      notify(`Could not open ${name}`, (err as Error).message, "err");
    } finally {
      setOpening("");
    }
  };

  const saveToDevice = useCallback((name: string) => {
    if (!conn) return;
    const a = document.createElement("a");
    a.href = `${conn.base}/files/${encodeURIComponent(name)}?t=${encodeURIComponent(conn.files)}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [conn]);

  const onDownload = useCallback((name?: string) => {
    setRefresh((n) => n + 1);
    if (name && store.get(AUTOSAVE_KEY) !== "0") saveToDevice(name);
  }, [saveToDevice]);

  const q = query.trim().toLowerCase();
  const web = WEB_APPS.filter((a) => !q || a.label.toLowerCase().includes(q));
  const laptop = useMemo(() => (laptopApps || []).filter((a) => !q || a.toLowerCase().includes(q)), [laptopApps, q]);

  if (!conn) {
    return (
      <div className="view">
        <section className="panel apps-empty">
          <h2><Icon name="grid" /> Apps</h2>
          <p>{error || "Connecting to your laptop..."}</p>
          {error && (
            <>
              <p className="muted small">Apps stream from the laptop running the JARVIS agent. Run install.cmd on it, then try again.</p>
              <button className="btn" onClick={connect}><Icon name="reload" size={14} /> Try again</button>
            </>
          )}
        </section>
      </div>
    );
  }

  if (win) {
    return (
      <div className="app-window">
        <div className="window-bar">
          <button className="btn small ghost" onClick={() => setWin(null)} title="Back to the home screen"><Icon name="home" size={15} /> Home</button>
          <span className="window-title">
            <img src={win.icon} alt="" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
            <span className="clip">{win.title}</span>
            <span className="muted small">{win.mode === "desktop" ? `on ${conn.device.name}'s screen` : `in ${conn.device.name}'s Chrome`}</span>
          </span>
          <button className="btn small ghost" onClick={() => setWin({ ...win, mode: win.mode === "desktop" ? "browser" : "desktop", title: win.mode === "desktop" ? "Browser" : "Desktop" })}>
            <Icon name={win.mode === "desktop" ? "globe" : "device"} size={14} /> {win.mode === "desktop" ? "Browser" : "Desktop"}
          </button>
          <button className="icon-btn" onClick={() => setWin(null)} aria-label="Close window" title="Close"><Icon name="close" size={15} /></button>
        </div>
        <RemoteBrowser key={win.mode} conn={conn} mode={win.mode} command={win.mode === "browser" ? command : null} onCommandDone={onCommandDone}
          onReconnect={connect} onDownload={onDownload} notify={notify} />
      </div>
    );
  }

  return (
    <div className="view apps-home">
      <div className="home-head">
        <div>
          <h1>Apps</h1>
          <p className="muted small"><span className="dot ok" /> {conn.device.name} is online</p>
        </div>
        <label className="search home-search">
          <Icon name="search" size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search apps" aria-label="Search apps" />
        </label>
      </div>

      <section className="home-section">
        <h2>On {conn.device.name}</h2>
        <div className="tiles">
          {!q && <Tile label="Desktop" icon="device" onClick={() => setWin({ mode: "desktop", title: "Desktop", icon: "" })} title="The whole laptop screen" />}
          {!q && <Tile label="Browser" icon="globe" onClick={() => setWin({ mode: "browser", title: "Browser", icon: favicon("google.com") })} title="The laptop's Chrome, where you left off" />}
          {!q && conn.vscode && (
            <Tile label="VS Code" img={favicon("code.visualstudio.com")} onClick={() => window.open(`https://vscode.dev/tunnel/${encodeURIComponent(conn.vscode)}`, "_blank", "noopener")} />
          )}
          {laptop.slice(0, q ? 200 : 40).map((name) => (
            <Tile key={name} label={name} busy={opening === name} onClick={() => openLaptop(name)}
              img={`${conn.base}/apps/icon?t=${encodeURIComponent(conn.files)}&name=${encodeURIComponent(name)}`} />
          ))}
          {laptopApps === null && <p className="muted small">Loading the laptop&apos;s apps...</p>}
        </div>
        {!q && laptop.length > 40 && <p className="muted small">{laptop.length - 40} more: search to find them.</p>}
      </section>

      <section className="home-section">
        <h2>Web</h2>
        <div className="tiles">
          {web.map((a) => <Tile key={a.label} label={a.label} img={favicon(a.domain)} onClick={() => openWeb(a)} />)}
        </div>
      </section>

      {!q && (
        <section className="home-section">
          <h2>JARVIS</h2>
          <div className="tiles">
            <Tile label="Files" icon="folder" onClick={() => onView("files")} />
            <Tile label="Code" icon="code" onClick={() => onView("code")} />
            <Tile label="Tasks" icon="tasks" onClick={() => onView("tasks")} />
            <Tile label="Memory" icon="memory" onClick={() => onView("memory")} />
            {tools.map((t) => <Tile key={t.name} label={t.name.replace(/_/g, " ")} icon="tool" title={t.description} onClick={() => onView("tasks")} />)}
          </div>
        </section>
      )}

      <Downloads conn={conn} refreshKey={refresh} autosave={autosave} onAutosave={(on) => { setAutosave(on); store.set(AUTOSAVE_KEY, on ? "1" : "0"); }} />
    </div>
  );
}
