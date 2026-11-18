"""anexis doctor: one line per part, working or what is missing and how to fix it.

Extras (Claude Code, Canvas, keys for more tools) are marked optional: when
they are missing Anexis still works, it just has less.
"""

from __future__ import annotations

import re
import shutil

from anexis.proc import run_process, tool_path
from anexis.tools import canvas


def check(part: str, ok: bool, detail: str, fix: str = "", optional: bool = False) -> dict:
    return {"part": part, "ok": ok, "detail": detail, "fix": "" if ok else fix, "optional": optional}


async def _version(program: str) -> str | None:
    found = shutil.which(program, path=tool_path())
    if not found:
        return None
    try:
        code, output = await run_process([found, "--version"], ".", 15)
    except OSError:
        return None
    return output.strip().splitlines()[0] if code == 0 and output.strip() else None


async def doctor(anexis) -> list[dict]:
    settings = anexis.settings
    out: list[dict] = []

    warnings = settings.warnings()
    out.append(check("config", not warnings, "; ".join(warnings) or "ok", "edit ~/.anexis/anexis.toml or ~/.anexis/.env"))

    for provider in await anexis.router.status():
        name = f"model: {provider['name']}"
        if not provider["ok"]:
            fix = "install and start Ollama (ollama serve)" if provider["name"] == "ollama" else "check the API key and the network"
            out.append(check(name, False, provider.get("error", "not reachable")[:200], fix, optional=len(getattr(anexis.router, "providers", [])) > 1))
        elif provider["missing"]:
            pull = " && ".join(f"ollama pull {m}" for m in provider["missing"])
            fix = pull if provider["name"] == "ollama" else "these were retired or renamed, pick current ones in anexis.toml"
            out.append(check(name, False, "missing models: " + ", ".join(provider["missing"]), fix))
        else:
            out.append(check(name, True, ", ".join(f"{r}={m}" for r, m in provider["models"].items()) or "reachable"))
    for provider in settings.providers:
        if not provider.active:
            out.append(check(f"model: {provider.name}", True, f"off, add {provider.api_key_env} to ~/.anexis/.env to turn on"))

    try:
        embedded = await anexis.router.embed(["hello"], "query")
    except Exception:
        embedded = None
    out.append(check("embeddings", bool(embedded), f"using {embedded[0]}" if embedded else "no embedding model answered",
                     "memory still works by word match. For meaning search pull the embed model", optional=True))
    out.append(check("memory", True, f"{anexis.memory.count()} memories in {settings.db_path}"))

    claude = await _version(settings.claude_bin)
    usable, why = anexis.claude.available()
    if not claude:
        out.append(check("claude code", False, "not installed, code tasks use Anexis's own coder",
                         "optional: npm install -g @anthropic-ai/claude-code, then run claude once to sign in", optional=True))
    else:
        out.append(check("claude code", usable, claude if usable else why, "nothing to do, it comes back by itself", optional=True))

    node = await _version("node")
    found = re.search(r"v?(\d+)", node or "")
    major = int(found.group(1)) if found else 0
    out.append(check("node", major >= 20, node or "not installed",
                     "run bash install.sh again, the npm tool servers need Node 20 or newer", optional=True))
    uvx = shutil.which("uvx", path=tool_path())
    out.append(check("uv", bool(uvx), uvx or "not installed", "run bash install.sh again, the Python tool servers run with uvx", optional=True))

    out.append(check("canvas", canvas.configured(settings), "on" if canvas.configured(settings) else "off",
                     "optional: CANVAS_URL and CANVAS_TOKEN in ~/.anexis/.env", optional=True))

    if not settings.outside_tools:
        out.append(check("outside tools", True, "switched off, only the built in tools are used"))
    for problem in anexis.mcp.problems:
        out.append(check("tools.yaml", False, problem, "fix that entry in tools.yaml", optional=True))
    for name, info in sorted(anexis.mcp.status.items()):
        state = info["state"]
        if state == "running":
            out.append(check(f"tool: {name}", True, f"{info['tools']} tools"))
        elif state == "needs key":
            out.append(check(f"tool: {name}", True, f"off, add {', '.join(info['needs'])} to ~/.anexis/.env to turn on"))
        elif state == "off":
            out.append(check(f"tool: {name}", True, "off in tools.yaml"))
        elif state == "starting":
            out.append(check(f"tool: {name}", True, "still starting"))
        else:
            out.append(check(f"tool: {name}", False, info.get("error", state), f"see {settings.home / 'tool-logs' / (name + '.log')}", optional=True))
    return out
