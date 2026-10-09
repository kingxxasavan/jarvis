"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { pickVoice, RATE_KEY, VOICE_KEY } from "@/hooks/useVoice";
import { api, store, timeAgo } from "@/lib/client/api";
import { arkiaGoogleToken } from "@/lib/client/arkiaGoogle";
import { browserClient } from "@/lib/supabase/browser";
import { parseTakeout } from "@/lib/youtube/takeout";
import { Icon } from "../Icon";

type Notify = (title: string, body?: string, tone?: "ok" | "err") => void;
type Device = { id: string; name: string; platform: string; version: string; last_seen: string | null; online: boolean; tools: string[] };

function Section({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <section className="panel setting">
      <h2><Icon name={icon} /> {title}</h2>
      {children}
    </section>
  );
}

function Security({ notify, onChange }: { notify: Notify; onChange: () => void }) {
  const sb = browserClient();
  const [email, setEmail] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  const load = useCallback(async () => {
    const [{ data: u }, { data: f }] = await Promise.all([sb.auth.getUser(), sb.auth.mfa.listFactors()]);
    setEmail(u.user?.email || "");
    setEnabled(!!f?.totp?.some((x) => x.status === "verified"));
  }, [sb]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    const { data: f } = await sb.auth.mfa.listFactors();
    for (const old of f?.all || []) if (old.status === "unverified") await sb.auth.mfa.unenroll({ factorId: old.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `JARVIS ${Date.now()}` });
    if (error || !data) return notify("Could not start setup", error?.message, "err");
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };

  const verify = async () => {
    if (!enroll) return;
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enroll.id, code: code.trim() });
    if (error) return notify("That code did not match", error.message, "err");
    setEnroll(null);
    setCode("");
    notify("Two-factor is on", "You will be asked for a code when you sign in.", "ok");
    await load();
    onChange();
  };

  const signOut = async () => {
    await sb.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <Section icon="shield" title="Account and security">
      <p className="muted small">Signed in as {email || "..."}</p>
      {enabled === null ? null : enabled ? (
        <p className="ok"><Icon name="check" size={14} /> Two-factor authentication is on.</p>
      ) : enroll ? (
        <div className="mfa">
          <img src={enroll.qr} alt="Scan with an authenticator app" width={160} height={160} />
          <div className="grow">
            <p className="small">Scan with Google Authenticator, 1Password or Authy, then enter the 6-digit code.</p>
            <p className="muted small">Or enter this key: <code>{enroll.secret}</code></p>
            <div className="row">
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456" aria-label="Code" />
              <button className="btn primary" onClick={verify} disabled={code.length !== 6}>Verify</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="small">Two-factor is required before Jarvis may control your devices.</p>
          <button className="btn primary" onClick={start}><Icon name="shield" size={14} /> Turn on two-factor</button>
        </>
      )}
      <button className="btn ghost" onClick={signOut}><Icon name="logout" size={14} /> Sign out</button>
    </Section>
  );
}

function Devices({ notify }: { notify: Notify }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [name, setName] = useState("");
  const [code, setCode] = useState<{ name: string; code: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices((await api<{ devices: Device[] }>("/api/devices")).devices);
    } catch {
      // shown as empty
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const pair = async () => {
    try {
      const res = await api<{ name: string; code: string }>("/api/devices", { method: "POST", json: { name } });
      setCode(res);
      setName("");
      await load();
    } catch (err) {
      notify("Could not add the device", (err as Error).message, "err");
    }
  };

  const remove = async (d: Device) => {
    if (!confirm(`Remove ${d.name}? Its agent stops working until it is paired again.`)) return;
    await api(`/api/devices?id=${d.id}`, { method: "DELETE" }).catch((err) => notify("Not removed", err.message, "err"));
    await load();
  };

  return (
    <Section icon="device" title="Devices">
      <p className="small">The agent runs on your laptop or PC and checks in for work. Nothing on your network is opened to the internet.</p>
      <ul className="rows">
        {devices.map((d) => (
          <li key={d.id}>
            <span className={`dot ${d.online ? "ok" : "idle"}`} />
            <span className="grow">
              {d.name} <span className="muted small">{d.platform || "not connected yet"}{d.version ? ` · v${d.version}` : ""} · {d.tools.length} abilities</span>
            </span>
            <span className="muted small">{d.online ? "online" : d.last_seen ? timeAgo(d.last_seen) : "never"}</span>
            <button className="icon-btn" onClick={() => remove(d)} aria-label={`Remove ${d.name}`}><Icon name="trash" size={14} /></button>
          </li>
        ))}
        {!devices.length && <li className="muted">No devices yet.</li>}
      </ul>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Device name, e.g. Laptop" aria-label="Device name" />
        <button className="btn" onClick={pair} disabled={!name.trim()}><Icon name="plus" size={14} /> Add device</button>
      </div>
      {code && (
        <div className="pairing">
          <p className="small">On <strong>{code.name}</strong>, in the <code>agent</code> folder, run this once. The code is shown only now.</p>
          <pre className="code select">python main.py pair {code.code}</pre>
          <div className="row">
            <button className="btn small" onClick={() => navigator.clipboard.writeText(`python main.py pair ${code.code}`).then(() => notify("Copied", undefined, "ok"))}>Copy</button>
            <button className="btn small ghost" onClick={() => setCode(null)}>Done</button>
          </div>
        </div>
      )}
    </Section>
  );
}

function Arkia({ notify, onChange }: { notify: Notify; onChange: () => void }) {
  const [conn, setConn] = useState<{ email: string } | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setConn((await api<{ connection: { email: string } | null }>("/api/arkia").catch(() => ({ connection: null }))).connection);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (body: Record<string, string>) => {
    setBusy(true);
    try {
      await api("/api/arkia", { method: "POST", json: body });
      setPassword("");
      notify("arkia.buzz linked", "Calendar, tasks and messages are now available to Jarvis.", "ok");
      await load();
      onChange();
    } catch (err) {
      notify("Could not link arkia", (err as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    try {
      const t = await arkiaGoogleToken();
      await connect({ refreshToken: t.refreshToken, email: t.email });
    } catch (err) {
      notify("Google sign-in failed", (err as Error).message, "err");
    }
  };

  const unlink = async () => {
    await api("/api/arkia", { method: "DELETE" }).catch(() => undefined);
    await load();
    onChange();
  };

  return (
    <Section icon="calendar" title="arkia.buzz">
      {conn === undefined ? null : conn ? (
        <>
          <p className="ok"><Icon name="check" size={14} /> Linked as {conn.email || "your account"}.</p>
          <button className="btn ghost" onClick={unlink}>Unlink</button>
        </>
      ) : (
        <>
          <p className="small">Lets Jarvis read your calendar, tasks and reminders, add items, and tell you when a friend messages you. Your password is used once to get a sign-in token and is never stored.</p>
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void connect({ email, password }); }}>
            <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="arkia email" aria-label="arkia email" />
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="arkia password" aria-label="arkia password" />
            <button className="btn primary" disabled={busy || !email || !password}>Link</button>
          </form>
          <button className="btn ghost" onClick={google} disabled={busy}>Use Google sign-in instead</button>
        </>
      )}
    </Section>
  );
}

function Imports({ notify, onChange }: { notify: Notify; onChange: () => void }) {
  const [status, setStatus] = useState("");

  const profile = async (file: File) => {
    setStatus("Importing profile...");
    try {
      const doc = JSON.parse(await file.text());
      const { added } = await api<{ added: number }>("/api/memory/import", { method: "POST", json: doc });
      setStatus(`Imported ${added} memories from your profile.`);
      onChange();
    } catch (err) {
      setStatus("");
      notify("Import failed", (err as Error).message, "err");
    }
  };

  const history = async (file: File) => {
    try {
      setStatus("Reading watch history...");
      const entries = parseTakeout(JSON.parse(await file.text()));
      let done = 0;
      for (let i = 0; i < entries.length; i += 1000) {
        const { imported } = await api<{ imported: number }>("/api/youtube", { method: "POST", json: { history: entries.slice(i, i + 1000) } });
        done += imported;
        setStatus(`Imported ${Math.min(i + 1000, entries.length)} of ${entries.length}...`);
      }
      setStatus(`Watch history imported: ${done} new entries.`);
    } catch (err) {
      setStatus("");
      notify("Import failed", (err as Error).message, "err");
    }
  };

  const pick = (accept: string, fn: (f: File) => void) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => input.files?.[0] && fn(input.files[0]);
    input.click();
  };

  return (
    <Section icon="memory" title="Import">
      <p className="small">
        <strong>About-me profile</strong> (about_me_complete.json): becomes memories. Older or unconfirmed details are marked so Jarvis checks them
        with you instead of assuming. Re-importing replaces the previous import; what Jarvis learned in conversation is kept.
      </p>
      <button className="btn" onClick={() => pick(".json,application/json", profile)}>Import profile JSON</button>
      <p className="small">
        <strong>YouTube watch history</strong>: from Google Takeout (YouTube and YouTube Music, history, JSON format), the file
        <code> watch-history.json</code>. Lets Jarvis replay things you watched anywhere.
      </p>
      <button className="btn" onClick={() => pick(".json,application/json", history)}>Import watch history</button>
      {status && <p className="muted small">{status}</p>}
    </Section>
  );
}

function Voice({ notify }: { notify: Notify }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [perm, setPerm] = useState<string>("default");

  useEffect(() => {
    const load = () => {
      const list = window.speechSynthesis?.getVoices() || [];
      setVoices(list.filter((v) => v.lang.startsWith("en")));
      setVoice(pickVoice(list, store.get(VOICE_KEY))?.name || "");
    };
    load();
    window.speechSynthesis?.addEventListener("voiceschanged", load);
    setRate(Number(store.get(RATE_KEY)) || 1);
    setPerm("Notification" in window ? Notification.permission : "unsupported");
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", load);
  }, []);

  const test = () => {
    const u = new SpeechSynthesisUtterance("At your service, Sir. All systems are online.");
    const v = voices.find((x) => x.name === voice);
    if (v) u.voice = v;
    u.rate = rate;
    u.pitch = 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };

  return (
    <Section icon="speaker" title="Voice and alerts">
      <div className="row wrap">
        <select value={voice} onChange={(e) => { setVoice(e.target.value); store.set(VOICE_KEY, e.target.value); }} aria-label="Voice">
          {voices.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
        </select>
        <label className="small row">Speed
          <input type="range" min={0.8} max={1.3} step={0.05} value={rate}
            onChange={(e) => { setRate(Number(e.target.value)); store.set(RATE_KEY, e.target.value); }} />
        </label>
        <button className="btn" onClick={test}><Icon name="play" size={14} /> Test</button>
      </div>
      <p className="muted small">Voices come from this device. On Chrome, &quot;Google UK English Male&quot; is the closest to JARVIS. Press Esc or click the orb to stop speech.</p>
      {perm === "default" && (
        <button className="btn" onClick={async () => { setPerm(await Notification.requestPermission()); notify("Alerts updated", undefined, "ok"); }}>
          Allow desktop alerts for messages and reminders
        </button>
      )}
      {perm === "granted" && <p className="ok small"><Icon name="check" size={14} /> Desktop alerts are on.</p>}
      {perm === "denied" && <p className="muted small">Desktop alerts are blocked in this browser&apos;s site settings.</p>}
    </Section>
  );
}

export function SettingsView({ notify, onChange }: { notify: Notify; onChange: () => void }) {
  return (
    <div className="view settings-grid">
      <Security notify={notify} onChange={onChange} />
      <Devices notify={notify} />
      <Arkia notify={notify} onChange={onChange} />
      <Imports notify={notify} onChange={onChange} />
      <Voice notify={notify} />
    </div>
  );
}
