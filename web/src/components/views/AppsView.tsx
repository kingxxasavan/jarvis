"use client";
import { useCallback, useEffect, useState } from "react";
import { api, store, timeAgo } from "@/lib/client/api";
import { Icon } from "../Icon";
import { RemoteBrowser, type StreamConn, type StreamMode } from "../RemoteBrowser";

const MODE_KEY = "jarvis.appsMode";

// Every app installed on the laptop (its Start Menu). Opening one switches to the
// Desktop view, where it can be used like any program on the laptop.
function LaptopApps({ onOpened, notify }: { onOpened: () => void; notify: (title: string, body?: string, tone?: "ok" | "err") => void }) {
  const [apps, setApps] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ result: { apps: string[] } }>("/api/devices/run", { method: "POST", json: { tool: "list_apps", args: { all: true } } })
      .then((r) => setApps(r.result.apps || []))
      .catch((err) => setError((err as Error).message));
  }, []);

  const open = async (name: string) => {
    setBusy(name);
    try {
      await api("/api/devices/run", { method: "POST", json: { tool: "open_app", args: { name } } });
      notify(`Opening ${name}`, "Showing the laptop screen.", "ok");
      onOpened();
    } catch (err) {
      notify(`Could not open ${name}`, (err as Error).message, "err");
    } finally {
      setBusy("");
    }
  };

  const shown = (apps || []).filter((a) => !query || a.toLowerCase().includes(query.toLowerCase()));
  return (
    <section className="panel laptop-apps">
      <h2><Icon name="spark" /> Laptop apps</h2>
      <label className="search">
        <Icon name="search" size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an app (Claude, Word...)" aria-label="Find an app" />
      </label>
      {error ? <p className="err small">{error}</p> : !apps ? <p className="empty small">Loading...</p> : (
        <ul className="rows app-list">
          {shown.slice(0, 200).map((a) => (
            <li key={a}>
              <button className="grow clip app-open" onClick={() => open(a)} disabled={!!busy} title={`Open ${a} on the laptop`}>
                {busy === a ? <i className="spin" /> : null} {a}
              </button>
            </li>
          ))}
          {!shown.length && <li className="muted small">No app matches.</li>}
        </ul>
      )}
    </section>
  );
}

type FileRow = { name: string; size: number; modified: number };

function size(n: number) {
  return n > 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : n > 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function Downloads({ conn, refreshKey }: { conn: StreamConn; refreshKey: number }) {
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
    <section className="panel downloads">
      <div className="row">
        <h2 className="grow"><Icon name="download" /> Downloads</h2>
        <button className="icon-btn" onClick={load} aria-label="Refresh downloads" title="Refresh"><Icon name="reload" size={14} /></button>
      </div>
      {error && <p className="err small">{error}</p>}
      {!files ? <p className="empty">Loading...</p> : !files.length ? (
        <p className="empty small">Nothing yet. Files you download in the browser, or ask Jarvis to download, land here on {conn.device.name}.</p>
      ) : (
        <ul className="rows">
          {files.map((f) => (
            <li key={f.name}>
              <span className="grow">
                <span className="clip">{f.name}</span>
                <span className="muted small">{size(f.size)} · {timeAgo(f.modified)}</span>
              </span>
              <a className="icon-btn" href={`${conn.base}/files/${encodeURIComponent(f.name)}?t=${encodeURIComponent(conn.files)}`}
                aria-label={`Save ${f.name} to this device`} title="Save to this device"><Icon name="download" size={14} /></a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AppsView({ command, onCommand, onCommandDone, onYouTube, notify }: {
  command: { url: string; n: number } | null;
  onCommand: (url: string) => void;
  onCommandDone: () => void;
  onYouTube: () => void;
  notify: (title: string, body?: string, tone?: "ok" | "err") => void;
}) {
  const [conn, setConn] = useState<StreamConn | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [mode, setModeState] = useState<StreamMode>("browser");

  useEffect(() => {
    if (store.get(MODE_KEY) === "desktop") setModeState("desktop");
  }, []);

  const setMode = useCallback((m: StreamMode) => {
    setModeState(m);
    store.set(MODE_KEY, m);
  }, []);

  // A launcher command (open Spotify...) always shows the browser.
  useEffect(() => {
    if (command?.url) setMode("browser");
  }, [command, setMode]);

  const connect = useCallback(async () => {
    setError("");
    try {
      const next = await api<StreamConn>("/api/stream");
      setConn({ ...next }); // always a new object, so the browser reconnects
    } catch (err) {
      setConn(null);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  const onDownload = useCallback(() => setRefresh((n) => n + 1), []);

  if (!conn) {
    return (
      <div className="view">
        <section className="panel apps-empty">
          <h2><Icon name="device" /> Apps</h2>
          <p>{error || "Connecting to your laptop..."}</p>
          {error && (
            <>
              <p className="muted small">
                Apps stream from a device running the JARVIS agent with Chrome and cloudflared installed
                (<code>winget install --id Cloudflare.cloudflared</code>).
              </p>
              <button className="btn" onClick={connect}><Icon name="reload" size={14} /> Try again</button>
            </>
          )}
        </section>
      </div>
    );
  }

  const launch = [
    { id: "browser", label: "Browser", icon: "globe", run: () => onCommand("https://www.google.com") },
    { id: "spotify", label: "Spotify", icon: "music", run: () => onCommand("https://open.spotify.com") },
    { id: "youtube", label: "YouTube", icon: "youtube", run: onYouTube },
    {
      id: "vscode", label: "VS Code", icon: "code",
      run: () => conn.vscode
        ? window.open(`https://vscode.dev/tunnel/${encodeURIComponent(conn.vscode)}`, "_blank", "noopener")
        : notify("VS Code is not set up", "On the laptop run `code tunnel service install`, then set VSCODE_TUNNEL in agent/.env.", "err"),
    },
  ];

  return (
    <div className="apps">
      <aside className="apps-side">
        <section className="panel">
          <h2><Icon name="device" /> {conn.device.name}</h2>
          <div className="mode-switch" role="tablist" aria-label="What to show">
            <button className={mode === "browser" ? "active" : ""} onClick={() => setMode("browser")} role="tab" aria-selected={mode === "browser"}>
              <Icon name="globe" size={14} /> Browser
            </button>
            <button className={mode === "desktop" ? "active" : ""} onClick={() => setMode("desktop")} role="tab" aria-selected={mode === "desktop"}>
              <Icon name="device" size={14} /> Desktop
            </button>
          </div>
          <div className="launchers">
            {launch.map((l) => (
              <button key={l.id} onClick={l.run}>
                <span className={`qicon ${l.id}`}><Icon name={l.icon} size={18} /></span>
                {l.label}
              </button>
            ))}
          </div>
          <p className="muted small">
            {mode === "desktop"
              ? "The whole laptop screen: every app works here. Click to focus, then type. Ctrl+V pastes your text."
              : "Click the page to type. Paste works with Ctrl+V; Ctrl+C copies selected text to this device."}
          </p>
        </section>
        <LaptopApps onOpened={() => setMode("desktop")} notify={notify} />
        <Downloads conn={conn} refreshKey={refresh} />
      </aside>
      <section className="apps-main">
        <RemoteBrowser key={mode} conn={conn} mode={mode} command={command} onCommandDone={onCommandDone}
          onReconnect={connect} onDownload={onDownload} notify={notify} />
      </section>
    </div>
  );
}
