"""Icons of the laptop's installed apps, for the Apps home screen.

All Start Menu shortcuts are converted in one PowerShell run (starting
PowerShell per icon would take minutes) into data/icons/<hash>.png, then served
from that cache. Off Windows, or when an app has no icon, the page draws a
lettered tile instead.
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import sys
import threading
import time
from pathlib import Path

from ..tools.system import _start_menu_entries

log = logging.getLogger("jarvis.icons")

IS_WIN = sys.platform == "win32"

SCRIPT = r"""
param([string]$List)
Add-Type -AssemblyName System.Drawing
$jobs = Get-Content -Raw -Encoding UTF8 $List | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
foreach ($j in $jobs) {
  try {
    $src = $j.path
    if ($src -like '*.lnk') {
      $l = $shell.CreateShortcut($src)
      $loc = ($l.IconLocation -split ',')[0]
      if ($loc -and (Test-Path $loc)) { $src = $loc } elseif ($l.TargetPath -and (Test-Path $l.TargetPath)) { $src = $l.TargetPath }
    }
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
    if ($icon) { $icon.ToBitmap().Save($j.out, [System.Drawing.Imaging.ImageFormat]::Png) }
  } catch { }
}
"""


def key(name: str) -> str:
    return hashlib.sha1(name.encode("utf-8")).hexdigest()[:20]


class AppIcons:
    def __init__(self, cache_dir: Path):
        self.dir = cache_dir
        self._lock = threading.Lock()
        self._built = 0.0

    def names(self) -> list[str]:
        return sorted(_start_menu_entries(), key=str.lower)

    def path(self, name: str) -> Path | None:
        self.ensure()
        p = self.dir / f"{key(name)}.png"
        return p if p.is_file() else None

    def ensure(self) -> None:
        """Builds the cache in the background once a day; never blocks a request for long."""
        if not IS_WIN or time.time() - self._built < 86400:
            return
        if self._lock.locked():
            return
        self._built = time.time()
        threading.Thread(target=self._build, name="icons", daemon=True).start()

    def _build(self) -> None:
        with self._lock:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                jobs = [{"path": str(p), "out": str(self.dir / f"{key(n)}.png")}
                        for n, p in _start_menu_entries().items() if not (self.dir / f"{key(n)}.png").exists()]
                if not jobs:
                    return
                listing = self.dir / "jobs.json"
                listing.write_text(json.dumps(jobs), encoding="utf-8")
                script = self.dir / "extract.ps1"
                script.write_text(SCRIPT, encoding="utf-8")
                subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-List", str(listing)],
                               capture_output=True, timeout=300, creationflags=subprocess.CREATE_NO_WINDOW)  # type: ignore[attr-defined]
                log.info("app icons ready (%d new)", len(jobs))
            except Exception as exc:  # noqa: BLE001 - icons are decoration
                log.warning("could not extract app icons: %s", exc)
