"""The agent loop: announce this device, then claim and run jobs until stopped.

Quick jobs and long ones (coding runs) share a small thread pool, so the device
keeps answering "open Spotify" while Codex is busy building something.
"""

from __future__ import annotations

import json
import logging
import platform
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .api import ApiError, DeviceApi
from .config import Config
from .registry import Registry, ToolContext
from .tools import plugins as plugin_tools
from .tools import projects, system

log = logging.getLogger("jarvis.runner")

WORKERS = 4
IDLE_POLL = 2.0
MAX_RESULT_CHARS = 300_000


def platform_label() -> str:
    if platform.system() == "Windows":
        build = platform.version().split(".")[-1]
        return f"Windows {'11' if build.isdigit() and int(build) >= 22000 else platform.release()}"
    return f"{platform.system()} {platform.release()}"


def build_registry(cfg: Config) -> Registry:
    ws = projects.Workspace(cfg.workspace, cfg.codex_bin, cfg.claude_bin)
    registry = Registry(builtins=[])
    plug = plugin_tools.Plugins(
        cfg.codex_bin, cfg.claude_bin,
        builtin_names=lambda: {t.name for t in registry.builtins},
        reload=lambda: registry.reload_plugins(),
    )
    registry.builtins = [*system.TOOLS, *ws.tools(), *plug.tools()]
    registry.reload_plugins()
    return registry


def jsonable(value: Any) -> Any:
    """Results must survive JSON; anything else becomes text. Oversized results are cut."""
    try:
        text = json.dumps(value, default=str)
    except (TypeError, ValueError):
        text = json.dumps(str(value))
    if len(text) > MAX_RESULT_CHARS:
        return {"truncated": True, "text": text[:MAX_RESULT_CHARS]}
    return json.loads(text)


class Runner:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.api = DeviceApi(cfg.supabase_url, cfg.supabase_key, cfg.device_token)
        self.registry = build_registry(cfg)
        self.pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="job")
        self.running: set[str] = set()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.manifest_dirty = threading.Event()
        self.manifest_dirty.set()
        original_reload = self.registry.reload_plugins

        def reload_and_flag() -> None:
            original_reload()
            self.manifest_dirty.set()

        self.registry.reload_plugins = reload_and_flag  # type: ignore[method-assign]

    def announce(self) -> dict[str, Any]:
        info = self.api.hello(platform_label(), self.registry.manifest())
        self.manifest_dirty.clear()
        return info

    def _job_log(self, job_id: str):
        def write(kind: str, text: str) -> None:
            try:
                self.api.log(job_id, kind, text)
            except ApiError as exc:
                log.debug("log write failed: %s", exc)
        return write

    def _cancelled(self, job_id: str):
        last = {"t": 0.0, "v": False}

        def check() -> bool:
            if last["v"]:
                return True
            if time.time() - last["t"] > 3:
                last["t"] = time.time()
                try:
                    last["v"] = self.api.status(job_id) == "cancelled"
                except ApiError:
                    pass
            return last["v"] or self.stop.is_set()
        return check

    def _run(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        name = job.get("tool", "")
        tool = self.registry.get(name)
        try:
            if not tool:
                raise LookupError(f"This device has no tool called {name}.")
            args = job.get("args") or {}
            if not isinstance(args, dict):
                raise ValueError("Job arguments must be an object.")
            log.info("job %s: %s", job_id[:8], name)
            ctx = ToolContext(job_id=job_id, log=self._job_log(job_id), cancelled=self._cancelled(job_id))
            result = tool.run(args, ctx)
            self.api.finish(job_id, True, jsonable(result), None)
            log.info("job %s done", job_id[:8])
        except Exception as exc:  # noqa: BLE001 - every failure is reported back, never raised
            message = str(exc) or exc.__class__.__name__
            log.warning("job %s failed: %s", job_id[:8], message)
            try:
                self.api.finish(job_id, False, None, message[:4000])
            except ApiError as api_exc:
                log.error("could not report failure for %s: %s", job_id[:8], api_exc)
        finally:
            with self.lock:
                self.running.discard(job_id)

    def loop(self) -> None:
        backoff = 2.0
        while not self.stop.is_set():
            try:
                if self.manifest_dirty.is_set():
                    self.announce()
                with self.lock:
                    free = WORKERS - len(self.running)
                jobs = self.api.claim(max(0, free))  # claim(0) is a pure heartbeat
                for job in jobs:
                    with self.lock:
                        self.running.add(job["id"])
                    self.pool.submit(self._run, job)
                backoff = 2.0
                self.stop.wait(0.3 if jobs else IDLE_POLL)
            except ApiError as exc:
                if "removed" in str(exc):
                    log.error("%s", exc)
                    raise SystemExit(str(exc)) from exc
                log.warning("connection problem: %s (retrying in %.0fs)", exc, backoff)
                self.stop.wait(backoff)
                backoff = min(backoff * 2, 60)
                self.manifest_dirty.set()

    def shutdown(self) -> None:
        self.stop.set()
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.api.close()
