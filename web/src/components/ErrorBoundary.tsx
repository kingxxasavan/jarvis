"use client";
// Keeps one broken panel from taking the whole page down. The panel shows what
// went wrong and a retry; the rest of JARVIS keeps working. A new resetKey (for
// example switching tabs) clears the error.
import { Component, type ReactNode } from "react";
import { Icon } from "./Icon";

type Props = { children: ReactNode; resetKey?: string; label?: string };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="view">
        <section className="panel apps-empty" role="alert">
          <h2><Icon name="close" /> {this.props.label || "This section"} hit a problem</h2>
          <p className="muted small"><code>{error.message || String(error)}</code></p>
          <div className="row">
            <button className="btn primary" onClick={() => this.setState({ error: null })}><Icon name="reload" size={14} /> Try again</button>
            <button className="btn ghost" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </section>
      </div>
    );
  }
}
