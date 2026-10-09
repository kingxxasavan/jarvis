"""The whole laptop screen, streamed like the browser, with mouse and keyboard.

This is how any installed app (the Claude desktop app, Explorer, Word...) is used
from JARVIS. Frames are JPEG screenshots taken only while someone is watching,
skipped when nothing changed. Pointer positions arrive as fractions of the
picture (0..1), so they land in the right place whatever the viewer's size.

Input uses the Windows SendInput family through ctypes (no extra install); on
Linux it falls back to xdotool when present. A locked screen cannot be captured
or controlled; the viewer is told so.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import shutil
import subprocess
import sys
import threading
import time
from typing import Awaitable, Callable

log = logging.getLogger("jarvis.desktop")

IS_WIN = sys.platform == "win32"

# Browser KeyboardEvent.keyCode values are Windows virtual-key codes already.
EXTENDED = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x6F, 0x90, 0xA3, 0xA5}
X_KEYS = {"Enter": "Return", "Backspace": "BackSpace", "Tab": "Tab", "Escape": "Escape", "ArrowLeft": "Left", "ArrowRight": "Right",
          "ArrowUp": "Up", "ArrowDown": "Down", "Delete": "Delete", "Home": "Home", "End": "End", "PageUp": "Prior",
          "PageDown": "Next", "Control": "ctrl", "Shift": "shift", "Alt": "alt", "Meta": "super", " ": "space"}

if IS_WIN:
    import ctypes
    from ctypes import wintypes

    ULONG_PTR = ctypes.c_size_t

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("pad", ctypes.c_byte * 32)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", _U)]

    def _send(*items: INPUT) -> None:
        arr = (INPUT * len(items))(*items)
        ctypes.windll.user32.SendInput(len(items), arr, ctypes.sizeof(INPUT))

    def _mouse(flags: int, data: int = 0) -> INPUT:
        i = INPUT(type=0)
        i.u.mi = MOUSEINPUT(0, 0, data & 0xFFFFFFFF, flags, 0, 0)
        return i

    def _key(vk: int = 0, scan: int = 0, flags: int = 0) -> INPUT:
        i = INPUT(type=1)
        i.u.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
        return i

    try:  # real pixels, so screenshots and the cursor agree on scaled displays
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:  # noqa: BLE001
            pass


class DesktopScreen:
    def __init__(self, send_frame: Callable[[bytes], Awaitable[None]], send_json: Callable[[dict], Awaitable[None]]):
        self.send_frame = send_frame
        self.send_json = send_json
        self.loop: asyncio.AbstractEventLoop | None = None
        self.view = (1280, 800)
        self.quality = 55
        self.scale = 0.85
        self.fps = 12
        self.monitor: dict[str, int] = {"left": 0, "top": 0, "width": 1920, "height": 1080}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._force = False
        self.error = ""

    # Capture ----------------------------------------------------------------------

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    async def start_stream(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._force = True
        if self.running and not self._stop.is_set():
            return
        if self._thread:
            self._thread.join(1)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="desktop", daemon=True)
        self._thread.start()

    async def stop_stream(self) -> None:
        self._stop.set()

    async def set_view(self, width: int, height: int, quality: int | None = None, scale: float | None = None) -> None:
        self.view = (max(320, min(int(width), 3840)), max(240, min(int(height), 2160)))
        if quality:
            self.quality = max(20, min(int(quality), 90))
        if scale:
            self.scale = max(0.4, min(float(scale), 1.0))
        self._force = True

    def _deliver(self, coro) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(coro, self.loop)

    def _run(self) -> None:
        try:
            import mss
            from PIL import Image
        except ImportError:
            self.error = "Desktop streaming needs mss and Pillow: run `py main.py setup` again."
            self._deliver(self.send_json({"type": "error", "message": self.error}))
            return
        try:
            grab_ctx = mss.mss()
        except Exception as exc:  # noqa: BLE001 - no display (service session, headless)
            self.error = f"This computer's screen cannot be captured: {exc}"
            log.warning("%s", self.error)
            self._deliver(self.send_json({"type": "error", "message": self.error}))
            return
        last_hash = b""
        locked_said = False
        with grab_ctx as grab:
            while not self._stop.is_set():
                started = time.monotonic()
                try:
                    mon = grab.monitors[1]
                    self.monitor = {k: int(mon[k]) for k in ("left", "top", "width", "height")}
                    shot = grab.grab(mon)
                    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
                    locked_said = False
                except Exception as exc:  # noqa: BLE001 - locked screen, display asleep, UAC prompt
                    if not locked_said:
                        locked_said = True
                        self._deliver(self.send_json({"type": "status", "state": "locked",
                                                      "message": f"The laptop screen cannot be captured right now (locked or asleep): {exc}"}))
                    self._stop.wait(2)
                    continue
                vw, vh = self.view
                fit = min(vw * self.scale / img.width, vh * self.scale / img.height, 1.0)
                if fit < 0.999:
                    img = img.resize((max(1, int(img.width * fit)), max(1, int(img.height * fit))), Image.BILINEAR)
                digest = hashlib.blake2b(img.tobytes(), digest_size=16).digest()
                if digest != last_hash or self._force:
                    last_hash = digest
                    self._force = False
                    buf = io.BytesIO()
                    img.save(buf, "JPEG", quality=self.quality)
                    self._deliver(self.send_frame(buf.getvalue()))
                self._stop.wait(max(0.0, 1 / self.fps - (time.monotonic() - started)))

    # Input --------------------------------------------------------------------------

    def _point(self, e: dict) -> tuple[int, int]:
        m = self.monitor
        nx = min(max(float(e.get("nx", 0)), 0.0), 1.0)
        ny = min(max(float(e.get("ny", 0)), 0.0), 1.0)
        return m["left"] + int(nx * (m["width"] - 1)), m["top"] + int(ny * (m["height"] - 1))

    async def mouse(self, e: dict) -> None:
        await asyncio.to_thread(self._mouse, e)

    def _mouse(self, e: dict) -> None:
        kind = e.get("kind")
        x, y = self._point(e)
        button = int(e.get("button", 0))
        if IS_WIN:
            ctypes.windll.user32.SetCursorPos(x, y)
            if kind == "wheel":
                dy, dx = float(e.get("dy", 0)), float(e.get("dx", 0))
                if dy:
                    _send(_mouse(0x0800, int(-dy * 1.2)))
                if dx:
                    _send(_mouse(0x1000, int(dx * 1.2)))
            elif kind in ("down", "up"):
                flags = {0: (0x0002, 0x0004), 1: (0x0020, 0x0040), 2: (0x0008, 0x0010)}.get(button, (0x0002, 0x0004))
                _send(_mouse(flags[0] if kind == "down" else flags[1]))
            return
        if not shutil.which("xdotool"):
            raise RuntimeError("Desktop control needs Windows, or xdotool on Linux.")
        cmd = ["xdotool", "mousemove", str(x), str(y)]
        xb = {0: "1", 1: "2", 2: "3"}.get(button, "1")
        if kind == "down":
            cmd += ["mousedown", xb]
        elif kind == "up":
            cmd += ["mouseup", xb]
        elif kind == "wheel":
            dy = float(e.get("dy", 0))
            if dy:
                cmd += ["click", "--repeat", str(max(1, min(int(abs(dy) / 50), 10))), "5" if dy > 0 else "4"]
        subprocess.run(cmd, capture_output=True, timeout=5)

    async def key(self, e: dict) -> None:
        await asyncio.to_thread(self._key, e)

    def _key(self, e: dict) -> None:
        up = e.get("kind") == "up"
        key = str(e.get("key", ""))
        vk = int(e.get("keyCode", 0))
        if IS_WIN:
            if not vk:
                if len(key) == 1 and not up:
                    self._type(key)
                return
            flags = (0x0002 if up else 0) | (0x0001 if vk in EXTENDED else 0)
            _send(_key(vk=vk, flags=flags))
            return
        if not shutil.which("xdotool"):
            raise RuntimeError("Desktop control needs Windows, or xdotool on Linux.")
        name = X_KEYS.get(key, key if len(key) == 1 else "")
        if name:
            subprocess.run(["xdotool", "keyup" if up else "keydown", name], capture_output=True, timeout=5)

    async def insert_text(self, text: str) -> None:
        await asyncio.to_thread(self._type, text[:5000])

    def _type(self, text: str) -> None:
        if IS_WIN:
            items = []
            for ch in text:
                if ch == "\n":
                    items += [_key(vk=0x0D), _key(vk=0x0D, flags=0x0002)]
                    continue
                for unit in ch.encode("utf-16-le").hex(" ", 2).split():
                    code = int.from_bytes(bytes.fromhex(unit), "little")
                    items += [_key(scan=code, flags=0x0004), _key(scan=code, flags=0x0004 | 0x0002)]
            for i in range(0, len(items), 200):
                _send(*items[i:i + 200])
            return
        if shutil.which("xdotool"):
            subprocess.run(["xdotool", "type", "--delay", "5", text], capture_output=True, timeout=60)

    async def selection(self) -> str:
        return ""
