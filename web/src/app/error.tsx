"use client";
// Shown inside the normal layout when a page fails; see global-error.tsx for
// the stale-build reload.
import { useEffect } from "react";

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="view">
      <section className="panel apps-empty" role="alert">
        <h2>JARVIS hit a problem</h2>
        <p className="muted small"><code>{error.message || "Unknown error"}{error.digest ? ` (${error.digest})` : ""}</code></p>
        <div className="row">
          <button className="btn primary" onClick={reset}>Try again</button>
          <button className="btn ghost" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </section>
    </div>
  );
}
