"""The stream service: a small web server on 127.0.0.1, reached from JARVIS
through the Cloudflare tunnel.

    GET /health            plain liveness check
    GET /ws?t=<pass>       the streamed browser (frames, audio, input, tabs)
    GET /files?t=<pass>    files in the JARVIS downloads folder
    GET /files/<name>?t=   download one of them
    GET /fs/list?t=&path=  the file manager: a folder on this computer
    GET /fs/get?t=&path=   one file (inline=1 to view it in the browser)
    POST /fs/upload?t=&path=<folder>   multipart upload into a folder
    POST /fs/open?t=&path= open a file or folder on this computer's screen
    POST /fs/cloud?t=&path= copy a file to the owner's cloud files

/ws?mode=desktop streams the whole screen instead of the browser.

Every route but /health needs a pass minted by the website for the signed-in
owner. Binary messages to the page start with one byte: 1 = JPEG frame,
2 = 20 ms of 24 kHz mono 16-bit audio.
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import re
import threading
from collections import deque
from pathlib import Path
from typing import Any, Callable

from aiohttp import WSMsgType, web

from . import auth
from .audio import AudioCapture
from ..tools import files as fs
from .chrome import ChromeBrowser
from .desktop import DesktopScreen
from .icons import AppIcons
from .tunnel import Tunnel

log = logging.getLogger("jarvis.stream")

FRAME, AUDIO = b"\x01", b"\x02"
CORS = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"}
GUID_NAME = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)  # Chrome download in progress
INPUT = {"mouse", "key", "view", "text", "copy"}


class Client:
    """One viewer. Frames go through a one-slot mailbox: if the network is slower
    than the screen changes, older frames are replaced instead of queued, so the
    picture is always current rather than seconds behind."""

    MAX_QUEUED_AUDIO = 25  # 0.5 s; older sound is dropped rather than played late

    def __init__(self, ws: web.WebSocketResponse, mode: str = "browser"):
        self.ws = ws
        self.mode = mode
        self.audio = False
        self.frame: bytes | None = None
        self.queue: deque[bytes | str] = deque()  # messages and sound, in order
        self.wake = asyncio.Event()
        self.sender: asyncio.Task | None = None

    def offer(self, packet: bytes) -> None:
        self.frame = packet
        self.wake.set()

    def push(self, data: bytes | str) -> None:
        if isinstance(data, bytes) and data[:1] == AUDIO:
            audio = sum(1 for d in self.queue if isinstance(d, bytes))
            if audio >= self.MAX_QUEUED_AUDIO:
                for i, d in enumerate(self.queue):
                    if isinstance(d, bytes):
                        del self.queue[i]
                        break
        self.queue.append(data)
        self.wake.set()

    async def pump(self) -> None:
        """The only place that writes to this viewer's socket."""
        while not self.ws.closed:
            await self.wake.wait()
            self.wake.clear()
            while self.queue:
                item = self.queue.popleft()
                if isinstance(item, bytes):
                    await asyncio.wait_for(self.ws.send_bytes(item), 15)
                else:
                    await asyncio.wait_for(self.ws.send_str(item), 15)
            packet, self.frame = self.frame, None
            if packet is not None:
                await asyncio.wait_for(self.ws.send_bytes(packet), 15)
                if self.queue or self.frame:
                    self.wake.set()


class StreamService:
    def __init__(self, data_dir: Path, downloads_dir: Path, chrome_bin: str = "", port: int = 8788,
                 on_published: Callable[[str, str], None] | None = None, tunnel_token: str = "", public_url: str = "",
                 cloud=None, extra_roots: list[tuple[str, Path]] | None = None, audio_device: str = ""):
        self.port = port
        self.downloads_dir = downloads_dir
        self.cloud = cloud
        self.extra_roots = extra_roots or []
        self.secret = auth.new_secret()
        self.on_published = on_published
        self.clients: set[Client] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.browser = ChromeBrowser(data_dir / "chrome-profile", downloads_dir, chrome_bin, self._send_frame, self._send_json,
                                     on_downloaded=self._downloaded)
        self.icons = AppIcons(data_dir / "icons")
        self.desktop = DesktopScreen(self._send_desktop_frame, self._send_desktop_json)
        self.audio = AudioCapture(self._on_audio, audio_device, on_error=lambda m: self._notify(m, "error"))
        self.tunnel = Tunnel(port, self._on_url, tunnel_token, public_url)
        self._ready = threading.Event()
        self.error = ""

    # Thread entry ---------------------------------------------------------------

    def start(self) -> None:
        threading.Thread(target=self._thread, name="stream", daemon=True).start()
        self._ready.wait(10)
        self.tunnel.start()

    def _thread(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._serve())
            self._ready.set()
            self.loop.run_forever()
        except OSError as exc:
            self.error = f"Stream server could not start on port {self.port}: {exc}"
            log.error(self.error)
            self._ready.set()

    async def _serve(self) -> None:
        app = web.Application(client_max_size=1024**2)
        app.add_routes([
            web.get("/health", self._health),
            web.get("/ws", self._ws),
            web.get("/files", self._list_files),
            web.get("/files/{name}", self._get_file),
            web.get("/fs/list", self._fs_list),
            web.get("/fs/get", self._fs_get),
            web.post("/fs/upload", self._fs_upload),
            web.post("/fs/open", self._fs_open),
            web.post("/fs/cloud", self._fs_cloud),
            web.get("/apps", self._apps),
            web.get("/apps/icon", self._app_icon),
            web.post("/apps/open", self._app_open),
        ])
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", self.port).start()
        log.info("stream server on 127.0.0.1:%d", self.port)

    def run(self, coro: Any, timeout: float = 30) -> Any:
        """Runs a coroutine on the stream loop from another thread (tools use this)."""
        if not self.loop:
            raise RuntimeError("The stream service is not running.")
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def stop(self) -> None:
        self.tunnel.stop()
        self.audio.stop()

    def _on_url(self, url: str) -> None:
        if self.on_published:
            self.on_published(url, self.secret)

    # Fan-out ---------------------------------------------------------------------

    async def _send(self, client: Client, data: bytes | str) -> None:
        client.push(data)

    async def _send_frame(self, jpeg: bytes) -> None:
        packet = FRAME + jpeg
        for c in list(self.clients):
            if c.mode == "browser":
                c.offer(packet)

    async def _send_desktop_frame(self, jpeg: bytes) -> None:
        packet = FRAME + jpeg
        for c in list(self.clients):
            if c.mode == "desktop":
                c.offer(packet)

    async def _send_json(self, msg: dict) -> None:
        text = json.dumps(msg)
        for c in list(self.clients):
            if c.mode == "browser" or msg.get("type") == "download":
                c.push(text)

    async def _send_desktop_json(self, msg: dict) -> None:
        text = json.dumps(msg)
        for c in list(self.clients):
            if c.mode == "desktop":
                c.push(text)

    def _downloaded(self, path: Path) -> None:
        """A download in the streamed Chrome finished: keep a copy in cloud files."""
        if not self.cloud:
            return
        note = self.cloud.submit(path, lambda kind, text: self._notify(text, kind))
        log.info("download %s: %s", path.name, note)

    def _notify(self, text: str, kind: str = "cloud") -> None:
        if self.loop:
            msg = json.dumps({"type": "error" if kind == "error" else "notice", "message": text})
            self.loop.call_soon_threadsafe(lambda: [c.push(msg) for c in list(self.clients)])

    def _on_audio(self, pcm: bytes) -> None:
        if self.loop:
            self.loop.call_soon_threadsafe(self._fan_audio, AUDIO + pcm)

    def _fan_audio(self, packet: bytes) -> None:
        for c in list(self.clients):
            if c.audio and not c.ws.closed:
                c.push(packet)

    def _update_audio(self) -> None:
        if any(c.audio for c in self.clients):
            self.audio.start()
        else:
            self.audio.stop()

    # Routes ----------------------------------------------------------------------

    def _authorized(self, request: web.Request, scope: str) -> bool:
        return auth.verify(self.secret, request.query.get("t"), scope)

    async def _health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True}, headers=CORS)

    async def _ws(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request, "stream"):
            return web.json_response({"error": "This link has expired. Reopen Apps in JARVIS."}, status=403, headers=CORS)
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=1024**2, compress=False)
        await ws.prepare(request)
        client = Client(ws, "desktop" if request.query.get("mode") == "desktop" else "browser")
        client.sender = asyncio.create_task(self._pump(client))
        self.clients.add(client)
        log.info("viewer connected (%d watching)", len(self.clients))
        inbox: deque[dict] = deque()
        wake = asyncio.Event()
        worker = asyncio.create_task(self._work(client, inbox, wake))
        try:
            if client.mode == "desktop":
                await self.desktop.start_stream()
            else:
                await self.browser.start_stream()
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    inbox.append(json.loads(msg.data))
                except ValueError:
                    continue
                wake.set()
        except Exception as exc:  # noqa: BLE001
            await self._send(client, json.dumps({"type": "error", "message": str(exc)}))
        finally:
            worker.cancel()
            if client.sender:
                client.sender.cancel()
            self.clients.discard(client)
            self._update_audio()
            if not any(c.mode == "browser" for c in self.clients):
                await self.browser.stop_stream()
            if not any(c.mode == "desktop" for c in self.clients):
                await self.desktop.stop_stream()
            log.info("viewer left (%d watching)", len(self.clients))
        return ws

    async def _pump(self, client: Client) -> None:
        try:
            await client.pump()
        except Exception:  # noqa: BLE001 - a stuck or closed viewer is dropped
            self.clients.discard(client)
            await client.ws.close()

    async def _work(self, client: Client, inbox: deque, wake: asyncio.Event) -> None:
        """Runs the viewer's input in order. Consecutive pointer moves collapse into
        the latest one and consecutive scrolls add up, so a click never waits behind
        a backlog of movement over a slow connection."""
        while True:
            await wake.wait()
            wake.clear()
            while inbox:
                m = inbox.popleft()
                if m.get("type") == "mouse":
                    kind = m.get("kind")
                    while inbox and inbox[0].get("type") == "mouse" and inbox[0].get("kind") == kind and kind in ("move", "wheel"):
                        nxt = inbox.popleft()
                        if kind == "wheel":
                            nxt["dx"] = float(nxt.get("dx", 0)) + float(m.get("dx", 0))
                            nxt["dy"] = float(nxt.get("dy", 0)) + float(m.get("dy", 0))
                        m = nxt
                try:
                    await self._handle(client, m)
                except Exception as exc:  # noqa: BLE001
                    if m.get("type") in (*INPUT, "audio"):
                        # Input landing mid-navigation can fail harmlessly; do not nag the viewer.
                        log.debug("input %s ignored: %s", m.get("type"), exc)
                    else:
                        await self._send(client, json.dumps({"type": "error", "message": str(exc) or exc.__class__.__name__}))

    async def _handle(self, client: Client, m: dict) -> None:
        kind = m.get("type")
        b = self.desktop if client.mode == "desktop" and kind in INPUT else self.browser
        if kind == "mouse":
            await b.mouse(m)
        elif kind == "key":
            await b.key(m)
        elif kind == "view":
            await b.set_view(m.get("width", 1280), m.get("height", 800), m.get("quality"), m.get("scale"))
        elif kind == "text":
            await b.insert_text(str(m.get("text", "")))
        elif kind == "copy":
            await self._send(client, json.dumps({"type": "clipboard", "text": await b.selection()}))
        elif kind == "navigate":
            await b.navigate(str(m.get("url", "")))
        elif kind == "back":
            await b.history(-1)
        elif kind == "forward":
            await b.history(1)
        elif kind == "reload":
            await b.reload()
        elif kind == "new_tab":
            await b.new_tab(str(m.get("url", "")))
        elif kind == "switch_tab":
            await b.activate(str(m.get("id", "")))
        elif kind == "close_tab":
            await b.close_tab(str(m.get("id", "")))
        elif kind == "file_chosen":
            names = m.get("names")
            await self.browser.choose_files([str(n) for n in names] if isinstance(names, list) else [])
        elif kind == "audio":
            client.audio = bool(m.get("on"))
            self._update_audio()
            if client.audio and self.audio.error:
                await self._send(client, json.dumps({"type": "error", "message": f"Sound unavailable: {self.audio.error}"}))

    def _safe_file(self, name: str) -> Path | None:
        target = (self.downloads_dir / name).resolve()
        root = self.downloads_dir.resolve()
        return target if target.parent == root and target.is_file() else None

    async def _list_files(self, request: web.Request) -> web.Response:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        files = []
        for p in sorted(self.downloads_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if p.is_file() and not p.name.endswith((".crdownload", ".part", ".tmp")) and not GUID_NAME.match(p.name):
                st = p.stat()
                files.append({"name": p.name, "size": st.st_size, "modified": int(st.st_mtime * 1000)})
        return web.json_response({"files": files[:300], "folder": str(self.downloads_dir)}, headers=CORS)

    async def _get_file(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        path = self._safe_file(request.match_info["name"])
        if not path:
            return web.json_response({"error": "not found"}, status=404, headers=CORS)
        quoted = path.name.replace('"', "")
        return web.FileResponse(path, headers={**CORS, "Content-Disposition": f'attachment; filename="{quoted}"'})

    # Installed apps -------------------------------------------------------------

    async def _apps(self, request: web.Request) -> web.Response:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        names = await asyncio.to_thread(self.icons.names)
        self.icons.ensure()
        return web.json_response({"apps": names}, headers=CORS)

    async def _app_icon(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        path = self.icons.path(request.query.get("name", ""))
        if not path:
            return web.Response(status=404, headers=CORS)
        return web.FileResponse(path, headers={**CORS, "Content-Type": "image/png", "Cache-Control": "private, max-age=86400"})

    async def _app_open(self, request: web.Request) -> web.Response:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        from ..tools.system import open_app

        try:
            result = await asyncio.to_thread(open_app, {"name": request.query.get("name", "")}, None)
            return web.json_response(result, headers=CORS)
        except (LookupError, ValueError, OSError) as exc:
            return web.json_response({"error": str(exc)}, status=404, headers=CORS)

    # File manager ----------------------------------------------------------------

    def _roots(self) -> list[dict[str, str]]:
        roots = [("JARVIS downloads", self.downloads_dir)]
        for label in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"):
            p = fs.known_folder(label.lower())
            if p and p.is_dir():
                roots.append((label, p))
        roots += self.extra_roots
        roots.append(("Home", Path.home()))
        return [{"label": label, "path": str(p)} for label, p in roots]

    def _fs_path(self, request: web.Request, default: str = "") -> Path:
        raw = request.query.get("path") or default
        if not raw:
            return self.downloads_dir
        return fs.resolve(raw)

    def _deny(self, exc: Exception) -> web.Response:
        status = 403 if isinstance(exc, PermissionError) else 404 if isinstance(exc, FileNotFoundError) else 400
        return web.json_response({"error": str(exc) or exc.__class__.__name__}, status=status, headers=CORS)

    async def _fs_list(self, request: web.Request) -> web.Response:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        try:
            folder = self._fs_path(request)
            if folder == self.downloads_dir:
                folder.mkdir(parents=True, exist_ok=True)
            if not folder.is_dir():
                raise FileNotFoundError(f"There is no folder at {folder}.")
            items = []
            for p in folder.iterdir():
                if p.name.startswith(".") or p.name.lower() in ("desktop.ini", "thumbs.db") or GUID_NAME.match(p.name):
                    continue
                try:
                    st = p.stat()
                    is_dir = p.is_dir()
                except OSError:
                    continue
                items.append({"name": p.name, "dir": is_dir, "size": 0 if is_dir else st.st_size, "modified": int(st.st_mtime * 1000)})
            items.sort(key=lambda i: (not i["dir"], i["name"].lower()))
            parent = str(folder.parent) if folder.parent != folder else ""
            try:
                fs.resolve(parent) if parent else None
            except PermissionError:
                parent = ""
            return web.json_response({"path": str(folder), "parent": parent, "items": items[:2000], "roots": self._roots(),
                                      "cloud": bool(self.cloud and self.cloud.enabled)}, headers=CORS)
        except (OSError, ValueError) as exc:
            return self._deny(exc)

    async def _fs_get(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        try:
            path = self._fs_path(request)
            if not path.is_file():
                raise FileNotFoundError("No such file.")
            if fs.SECRET_FILE.search(str(path)):
                raise PermissionError("That file holds secrets or keys, so it is not shared.")
        except (OSError, ValueError) as exc:
            return self._deny(exc)
        quoted = path.name.replace('"', "")
        disposition = "inline" if request.query.get("inline") else "attachment"
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return web.FileResponse(path, headers={**CORS, "Content-Type": ctype, "Content-Disposition": f'{disposition}; filename="{quoted}"'})

    async def _fs_upload(self, request: web.Request) -> web.Response:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        try:
            folder = self._fs_path(request)
            folder.mkdir(parents=True, exist_ok=True)
            saved = []
            reader = await request.multipart()
            from ..tools.apps import clean_name, unique_path

            while True:
                part = await reader.next()
                if part is None:
                    break
                if not getattr(part, "filename", None):
                    continue
                target = unique_path(folder, clean_name(part.filename))
                tmp = target.with_name(target.name + ".part")
                with open(tmp, "wb") as f:
                    while chunk := await part.read_chunk(1024 * 512):
                        f.write(chunk)
                tmp.replace(target)
                saved.append(target.name)
            return web.json_response({"saved": saved, "folder": str(folder)}, headers=CORS)
        except (OSError, ValueError) as exc:
            return self._deny(exc)

    async def _fs_open(self, request: web.Request) -> web.Response:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        try:
            path = self._fs_path(request)
            args = {"path": str(path)}
            if path.is_dir():
                result = await asyncio.to_thread(fs.open_folder, args, None)
            else:
                result = await asyncio.to_thread(fs.Files(self.downloads_dir).open_file, args, None)
            return web.json_response(result, headers=CORS)
        except (OSError, ValueError) as exc:
            return self._deny(exc)

    async def _fs_cloud(self, request: web.Request) -> web.Response:
        if not self._authorized(request, "files"):
            return web.json_response({"error": "expired"}, status=403, headers=CORS)
        try:
            path = self._fs_path(request)
            if not path.is_file():
                raise FileNotFoundError("No such file.")
            if fs.SECRET_FILE.search(str(path)):
                raise PermissionError("That file holds secrets or keys, so it is not uploaded.")
            if not self.cloud:
                raise ValueError("Cloud files are off on this device.")
            await asyncio.to_thread(self.cloud.upload_now, path)
            return web.json_response({"uploaded": path.name}, headers=CORS)
        except (OSError, ValueError, RuntimeError) as exc:
            return self._deny(exc)
        except Exception as exc:  # noqa: BLE001 - upload errors are reported to the viewer
            return web.json_response({"error": str(exc)}, status=502, headers=CORS)


def status_line(service: StreamService | None) -> str:
    if not service:
        return "off"
    if service.error:
        return service.error
    if service.tunnel.url:
        return f"online at {service.tunnel.url}"
    return service.tunnel.error or f"starting (local only on 127.0.0.1:{service.port})"

