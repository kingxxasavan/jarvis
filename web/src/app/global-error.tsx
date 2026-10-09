"use client";
// Last resort when the whole page fails. After a new deploy an open tab can ask
// for code that no longer exists; that case reloads once by itself. Anything
// else shows the actual error instead of a blank "This page couldn't load".
import { useEffect } from "react";
import "./globals.css";

const RELOADED = "jarvis.reloaded";

function isStaleBuild(error: Error) {
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
    `${error.name} ${error.message}`,
  );
}

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    try {
      if (isStaleBuild(error) && !sessionStorage.getItem(RELOADED)) {
        sessionStorage.setItem(RELOADED, "1");
        window.location.reload();
      }
    } catch {
      // storage blocked: just show the message
    }
  }, [error]);

  return (
    <html lang="en" translate="no">
      <body>
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
      </body>
    </html>
  );
}
