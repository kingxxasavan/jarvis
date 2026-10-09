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
import zipfile
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


SECRET_FILE = re.compile(r"(^|[\\/])(\.env[^\\/]*|id_rsa[^\\/]*|id_ed25519[^\\/]*|[^\\/]*\.(pem|key|pfx|p12|kdbx))$", re.I)
TEXT_EXT = {".txt", ".md", ".csv", ".tsv", ".json", ".log", ".xml", ".html", ".htm", ".py", ".js", ".ts", ".tsx", ".jsx",
            ".css", ".yml", ".yaml", ".ini", ".toml", ".sql", ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".sh", ".ps1", ".bat"}
MAX_CHARS = 60_000


def find_file(raw: str, downloads_dir: Path | None) -> Path:
    """A path as given, or a bare file name looked up in the usual download folders."""
    path = resolve(raw)
    if path.is_file():
        return path
    name = Path(str(raw).strip().strip('"')).name
    for folder in [downloads_dir, known_folder("downloads"), known_folder("desktop"), known_folder("documents")]:
        if folder and (folder / name).is_file():
            return resolve(str(folder / name))
    raise FileNotFoundError(f"There is no file at {path}. Use list_folder or list_downloads to find it.")


def _xml_text(xml: bytes, para_tag: str) -> str:
    text = re.sub(rf"</{para_tag}>", "\n", xml.decode("utf-8", "replace"))
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", text).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')


def _cell(v: Any) -> str:
    if v is None:
        return ""
    s = str(v)
    return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n') else s


def file_text(path: Path, max_rows: int = 400) -> tuple[str, dict[str, Any]]:
    """Readable text from a file: spreadsheets as CSV per sheet, Word/PowerPoint/PDF as plain text."""
    ext = path.suffix.lower()
    info: dict[str, Any] = {}
    if ext in (".xlsx", ".xlsm"):
        import openpyxl

        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        parts, sheets = [], []
        for ws in wb.worksheets:
            rows = []
            total = 0
            for row in ws.iter_rows(values_only=True):
                total += 1
                if len(rows) < max_rows and any(v is not None and str(v).strip() for v in row):
                    rows.append(",".join(_cell(v) for v in row).rstrip(","))
            sheets.append({"name": ws.title, "rows": total, "shown": len(rows)})
            parts.append(f"## Sheet: {ws.title}\n" + "\n".join(rows))
        wb.close()
        info["sheets"] = sheets
        return "\n\n".join(parts), info
    if ext == ".docx":
        with zipfile.ZipFile(path) as z:
            return _xml_text(z.read("word/document.xml"), "w:p"), info
    if ext == ".pptx":
        with zipfile.ZipFile(path) as z:
            slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                            key=lambda n: int(re.findall(r"\d+", n)[-1]))
            return "\n\n".join(f"## Slide {i + 1}\n" + _xml_text(z.read(n), "a:p") for i, n in enumerate(slides)), info
    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        info["pages"] = len(reader.pages)
        return "\n\n".join(f"## Page {i + 1}\n" + (p.extract_text() or "") for i, p in enumerate(reader.pages[:40])), info
    if ext in TEXT_EXT or path.stat().st_size < 200_000:
        raw = path.read_bytes()[:400_000]
        if b"\x00" in raw[:4000] and ext not in TEXT_EXT:
            raise ValueError(f"{path.name} is not a text document, so it cannot be read out. Open it on the device instead.")
        return raw.decode("utf-8", errors="replace"), info
    raise ValueError(f"{path.name} is too large or not a readable document type.")


class Files:
    def __init__(self, downloads_dir: Path | None = None):
        self.downloads_dir = downloads_dir

    def read_file(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        path = find_file(str(args.get("path") or ""), self.downloads_dir)
        if SECRET_FILE.search(str(path)):
            raise PermissionError("That file holds secrets or keys, so it is not read remotely.")
        if path.stat().st_size > 50 * 2**20:
            raise ValueError("That file is over 50 MB, too large to read here.")
        text, info = file_text(path)
        cut = len(text) > MAX_CHARS
        return {"file": str(path), **info, "content": text[:MAX_CHARS], "truncated": cut,
                "note": "This is the file's actual content. Answer from it directly." + (" It was cut to fit." if cut else "")}

    def write_file(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        """Writes a text file (code, notes, a web page...). Used when Jarvis builds something itself."""
        raw = str(args.get("path") or "").strip()
        content = args.get("content")
        if not raw or not isinstance(content, str):
            raise ValueError("Give a path and the file's text content.")
        if len(content) > 2_000_000:
            raise ValueError("That is over 2 MB of text; split it into several files.")
        path = resolve(raw)
        if SECRET_FILE.search(str(path)):
            raise PermissionError("That name is reserved for secrets and keys, so JARVIS does not write it.")
        if path.is_dir():
            raise IsADirectoryError(f"{path} is a folder; give a file name inside it.")
        path.parent.mkdir(parents=True, exist_ok=True)
        existed = path.exists()
        with open(path, "a" if args.get("append") else "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return {"written": str(path), "bytes": len(content.encode("utf-8")), "replaced": existed and not args.get("append")}

    def open_file(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        path = find_file(str(args.get("path") or ""), self.downloads_dir)
        if IS_WIN:
            os.startfile(str(path))  # noqa: S606 - opening the owner's file in its default app is the intent
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"opened": str(path), "note": "Opened in its default app on the device's screen (visible in Apps > Desktop)."}

    def tools(self) -> list[Tool]:
        file_arg = {"path": {"type": "string", "description": "Path like 'Downloads/JARVIS/report.xlsx', or just the file name"}}
        return [
            Tool("create_folder", "Create a folder (and any missing parent folders) on this device.", schema(PATH, ["path"]), create_folder),
            Tool("list_folder", "List what is inside a folder on this device.", schema(PATH), list_folder),
            Tool("open_folder", "Open a folder in the file manager on this device's screen.", schema(PATH), open_folder),
            Tool("read_file", "Read a document on this device and return its contents: spreadsheets (xlsx, csv) as CSV per "
                 "sheet, Word, PowerPoint, PDF and text files as text. Use this to show or summarise a file's data in chat; "
                 "never start a coding agent just to read a file.", schema(file_arg, ["path"]), self.read_file, timeout=60),
            Tool("open_file", "Open a file in its default app on this device's screen.", schema(file_arg, ["path"]), self.open_file),
            Tool("write_file", "Create or overwrite a text file on this device (code, HTML, notes, scripts). Folders are created "
                 "as needed. Use it to build things yourself when Claude Code is not available, or for small files.",
                 schema({"path": {"type": "string", "description": "e.g. 'Desktop/site/index.html' or 'JarvisProjects/app/main.py'"},
                         "content": {"type": "string", "description": "The full text of the file"},
                         "append": {"type": "boolean", "description": "Add to the end instead of replacing"}}, ["path", "content"]),
                 self.write_file),
        ]


PATH = {"path": {"type": "string", "description": "e.g. 'Desktop/School/APUSH' or 'Documents/Projects'"}}
TOOLS = Files().tools()
