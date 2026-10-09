"""Folders on this device: create, list and open them.

Paths are relative to the home folder unless absolute, and the first word may be a
known folder ("Desktop/School", "Documents", "Downloads"). On Windows those resolve
through the shell, so a Desktop moved into OneDrive is still found. System and
secret folders (AppData, .ssh, Windows, Program Files...) are refused.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..registry import Tool, ToolContext, schema

IS_WIN = sys.platform == "win32"
DENY = re.compile(r"(^|[\\/])(appdata|\.ssh|\.aws|\.gnupg|\.claude|\.codex|\.config)([\\/]|$)", re.I)
SYSTEM_ROOTS = [Path(os.environ[k]).resolve() for k in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData") if os.environ.get(k)]
KNOWN = {
    "desktop": "B4BFCC3A-DB2C-424C-B029-7FE99A87C641",
    "documents": "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
    "downloads": "374DE290-123F-4565-9164-39C4925E467B",
    "pictures": "33E28130-4E1E-4676-835A-98395C3BC3BB",
    "music": "4BD8D571-6D19-48D3-BE97-422220080E43",
    "videos": "18989B1D-99B5-455B-841C-AB7C74E4DDFC",
}


def known_folder(name: str) -> Path | None:
    key = name.lower()
    if key not in KNOWN:
        return None
    if IS_WIN:
        import ctypes
        import uuid
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_byte * 8)]

        u = uuid.UUID(KNOWN[key])
        g = GUID(u.fields[0], u.fields[1], u.fields[2], (ctypes.c_byte * 8).from_buffer_copy(u.bytes[8:]))
        out = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(out)) == 0:
            path = Path(out.value or "")
            ctypes.windll.ole32.CoTaskMemFree(out)
            if path.exists():
                return path
    fallback = Path.home() / name.capitalize()
    return fallback


def resolve(raw: str) -> Path:
    text = str(raw or "").strip().strip('"')
    if not text:
        raise ValueError("Which folder?")
    text = os.path.expandvars(os.path.expanduser(text))
    parts = re.split(r"[\\/]", text, maxsplit=1)
    base = known_folder(parts[0]) if not Path(text).is_absolute() else None
    if base:
        path = base / (parts[1] if len(parts) > 1 else "")
    else:
        path = Path(text) if Path(text).is_absolute() else Path.home() / text
    path = path.resolve()
    if DENY.search(str(path)) or any(path == r or r in path.parents for r in SYSTEM_ROOTS):
        raise PermissionError("That is a system or private folder, so JARVIS leaves it alone.")
    return path


def create_folder(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    path = resolve(str(args.get("path") or ""))
    existed = path.is_dir()
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise RuntimeError(f"Windows did not create {path}.")
    return {"folder": str(path), "created": not existed, "note": "It already existed." if existed else "Created."}


def list_folder(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    path = resolve(str(args.get("path") or "Desktop"))
    if not path.is_dir():
        raise FileNotFoundError(f"There is no folder at {path}.")
    items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    return {"folder": str(path),
            "items": [("[folder] " if p.is_dir() else "") + p.name for p in items if not p.name.startswith(".")][:200]}


def open_folder(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    path = resolve(str(args.get("path") or "Desktop"))
    if not path.is_dir():
        raise FileNotFoundError(f"There is no folder at {path}.")
    if IS_WIN:
        subprocess.Popen(["explorer.exe", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"opened": str(path)}


PATH = {"path": {"type": "string", "description": "e.g. 'Desktop/School/APUSH' or 'Documents/Projects'"}}

TOOLS = [
    Tool("create_folder", "Create a folder (and any missing parent folders) on this device.", schema(PATH, ["path"]), create_folder),
    Tool("list_folder", "List what is inside a folder on this device.", schema(PATH), list_folder),
    Tool("open_folder", "Open a folder in the file manager on this device's screen.", schema(PATH), open_folder),
]
