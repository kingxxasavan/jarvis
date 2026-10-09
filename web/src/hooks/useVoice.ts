"use client";
// Voice in the browser, with nothing to install: the Web Speech API for
// listening (Chrome, Edge, ChromeOS) and the system's own voices for speaking,
// preferring a British male voice. Esc or a click on the orb stops speech.
import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "@/lib/client/api";

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

const PREFERRED = [/Google UK English Male/i, /Microsoft (Ryan|Thomas|George)/i, /\bDaniel\b/i, /\bArthur\b/i, /en-GB/i];
export const VOICE_KEY = "jarvis.voice";
export const RATE_KEY = "jarvis.rate";

export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code is on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link on screen")
    .replace(/[*_#>|]/g, "")
    .replace(/\be\.g\./gi, "for example")
    .replace(/\bi\.e\./gi, "that is")
    .replace(/\s+/g, " ")
    .trim();
}

// Chrome cuts off utterances longer than ~15 s, so speech goes out in chunks.
function chunks(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > 220 && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function pickVoice(voices: SpeechSynthesisVoice[], saved: string | null) {
  if (saved) {
    const v = voices.find((x) => x.name === saved);
    if (v) return v;
  }
  for (const re of PREFERRED) {
    const v = voices.find((x) => re.test(x.name) || re.test(x.lang));
    if (v) return v;
  }
  return voices.find((v) => v.lang.startsWith("en")) || voices[0] || null;
}

export function useVoice(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState({ listen: false, speak: false });
  const [error, setError] = useState("");
  const level = useRef(0);
  const rec = useRef<Recognition | null>(null);
  const audio = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);
  const final = useRef(onFinal);
  final.current = onFinal;

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    setSupported({ listen: !!(w.SpeechRecognition || w.webkitSpeechRecognition), speak: "speechSynthesis" in window });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.speechSynthesis?.cancel();
    };
    window.addEventListener("keydown", onKey);
    window.speechSynthesis?.getVoices();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stopMeter = () => {
    if (!audio.current) return;
    cancelAnimationFrame(audio.current.raf);
    audio.current.stream.getTracks().forEach((t) => t.stop());
    void audio.current.ctx.close();
    audio.current = null;
    level.current = 0;
  };

  const startMeter = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        level.current = level.current * 0.6 + Math.min(1, peak / 50) * 0.4;
        if (audio.current) audio.current.raf = requestAnimationFrame(tick);
      };
      audio.current = { stream, ctx, raf: requestAnimationFrame(tick) };
    } catch {
      // The meter only animates the orb; recognition works without it.
    }
  };

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    level.current = 0;
  }, []);

  const listen = useCallback(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setError("This browser cannot listen. Chrome or Edge can.");
      return;
    }
    if (rec.current) {
      rec.current.stop();
      return;
    }
    stopSpeaking();
    setError("");
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    let said = "";
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      said = text;
      setInterim(text);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed") setError("Microphone access is blocked for this site.");
      else if (e.error !== "no-speech" && e.error !== "aborted") setError(`Listening failed (${e.error}).`);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
      stopMeter();
      if (said.trim()) final.current(said.trim());
    };
    rec.current = r;
    setListening(true);
    void startMeter();
    r.start();
  }, [stopSpeaking]);

  const speak = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    const clean = cleanForSpeech(text);
    if (!synth || !clean) return;
    synth.cancel();
    const voice = pickVoice(synth.getVoices(), store.get(VOICE_KEY));
    const rate = Number(store.get(RATE_KEY)) || 1;
    const parts = chunks(clean);
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      if (voice) u.voice = voice;
      u.rate = rate;
      u.pitch = 0.95;
      u.onstart = () => setSpeaking(true);
      u.onboundary = () => {
        level.current = 0.55 + Math.random() * 0.45;
      };
      u.onend = u.onerror = () => {
        if (i === parts.length - 1) {
          setSpeaking(false);
          level.current = 0;
        }
      };
      synth.speak(u);
    });
  }, []);

  useEffect(() => {
    if (!speaking) return;
    const id = setInterval(() => {
      level.current *= 0.85;
    }, 60);
    return () => clearInterval(id);
  }, [speaking]);

  return { listening, speaking, interim, supported, error, level, listen, speak, stopSpeaking };
}
