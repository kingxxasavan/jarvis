"use client";
import { useCallback, useEffect, useState } from "react";
import { api, timeAgo } from "@/lib/client/api";
import { Icon } from "../Icon";
import { RemoteBrowser, type StreamConn } from "../RemoteBrowser";

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

export function AppsView({ command, onCommand, onYouTube, notify }: {
  command: { url: string; n: number } | null;
  onCommand: (url: string) => void;
  onYouTube: () => void;
  notify: (title: string, body?: string, tone?: "ok" | "err") => void;
}) {
  const [conn, setConn] = useState<StreamConn | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

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
                (<code>winget install --id Cloudflare.cloudflared</code>). Two-factor must be on.
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
          <div className="launchers">
            {launch.map((l) => (
              <button key={l.id} onClick={l.run}>
                <span className={`qicon ${l.id}`}><Icon name={l.icon} size={18} /></span>
                {l.label}
              </button>
            ))}
          </div>
          <p className="muted small">Click the page to type. Paste works with Ctrl+V; Ctrl+C copies selected text to this device.</p>
        </section>
        <Downloads conn={conn} refreshKey={refresh} />
      </aside>
      <section className="apps-main">
        <RemoteBrowser conn={conn} command={command} onReconnect={connect} onDownload={onDownload} notify={notify} />
      </section>
    </div>
  );
}
