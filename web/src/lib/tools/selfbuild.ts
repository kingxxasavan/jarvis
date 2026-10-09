// build_tool: Jarvis writes a new device tool itself, from its own knowledge,
// when Claude Code cannot (not installed, not signed in, out of credit, or it
// failed). The code is saved to the plugins table and installed on a device.
import { completeText } from "../ai/providers.ts";
import { isOnline, pickDevice, queueJob, waitForJob } from "../devices.ts";
import { str, type Tool } from "./types.ts";

const CONTRACT = `Write ONE complete Python file: a new tool for the JARVIS assistant on a Windows laptop.

Contract (follow exactly):
- Module docstring: one line saying what the tool does.
- A dict named TOOL:
    TOOL = {
        "name": "{name}",
        "description": "<what it does and when to use it, one or two sentences>",
        "parameters": {"type": "object", "properties": {...JSON schema...}, "required": [...]},
        "timeout": 30,
    }
- A function run(args: dict) -> dict | str that does the work and returns a short, plain result.
  Raise an exception with a clear message when something goes wrong.
- Python 3.12 standard library only, plus httpx and psutil if needed. No other packages, no API keys.
- Importing the file must have no side effects (no network calls, file writes or prints at import time).
- Never delete user files, change system settings, send messages or spend money.
- Under 250 lines, readable, with sensible error handling. Must work on Windows.

Reply with only the code in one \`\`\`python block.

What the tool should do:
{purpose}`;

function extractCode(reply: string): string {
  const fenced = reply.match(/```(?:python|py)?\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : reply).trim() + "\n";
}

export const selfBuildTools: Tool[] = [
  {
    name: "build_tool",
    description:
      "Write and install a new device tool yourself (Python), without Claude Code. Use when pc_create_plugin fails or is " +
      "unavailable, or for a simple tool you can write reliably. It is saved to the database, installed on the laptop and " +
      "switched on; the result says whether it loaded, and the exact error if not (fix it and call again).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "snake_case tool name, e.g. weather_alerts" },
        purpose: { type: "string", description: "What it does, its inputs and output, and any details that matter" },
        device: { type: "string", description: "Which device (default: most recently active)" },
      },
      required: ["name", "purpose"],
    },
    label: (a) => `Building tool ${str(a.name, 40)}`,
    async run(a, ctx) {
      const name = str(a.name, 41).toLowerCase().replace(/[^a-z0-9_]/g, "_");
      const purpose = str(a.purpose, 4000);
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) return { error: "Tool names are lowercase letters, digits and underscores, starting with a letter." };
      if (purpose.length < 15) return { error: "Describe what the tool should do in more detail." };
      const device = pickDevice(ctx.devices.filter(isOnline), "enable_plugin", str(a.device));
      if (!device) return { error: "No device is online to install the tool on." };

      const reply = await completeText([
        { role: "system", content: "You are a senior Python engineer. You write small, correct, dependable tools." },
        { role: "user", content: CONTRACT.replace("{name}", name).replace("{purpose}", purpose) },
      ], 6000);
      const code = extractCode(reply);
      if (!/^TOOL\s*=/m.test(code) || !/^def run\(/m.test(code)) {
        return { error: "The code I wrote did not follow the tool format (TOOL dict and run function). Try again with a clearer purpose." };
      }

      const { error: saveError } = await ctx.sb.from("plugins").upsert({
        name, description: purpose.slice(0, 600), code, valid: true, problem: null, device_id: device.id, updated_at: new Date().toISOString(),
      }, { onConflict: "owner_id,name" });
      const job = await queueJob(ctx.sb, {
        deviceId: device.id, tool: "enable_plugin", args: { name, code }, title: `install tool: ${name}`, conversationId: ctx.conversationId,
      });
      const done = await waitForJob(ctx.sb, job.id, 40_000, ctx.signal);
      if (done?.status === "done") {
        return {
          installed: name, device: device.name, saved_to_database: !saveError,
          note: `The tool is live as pc_${name} from the next message on. Tell Sir it is ready and what it does.`,
        };
      }
      const problem = done?.error || `The device did not answer (task ${job.id} is ${done?.status}).`;
      await ctx.sb.from("plugins").update({ valid: false, problem }).eq("name", name);
      return { error: `The tool did not load: ${problem}`, code_excerpt: code.slice(0, 1500) };
    },
  },
];
