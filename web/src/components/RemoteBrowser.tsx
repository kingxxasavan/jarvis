"use client";
// The laptop's Chrome, drawn on a canvas. Frames and sound arrive over one
// WebSocket through the Cloudflare tunnel; mouse, keyboard, touch and paste go
// back the same way. Binary messages: first byte 1 = JPEG frame, 2 = audio.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type StreamConn = { ws: string; base: string; files: string; vscode: string; device: { id: string; name: string } };
type Tab = { id: string; title: string; url: string; active: boolean };
type Status = "connecting" | "live" | "closed";

const QUALITY: Record<string, number> = { low: 40, normal: 60, sharp: 80 };

function mods(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function RemoteBrowser({ conn, command, onReconnect, onDownload, notify }: {
  conn: StreamConn;
  command: { url: string; n: number } | null;
  onReconnect: () => void;
  onDownload: () => void;
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
  const [status, setStatus] = useState<Status>("connecting");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [address, setAddress] = useState("");
  const [sound, setSound] = useState(false);
  const [quality, setQuality] = useState("normal");

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
      const bmp = await createImageBitmap(blob);
      const c = canvas.current;
      const g = c?.getContext("2d");
      if (c && g) {
        if (c.width !== bmp.width || c.height !== bmp.height) {
          c.width = bmp.width;
          c.height = bmp.height;
        }
        g.drawImage(bmp, 0, 0);
      }
      bmp.close();
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
    const pcm = new Int16Array(buf, 1, (buf.byteLength - 1) >> 1);
    const ab = a.ctx.createBuffer(1, pcm.length, 24000);
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

  const measure = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (r && r.width > 0) view.current = { w: Math.max(320, Math.floor(r.width)), h: Math.max(240, Math.floor(r.height)) };
  };

  // Connection. Each conn carries a fresh pass; a new conn object means a new socket.
  useEffect(() => {
    measure();
    const socket = new WebSocket(conn.ws);
    socket.binaryType = "arraybuffer";
    ws.current = socket;
    let retryTimer = 0;
    setStatus("connecting");
    socket.onopen = () => {
      retries.current = 0;
      setStatus("live");
      socket.send(JSON.stringify({ type: "view", width: view.current.w, height: view.current.h, quality: QUALITY[quality] }));
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
          onDownload();
        } else if (m.state === "started") notify("Downloading on the laptop", String(m.name));
      } else if (m.type === "clipboard" && m.text) {
        void navigator.clipboard?.writeText(String(m.text)).catch(() => undefined);
      } else if (m.type === "error") {
        notify("Browser", String(m.message), "err");
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
  }, [conn, draw, playAudio, notify, onDownload, onReconnect]);

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
        send({ type: "view", width: view.current.w, height: view.current.h, quality: QUALITY[quality] });
      }, 250);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [send, quality]);

  // Launcher commands wait until the connection is live, then run once each.
  const done = useRef(0);
  useEffect(() => {
    if (status === "live" && command?.url && command.n !== done.current) {
      done.current = command.n;
      send({ type: "new_tab", url: command.url });
    }
  }, [command, status, send]);

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
    const ctx = new AudioContext({ sampleRate: 24000 });
    audio.current = { ctx, next: 0 };
    send({ type: "audio", on: true });
    setSound(true);
  };

  // Input --------------------------------------------------------------------------

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvas.current?.focus();
    if (e.pointerType === "touch") {
      touch.current = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    send({ type: "mouse", kind: "down", ...point(e), button: e.button, buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") {
      const t = touch.current;
      if (!t) return;
      send({ type: "mouse", kind: "wheel", ...point(e), dx: (t.x - e.clientX) * 1.5, dy: (t.y - e.clientY) * 1.5, mods: 0 });
      touch.current = { ...t, x: e.clientX, y: e.clientY };
      return;
    }
    send({ type: "mouse", kind: "move", ...point(e), buttons: e.buttons, mods: mods(e) });
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
    send({ type: "mouse", kind: "up", ...point(e), button: e.button, buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
  };

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    send({ type: "mouse", kind: "wheel", x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height,
      dx: e.deltaX, dy: e.deltaY, mods: mods(e) });
  }, [send]);

  useEffect(() => {
    const c = canvas.current;
    c?.addEventListener("wheel", onWheel, { passive: false });
    return () => c?.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onKey = (kind: "down" | "up") => (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "v") return; // let the paste event carry the text
    if (ctrl && e.key.toLowerCase() === "c" && kind === "down") {
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
      <div className="rtabs" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} className={`rtab ${t.active ? "active" : ""}`} role="tab" aria-selected={t.active}>
            <button className="clip" onClick={() => send({ type: "switch_tab", id: t.id })} title={t.url}>{t.title || t.url || "New tab"}</button>
            <button className="x" onClick={() => send({ type: "close_tab", id: t.id })} aria-label="Close tab"><Icon name="close" size={12} /></button>
          </div>
        ))}
        <button className="icon-btn" onClick={() => send({ type: "new_tab", url: "" })} aria-label="New tab" title="New tab"><Icon name="plus" size={14} /></button>
      </div>
      <div className="rtoolbar">
        <button className="icon-btn" onClick={() => send({ type: "back" })} aria-label="Back" title="Back"><Icon name="back" size={15} /></button>
        <button className="icon-btn" onClick={() => send({ type: "forward" })} aria-label="Forward" title="Forward"><Icon name="forward" size={15} /></button>
        <button className="icon-btn" onClick={() => send({ type: "reload" })} aria-label="Reload" title="Reload"><Icon name="reload" size={15} /></button>
        <form className="raddress" onSubmit={(e) => { e.preventDefault(); editingUrl.current = false; send({ type: "navigate", url: address }); canvas.current?.focus(); }}>
          <Icon name="globe" size={14} />
          <input value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => { editingUrl.current = true; e.target.select(); }}
            onBlur={() => { editingUrl.current = false; }} placeholder="Search or type a web address" aria-label="Address" spellCheck={false} />
        </form>
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
          aria-label={`Browser on ${conn.device.name}${active ? `: ${active.title}` : ""}`}
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
        {status !== "live" && (
          <div className="roverlay">
            {status === "connecting" ? (
              <p><i className="spin" /> Connecting to {conn.device.name}...</p>
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
