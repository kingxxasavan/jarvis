"use client";
// Last resort when even the layout fails. Plain styles: the stylesheet may be what broke.
import { useEffect } from "react";
import { reportError } from "@/lib/client/report";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportError(error, "global"), [error]);
  return (
    <html lang="en">
      <body style={{ background: "#03080d", color: "#d4ecf8", font: "14px system-ui", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ maxWidth: 420, padding: 20, textAlign: "center" }}>
          <h1 style={{ fontWeight: 300, letterSpacing: "0.2em" }}>J.A.R.V.I.S.</h1>
          <p>Something crashed: {error.message || "unknown error"}</p>
          <button onClick={reset} style={{ padding: "8px 16px", marginRight: 8 }}>Try again</button>
          <button onClick={() => window.location.reload()} style={{ padding: "8px 16px" }}>Reload</button>
        </div>
      </body>
    </html>
  );
}
