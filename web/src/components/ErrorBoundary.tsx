"use client";
// Keeps one broken view from taking the whole HUD down. The chat, voice and any
// running task keep going; the broken part shows what failed and can retry.
import { Component, type ReactNode } from "react";
import { reportError } from "@/lib/client/report";

type Props = { children: ReactNode; name: string };
type State = { error: Error | null; tries: number };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, tries: 0 };
  private timer = 0;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    reportError(error, `view:${this.props.name}`);
    // One quiet automatic retry: most of these are a passing bad state.
    if (this.state.tries < 1) this.timer = window.setTimeout(() => this.retry(), 600);
  }

  componentWillUnmount() {
    clearTimeout(this.timer);
  }

  retry = () => this.setState((s) => ({ error: null, tries: s.tries + 1 }));

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view">
        <section className="panel crash">
          <h2>This part of JARVIS hit a problem</h2>
          <p className="muted small">The rest keeps working. The error was sent to the server log.</p>
          <pre className="code">{this.state.error.message || String(this.state.error)}</pre>
          <div className="row">
            <button className="btn primary" onClick={this.retry}>Try again</button>
            <button className="btn ghost" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </section>
      </div>
    );
  }
}
