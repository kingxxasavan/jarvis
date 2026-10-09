"use client";
// Files: the laptop's folders (browse, view, download to this device, upload,
// open on the laptop) and cloud files (copies kept in the JARVIS database's
// storage, reachable from any computer, even when the laptop is off).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, timeAgo } from "@/lib/client/api";
import { browserClient } from "@/lib/supabase/browser";
import { Icon } from "../Icon";
import type { StreamConn } from "../RemoteBrowser";

type Notify = (title: string, body?: string, tone?: "ok" | "err") => void;
type Item = { name: string; dir: boolean; size: number; modified: number };
type Listing = { path: string; parent: string; items: Item[]; roots: { label: string; path: string }[]; cloud: boolean };
type CloudFile = { id: string; name: string; size: number; content_type: string; status: string; source: string; created_at: string; url: string | null };

export function size(n: number) {
  return n > 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : n > 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const VIEWABLE = /\.(png|jpe?g|gif|webp|svg|bmp|pdf|txt|md|csv|json|log|mp4|webm|mov|mp3|wav|ogg|m4a|html?)$/i;
const sep = (p: string) => (p.includes("\\") ? "\\" : "/");

function Preview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const kind = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name) ? "img" : /\.(mp4|webm|mov)$/i.test(name) ? "video"
    : /\.(mp3|wav|ogg|m4a)$/i.test(name) ? "audio" : "frame";
  return (
    <div className="preview" role="dialog" aria-label={name} onClick={onClose}>
      <div className="preview-card" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <span className="grow clip strong">{name}</span>
          <a className="icon-btn" href={url} target="_blank" rel="noreferrer noopener" title="Open in a new tab"><Icon name="external" size={14} /></a>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        {kind === "img" ? <img src={url} alt={name} /> : kind === "video" ? <video src={url} controls autoPlay playsInline />
          : kind === "audio" ? <audio src={url} controls autoPlay /> : <iframe src={url} title={name} />}
      </div>
    </div>
  );
}

function Laptop({ conn, notify, onCloud }: { conn: StreamConn; notify: Notify; onCloud: () => void }) {
  const [list, setList] = useState<Listing | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [view, setView] = useState<{ url: string; name: string } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const t = encodeURIComponent(conn.files);
  const fileUrl = (full: string, inline = false) => `${conn.base}/fs/get?t=${t}&path=${encodeURIComponent(full)}${inline ? "&inline=1" : ""}`;

  const load = useCallback(async (p: string) => {
    setError("");
    try {
      const res = await fetch(`${conn.base}/fs/list?t=${t}&path=${encodeURIComponent(p)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404 && !data.error) throw new Error("The laptop agent needs updating for the file manager (git pull, py main.py setup, restart).");
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setList(data as Listing);
      setPath((data as Listing).path);
    } catch (err) {
      setError((err as Error).message || "Could not reach the laptop.");
    }
  }, [conn.base, t]);

  useEffect(() => {
    void load("");
  }, [load]);

  const post = async (action: "open" | "cloud", full: string, label: string) => {
    setBusy(full);
    try {
      const res = await fetch(`${conn.base}/fs/${action}?t=${t}&path=${encodeURIComponent(full)}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      notify(action === "open" ? `Opened ${label} on ${conn.device.name}` : `Saved ${label} to cloud files`, undefined, "ok");
      if (action === "cloud") onCloud();
    } catch (err) {
      notify(action === "open" ? "Could not open it" : "Cloud upload failed", (err as Error).message, "err");
    } finally {
      setBusy("");
    }
  };

  const send = async (files: FileList | null) => {
    if (!files?.length || !list) return;
    const form = new FormData();
    for (const f of Array.from(files)) form.append("file", f, f.name);
    setBusy("upload");
    try {
      const res = await fetch(`${conn.base}/fs/upload?t=${t}&path=${encodeURIComponent(list.path)}`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      notify(`Sent to ${conn.device.name}`, (data.saved as string[]).join(", "), "ok");
      await load(list.path);
    } catch (err) {
      notify("Upload failed", (err as Error).message, "err");
    } finally {
      setBusy("");
      if (upload.current) upload.current.value = "";
    }
  };

  const join = (name: string) => (list ? list.path.replace(/[\\/]+$/, "") + sep(list.path) + name : name);

  return (
    <section className="panel files-panel">
      <div className="row wrap">
        <h2 className="grow"><Icon name="device" /> {conn.device.name}</h2>
        <button className="btn small" onClick={() => upload.current?.click()} disabled={!list || busy === "upload"}>
          {busy === "upload" ? <i className="spin" /> : <Icon name="plus" size={14} />} Upload here
        </button>
        <input ref={upload} type="file" multiple hidden onChange={(e) => send(e.target.files)} />
      </div>
      {list && (
        <div className="roots">
          {list.roots.map((r) => (
            <button key={r.path} className={r.path === list.path ? "active" : ""} onClick={() => load(r.path)}>{r.label}</button>
          ))}
        </div>
      )}
      <form className="pathbar" onSubmit={(e) => { e.preventDefault(); void load(path); }}>
        <button type="button" className="icon-btn" onClick={() => list?.parent && load(list.parent)} disabled={!list?.parent} aria-label="Up one folder" title="Up">
          <Icon name="back" size={14} />
        </button>
        <input value={path} onChange={(e) => setPath(e.target.value)} aria-label="Folder path" spellCheck={false} />
        <button type="button" className="icon-btn" onClick={() => list && load(list.path)} aria-label="Refresh" title="Refresh"><Icon name="reload" size={14} /></button>
      </form>
      {error && <p className="err small">{error}</p>}
      {!list ? (!error && <p className="empty">Loading...</p>) : !list.items.length ? <p className="empty small">This folder is empty.</p> : (
        <ul className="rows files">
          {list.items.map((it) => {
            const full = join(it.name);
            return (
              <li key={it.name}>
                {it.dir ? (
                  <button className="grow file-name" onClick={() => load(full)}>
                    <Icon name="folder" size={15} /> <span className="clip">{it.name}</span>
                  </button>
                ) : (
                  <span className="grow file-name">
                    <Icon name="memory" size={15} />
                    <span className="grow">
                      <span className="clip">{it.name}</span>
                      <span className="muted small">{size(it.size)} · {timeAgo(it.modified)}</span>
                    </span>
                  </span>
                )}
                <span className="file-actions">
                  {!it.dir && VIEWABLE.test(it.name) && (
                    <button className="icon-btn" onClick={() => setView({ url: fileUrl(full, true), name: it.name })} title="View here" aria-label={`View ${it.name}`}>
                      <Icon name="search" size={14} />
                    </button>
                  )}
                  {!it.dir && (
                    <a className="icon-btn" href={fileUrl(full)} title="Download to this device" aria-label={`Download ${it.name}`}><Icon name="download" size={14} /></a>
                  )}
                  {!it.dir && list.cloud && (
                    <button className="icon-btn" onClick={() => post("cloud", full, it.name)} disabled={busy === full} title="Copy to cloud files" aria-label={`Copy ${it.name} to cloud`}>
                      {busy === full ? <i className="spin" /> : <Icon name="globe" size={14} />}
                    </button>
                  )}
                  <button className="icon-btn" onClick={() => post("open", full, it.name)} title={`Open on ${conn.device.name}`} aria-label={`Open ${it.name} on the laptop`}>
                    <Icon name="external" size={14} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {view && <Preview url={view.url} name={view.name} onClose={() => setView(null)} />}
    </section>
  );
}

function Cloud({ notify, refreshKey, laptop }: { notify: Notify; refreshKey: number; laptop: string }) {
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [view, setView] = useState<{ url: string; name: string } | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setFiles((await api<{ files: CloudFile[] }>("/api/cloud")).files);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load, refreshKey]);

  const send = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy("upload");
    for (const f of Array.from(list)) {
      try {
        const slot = await api<{ id: string; path: string; token: string }>("/api/cloud", { method: "POST", json: { name: f.name, size: f.size, type: f.type } });
        const { error: e } = await browserClient().storage.from("jarvis-files").uploadToSignedUrl(slot.path, slot.token, f, { contentType: f.type || undefined });
        await api("/api/cloud", { method: "POST", json: e ? { failed: slot.id } : { done: slot.id } });
        if (e) throw new Error(e.message);
        notify("Uploaded to cloud files", f.name, "ok");
      } catch (err) {
        notify(`Could not upload ${f.name}`, (err as Error).message, "err");
      }
    }
    setBusy("");
    if (upload.current) upload.current.value = "";
    await load();
  };

  const toLaptop = async (f: CloudFile) => {
    setBusy(f.id);
    try {
      const r = await api<{ device: string }>("/api/cloud", { method: "POST", json: { toDevice: f.id } });
      notify(`Sending to ${r.device}`, `${f.name} goes into the JARVIS downloads folder.`, "ok");
    } catch (err) {
      notify("Could not send it", (err as Error).message, "err");
    } finally {
      setBusy("");
    }
  };

  const remove = async (f: CloudFile) => {
    if (!confirm(`Delete ${f.name} from cloud files?`)) return;
    await api(`/api/cloud?id=${f.id}`, { method: "DELETE" }).catch((err) => notify("Not deleted", (err as Error).message, "err"));
    await load();
  };

  return (
    <section className="panel files-panel">
      <div className="row wrap">
        <h2 className="grow"><Icon name="globe" /> Cloud files</h2>
        <button className="btn small" onClick={() => upload.current?.click()} disabled={busy === "upload"}>
          {busy === "upload" ? <i className="spin" /> : <Icon name="plus" size={14} />} Upload
        </button>
        <input ref={upload} type="file" multiple hidden onChange={(e) => send(e.target.files)} />
      </div>
      <p className="muted small">Everything the laptop downloads is copied here (up to 50 MB a file), so you can get it on any computer, even with the laptop off.</p>
      {error && <p className="err small">{error}</p>}
      {!files ? (!error && <p className="empty">Loading...</p>) : !files.length ? <p className="empty small">Nothing yet.</p> : (
        <ul className="rows files">
          {files.map((f) => (
            <li key={f.id}>
              <span className="grow file-name">
                <Icon name="download" size={15} />
                <span className="grow">
                  <span className="clip">{f.name}</span>
                  <span className="muted small">{size(f.size)} · {timeAgo(f.created_at)} · {f.status === "uploading" ? "uploading..." : f.source === "browser" ? "uploaded" : "from the laptop"}</span>
                </span>
              </span>
              <span className="file-actions">
                {f.url && VIEWABLE.test(f.name) && (
                  <button className="icon-btn" onClick={() => setView({ url: f.url!.replace(/[?&]download=[^&]*/, ""), name: f.name })} title="View here" aria-label={`View ${f.name}`}>
                    <Icon name="search" size={14} />
                  </button>
                )}
                {f.url && <a className="icon-btn" href={f.url} title="Download to this device" aria-label={`Download ${f.name}`}><Icon name="download" size={14} /></a>}
                {f.url && laptop && (
                  <button className="icon-btn" onClick={() => toLaptop(f)} disabled={busy === f.id} title={`Save on ${laptop}`} aria-label={`Save ${f.name} on the laptop`}>
                    {busy === f.id ? <i className="spin" /> : <Icon name="device" size={14} />}
                  </button>
                )}
                <button className="icon-btn" onClick={() => remove(f)} title="Delete" aria-label={`Delete ${f.name}`}><Icon name="trash" size={14} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {view && <Preview url={view.url} name={view.name} onClose={() => setView(null)} />}
    </section>
  );
}

export function FilesView({ notify }: { notify: Notify }) {
  const [conn, setConn] = useState<StreamConn | null>(null);
  const [error, setError] = useState("");
  const [cloudKey, setCloudKey] = useState(0);

  const connect = useCallback(async () => {
    setError("");
    try {
      setConn(await api<StreamConn>("/api/stream"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void connect();
    const id = setInterval(connect, 50 * 60_000); // passes last an hour
    return () => clearInterval(id);
  }, [connect]);

  return (
    <div className="view files-view">
      {conn ? (
        <Laptop conn={conn} notify={notify} onCloud={() => setCloudKey((n) => n + 1)} />
      ) : (
        <section className="panel files-panel">
          <h2><Icon name="device" /> Laptop</h2>
          <p className="small">{error || "Connecting to your laptop..."}</p>
          {error && <button className="btn small" onClick={connect}><Icon name="reload" size={14} /> Try again</button>}
        </section>
      )}
      <Cloud notify={notify} refreshKey={cloudKey} laptop={conn?.device.name || ""} />
    </div>
  );
}
