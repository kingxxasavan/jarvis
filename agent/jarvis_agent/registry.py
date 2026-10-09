"""Tools this device offers, built-in and plugins, and the manifest sent to the website.

A plugin is one file, plugins/<name>.py, with a TOOL dict and a run(args) function.
Only plugins listed in plugins/enabled.json are loaded, and a plugin only gets
there when the owner presses Enable after reading its code.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .config import PLUGIN_DIR

log = logging.getLogger("jarvis.registry")

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
ENABLED_FILE = PLUGIN_DIR / "enabled.json"


@dataclass
class ToolContext:
    job_id: str
    log: Callable[[str, str], None]
    cancelled: Callable[[], bool]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    run: Callable[[dict[str, Any], ToolContext], Any]
    long_running: bool = False
    approval: bool = False
    hidden: bool = False
    timeout: int = 20
    plugin: bool = False

    def manifest(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "description": self.description, "parameters": self.parameters}
        for key in ("long_running", "approval", "hidden"):
            if getattr(self, key):
                out[key] = True
        if self.timeout != 20:
            out["timeout"] = self.timeout
        return out


def schema(properties: dict[str, Any] | None = None, required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties or {}, "required": required or []}


def validate_plugin_tool(tool: Any, expected_name: str) -> str | None:
    """Returns a problem description, or None when the TOOL dict is usable."""
    if not isinstance(tool, dict):
        return "TOOL must be a dict"
    if tool.get("name") != expected_name:
        return f"TOOL['name'] must be '{expected_name}'"
    if not isinstance(tool.get("description"), str) or len(tool["description"]) < 10:
        return "TOOL['description'] must describe what the tool does"
    params = tool.get("parameters")
    if not isinstance(params, dict) or params.get("type") != "object" or not isinstance(params.get("properties"), dict):
        return "TOOL['parameters'] must be a JSON schema object with 'properties'"
    return None


def load_plugin_file(path: Path) -> tuple[dict[str, Any], Callable[[dict[str, Any]], Any]]:
    name = path.stem
    spec = importlib.util.spec_from_file_location(f"jarvis_plugin_{name}", path)
    if not spec or not spec.loader:
        raise ImportError(f"cannot load {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tool = getattr(module, "TOOL", None)
    problem = validate_plugin_tool(tool, name)
    if problem:
        raise ValueError(problem)
    run = getattr(module, "run", None)
    if not callable(run):
        raise ValueError("plugin has no run(args) function")
    return tool, run


def read_enabled() -> list[str]:
    try:
        names = json.loads(ENABLED_FILE.read_text(encoding="utf-8"))
        return [n for n in names if isinstance(n, str) and NAME_RE.match(n)]
    except (OSError, ValueError):
        return []


def write_enabled(names: list[str]) -> None:
    PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
    ENABLED_FILE.write_text(json.dumps(sorted(set(names)), indent=2), encoding="utf-8")


@dataclass
class Registry:
    builtins: list[Tool]
    plugins: dict[str, Tool] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def reload_plugins(self) -> None:
        taken = {t.name for t in self.builtins}
        loaded: dict[str, Tool] = {}
        errors: dict[str, str] = {}
        for name in read_enabled():
            path = PLUGIN_DIR / f"{name}.py"
            if name in taken:
                errors[name] = "name clashes with a built-in tool"
                continue
            try:
                spec, fn = load_plugin_file(path)
            except Exception as exc:  # noqa: BLE001 - a broken plugin must not stop the agent
                errors[name] = f"{exc.__class__.__name__}: {exc}"
                log.warning("plugin %s failed to load: %s", name, exc)
                continue
            loaded[name] = Tool(
                name=name,
                description=str(spec["description"])[:600],
                parameters=spec["parameters"],
                run=lambda args, ctx, fn=fn: fn(args),
                timeout=int(spec.get("timeout", 30)),
                plugin=True,
            )
        with self._lock:
            self.plugins = loaded
            self.errors = errors

    def all(self) -> list[Tool]:
        with self._lock:
            return [*self.builtins, *self.plugins.values()]

    def get(self, name: str) -> Tool | None:
        return next((t for t in self.all() if t.name == name), None)

    def manifest(self) -> list[dict[str, Any]]:
        return [t.manifest() for t in self.all()]
