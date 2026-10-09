"use client";
// The laptop's Chrome, drawn on a canvas. Frames and sound arrive over one
// WebSocket through the Cloudflare tunnel; mouse, keyboard, touch and paste go
// back the same way. Binary messages: first byte 1 = JPEG frame, 2 = audio.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type StreamConn = { ws: string; desktop?: string; base: string; files: string; vscode: string; device: { id: string; name: string } };
export type StreamMode = "browser" | "desktop";

type AudioCtor = typeof AudioContext;

// Web Audio, with the older Safari name, and on iPhone/iPad the "playback"
// session so the sound is not muted by the ring/silent switch.
function makeAudio(): AudioContext | null {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctor = w.AudioContext || w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = "playback";
  } catch {
    // older browsers
  }
  try {
    return new Ctor({ latencyHint: "interactive" });
  } catch {
    return new Ctor();
  }
}

// Decodes a JPEG frame. createImageBitmap is fastest; older Safari falls back to an <img>.
async function decode(blob: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; done: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(blob);
    return { img: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}
type Tab = { id: string; title: string; url: string; active: boolean };
type Status = "connecting" | "live" | "closed";

// JPEG quality and the share of full resolution sent. Lower = less data, less lag.
const QUALITY: Record<string, { quality: number; scale: number }> = {
  low: { quality: 40, scale: 0.6 },
  normal: { quality: 55, scale: 0.85 },
  sharp: { quality: 75, scale: 1 },
};

function mods(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function RemoteBrowser({ conn, mode = "browser", command, onCommandDone, onReconnect, onDownload, notify }: {
  conn: StreamConn;
  mode?: StreamMode;
  command: { url: string; n: number; match?: string } | null;
  onCommandDone: () => void;
  onReconnect: () => void;
  onDownload: (name?: string) => void;
  notify: (title: string, body?: string, tone?: "ok" | "err") => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef<HTMLInputElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const view = useRef({ w: 1280, h: 800 });
  const decoding = useRef(false);
  const pendingFrame = useRef<Blob | null>(null);
  const audio = useRef<{ ctx: AudioContext; next: number } | null>(null);
  const editingUrl = useRef(false);
  const touch = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const retries = useRef(0);
  const heard = useRef(0);
  const desktop = mode === "desktop";
  const [status, setStatus] = useState<Status>("connecting");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [address, setAddress] = useState("");
  const [sound, setSound] = useState(false);
  const [quality, setQuality] = useState("normal");
  const [chooser, setChooser] = useState<{ multiple: boolean; folder: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // A page on the laptop asked for a file: the file comes from this device.
  const sendFiles = async (list: FileList | null) => {
    if (!list?.length || !chooser) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of Array.from(list)) form.append("file", f, f.name);
      const res = await fetch(`${conn.base}/fs/upload?t=${encodeURIComponent(conn.files)}&path=${encodeURIComponent(chooser.folder)}`, { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { saved?: string[]; error?: string };
      if (!res.ok || !data.saved) throw new Error(data.error || `Upload failed (${res.status}).`);
      send({ type: "file_chosen", names: data.saved });
      setChooser(null);
    } catch (err) {
      notify("Could not send the file", (err as Error).message, "err");
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  };

  const send = useCallback((msg: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  const draw = useCallback(async (blob: Blob) => {
    if (decoding.current) {
      pendingFrame.current = blob; // keep only the newest frame while one is decoding
      return;
    }
    decoding.current = true;
    try {
      const frame = await decode(blob);
      const c = canvas.current;
      const g = c?.getContext("2d");
      if (c && g) {
        if (c.width !== frame.w || c.height !== frame.h) {
          c.width = frame.w;
          c.height = frame.h;
        }
        g.drawImage(frame.img, 0, 0);
      }
      frame.done();
    } catch {
      // a corrupt frame is skipped
    } finally {
      decoding.current = false;
      const next = pendingFrame.current;
      pendingFrame.current = null;
      if (next) void draw(next);
    }
  }, []);

  const playAudio = useCallback((buf: ArrayBuffer) => {
    const a = audio.current;
    if (!a) return;
    // Copy past the 1-byte header: an Int16Array cannot start at an odd byte offset.
    const pcm = new Int16Array(buf.slice(1, 1 + ((buf.byteLength - 1) & ~1)));
    if (!pcm.length) return;
    heard.current = Date.now();
    if (a.ctx.state === "suspended") void a.ctx.resume();
    const ab = a.ctx.createBuffer(1, pcm.length, 24000); // the context resamples to its own rate
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = a.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(a.ctx.destination);
    const now = a.ctx.currentTime;
    if (a.next < now + 0.04 || a.next > now + 0.6) a.next = now + 0.12; // re-sync on underrun or drift
    src.start(a.next);
    a.next += ab.duration;
  }, []);

  // The laptop screen is shrunk to fit what is asked for. A phone-sized panel
  // would make it unreadable, so desktop pictures are at least 1280 wide
  // (pinch-zoom or full screen to read them).
  const viewMsg = () => {
    const { w, h } = view.current;
    if (!desktop) return { type: "view", width: w, height: h, ...QUALITY[quality] };
    const k = Math.max(1, 1280 / w, Math.min(window.devicePixelRatio || 1, 2));
    return { type: "view", width: Math.round(w * k), height: Math.round(h * k), ...QUALITY[quality] };
  };

  const measure = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (r && r.width > 0) view.current = { w: Math.max(320, Math.floor(r.width)), h: Math.max(240, Math.floor(r.height)) };
  };

  // Connection. Each conn carries a fresh pass; a new conn object means a new socket.
  useEffect(() => {
    measure();
    const url = desktop ? conn.desktop : conn.ws;
    if (!url) {
      setStatus("closed");
      notify("Desktop streaming needs the updated agent", "On the laptop: git pull, then py main.py setup, then restart the agent.", "err");
      return;
    }
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    ws.current = socket;
    let retryTimer = 0;
    setStatus("connecting");
    socket.onopen = () => {
      retries.current = 0;
      setStatus("live");
      socket.send(JSON.stringify(viewMsg()));
      if (audio.current) socket.send(JSON.stringify({ type: "audio", on: true }));
    };
    socket.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const kind = new Uint8Array(ev.data, 0, 1)[0];
        if (kind === 1) void draw(new Blob([ev.data.slice(1)], { type: "image/jpeg" }));
        else if (kind === 2) playAudio(ev.data);
        return;
      }
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "tabs") {
        setTabs(m.tabs as Tab[]);
        if (!editingUrl.current) setAddress(String(m.url || ""));
      } else if (m.type === "download") {
        if (m.state === "completed") {
          notify("Download finished", String(m.name), "ok");
          onDownload(String(m.name));
        } else if (m.state === "started") notify("Downloading on the laptop", String(m.name));
      } else if (m.type === "clipboard" && m.text) {
        void navigator.clipboard?.writeText(String(m.text)).catch(() => undefined);
      } else if (m.type === "error") {
        notify(desktop ? "Desktop" : "Browser", String(m.message), "err");
      } else if (m.type === "file_chooser") {
        setChooser({ multiple: !!m.multiple, folder: String(m.folder || "") });
      } else if (m.type === "notice") {
        notify(String(m.message), undefined, "ok");
      } else if (m.type === "status" && m.message) {
        notify(desktop ? "Desktop" : "Browser", String(m.message));
      }
    };
    socket.onclose = () => {
      if (ws.current !== socket) return; // closed on purpose (unmount or replaced)
      if (retries.current < 5) {
        // Dropped (network blip, laptop restart): fetch a fresh pass and reconnect, backing off.
        const delay = 1000 * 2 ** retries.current;
        retries.current += 1;
        setStatus("connecting");
        retryTimer = window.setTimeout(onReconnect, delay);
      } else {
        setStatus("closed");
      }
    };
    return () => {
      clearTimeout(retryTimer);
      ws.current = null;
      socket.close();
    };
    // quality is applied through the "view" message, not by reconnecting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, desktop, draw, playAudio, notify, onDownload, onReconnect]);

  // Keep the remote page the same size as the panel.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        view.current = { w: Math.max(320, Math.floor(r.width)), h: Math.max(240, Math.floor(r.height)) };
        send(viewMsg());
      }, 250);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, quality, desktop]);

  // Launcher commands wait until the connection (and its tab list) is live,
  // then run once. An app that already has a tab is switched to instead of
  // opened again. The parent clears the command, so it never replays.
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  useEffect(() => {
    if (status !== "live" || !command?.url) return;
    const t = window.setTimeout(() => {
      const existing = command.match ? tabsRef.current.find((tab) => {
        try {
          return new URL(tab.url).hostname.endsWith(command.match!.replace(/^www\./, ""));
        } catch {
          return false;
        }
      }) : undefined;
      send(existing ? { type: "switch_tab", id: existing.id } : { type: "new_tab", url: command.url });
      onCommandDone();
    }, 400);
    return () => clearTimeout(t);
  }, [command, status, send, onCommandDone]);

  useEffect(() => () => {
    void audio.current?.ctx.close();
    audio.current = null;
  }, []);

  const toggleSound = () => {
    if (sound) {
      send({ type: "audio", on: false });
      void audio.current?.ctx.close();
      audio.current = null;
      setSound(false);
      return;
    }
    const ctx = makeAudio();
    if (!ctx) {
      notify("This browser cannot play streamed sound", undefined, "err");
      return;
    }
    // Unlock audio inside the tap itself (iPhone and Chromebook both require it).
    const blip = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = blip;
    src.connect(ctx.destination);
    src.start(0);
    void ctx.resume();
    audio.current = { ctx, next: 0 };
    heard.current = 0;
    send({ type: "audio", on: true });
    setSound(true);
    window.setTimeout(() => {
      if (audio.current?.ctx === ctx && !heard.current) {
        notify("No sound is arriving yet", "Play something on the laptop. If it stays silent, check the agent log for 'audio capture'.", "err");
      }
    }, 6000);
  };

  // Input --------------------------------------------------------------------------

  // Browser mode: the remote page is the panel's size, so panel pixels map 1:1.
  // Desktop mode: the screen picture is letterboxed inside the panel, so the
  // pointer is sent as a fraction of the picture (nx, ny).
  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    if (desktop) {
      const scale = Math.min(r.width / (c.width || 1), r.height / (c.height || 1));
      const w = c.width * scale;
      const h = c.height * scale;
      const nx = (e.clientX - r.left - (r.width - w) / 2) / w;
      const ny = (e.clientY - r.top - (r.height - h) / 2) / h;
      return { x: 0, y: 0, nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) };
    }
    return { x: ((e.clientX - r.left) * view.current.w) / r.width, y: ((e.clientY - r.top) * view.current.h) / r.height };
  };

  // At most one pointer move per screen refresh; only the latest position matters.
  const pendingMove = useRef<object | null>(null);
  const flushMove = () => {
    if (pendingMove.current) send(pendingMove.current);
    pendingMove.current = null;
  };
  const queueMove = (msg: object) => {
    const first = pendingMove.current === null;
    pendingMove.current = msg;
    if (first) {
      requestAnimationFrame(() => {
        if (pendingMove.current) send(pendingMove.current);
        pendingMove.current = null;
      });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvas.current?.focus();
    if (e.pointerType === "touch") {
      touch.current = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    flushMove();
    send({ type: "mouse", kind: "down", ...point(e), button: e.button, buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") {
      const t = touch.current;
      if (!t) return;
      const first = !wheel.current;
      const cur = wheel.current ?? { msg: {}, dx: 0, dy: 0 };
      cur.msg = { type: "mouse", kind: "wheel", ...point(e), mods: 0 };
      cur.dx += (t.x - e.clientX) * 1.5;
      cur.dy += (t.y - e.clientY) * 1.5;
      wheel.current = cur;
      if (first) {
        requestAnimationFrame(() => {
          const w = wheel.current;
          wheel.current = null;
          if (w) send({ ...w.msg, dx: w.dx, dy: w.dy });
        });
      }
      touch.current = { ...t, x: e.clientX, y: e.clientY };
      return;
    }
    queueMove({ type: "mouse", kind: "move", ...point(e), buttons: e.buttons, mods: mods(e) });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") {
      const t = touch.current;
      touch.current = null;
      if (t && Math.hypot(e.clientX - t.sx, e.clientY - t.sy) < 10) {
        const p = point(e);
        send({ type: "mouse", kind: "down", ...p, button: 0, buttons: 1, clicks: 1, mods: 0 });
        send({ type: "mouse", kind: "up", ...p, button: 0, buttons: 0, clicks: 1, mods: 0 });
      }
      return;
    }
    flushMove();
    send({ type: "mouse", kind: "up", ...point(e), button: e.button, buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
  };

  // Wheel events arrive many times per frame; they are added up and sent once
  // per screen refresh, so a scroll never queues behind itself.
  const wheel = useRef<{ msg: Record<string, unknown>; dx: number; dy: number } | null>(null);
  const pointRef = useRef(point);
  pointRef.current = point;
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    const first = !wheel.current;
    const cur = wheel.current ?? { msg: {}, dx: 0, dy: 0 };
    cur.msg = { type: "mouse", kind: "wheel", ...pointRef.current(e), mods: mods(e) };
    cur.dx += e.deltaX * scale;
    cur.dy += e.deltaY * scale;
    wheel.current = cur;
    if (first) {
      requestAnimationFrame(() => {
        const w = wheel.current;
        wheel.current = null;
        if (w) send({ ...w.msg, dx: w.dx, dy: w.dy });
      });
    }
  }, [send]);

  useEffect(() => {
    const c = canvas.current;
    c?.addEventListener("wheel", onWheel, { passive: false });
    return () => c?.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onKey = (kind: "down" | "up") => (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "v") return; // let the paste event carry the text
    if (!desktop && ctrl && e.key.toLowerCase() === "c" && kind === "down") {
      e.preventDefault();
      send({ type: "copy" });
      return;
    }
    e.preventDefault();
    send({ type: "key", kind, key: e.key, code: e.code, keyCode: e.keyCode, mods: mods(e) });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text) send({ type: "text", text });
  };

  const active = tabs.find((t) => t.active);

  return (
    <div className="rbrowser">
      {!desktop && <div className="rtabs" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} className={`rtab ${t.active ? "active" : ""}`} role="tab" aria-selected={t.active}>
            <button className="clip" onClick={() => send({ type: "switch_tab", id: t.id })} title={t.url}>{t.title || t.url || "New tab"}</button>
            <button className="x" onClick={() => send({ type: "close_tab", id: t.id })} aria-label="Close tab"><Icon name="close" size={12} /></button>
          </div>
        ))}
        <button className="icon-btn" onClick={() => send({ type: "new_tab", url: "" })} aria-label="New tab" title="New tab"><Icon name="plus" size={14} /></button>
      </div>}
      <div className="rtoolbar">
        {desktop ? (
          <span className="grow muted small rdesk-label"><Icon name="device" size={14} /> {conn.device.name} screen</span>
        ) : (<>
        <button className="icon-btn" onClick={() => send({ type: "back" })} aria-label="Back" title="Back"><Icon name="back" size={15} /></button>
        <button className="icon-btn" onClick={() => send({ type: "forward" })} aria-label="Forward" title="Forward"><Icon name="forward" size={15} /></button>
        <button className="icon-btn" onClick={() => send({ type: "reload" })} aria-label="Reload" title="Reload"><Icon name="reload" size={15} /></button>
        <form className="raddress" onSubmit={(e) => { e.preventDefault(); editingUrl.current = false; send({ type: "navigate", url: address }); canvas.current?.focus(); }}>
          <Icon name="globe" size={14} />
          <input value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => { editingUrl.current = true; e.target.select(); }}
            onBlur={() => { editingUrl.current = false; }} placeholder="Search or type a web address" aria-label="Address" spellCheck={false} />
        </form>
        </>)}
        <button className={`icon-btn ${sound ? "on" : ""}`} onClick={toggleSound} title={sound ? "Sound on" : "Sound off"} aria-label="Toggle sound">
          <Icon name={sound ? "speaker" : "mute"} size={15} />
        </button>
        <select value={quality} onChange={(e) => { setQuality(e.target.value); }} aria-label="Picture quality" title="Picture quality">
          <option value="low">Low data</option>
          <option value="normal">Normal</option>
          <option value="sharp">Sharp</option>
        </select>
        <button className="icon-btn mobile-only" onClick={() => keyboard.current?.focus()} aria-label="Keyboard" title="Keyboard"><Icon name="edit" size={15} /></button>
        <button className="icon-btn" onClick={() => wrap.current?.parentElement?.requestFullscreen?.()} aria-label="Full screen" title="Full screen"><Icon name="fullscreen" size={15} /></button>
      </div>
      <div className="rview" ref={wrap}>
        <canvas
          ref={canvas}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKey("down")}
          onKeyUp={onKey("up")}
          onPaste={onPaste}
          aria-label={desktop ? `${conn.device.name} screen` : `Browser on ${conn.device.name}${active ? `: ${active.title}` : ""}`}
        />
        <input
          ref={keyboard}
          className="soft-keyboard"
          aria-label="Type into the browser"
          onInput={(e) => {
            const v = e.currentTarget.value;
            if (v) send({ type: "text", text: v });
            e.currentTarget.value = "";
          }}
          onKeyDown={(e) => {
            if (["Backspace", "Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
              e.preventDefault();
              send({ type: "key", kind: "down", key: e.key, code: e.code, keyCode: e.keyCode, mods: 0 });
              send({ type: "key", kind: "up", key: e.key, code: e.code, keyCode: e.keyCode, mods: 0 });
            }
          }}
        />
        {chooser && (
          <div className="rchooser" role="dialog" aria-label="The page wants a file">
            <Icon name="upload" size={18} />
            <span className="grow">The page on {conn.device.name} wants {chooser.multiple ? "files" : "a file"}.</span>
            <button className="btn small primary" onClick={() => picker.current?.click()} disabled={uploading}>
              {uploading ? <i className="spin" /> : null} Choose from this device
            </button>
            <button className="btn small ghost" onClick={() => setChooser(null)}>Cancel</button>
            <input ref={picker} type="file" hidden multiple={chooser.multiple} onChange={(e) => sendFiles(e.target.files)} />
          </div>
        )}
        {status !== "live" && (
          <div className="roverlay">
            {status === "connecting" ? (
              <p><i className="spin" /> Connecting to {conn.device.name}{desktop ? "'s screen" : ""}...</p>
            ) : (
              <>
                <p>The connection to {conn.device.name} closed.</p>
                <button className="btn primary" onClick={() => { retries.current = 0; onReconnect(); }}>Reconnect</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
