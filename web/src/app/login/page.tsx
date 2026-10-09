"use client";
import { useEffect, useState } from "react";
import { Orb } from "@/components/Orb";
import { browserClient } from "@/lib/supabase/browser";

type Step = "password" | "mfa";

export default function Login() {
  const sb = browserClient();
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("denied")) setError("That account does not have access to this JARVIS.");
    if (params.get("mfa")) setStep("mfa");
    sb.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => {
      if (data?.nextLevel === "aal2" && data.currentLevel !== "aal2") setStep("mfa");
    });
  }, [sb]);

  const finish = async () => {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.nextLevel === "aal2" && data.currentLevel !== "aal2") {
      setStep("mfa");
      return;
    }
    window.location.href = "/";
  };

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setError(error.message === "Invalid login credentials" ? "Wrong email or password." : error.message);
      return;
    }
    setPassword("");
    await finish();
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { data: factors } = await sb.auth.mfa.listFactors();
    const totp = factors?.totp?.find((f) => f.status === "verified");
    if (!totp) {
      setBusy(false);
      setError("No authenticator is set up for this account.");
      return;
    }
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: code.trim() });
    setBusy(false);
    if (error) {
      setError("That code did not match. Codes change every 30 seconds.");
      return;
    }
    window.location.href = "/";
  };

  return (
    <main className="login">
      <div className="backdrop" aria-hidden="true" />
      <div className="login-card">
        <Orb state={busy ? "thinking" : "idle"} size={150} />
        <h1 className="wordmark big">J.A.R.V.I.S.</h1>
        <p className="muted small">Private system. Owner access only.</p>
        {step === "password" ? (
          <form onSubmit={signIn}>
            <input type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
            <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-label="Password" />
            <button className="btn primary wide" disabled={busy}>{busy ? "Verifying..." : "Sign in"}</button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="small">Enter the 6-digit code from your authenticator app.</p>
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus aria-label="Code" />
            <button className="btn primary wide" disabled={busy || code.length !== 6}>{busy ? "Checking..." : "Continue"}</button>
            <button type="button" className="btn ghost wide" onClick={async () => { await sb.auth.signOut(); setStep("password"); }}>
              Use a different account
            </button>
          </form>
        )}
        {error && <p className="err small">{error}</p>}
      </div>
    </main>
  );
}
