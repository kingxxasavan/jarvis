"""A real Chrome on this computer, driven over the DevTools protocol.

It runs with its own profile (agent/data/chrome-profile), so logins made through
JARVIS (Google, Spotify, school sites) stay put and never touch your everyday
Chrome profile. Frames come from Chrome's screencast, which only sends a new
image when the page actually changes, and the next frame waits for the
previous one to be delivered, so a slow connection gets fewer frames instead
of a growing delay.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote_plus

import aiohttp

log = logging.getLogger("jarvis.chrome")

PORT = int(os.environ.get("JARVIS_CHROME_PORT", "9333"))
BLOCKED_SCHEMES = re.compile(r"^(file|chrome|devtools|javascript|data|view-source|chrome-extension):", re.I)
BUTTONS = {0: "left", 1: "middle", 2: "right"}


class CdpError(Exception):
    pass


def find_chrome(configured: str = "") -> str | None:
    if configured and Path(configured).exists():
        return configured
    if sys.platform == "win32":
        for base in (os.environ.get("PROGRAMFILES", r"C:\Program Files"), os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
                     os.environ.get("LOCALAPPDATA", "")):
            for rel in (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"):
                p = Path(base) / rel
                if base and p.exists():
                    return str(p)
        return None
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"):
        if shutil.which(name):
            return shutil.which(name)
    return None


def to_url(text: str) -> str:
    t = text.strip()
    if BLOCKED_SCHEMES.match(t):
        raise ValueError("That kind of address cannot be opened remotely.")
    if re.match(r"^[a-z][a-z0-9+.-]*://", t, re.I):
        if not re.match(r"^https?://", t, re.I):
            raise ValueError("Only web addresses can be opened remotely.")
        return t
    if t and " " not in t and ("." in t or t.startswith("localhost")):
        return "https://" + t
    return "https://www.google.com/search?q=" + quote_plus(t)


class Cdp:
    """One browser-level DevTools connection with flattened page sessions."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse, on_event: Callable[[str, dict, str | None], None]):
        self.ws = ws
        self.on_event = on_event
        self._next = 0
        self._pending: dict[int, asyncio.Future] = {}

    async def call(self, method: str, params: dict | None = None, session: str | None = None, timeout: float = 15) -> dict:
        self._next += 1
        msg_id = self._next
        fut = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        msg: dict[str, Any] = {"id": msg_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        try:
            await self.ws.send_str(json.dumps(msg))
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    async def read_loop(self) -> None:
        try:
            async for raw in self.ws:
                if raw.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(raw.data)
                if "id" in data:
                    fut = self._pending.get(data["id"])
                    if fut and not fut.done():
                        if "error" in data:
                            fut.set_exception(CdpError(data["error"].get("message", "CDP error")))
                        else:
                            fut.set_result(data.get("result", {}))
                elif data.get("method"):
                    try:
                        self.on_event(data["method"], data.get("params", {}), data.get("sessionId"))
                    except Exception:  # noqa: BLE001 - one bad event must not end the connection
                        log.exception("error handling %s", data["method"])
        finally:
            log.info("DevTools connection ended (close code %s)", self.ws.close_code)
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(CdpError("Chrome closed"))


class ChromeBrowser:
    def __init__(self, profile_dir: Path, downloads_dir: Path, chrome_bin: str,
                 send_frame: Callable[[bytes], Awaitable[None]], send_json: Callable[[dict], Awaitable[None]]):
        self.profile_dir = profile_dir
        self.downloads_dir = downloads_dir
        self.chrome_bin = chrome_bin
        self.send_frame = send_frame
        self.send_json = send_json
        self.http: aiohttp.ClientSession | None = None
        self.cdp: Cdp | None = None
        self.proc: subprocess.Popen | None = None
        self.targets: dict[str, dict[str, str]] = {}
        self.sessions: dict[str, str] = {}
        self.active: str | None = None
        self.viewport = (1280, 800)
        self.streaming = False
        self.quality = 55
        self.scale = 0.85
        self._last_ack = 0.0
        self.downloads: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    # Lifecycle -------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return bool(self.cdp and not self.cdp.ws.closed)

    async def ensure(self) -> None:
        async with self._lock:
            if self.connected:
                return
            self.http = self.http or aiohttp.ClientSession()
            info = await self._version()
            if not info:
                self._launch()
                for _ in range(60):
                    await asyncio.sleep(0.25)
                    info = await self._version()
                    if info:
                        break
            if not info:
                raise RuntimeError("Chrome did not start. Is it installed on this computer?")
            ws = await self.http.ws_connect(info["webSocketDebuggerUrl"], max_msg_size=0)
            self.cdp = Cdp(ws, self._on_event)
            asyncio.create_task(self._watch(self.cdp))
            await self._setup()

    async def _version(self) -> dict | None:
        assert self.http
        try:
            async with self.http.get(f"http://127.0.0.1:{PORT}/json/version", timeout=aiohttp.ClientTimeout(total=2)) as r:
                return await r.json()
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return None

    def _launch(self) -> None:
        exe = find_chrome(self.chrome_bin)
        if not exe:
            raise RuntimeError("Chrome is not installed on this computer.")
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        args = [exe, f"--remote-debugging-port={PORT}", f"--user-data-dir={self.profile_dir}",
                "--no-first-run", "--no-default-browser-check", "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
                "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800", "https://www.google.com"]
        log.info("starting Chrome for streaming")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    async def _watch(self, cdp: Cdp) -> None:
        await cdp.read_loop()
        if self.cdp is cdp:
            self.cdp = None
            self.targets.clear()
            self.sessions.clear()
            self.active = None
            await self.send_json({"type": "status", "state": "closed", "message": "The browser was closed. It reopens on your next action."})

    async def _setup(self) -> None:
        assert self.cdp
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        await self.cdp.call("Target.setDiscoverTargets", {"discover": True})
        await self.cdp.call("Browser.setDownloadBehavior",
                            {"behavior": "allow", "downloadPath": str(self.downloads_dir), "eventsEnabled": True})
        res = await self.cdp.call("Target.getTargets")
        for t in res.get("targetInfos", []):
            if t["type"] == "page":
                self.targets[t["targetId"]] = {"id": t["targetId"], "title": t.get("title", ""), "url": t.get("url", "")}
        if not self.targets:
            await self._new_tab("https://www.google.com")
        else:
            await self._activate(next(iter(self.targets)))

    async def close(self) -> None:
        if self.cdp:
            await self.cdp.ws.close()
        if self.http:
            await self.http.close()

    # Events ----------------------------------------------------------------------

    def _on_event(self, method: str, params: dict, session: str | None) -> None:
        if method == "Page.screencastFrame":
            if session and session == self.sessions.get(self.active or ""):
                asyncio.create_task(self._frame(params, session))
            return
        if method in ("Target.targetCreated", "Target.targetInfoChanged"):
            t = params["targetInfo"]
            if t["type"] != "page":
                return
            is_new = t["targetId"] not in self.targets
            self.targets[t["targetId"]] = {"id": t["targetId"], "title": t.get("title", ""), "url": t.get("url", "")}
            if is_new and t.get("openerId"):
                asyncio.create_task(self._activate(t["targetId"]))  # follow links that open a new tab
            else:
                asyncio.create_task(self.send_tabs())
        elif method == "Target.targetDestroyed":
            tid = params["targetId"]
            if self.targets.pop(tid, None) is not None:
                self.sessions.pop(tid, None)
                if tid == self.active:
                    self.active = None
                    nxt = next(iter(self.targets), None)
                    asyncio.create_task(self._activate(nxt) if nxt else self._new_tab("https://www.google.com"))
                else:
                    asyncio.create_task(self.send_tabs())
        elif method == "Target.detachedFromTarget":
            for tid, sid in list(self.sessions.items()):
                if sid == params.get("sessionId"):
                    self.sessions.pop(tid, None)
        elif method == "Browser.downloadWillBegin":
            self.downloads[params["guid"]] = {"name": params.get("suggestedFilename", "download"), "url": params.get("url", "")}
            asyncio.create_task(self.send_json({"type": "download", "name": self.downloads[params["guid"]]["name"], "state": "started"}))
        elif method == "Browser.downloadProgress":
            d = self.downloads.get(params["guid"], {"name": "download"})
            if params.get("state") in ("completed", "canceled"):
                asyncio.create_task(self.send_json({"type": "download", "name": d["name"], "state": params["state"],
                                                    "bytes": params.get("totalBytes", 0)}))

    async def _frame(self, params: dict, session: str) -> None:
        """Hands the frame to the viewers (who keep only the newest) and asks Chrome
        for the next one straight away, at most ~25 times a second."""
        import base64
        import time

        try:
            await self.send_frame(base64.b64decode(params["data"]))
        finally:
            wait = self._last_ack + 0.04 - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_ack = time.monotonic()
            if self.cdp:
                try:
                    await self.cdp.call("Page.screencastFrameAck", {"sessionId": params["sessionId"]}, session, timeout=5)
                except (CdpError, asyncio.TimeoutError):
                    pass

    # Tabs and view ---------------------------------------------------------------

    async def send_tabs(self) -> None:
        tabs = [{**t, "active": t["id"] == self.active} for t in self.targets.values()]
        active = self.targets.get(self.active or "", {})
        await self.send_json({"type": "tabs", "tabs": tabs, "url": active.get("url", ""), "title": active.get("title", "")})

    async def _session(self, target_id: str) -> str:
        assert self.cdp
        if target_id not in self.sessions:
            res = await self.cdp.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})
            self.sessions[target_id] = res["sessionId"]
            await self.cdp.call("Page.enable", session=res["sessionId"])
        return self.sessions[target_id]

    async def activate(self, target_id: str) -> None:
        await self.ensure()
        await self._activate(target_id)

    async def _activate(self, target_id: str) -> None:
        """Shows one tab. Assumes the DevTools connection is up (ensure() calls this)."""
        assert self.cdp
        if target_id not in self.targets:
            raise ValueError("That tab is gone.")
        previous = self.sessions.get(self.active or "")
        if previous and self.streaming and self.active != target_id:
            try:
                await self.cdp.call("Page.stopScreencast", session=previous)
            except CdpError:
                pass
        self.active = target_id
        sid = await self._session(target_id)
        await self.cdp.call("Target.activateTarget", {"targetId": target_id})
        await self._apply_viewport(sid)
        if self.streaming:
            await self._start_screencast(sid)
        await self.send_tabs()

    async def _apply_viewport(self, sid: str) -> None:
        assert self.cdp
        w, h = self.viewport
        await self.cdp.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, sid)

    async def _start_screencast(self, sid: str) -> None:
        """(Re)starts the screencast; a running one is stopped first so size and quality changes apply."""
        assert self.cdp
        try:
            await self.cdp.call("Page.stopScreencast", session=sid)
        except CdpError:
            pass
        w, h = self.viewport
        await self.cdp.call("Page.startScreencast", {"format": "jpeg", "quality": self.quality,
                                                     "maxWidth": int(w * self.scale), "maxHeight": int(h * self.scale)}, sid)

    async def set_view(self, width: int, height: int, quality: int | None = None, scale: float | None = None) -> None:
        self.viewport = (max(320, min(int(width), 1920)), max(240, min(int(height), 1200)))
        if quality:
            self.quality = max(20, min(int(quality), 90))
        if scale:
            self.scale = max(0.4, min(float(scale), 1.0))
        await self.ensure()
        if self.active:
            sid = await self._session(self.active)
            await self._apply_viewport(sid)
            if self.streaming:
                await self._start_screencast(sid)

    async def start_stream(self) -> None:
        self.streaming = True
        await self.ensure()
        if self.active:
            await self._start_screencast(await self._session(self.active))
        await self.send_tabs()

    async def stop_stream(self) -> None:
        self.streaming = False
        if self.connected and self.active and self.active in self.sessions:
            try:
                await self.cdp.call("Page.stopScreencast", session=self.sessions[self.active])  # type: ignore[union-attr]
            except CdpError:
                pass

    async def new_tab(self, url: str) -> str:
        await self.ensure()
        return await self._new_tab(url)

    async def _new_tab(self, url: str) -> str:
        assert self.cdp
        res = await self.cdp.call("Target.createTarget", {"url": to_url(url) if url else "https://www.google.com"})
        tid = res["targetId"]
        self.targets.setdefault(tid, {"id": tid, "title": "", "url": url})
        await self._activate(tid)
        return tid

    async def close_tab(self, target_id: str) -> None:
        await self.ensure()
        assert self.cdp
        if len(self.targets) <= 1:
            await self.navigate("https://www.google.com")
            return
        await self.cdp.call("Target.closeTarget", {"targetId": target_id})

    # Page actions ------------------------------------------------------------------

    async def _active_session(self) -> str:
        await self.ensure()
        if not self.active:
            await self._new_tab("https://www.google.com")
        return await self._session(self.active)  # type: ignore[arg-type]

    async def navigate(self, text: str) -> None:
        sid = await self._active_session()
        await self.cdp.call("Page.navigate", {"url": to_url(text)}, sid)  # type: ignore[union-attr]

    async def history(self, step: int) -> None:
        sid = await self._active_session()
        assert self.cdp
        h = await self.cdp.call("Page.getNavigationHistory", session=sid)
        index = h["currentIndex"] + step
        if 0 <= index < len(h["entries"]):
            await self.cdp.call("Page.navigateToHistoryEntry", {"entryId": h["entries"][index]["id"]}, sid)

    async def reload(self) -> None:
        sid = await self._active_session()
        await self.cdp.call("Page.reload", session=sid)  # type: ignore[union-attr]

    async def mouse(self, e: dict) -> None:
        sid = await self._active_session()
        kind = e.get("kind")
        x, y = float(e.get("x", 0)), float(e.get("y", 0))
        mods = int(e.get("mods", 0))
        base = {"x": x, "y": y, "modifiers": mods}
        if kind == "wheel":
            params = {**base, "type": "mouseWheel", "deltaX": float(e.get("dx", 0)), "deltaY": float(e.get("dy", 0))}
        elif kind == "move":
            buttons = int(e.get("buttons", 0))
            params = {**base, "type": "mouseMoved", "button": "left" if buttons & 1 else "none", "buttons": buttons}
        elif kind in ("down", "up"):
            params = {**base, "type": "mousePressed" if kind == "down" else "mouseReleased",
                      "button": BUTTONS.get(int(e.get("button", 0)), "left"), "clickCount": max(1, int(e.get("clicks", 1))),
                      "buttons": int(e.get("buttons", 0))}
        else:
            return
        await self.cdp.call("Input.dispatchMouseEvent", params, sid)  # type: ignore[union-attr]

    async def key(self, e: dict) -> None:
        sid = await self._active_session()
        key = str(e.get("key", ""))
        mods = int(e.get("mods", 0))
        vk = int(e.get("keyCode", 0))
        common = {"key": key, "code": str(e.get("code", "")), "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": mods}
        if e.get("kind") == "up":
            params = {**common, "type": "keyUp"}
        else:
            text = key if len(key) == 1 and not mods & (2 | 4) else ("\r" if key == "Enter" else "")
            params = {**common, "type": "keyDown" if text else "rawKeyDown"}
            if text:
                params.update(text=text, unmodifiedText=text)
        await self.cdp.call("Input.dispatchKeyEvent", params, sid)  # type: ignore[union-attr]

    async def insert_text(self, text: str) -> None:
        sid = await self._active_session()
        await self.cdp.call("Input.insertText", {"text": text[:20000]}, sid)  # type: ignore[union-attr]

    async def selection(self) -> str:
        sid = await self._active_session()
        res = await self.cdp.call("Runtime.evaluate", {"expression": "String(window.getSelection() || '')", "returnByValue": True}, sid)  # type: ignore[union-attr]
        return str(res.get("result", {}).get("value", ""))[:20000]
