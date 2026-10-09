"use client";
// Shown instead of Next's blank "This page couldn't load" when something in the
// page crashes. It tries to recover on its own once, and says what went wrong.
import { useEffect } from "react";
import { reportError } from "@/lib/client/report";

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportError(error, "page");
    const key = "jarvis.autoreset";
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - last > 30_000) {
      sessionStorage.setItem(key, String(Date.now()));
      const t = setTimeout(reset, 400);
      return () => clearTimeout(t);
    }
  }, [error, reset]);

  return (
    <main className="login">
      <div className="login-card">
        <h1 className="wordmark big">J.A.R.V.I.S.</h1>
        <p>Something on this page crashed.</p>
        <pre className="code" style={{ maxWidth: "100%" }}>{error.message || "Unknown error"}{error.digest ? ` (${error.digest})` : ""}</pre>
        <button className="btn primary wide" onClick={reset}>Try again</button>
        <button className="btn ghost wide" onClick={() => window.location.reload()}>Reload</button>
      </div>
    </main>
  );
}
