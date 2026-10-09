"use client";
// Sends browser errors to the server log (Vercel > Logs), so a crash on a phone
// or Chromebook leaves a readable trace with the real message and stack.
const sent = new Set<string>();

export function reportError(err: unknown, where: string) {
  const e = err instanceof Error ? err : new Error(String(err));
  const key = `${where}:${e.message}`;
  if (sent.has(key) || sent.size > 20) return;
  sent.add(key);
  try {
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where, message: e.message, stack: (e.stack || "").slice(0, 3000), agent: navigator.userAgent, url: location.pathname }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // reporting must never throw
  }
}

let installed = false;
export function installErrorReporter() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => reportError(e.error ?? e.message, "window"));
  window.addEventListener("unhandledrejection", (e) => reportError(e.reason, "promise"));
}
