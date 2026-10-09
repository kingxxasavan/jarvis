"""Copies finished downloads into the owner's cloud files (Supabase Storage), so
anything downloaded on the laptop can be fetched from JARVIS on any computer.

Uploads run one at a time on their own thread; a failure is logged and never
affects the download itself. Files over the size limit stay on the laptop only.
"""

from __future__ import annotations

import logging
import mimetypes
import queue
import threading
from pathlib import Path
from typing import Callable

from .api import ApiError, DeviceApi

log = logging.getLogger("jarvis.cloud")


class CloudSync:
    def __init__(self, api: DeviceApi | None, enabled: bool = True, max_mb: int = 50):
        self.api = api
        self.enabled = enabled and api is not None
        self.max_bytes = max_mb * 2**20
        self._q: queue.Queue[tuple[Path, Callable[[str, str], None] | None]] = queue.Queue()
        self._thread: threading.Thread | None = None

    def submit(self, path: Path, report: Callable[[str, str], None] | None = None) -> str:
        """Queues one file. Returns a short note for the caller to show."""
        if not self.enabled:
            return "Cloud copies are off on this device."
        if not path.is_file():
            return "Not uploaded: the file is gone."
        if path.stat().st_size > self.max_bytes:
            return f"Too large for cloud files (over {self.max_bytes // 2**20} MB); it stays on the laptop."
        self._q.put((path, report))
        if not self._thread or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="cloud", daemon=True)
            self._thread.start()
        return "A copy is going to your cloud files."

    def upload_now(self, path: Path) -> str:
        if not self.enabled or not self.api:
            raise RuntimeError("Cloud copies are off on this device (JARVIS_CLOUD=off).")
        if path.stat().st_size > self.max_bytes:
            raise ValueError(f"That file is over {self.max_bytes // 2**20} MB, the cloud limit.")
        return self.api.upload(path, mimetypes.guess_type(path.name)[0] or "application/octet-stream")

    def _run(self) -> None:
        while True:
            try:
                path, report = self._q.get(timeout=60)
            except queue.Empty:
                return
            try:
                self.upload_now(path)
                log.info("uploaded %s to cloud files", path.name)
                if report:
                    report("cloud", f"Saved to cloud files: {path.name}")
            except (ApiError, OSError, ValueError, RuntimeError) as exc:
                log.warning("cloud upload of %s failed: %s", path.name, exc)
                if report:
                    report("error", f"Cloud upload failed for {path.name}: {exc}")
