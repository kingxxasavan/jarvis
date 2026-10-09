"""Tools tied to the streamed apps: the remote browser and the downloads folder."""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx

from ..registry import Tool, ToolContext, schema

UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def clean_name(name: str) -> str:
    name = UNSAFE.sub("_", unquote(name)).strip(" .")[:150]
    return name or "download"


def unique_path(folder: Path, name: str) -> Path:
    path = folder / name
    stem, suffix = path.stem, path.suffix
    n = 1
    while path.exists():
        path = folder / f"{stem} ({n}){suffix}"
        n += 1
    return path


def filename_for(url: str, headers: httpx.Headers) -> str:
    cd = headers.get("content-disposition", "")
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd, re.I) or re.search(r'filename="?([^";]+)"?', cd, re.I)
    if m:
        return clean_name(m.group(1))
    return clean_name(Path(urlparse(url).path).name or "download")


class AppTools:
    def __init__(self, downloads_dir: Path, stream_getter):
        self.downloads_dir = downloads_dir
        self.stream = stream_getter

    def browser_open(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        service = self.stream()
        if not service:
            raise RuntimeError("App streaming is turned off on this device.")
        url = str(args.get("url") or "").strip()
        if not url:
            raise ValueError("Which page?")
        service.run(service.browser.new_tab(url))
        return {"opened": url, "note": "Open the Apps tab in JARVIS to see and use it."}

    def download_file(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        url = str(args.get("url") or "").strip()
        if not re.match(r"^https?://", url, re.I):
            raise ValueError("Give a web address (http or https) to download.")
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(30, read=120),
                          headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS"}) as res:
            res.raise_for_status()
            name = clean_name(str(args.get("filename") or "")) if args.get("filename") else filename_for(str(res.url), res.headers)
            target = unique_path(self.downloads_dir, name)
            total = int(res.headers.get("content-length") or 0)
            part = target.with_name(target.name + ".part")
            got, last_report = 0, time.time()
            ctx.log("log", f"Downloading {name}" + (f" ({total / 2**20:.1f} MB)" if total else ""))
            with open(part, "wb") as f:
                for chunk in res.iter_bytes(1024 * 256):
                    if ctx.cancelled():
                        f.close()
                        part.unlink(missing_ok=True)
                        raise RuntimeError("Download cancelled.")
                    f.write(chunk)
                    got += len(chunk)
                    if time.time() - last_report > 5:
                        last_report = time.time()
                        ctx.log("log", f"{got / 2**20:.1f} MB" + (f" of {total / 2**20:.1f} MB ({got * 100 // total}%)" if total else ""))
            part.replace(target)
        return {"saved": target.name, "folder": str(self.downloads_dir), "size_mb": round(got / 2**20, 2),
                "note": "It is in the Downloads list on the Apps tab."}

    def list_downloads(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        files = sorted((p for p in self.downloads_dir.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        return {"folder": str(self.downloads_dir),
                "files": [{"name": p.name, "size_mb": round(p.stat().st_size / 2**20, 2)} for p in files[:50]]}

    def tools(self) -> list[Tool]:
        return [
            Tool("browser_open", "Open a web page in the streamed browser on this device, the one Sir uses from the Apps tab "
                 "(logged-in sites, Spotify web player, school sites).", schema({"url": {"type": "string"}}, ["url"]), self.browser_open),
            Tool("download_file", "Download a file from a web address into the JARVIS downloads folder on this device.",
                 schema({"url": {"type": "string"}, "filename": {"type": "string", "description": "Optional name to save as"}}, ["url"]),
                 self.download_file, long_running=True),
            Tool("list_downloads", "List files in the JARVIS downloads folder on this device.", schema(), self.list_downloads),
        ]
