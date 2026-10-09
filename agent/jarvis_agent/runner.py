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
from .config import DATA_DIR, JARVIS_REPO
from .tools import apps as app_tools
from .tools import plugins as plugin_tools
from .tools import files, projects, system

log = logging.getLogger("jarvis.runner")

WORKERS = 4
IDLE_POLL = 2.0
MAX_RESULT_CHARS = 300_000


def platform_label() -> str:
    if platform.system() == "Windows":
        build = platform.version().split(".")[-1]
        return f"Windows {'11' if build.isdigit() and int(build) >= 22000 else platform.release()}"
    return f"{platform.system()} {platform.release()}"


def build_registry(cfg: Config, stream_getter=lambda: None, cloud=None, api: DeviceApi | None = None,
                   restart=None) -> Registry:
    ws = projects.Workspace(cfg.workspace, cfg.codex_bin, cfg.claude_bin, restart=restart)
    apps = app_tools.AppTools(cfg.downloads_dir, stream_getter, cloud)
    registry = Registry(builtins=[])
    plug = plugin_tools.Plugins(
        cfg.codex_bin, cfg.claude_bin,
        builtin_names=lambda: {t.name for t in registry.builtins},
        reload=lambda: registry.reload_plugins(),
        save=api.save_plugin if api else None,
    )
    registry.builtins = [*system.TOOLS, *files.Files(cfg.downloads_dir).tools(), *ws.tools(), *apps.tools(), *plug.tools()]
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
        self._stream_pending: tuple[str, str] | None = None
        self.stream = None
        from .cloud import CloudSync

        self.cloud = CloudSync(DeviceApi(cfg.supabase_url, cfg.supabase_key, cfg.device_token, timeout=60),
                               cfg.cloud_enabled, cfg.cloud_max_mb)
        if cfg.stream_enabled:
            from .stream.server import StreamService

            self.stream = StreamService(DATA_DIR, cfg.downloads_dir, cfg.chrome_bin, cfg.stream_port,
                                        self._publish_stream, cfg.tunnel_token, cfg.stream_public_url,
                                        cloud=self.cloud, extra_roots=[("Projects", cfg.workspace), ("JARVIS code", JARVIS_REPO)],
                                        audio_device=cfg.audio_device)
        self.registry = build_registry(cfg, lambda: self.stream, self.cloud, self.api, self.request_restart)
        self.pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="job")
        self.running: set[str] = set()
        self.restart_wanted = False
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.manifest_dirty = threading.Event()
        self.manifest_dirty.set()
        original_reload = self.registry.reload_plugins

        def reload_and_flag() -> None:
            original_reload()
            self.manifest_dirty.set()

        self.registry.reload_plugins = reload_and_flag  # type: ignore[method-assign]

    def request_restart(self) -> None:
        """Restart once the current jobs (including the one asking) have reported back."""
        self.restart_wanted = True

    def _publish_stream(self, url: str, secret: str) -> None:
        # Called from the tunnel thread; the main loop does the network call (and retries).
        self._stream_pending = (url, secret)

    def _flush_stream(self) -> None:
        pending = self._stream_pending
        if not pending:
            return
        info = {"vscode": self.cfg.vscode_tunnel, "downloads": str(self.cfg.downloads_dir)}
        self.api.stream(pending[0], pending[1], info)
        if self._stream_pending == pending:
            self._stream_pending = None

    def start_stream(self) -> None:
        if self.stream:
            self.stream.start()

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
            if name == "create_plugin":
                args = {**args, "_job_id": job_id}
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
                self._flush_stream()
                with self.lock:
                    free = WORKERS - len(self.running)
                jobs = self.api.claim(max(0, free))  # claim(0) is a pure heartbeat
                for job in jobs:
                    with self.lock:
                        self.running.add(job["id"])
                    self.pool.submit(self._run, job)
                backoff = 2.0
                if self.restart_wanted:
                    with self.lock:
                        idle = not self.running
                    if idle:
                        log.info("restarting to load updated code")
                        return
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
        if self.stream:
            self.stream.stop()
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.api.close()
