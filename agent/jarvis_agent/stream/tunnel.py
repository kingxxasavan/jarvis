"""Cloudflare Tunnel: gives the local stream server a public HTTPS address
without opening any port on the router.

- With CLOUDFLARE_TUNNEL_TOKEN and STREAM_PUBLIC_URL set (a named tunnel on your
  own domain) the address never changes.
- Otherwise a free "quick tunnel" is used; its random trycloudflare.com address
  changes on every start, and the agent reports each new one to JARVIS.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger("jarvis.tunnel")

QUICK_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def find_cloudflared() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found
    if sys.platform == "win32":
        for base in (os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"), os.environ.get("PROGRAMFILES", r"C:\Program Files")):
            p = Path(base) / "cloudflared" / "cloudflared.exe"
            if p.exists():
                return str(p)
    return None


class Tunnel:
    def __init__(self, port: int, on_url: Callable[[str], None], token: str = "", public_url: str = ""):
        self.port = port
        self.on_url = on_url
        self.token = token
        self.public_url = public_url.rstrip("/")
        self.url = ""
        self.error = ""
        self._stop = threading.Event()
        self._proc: subprocess.Popen | None = None

    def start(self) -> None:
        threading.Thread(target=self._run, name="tunnel", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    def _run(self) -> None:
        exe = find_cloudflared()
        if not exe:
            self.error = "cloudflared is not installed, so apps are only reachable on this computer."
            log.warning("%s Install it with: winget install --id Cloudflare.cloudflared", self.error)
            return
        delay = 3.0
        while not self._stop.is_set():
            if self.token and self.public_url:
                cmd = [exe, "tunnel", "--no-autoupdate", "run", "--token", self.token]
                self._set_url(self.public_url)
            else:
                cmd = [exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{self.port}"]
            started = time.time()
            self._proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                          encoding="utf-8", errors="replace",
                                          creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            assert self._proc.stderr
            for line in self._proc.stderr:
                m = QUICK_URL.search(line)
                if m and not self.token:
                    self._set_url(m.group(0))
            code = self._proc.wait()
            if self._stop.is_set():
                return
            log.warning("tunnel exited (code %s); restarting in %.0fs", code, delay)
            delay = 3.0 if time.time() - started > 120 else min(delay * 2, 120)
            self._stop.wait(delay)

    def _set_url(self, url: str) -> None:
        if url != self.url:
            self.url = url
            self.error = ""
            log.info("apps are reachable at %s", url)
            self.on_url(url)
