"""The stream service: a small web server on 127.0.0.1, reached from JARVIS
through the Cloudflare tunnel.

    GET /health            plain liveness check
    GET /ws?t=<pass>       the streamed browser (frames, audio, input, tabs)
    GET /files?t=<pass>    files in the JARVIS downloads folder
    GET /files/<name>?t=   download one of them

Every route but /health needs a pass minted by the website for the signed-in
owner. Binary messages to the page start with one byte: 1 = JPEG frame,
2 = 20 ms of 24 kHz mono 16-bit audio.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any, Callable

from aiohttp import WSMsgType, web

from . import auth
from .audio import AudioCapture
from .chrome import ChromeBrowser
from .tunnel import Tunnel

log = logging.getLogger("jarvis.stream")

FRAME, AUDIO = b"\x01", b"\x02"
CORS = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"}


class Client:
    def __init__(self, ws: web.WebSocketResponse):
        self.ws = ws
        self.audio = False


class StreamService:
    def __init__(self, data_dir: Path, downloads_dir: Path, chrome_bin: str = "", port: int = 8788,
                 on_published: Callable[[str, str], None] | None = None, tunnel_token: str = "", public_url: str = ""):
        self.port = port
        self.downloads_dir = downloads_dir
        self.secret = auth.new_secret()
        self.on_published = on_published
        self.clients: set[Client] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.browser = ChromeBrowser(data_dir / "chrome-profile", downloads_dir, chrome_bin, self._send_frame, self._send_json)
        self.audio = AudioCapture(self._on_audio)
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
        try:
            if isinstance(data, bytes):
                await asyncio.wait_for(client.ws.send_bytes(data), 10)
            else:
                await asyncio.wait_for(client.ws.send_str(data), 10)
        except Exception:  # noqa: BLE001 - a dead or stuck viewer is dropped
            self.clients.discard(client)
            await client.ws.close()

    async def _send_frame(self, jpeg: bytes) -> None:
        await asyncio.gather(*(self._send(c, FRAME + jpeg) for c in list(self.clients)))

    async def _send_json(self, msg: dict) -> None:
        text = json.dumps(msg)
        await asyncio.gather(*(self._send(c, text) for c in list(self.clients)))

    def _on_audio(self, pcm: bytes) -> None:
        if self.loop:
            self.loop.call_soon_threadsafe(self._fan_audio, AUDIO + pcm)

    def _fan_audio(self, packet: bytes) -> None:
        for c in list(self.clients):
            if c.audio and not c.ws.closed:
                asyncio.create_task(self._send(c, packet))

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
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=1024**2)
        await ws.prepare(request)
        client = Client(ws)
        self.clients.add(client)
        log.info("viewer connected (%d watching)", len(self.clients))
        try:
            await self.browser.start_stream()
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    await self._handle(client, json.loads(msg.data))
                except Exception as exc:  # noqa: BLE001 - report to the page, keep the session
                    await self._send(client, json.dumps({"type": "error", "message": str(exc) or exc.__class__.__name__}))
        except Exception as exc:  # noqa: BLE001
            await self._send(client, json.dumps({"type": "error", "message": str(exc)}))
        finally:
            self.clients.discard(client)
            self._update_audio()
            if not self.clients:
                await self.browser.stop_stream()
            log.info("viewer left (%d watching)", len(self.clients))
        return ws

    async def _handle(self, client: Client, m: dict) -> None:
        kind = m.get("type")
        b = self.browser
        if kind == "mouse":
            await b.mouse(m)
        elif kind == "key":
            await b.key(m)
        elif kind == "view":
            await b.set_view(m.get("width", 1280), m.get("height", 800), m.get("quality"))
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
            if p.is_file() and not p.name.endswith((".crdownload", ".part", ".tmp")):
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


def status_line(service: StreamService | None) -> str:
    if not service:
        return "off"
    if service.error:
        return service.error
    if service.tunnel.url:
        return f"online at {service.tunnel.url}"
    return service.tunnel.error or f"starting (local only on 127.0.0.1:{service.port})"

