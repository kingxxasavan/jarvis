// Some open models (Nemotron, Qwen, gpt-oss on some hosts) occasionally write a
// tool call as text instead of using the API's tool_calls field, e.g.
//   <tool_call><function=pc_read_file><parameter=path>x.xlsx</parameter></function></tool_call>
//   <tool_call>{"name": "pc_read_file", "arguments": {"path": "x.xlsx"}}</tool_call>
// That text must never reach the screen, and the call should still run.
import type { ToolCall } from "./providers.ts";

const MARKERS = ["<tool_call>", "<function="];

// Holds back streamed text from the first marker on (and any trailing partial
// marker), so the markup is never shown while it is still arriving.
export class ToolTextGate {
  private text = "";
  private shown = 0;
  private held = false;

  push(delta: string): string {
    this.text += delta;
    if (this.held) return "";
    const at = Math.min(...MARKERS.map((m) => this.text.indexOf(m, this.shown)).map((i) => (i < 0 ? Infinity : i)));
    if (at !== Infinity) {
      this.held = true;
      const out = this.text.slice(this.shown, at);
      this.shown = at;
      return out;
    }
    let safe = this.text.length;
    for (const m of MARKERS) {
      for (let k = Math.min(m.length - 1, this.text.length); k > 0; k--) {
        if (this.text.endsWith(m.slice(0, k))) {
          safe = Math.min(safe, this.text.length - k);
          break;
        }
      }
    }
    const out = this.text.slice(this.shown, Math.max(this.shown, safe));
    this.shown = Math.max(this.shown, safe);
    return out;
  }

  // What is left to show, and any tool calls found in the held text.
  finish(): { rest: string; calls: ToolCall[] } {
    const tail = this.text.slice(this.shown);
    if (!this.held) return { rest: tail, calls: [] };
    const { calls, rest } = parseToolText(tail);
    return { rest: calls.length ? rest : tail, calls };
  }
}

function coerce(v: string): unknown {
  const t = v.trim();
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(t) || /^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  return t;
}

export function parseToolText(text: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const id = () => `call_txt_${Date.now().toString(36)}_${calls.length}`;
  let rest = text;

  const xml = /(?:<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)(?:\s*<\/tool_call>)?/g;
  rest = rest.replace(xml, (_m, name: string, body: string) => {
    const args: Record<string, unknown> = {};
    for (const p of body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g)) args[p[1]] = coerce(p[2]);
    calls.push({ id: id(), name, arguments: JSON.stringify(args) });
    return "";
  });

  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (m, body: string) => {
    try {
      const j = JSON.parse(body) as { name?: string; arguments?: unknown; parameters?: unknown };
      if (!j.name) return m;
      const a = j.arguments ?? j.parameters ?? {};
      calls.push({ id: id(), name: j.name, arguments: typeof a === "string" ? a : JSON.stringify(a) });
      return "";
    } catch {
      return m;
    }
  });

  return { calls, rest: rest.replace(/<\/?tool_call>/g, "").trim() };
}
