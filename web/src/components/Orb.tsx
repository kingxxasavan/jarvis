"use client";
// The JARVIS reactor: layered rings that turn at different speeds, drawn on a
// canvas. It idles slowly, brightens and follows the mic level when listening,
// spins up while thinking, and pulses with the voice while speaking.
import { useEffect, useRef, type MutableRefObject } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

const SPEED: Record<OrbState, number> = { idle: 1, listening: 1.5, thinking: 3.2, speaking: 1.3 };
const GLOW: Record<OrbState, number> = { idle: 0.75, listening: 1, thinking: 0.95, speaking: 1 };

type Arc = { r: number; w: number; from: number; len: number; speed: number; alpha: number };

const ARCS: Arc[] = [
  { r: 0.86, w: 0.035, from: 0.1, len: 0.7, speed: 0.12, alpha: 0.9 },
  { r: 0.86, w: 0.035, from: 1.4, len: 1.25, speed: 0.12, alpha: 0.75 },
  { r: 0.86, w: 0.035, from: 3.5, len: 0.45, speed: 0.12, alpha: 0.9 },
  { r: 0.86, w: 0.035, from: 4.6, len: 0.9, speed: 0.12, alpha: 0.55 },
  { r: 0.66, w: 0.06, from: 0.3, len: 1.0, speed: -0.2, alpha: 0.85 },
  { r: 0.66, w: 0.06, from: 1.75, len: 0.55, speed: -0.2, alpha: 0.6 },
  { r: 0.66, w: 0.06, from: 2.9, len: 1.3, speed: -0.2, alpha: 0.9 },
  { r: 0.66, w: 0.06, from: 4.8, len: 0.7, speed: -0.2, alpha: 0.7 },
  { r: 0.5, w: 0.022, from: 0.8, len: 2.2, speed: 0.33, alpha: 0.7 },
  { r: 0.5, w: 0.022, from: 3.9, len: 1.4, speed: 0.33, alpha: 0.5 },
];

export function Orb({ state, level, size = 300, onClick }: {
  state: OrbState;
  level?: MutableRefObject<number>;
  size?: number;
  onClick?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let angle = 0;
    let last = performance.now();
    let lastDraw = 0;
    let speed = 1;
    let glow = 0.75;
    let pulse = 0;
    let visible = true;
    // The parts that never change shape are drawn once per size into their own
    // canvases and then only rotated. Canvas shadows (blur) are the slow part on
    // phones and Chromebooks, so glow is faked with a wider faint stroke instead.
    let cache: { W: number; ticks: HTMLCanvasElement; rings: HTMLCanvasElement; inner: HTMLCanvasElement } | null = null;

    const layer = (W: number, paint: (c: CanvasRenderingContext2D, R: number) => void) => {
      const off = document.createElement("canvas");
      off.width = off.height = W;
      const c = off.getContext("2d")!;
      c.translate(W / 2, W / 2);
      paint(c, W * 0.47);
      return off;
    };

    const build = (W: number) => ({
      W,
      ticks: layer(W, (c, R) => {
        for (let i = 0; i < 180; i++) {
          const a = (i / 180) * Math.PI * 2;
          const long = i % 10 === 0;
          c.strokeStyle = `rgba(90,200,255,${long ? 0.55 : 0.22})`;
          c.lineWidth = W * (long ? 0.004 : 0.0025);
          c.beginPath();
          c.moveTo(Math.cos(a) * R, Math.sin(a) * R);
          c.lineTo(Math.cos(a) * R * (long ? 0.94 : 0.965), Math.sin(a) * R * (long ? 0.94 : 0.965));
          c.stroke();
        }
      }),
      rings: layer(W, (c, R) => {
        c.strokeStyle = "rgba(90,200,255,0.16)";
        c.lineWidth = W * 0.002;
        c.setLineDash([W * 0.006, W * 0.012]);
        c.beginPath();
        c.moveTo(-R, 0); c.lineTo(R, 0);
        c.moveTo(0, -R); c.lineTo(0, R);
        c.stroke();
        c.setLineDash([]);
        for (const [r, a] of [[0.92, 0.35], [0.76, 0.25], [0.58, 0.3], [0.42, 0.45], [0.34, 0.35], [0.27, 0.5]] as const) {
          c.strokeStyle = `rgba(90,205,255,${a * 0.35})`;
          c.lineWidth = W * 0.012;
          c.beginPath();
          c.arc(0, 0, R * r, 0, Math.PI * 2);
          c.stroke();
          c.strokeStyle = `rgba(90,205,255,${a})`;
          c.lineWidth = W * 0.003;
          c.stroke();
        }
      }),
      inner: layer(W, (c, R) => {
        for (let i = 0; i < 60; i++) {
          const a = (i / 60) * Math.PI * 2;
          c.strokeStyle = `rgba(150,225,255,${i % 5 === 0 ? 0.6 : 0.25})`;
          c.lineWidth = W * 0.0025;
          c.beginPath();
          c.moveTo(Math.cos(a) * R * 0.37, Math.sin(a) * R * 0.37);
          c.lineTo(Math.cos(a) * R * 0.39, Math.sin(a) * R * 0.39);
          c.stroke();
        }
      }),
    });

    const rotated = (img: HTMLCanvasElement, W: number, turn: number) => {
      g.save();
      g.rotate(turn);
      g.drawImage(img, -W / 2, -W / 2);
      g.restore();
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // About 30 frames a second is plenty for slow rings, and halves the work.
      if (!visible || now - lastDraw < 32) return;
      lastDraw = now;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const css = el.clientWidth;
      const px = Math.max(1, Math.round(css * dpr));
      if (el.width !== px || el.height !== px) {
        el.width = px;
        el.height = px;
      }
      const W = el.width;
      if (!cache || cache.W !== W) cache = build(W);
      const c = W / 2;
      const R = W * 0.47;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      speed += (SPEED[st] - speed) * 0.1;
      glow += (GLOW[st] - glow) * 0.1;
      const target = st === "thinking" ? 0.35 + 0.25 * Math.sin(now / 180) : level?.current ?? 0;
      pulse += (target - pulse) * 0.35;
      angle += dt * speed * (reduced ? 0.25 : 1);

      g.clearRect(0, 0, W, W);
      g.save();
      g.translate(c, c);

      const bloom = g.createRadialGradient(0, 0, R * 0.05, 0, 0, R * 1.05);
      bloom.addColorStop(0, `rgba(60,200,255,${0.22 * glow + pulse * 0.15})`);
      bloom.addColorStop(0.45, `rgba(20,120,255,${0.07 * glow})`);
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = bloom;
      g.beginPath();
      g.arc(0, 0, R * 1.05, 0, Math.PI * 2);
      g.fill();

      g.globalAlpha = Math.min(1, 0.75 + glow * 0.2 + pulse * 0.2);
      g.drawImage(cache.rings, -W / 2, -W / 2);
      g.globalAlpha = 1;
      rotated(cache.ticks, W, angle * 0.05);
      rotated(cache.inner, W, angle * 0.4);

      g.save();
      g.rotate(-angle * 0.15);
      g.setLineDash([W * 0.012, W * 0.02]);
      g.strokeStyle = `rgba(110,215,255,${0.45 * glow})`;
      g.lineWidth = W * 0.012;
      g.beginPath();
      g.arc(0, 0, R * 0.79, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.restore();

      g.lineCap = "butt";
      for (const s of ARCS) {
        const start = s.from + angle * s.speed * 3;
        const alpha = Math.min(1, s.alpha * glow + pulse * 0.25);
        g.beginPath();
        g.arc(0, 0, R * s.r, start, start + s.len);
        g.strokeStyle = `rgba(70,200,255,${alpha * 0.25})`;
        g.lineWidth = W * s.w * 1.4;
        g.stroke();
        g.strokeStyle = `rgba(70,200,255,${alpha})`;
        g.lineWidth = W * s.w * 0.5;
        g.stroke();
      }

      const coreR = R * (0.16 + pulse * 0.05);
      const core = g.createRadialGradient(0, 0, 0, 0, 0, coreR * 2.4);
      core.addColorStop(0, "rgba(235,250,255,1)");
      core.addColorStop(0.2, `rgba(120,220,255,${0.95 * glow})`);
      core.addColorStop(0.5, `rgba(30,140,255,${0.45 * glow})`);
      core.addColorStop(1, "rgba(0,60,160,0)");
      g.fillStyle = core;
      g.beginPath();
      g.arc(0, 0, coreR * 2.4, 0, Math.PI * 2);
      g.fill();

      g.restore();
    };

    // Nothing is drawn while the orb is off screen or the browser tab is hidden.
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting && !document.hidden;
    });
    io.observe(el);
    const onVis = () => {
      visible = !document.hidden;
      last = performance.now();
    };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [level]);

  return (
    <button
      type="button"
      className="orb"
      style={{ ["--orb" as string]: `${size}px` }}
      onClick={onClick}
      aria-label={state === "speaking" ? "Stop speaking" : "Talk to Jarvis"}
      title={state === "speaking" ? "Stop speaking (Esc)" : "Click to talk"}
    >
      <canvas ref={canvas} />
    </button>
  );
}
