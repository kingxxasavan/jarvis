"""Self-extension: JARVIS writes a new device tool with Codex or Claude Code.

The draft lands in plugins/drafts/<name>/plugin.py and is checked in a separate
Python process (it must import cleanly and declare a valid TOOL). It does not
run until the owner reads the code on the Tasks page and presses Enable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from ..coding import available, run_agent
from ..config import DRAFT_DIR, PLUGIN_DIR
from ..registry import NAME_RE, Tool, ToolContext, read_enabled, schema, write_enabled

CONTRACT = '''Write ONE Python file named plugin.py in this folder: a new tool for the JARVIS assistant.

Contract (follow exactly):
- Module docstring: one line saying what the tool does.
- A dict named TOOL:
    TOOL = {
        "name": "{name}",
        "description": "<what it does and when to use it, one or two sentences>",
        "parameters": {"type": "object", "properties": {...JSON schema...}, "required": [...]},
        "timeout": 30,   # seconds the assistant should wait for a result
    }
- A function run(args: dict) -> dict | str that does the work and returns a short, plain result.
  Raise an exception with a clear message when something goes wrong.
- Python 3.10+ standard library only, plus httpx and psutil if needed (both installed).
  No other third-party packages. No API keys: use public, key-free endpoints only.
- Importing the file must have no side effects: no network calls, no file writes, no prints at import time.
- Never delete files, change system settings, send messages or spend money.
- Keep it under 250 lines, readable and documented. You may test it, but leave only plugin.py behind.

What the tool should do:
{purpose}
'''

CHECK = r"""
import importlib.util, json, sys
path, name = sys.argv[1], sys.argv[2]
try:
    spec = importlib.util.spec_from_file_location("draft_" + name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    tool = getattr(mod, "TOOL", None)
    ok = isinstance(tool, dict) and tool.get("name") == name and isinstance(tool.get("description"), str) \
        and isinstance(tool.get("parameters"), dict) and tool["parameters"].get("type") == "object" \
        and isinstance(tool["parameters"].get("properties"), dict) and callable(getattr(mod, "run", None))
    print(json.dumps({"valid": ok, "problem": None if ok else "TOOL or run() does not follow the contract"}))
except Exception as exc:
    print(json.dumps({"valid": False, "problem": f"{type(exc).__name__}: {exc}"}))
"""


def check_draft(path: Path, name: str) -> dict[str, Any]:
    """Imports the draft in a separate, isolated interpreter so a bad file cannot touch the agent."""
    try:
        res = subprocess.run([sys.executable, "-I", "-c", CHECK, str(path), name], capture_output=True, text=True,
                             timeout=30, cwd=str(path.parent))
        return json.loads(res.stdout.strip().splitlines()[-1])
    except (subprocess.TimeoutExpired, ValueError, IndexError):
        return {"valid": False, "problem": "Importing the plugin hung or crashed."}


class Plugins:
    def __init__(self, codex_bin: str, claude_bin: str, builtin_names: Callable[[], set[str]], reload: Callable[[], None]):
        self.codex_bin = codex_bin
        self.claude_bin = claude_bin
        self.builtin_names = builtin_names
        self.reload = reload

    def _name(self, raw: Any) -> str:
        name = str(raw or "").strip().lower().replace("-", "_").replace(" ", "_")
        if not NAME_RE.match(name):
            raise ValueError("Plugin names are lowercase letters, digits and underscores, starting with a letter.")
        if name in self.builtin_names():
            raise ValueError(f"'{name}' is already a built-in tool.")
        return name

    def create(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        name = self._name(args.get("name"))
        purpose = str(args.get("purpose") or "").strip()
        if len(purpose) < 15:
            raise ValueError("Describe what the tool should do.")
        tools = available(self.codex_bin, self.claude_bin)
        wanted = str(args.get("agent") or "codex").lower()
        agent = next((a for a in [wanted, "codex", "claude"] if tools.get(a)), None)
        if not agent:
            raise RuntimeError("Building a plugin needs Codex or Claude Code installed on this device.")

        draft = DRAFT_DIR / name
        if draft.exists():
            shutil.rmtree(draft)
        draft.mkdir(parents=True)
        prompt = CONTRACT.replace("{name}", name).replace("{purpose}", purpose)
        ctx.log("log", f"Writing plugin '{name}' with {agent}.")
        result = run_agent(agent, tools[agent] or "", prompt, draft, ctx.log, ctx.cancelled)
        file = draft / "plugin.py"
        if not file.exists():
            raise RuntimeError(f"{agent} did not produce plugin.py. {result.error or result.summary}"[:800])
        verdict = check_draft(file, name)
        ctx.log("log" if verdict["valid"] else "error", "Plugin loads cleanly." if verdict["valid"] else f"Plugin problem: {verdict['problem']}")
        return {"name": name, "valid": verdict["valid"], "problem": verdict["problem"], "summary": result.summary,
                "code": file.read_text(encoding="utf-8", errors="replace")[:60000]}

    def enable(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        name = self._name(args.get("name"))
        src = DRAFT_DIR / name / "plugin.py"
        if not src.exists():
            raise FileNotFoundError("There is no draft with that name. Build it first.")
        verdict = check_draft(src, name)
        if not verdict["valid"]:
            raise ValueError(f"The draft does not load: {verdict['problem']}")
        PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, PLUGIN_DIR / f"{name}.py")
        write_enabled([*read_enabled(), name])
        self.reload()
        return {"enabled": name, "note": "JARVIS can use it now."}

    def disable(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        name = self._name(args.get("name"))
        write_enabled([n for n in read_enabled() if n != name])
        self.reload()
        return {"disabled": name}

    def tools(self) -> list[Tool]:
        return [
            Tool(
                "create_plugin",
                "Teach JARVIS a new ability: Codex or Claude Code writes a small Python tool for this device. "
                "Sir reviews the code on the Tasks page and enables it; until then it does nothing.",
                schema({
                    "name": {"type": "string", "description": "snake_case tool name, e.g. weather_alerts"},
                    "purpose": {"type": "string", "description": "What it does, its inputs and its output, in detail"},
                    "agent": {"type": "string", "enum": ["codex", "claude"]},
                }, ["name", "purpose"]),
                self.create, long_running=True, approval=True,
            ),
            Tool("enable_plugin", "Enable a reviewed plugin draft.", schema({"name": {"type": "string"}}, ["name"]), self.enable, hidden=True),
            Tool("disable_plugin", "Disable a plugin.", schema({"name": {"type": "string"}}, ["name"]), self.disable, hidden=True),
        ]
