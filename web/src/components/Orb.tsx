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
    let speed = 1;
    let glow = 0.75;
    let pulse = 0;

    const draw = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const css = el.clientWidth;
      const px = Math.max(1, Math.round(css * dpr));
      if (el.width !== px || el.height !== px) {
        el.width = px;
        el.height = px;
      }
      const W = el.width;
      const c = W / 2;
      const R = W * 0.47;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      speed += (SPEED[st] - speed) * 0.05;
      glow += (GLOW[st] - glow) * 0.05;
      const target = st === "thinking" ? 0.35 + 0.25 * Math.sin(now / 180) : level?.current ?? 0;
      pulse += (target - pulse) * 0.25;
      angle += dt * speed * (reduced ? 0.25 : 1);

      g.clearRect(0, 0, W, W);
      g.save();
      g.translate(c, c);

      // Soft bloom behind everything.
      const bloom = g.createRadialGradient(0, 0, R * 0.05, 0, 0, R * 1.05);
      bloom.addColorStop(0, `rgba(60,200,255,${0.22 * glow + pulse * 0.15})`);
      bloom.addColorStop(0.45, `rgba(20,120,255,${0.07 * glow})`);
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = bloom;
      g.beginPath();
      g.arc(0, 0, R * 1.05, 0, Math.PI * 2);
      g.fill();

      g.shadowColor = "rgba(60,200,255,0.9)";
      g.lineCap = "butt";

      // Crosshair.
      g.shadowBlur = 0;
      g.strokeStyle = "rgba(90,200,255,0.16)";
      g.lineWidth = W * 0.002;
      g.setLineDash([W * 0.006, W * 0.012]);
      g.beginPath();
      g.moveTo(-R, 0); g.lineTo(R, 0);
      g.moveTo(0, -R); g.lineTo(0, R);
      g.stroke();
      g.setLineDash([]);

      // Outer tick ring.
      g.save();
      g.rotate(angle * 0.05);
      for (let i = 0; i < 180; i++) {
        const a = (i / 180) * Math.PI * 2;
        const long = i % 10 === 0;
        g.strokeStyle = `rgba(90,200,255,${long ? 0.55 : 0.22})`;
        g.lineWidth = W * (long ? 0.004 : 0.0025);
        g.beginPath();
        g.moveTo(Math.cos(a) * R, Math.sin(a) * R);
        g.lineTo(Math.cos(a) * R * (long ? 0.94 : 0.965), Math.sin(a) * R * (long ? 0.94 : 0.965));
        g.stroke();
      }
      g.restore();

      // Thin full rings.
      for (const [r, a] of [[0.92, 0.35], [0.76, 0.25], [0.58, 0.3], [0.42, 0.45], [0.34, 0.35], [0.27, 0.5]] as const) {
        g.strokeStyle = `rgba(90,205,255,${a * glow + pulse * 0.2})`;
        g.lineWidth = W * 0.003;
        g.shadowBlur = W * 0.01;
        g.beginPath();
        g.arc(0, 0, R * (r + (r < 0.45 ? pulse * 0.025 : 0)), 0, Math.PI * 2);
        g.stroke();
      }

      // Dashed ring turning the other way.
      g.save();
      g.rotate(-angle * 0.15);
      g.setLineDash([W * 0.012, W * 0.02]);
      g.strokeStyle = `rgba(110,215,255,${0.45 * glow})`;
      g.lineWidth = W * 0.012;
      g.shadowBlur = 0;
      g.beginPath();
      g.arc(0, 0, R * 0.79, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.restore();

      // Segmented arcs.
      for (const s of ARCS) {
        const start = s.from + angle * s.speed * 3;
        g.strokeStyle = `rgba(70,200,255,${Math.min(1, s.alpha * glow + pulse * 0.25)})`;
        g.lineWidth = W * s.w * 0.5;
        g.shadowBlur = W * 0.025;
        g.beginPath();
        g.arc(0, 0, R * s.r, start, start + s.len);
        g.stroke();
      }

      // Inner fine ticks.
      g.save();
      g.rotate(angle * 0.4);
      g.shadowBlur = 0;
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2;
        g.strokeStyle = `rgba(150,225,255,${i % 5 === 0 ? 0.6 : 0.25})`;
        g.lineWidth = W * 0.0025;
        g.beginPath();
        g.moveTo(Math.cos(a) * R * 0.37, Math.sin(a) * R * 0.37);
        g.lineTo(Math.cos(a) * R * 0.39, Math.sin(a) * R * 0.39);
        g.stroke();
      }
      g.restore();

      // Core.
      const coreR = R * (0.16 + pulse * 0.05);
      const core = g.createRadialGradient(0, 0, 0, 0, 0, coreR * 1.9);
      core.addColorStop(0, "rgba(235,250,255,1)");
      core.addColorStop(0.25, `rgba(120,220,255,${0.95 * glow})`);
      core.addColorStop(0.6, `rgba(30,140,255,${0.45 * glow})`);
      core.addColorStop(1, "rgba(0,60,160,0)");
      g.shadowBlur = W * 0.05;
      g.fillStyle = core;
      g.beginPath();
      g.arc(0, 0, coreR * 1.9, 0, Math.PI * 2);
      g.fill();

      g.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
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
