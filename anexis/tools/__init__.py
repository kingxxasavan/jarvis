"""Every tool Anexis has.

Built in (no key, no extra install):
  core     time, math, memory, notes, todos, assignments, reminders, find_tools
  system   files, search, shell, Python, server status, processes
  web      web search, page reading, GitHub repos and files
  code     code_task (Claude Code when it is there, Anexis's own coder when not)

Only loaded when their key is in ~/.anexis/.env:
  canvas   CANVAS_URL and CANVAS_TOKEN
  github_search_code   GITHUB_TOKEN

Outside tools come from the MCP servers in tools.yaml (see mcp.py).
"""

from anexis.tools import canvas, core, system, web
from anexis.tools.registry import Registry


def register_builtin(registry: Registry, settings=None) -> None:
    keyed = settings is not None
    for tool in [*core.TOOLS, *system.TOOLS, *(web.tools(settings) if keyed else web.TOOLS)]:
        registry.add(tool)
    if keyed and canvas.configured(settings):
        for tool in canvas.TOOLS:
            registry.add(tool)
