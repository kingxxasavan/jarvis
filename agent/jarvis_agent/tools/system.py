"""Everyday device control: open apps and pages, play YouTube, media keys, system status.

Each action reports what it actually observed. Windows in particular lets a
launch "succeed" without anything appearing, so open_app watches for the new
process instead of trusting the launch call.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any

import psutil

from ..registry import Tool, ToolContext, schema

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

# Common names mapped to what to search for or run on each OS.
ALIASES: dict[str, dict[str, list[str]]] = {
    "browser": {"win": ["Google Chrome", "Microsoft Edge", "Firefox"], "linux": ["google-chrome", "chromium", "firefox"]},
    "chrome": {"win": ["Google Chrome"], "linux": ["google-chrome", "chromium"]},
    "edge": {"win": ["Microsoft Edge"], "linux": ["microsoft-edge"]},
    "vscode": {"win": ["Visual Studio Code"], "linux": ["code"]},
    "vs code": {"win": ["Visual Studio Code"], "linux": ["code"]},
    "terminal": {"win": ["Terminal", "Windows PowerShell", "Command Prompt"], "linux": ["x-terminal-emulator", "gnome-terminal", "konsole"]},
    "files": {"win": ["explorer"], "linux": ["nautilus", "dolphin", "thunar", "nemo"]},
    "file explorer": {"win": ["explorer"], "linux": ["nautilus", "dolphin", "thunar", "nemo"]},
    "settings": {"win": ["ms-settings:"], "linux": ["gnome-control-center"]},
    "spotify": {"win": ["Spotify"], "linux": ["spotify"]},
    "discord": {"win": ["Discord"], "linux": ["discord"]},
    "steam": {"win": ["Steam"], "linux": ["steam"]},
}

YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _start_menu_entries() -> dict[str, Path]:
    """Display name -> shortcut, from the Start Menu (Windows) or .desktop files (Linux)."""
    found: dict[str, Path] = {}
    if IS_WIN:
        roots = [
            Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft/Windows/Start Menu/Programs",
            Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs",
        ]
        for root in roots:
            if root.is_dir():
                for p in root.rglob("*"):
                    if p.suffix.lower() in (".lnk", ".url") and "uninstall" not in p.stem.lower():
                        found.setdefault(p.stem, p)
    else:
        roots = [Path("/usr/share/applications"), Path.home() / ".local/share/applications", Path("/var/lib/flatpak/exports/share/applications")]
        for root in roots:
            if root.is_dir():
                for p in root.glob("*.desktop"):
                    name = p.stem
                    try:
                        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                            if line.startswith("Name="):
                                name = line[5:].strip()
                                break
                    except OSError:
                        pass
                    found.setdefault(name, p)
    return found


def _score(query: str, name: str) -> int:
    q, n = query.lower().strip(), name.lower()
    if q == n:
        return 100
    if n.startswith(q):
        return 80
    if q in n:
        return 60
    words = [w for w in re.split(r"\W+", q) if w]
    return 40 if words and all(w in n for w in words) else 0


def find_app(query: str, entries: dict[str, Path] | None = None) -> tuple[str, Path] | None:
    entries = entries if entries is not None else _start_menu_entries()
    best = max(((_score(query, name), name) for name in entries), default=(0, ""))
    return (best[1], entries[best[1]]) if best[0] else None


def _pids() -> set[int]:
    return set(psutil.pids())


def _launch(target: str | Path) -> None:
    if IS_WIN:
        os.startfile(str(target))  # noqa: S606 - opening a Start Menu entry is the intent
    elif IS_MAC:
        subprocess.Popen(["open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif str(target).endswith(".desktop"):
        subprocess.Popen(["gtk-launch", Path(target).stem], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    else:
        subprocess.Popen([str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def _new_processes(before: set[int], wait: float = 5.0) -> list[str]:
    deadline = time.time() + wait
    while time.time() < deadline:
        new = _pids() - before
        names = []
        for pid in new:
            try:
                names.append(psutil.Process(pid).name())
            except psutil.Error:
                continue
        if names:
            return names
        time.sleep(0.4)
    return []


def open_app(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    query = str(args.get("name") or "").strip()
    if not query:
        raise ValueError("Which app?")
    key = "win" if IS_WIN else "linux"
    candidates = ALIASES.get(query.lower(), {}).get(key, []) + [query]
    entries = _start_menu_entries()
    before = _pids()
    for cand in candidates:
        if IS_WIN and cand == "explorer":
            subprocess.Popen(["explorer.exe", str(Path.home())])
            return {"opened": "File Explorer", "verified": True, "note": "Explorer window requested in the home folder."}
        if cand.endswith(":"):  # a URI such as ms-settings:
            _launch(cand)
            return {"opened": query, "verified": False, "note": "Asked Windows to open it."}
        match = find_app(cand, entries)
        if match:
            name, path = match
            _launch(path)
            started = _new_processes(before)
            if started:
                return {"opened": name, "verified": True, "processes": sorted(set(started))[:5]}
            return {"opened": name, "verified": False,
                    "note": "Launched, but no new process appeared. It may have been running already and come to the front, or it failed to start."}
        exe = shutil.which(cand)
        if exe:
            _launch(exe)
            started = _new_processes(before)
            return {"opened": cand, "verified": bool(started), "processes": sorted(set(started))[:5]}
    raise LookupError(f"No app called '{query}' is installed here. Use list_apps to see what is.")


def list_apps(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    q = str(args.get("query") or "").strip()
    names = sorted(_start_menu_entries())
    if q:
        names = [n for n in names if _score(q, n)]
    return {"apps": names[:80], "total": len(names)}


def open_url(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    url = str(args.get("url") or "").strip()
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("Only web addresses (http or https) can be opened.")
    if not webbrowser.open(url, new=2):
        raise RuntimeError("No web browser is available on this device.")
    return {"opened": url, "note": "Sent to the default browser."}


def play_youtube(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    vid = str(args.get("video_id") or "").strip()
    if not YT_ID.match(vid):
        raise ValueError("That is not a YouTube video id.")
    url = f"https://www.youtube.com/watch?v={vid}"
    if not webbrowser.open(url, new=2):
        raise RuntimeError("No web browser is available on this device.")
    return {"opened": url, "note": "Playing in the default browser."}


_VK = {"play_pause": 0xB3, "next": 0xB0, "previous": 0xB1, "mute": 0xAD, "volume_down": 0xAE, "volume_up": 0xAF}
_LINUX = {
    "play_pause": ["playerctl", "play-pause"], "next": ["playerctl", "next"], "previous": ["playerctl", "previous"],
    "mute": ["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"],
    "volume_down": ["pactl", "set-sink-volume", "@DEFAULT_SINK@", "-5%"],
    "volume_up": ["pactl", "set-sink-volume", "@DEFAULT_SINK@", "+5%"],
}


def media(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    action = str(args.get("action") or "")
    times = max(1, min(int(args.get("times") or 1), 20))
    if action not in _VK:
        raise ValueError(f"Action must be one of: {', '.join(_VK)}")
    if IS_WIN:
        import ctypes

        for _ in range(times):
            ctypes.windll.user32.keybd_event(_VK[action], 0, 0, 0)
            ctypes.windll.user32.keybd_event(_VK[action], 0, 2, 0)
            time.sleep(0.05)
    else:
        cmd = _LINUX[action]
        if not shutil.which(cmd[0]):
            raise RuntimeError(f"{cmd[0]} is not installed on this device.")
        for _ in range(times):
            subprocess.run(cmd, check=True, timeout=5, capture_output=True)
    return {"done": action, "times": times}


def system_info(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage(str(Path.home()))
    battery = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None
    top = sorted(
        (p.info for p in psutil.process_iter(["name", "memory_percent"]) if p.info.get("memory_percent")),
        key=lambda i: i["memory_percent"], reverse=True,
    )[:5]
    return {
        "device": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "cpu_percent": psutil.cpu_percent(interval=0.5),
        "memory": f"{vm.percent}% of {round(vm.total / 2**30, 1)} GB used",
        "disk_free_gb": round(disk.free / 2**30, 1),
        "battery": None if not battery else f"{round(battery.percent)}%{' charging' if battery.power_plugged else ''}",
        "uptime_hours": round((time.time() - psutil.boot_time()) / 3600, 1),
        "top_memory": [f"{i['name']} {i['memory_percent']:.1f}%" for i in top],
    }


TOOLS = [
    Tool("open_app", "Open an installed app by name (e.g. Chrome, VS Code, Spotify, terminal, files).",
         schema({"name": {"type": "string"}}, ["name"]), open_app),
    Tool("list_apps", "List apps installed on the device, optionally filtered.",
         schema({"query": {"type": "string"}}), list_apps),
    Tool("open_url", "Open a web page in the device's browser.", schema({"url": {"type": "string"}}, ["url"]), open_url),
    Tool("play_youtube", "Play a YouTube video in the device's browser. Prefer the play_youtube tool with on='device'.",
         schema({"video_id": {"type": "string"}}, ["video_id"]), play_youtube, hidden=True),
    Tool("media", "Media and volume keys: play_pause, next, previous, mute, volume_up, volume_down.",
         schema({"action": {"type": "string", "enum": list(_VK)}, "times": {"type": "integer", "description": "Repeat count for volume"}}, ["action"]), media),
    Tool("system_info", "CPU, memory, disk, battery, uptime and the heaviest apps on the device.", schema(), system_info),
]
