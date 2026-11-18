"""The HTTP API the terminal chat talks to.

It only listens on 127.0.0.1 and only answers requests addressed to this
machine, so there is no token to set up or get wrong. To use Anexis from
somewhere else, SSH into the server and run `anexis` there.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse

from anexis import models
from anexis.agent import MODES
from anexis.doctor import doctor
from anexis.memory.store import KINDS
from anexis.tools.core import due_soon

LOCAL_NAMES = {"127.0.0.1", "localhost", "[::1]", "::1"}


def _hostname(value: str) -> str:
    """The host part of a Host header or an Origin, without scheme or port."""
    value = value.split("://", 1)[-1].split("/", 1)[0].strip().lower()
    if value.startswith("["):
        return value.split("]", 1)[0] + "]"
    return value.rsplit(":", 1)[0] if ":" in value else value


class LocalOnly:
    """Answers only requests really meant for this machine. A web page cannot
    reach Anexis by pointing a made up name at 127.0.0.1, or post to it from a
    browser on the server."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in scope.get("headers", [])}
            names = [headers.get("host", "")] + ([headers["origin"]] if "origin" in headers else [])
            if any(_hostname(name) not in LOCAL_NAMES for name in names):
                await PlainTextResponse("This Anexis only answers its own machine.", 403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(anexis) -> FastAPI:
    settings = anexis.settings
    pending: dict[str, asyncio.Future] = {}
    turns: dict[str, asyncio.Task] = {}  # session id -> the turn running in it

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await anexis.start()
        yield
        await anexis.stop()

    app = FastAPI(title=settings.name, lifespan=lifespan)
    app.state.anexis = anexis
    app.add_middleware(LocalOnly)

    @app.get("/health")
    async def health():
        status = anexis.mcp.status
        return {
            "name": settings.name,
            "edition": "server",  # how the chat tells this apart from an older Anexis on the same port
            "memories": anexis.memory.count(),
            "tools": len(anexis.registry),
            "control": settings.control,
            "busy": sorted(turns),
            "tool_servers": sum(1 for s in status.values() if s["state"] == "running"),
            "tool_servers_starting": [n for n, s in status.items() if s["state"] == "starting"],
            "providers": [p.name for p in getattr(anexis.router, "providers", [])],
            "chat_models": {p.name: p.cfg.models.get("chat", "") for p in getattr(anexis.router, "providers", [])},
            "due": [f"{i['title']} (due {i['due_at']})" for i in due_soon(anexis.memory, days=2)],
            "warnings": settings.warnings(),
            "model_notes": anexis.model_notes,
        }

    @app.post("/chat")
    async def chat(body: dict):
        text = str(body.get("text", "")).strip()
        if not text:
            raise HTTPException(400, "Nothing to say")
        mode = body.get("mode") if body.get("mode") in MODES else None
        queue: asyncio.Queue = asyncio.Queue()
        sid = anexis.memory.ensure_session(body.get("session_id"), mode)

        async def confirm(tool, args, reason) -> bool:
            ask_id = uuid.uuid4().hex[:10]
            future = asyncio.get_running_loop().create_future()
            pending[ask_id] = future
            queue.put_nowait({"type": "confirm", "id": ask_id, "tool": tool.name, "args": args, "reason": reason})
            try:
                return bool(await asyncio.wait_for(future, settings.confirm_timeout))
            except TimeoutError:
                return False  # nobody answered, so the answer is no
            finally:
                pending.pop(ask_id, None)

        async def run() -> None:
            try:
                await anexis.agent.run_turn(sid, text, queue.put_nowait, confirm, mode)
            except asyncio.CancelledError:
                queue.put_nowait({"type": "stopped", "session_id": sid})
            except Exception as e:  # keep the server up whatever a turn does
                queue.put_nowait({"type": "error", "message": f"{type(e).__name__}: {e}"})
            finally:
                if turns.get(sid) is task:
                    del turns[sid]
                queue.put_nowait(None)

        task = asyncio.create_task(run())
        turns[sid] = task

        async def stream():
            try:
                while True:
                    event = await queue.get()
                    if event is None:
                        break
                    yield json.dumps(event) + "\n"
            finally:
                if not task.done():
                    task.cancel()  # the chat hung up, stop working

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.post("/chat/stop")
    async def chat_stop(body: dict | None = None):
        wanted = (body or {}).get("session_id")
        stopping = [task for sid, task in list(turns.items()) if not wanted or sid == wanted]
        for task in stopping:
            task.cancel()
        await asyncio.gather(*stopping, return_exceptions=True)
        return {"stopped": len(stopping)}

    @app.post("/confirm")
    async def confirm_answer(body: dict):
        future = pending.get(str(body.get("id")))
        if future is None or future.done():
            raise HTTPException(404, "Nothing is waiting on that answer")
        future.set_result(bool(body.get("allow")))
        return {"ok": True}

    @app.get("/events")
    async def events():
        """Everything Anexis is doing, as it happens. One JSON object per line."""
        async def stream():
            feed = anexis.events.subscribe().__aiter__()
            nxt = None
            try:
                while True:
                    nxt = nxt or asyncio.ensure_future(feed.__anext__())
                    done, _ = await asyncio.wait({nxt}, timeout=15)
                    if not done:
                        yield "\n"  # keeps the line open through quiet minutes
                        continue
                    yield json.dumps(nxt.result()) + "\n"
                    nxt = None
            finally:
                if nxt:
                    nxt.cancel()
                    await asyncio.gather(nxt, return_exceptions=True)
                try:
                    await feed.aclose()
                except RuntimeError:
                    pass

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.get("/activity")
    async def activity():
        return anexis.events.recent(200)

    @app.get("/memory")
    async def memory_list(q: str = "", kind: str = ""):
        if q:
            vec = None
            try:
                vec = await anexis.router.embed([q], "query")
            except Exception:
                pass
            rows = anexis.memory.search(q, 20, vec[1][0] if vec else None, vec[0] if vec else None)
        else:
            rows = anexis.memory.list(kind if kind in KINDS else None, 50)
        return [r.public() for r in rows]

    @app.post("/memory")
    async def memory_add(body: dict):
        text = str(body.get("text", "")).strip()
        if not text:
            raise HTTPException(400, "Nothing to remember")
        kind = body.get("kind") if body.get("kind") in KINDS else "fact"
        pinned = bool(body.get("pinned"))
        same = anexis.memory.find_duplicate(text)
        if same and (not pinned or anexis.memory.get(same).pinned):
            anexis.memory.reinforce(same)  # already known: more sure of it, not a second copy
            return anexis.memory.get(same).public()
        memory_id = anexis.memory.add(kind, text, confidence=0.95 if pinned else 0.9,
                                      importance=0.9 if pinned else 0.7, source="told", pinned=pinned)
        return anexis.memory.get(memory_id).public()

    @app.delete("/memory/{memory_id}")
    async def memory_forget(memory_id: int):
        return {"forgotten": anexis.memory.forget(memory_id)}

    @app.get("/sessions")
    async def sessions():
        return anexis.memory.list_sessions(30)

    @app.get("/sessions/{session_id}/messages")
    async def session_messages(session_id: str):
        if anexis.memory.session(session_id) is None:
            raise HTTPException(404, "No such chat")
        return {"messages": anexis.memory.history(session_id, 200)}

    @app.delete("/sessions/{session_id}")
    async def session_delete(session_id: str):
        return {"deleted": anexis.memory.delete_session(session_id)}

    @app.get("/why")
    async def why(session_id: str):
        last = anexis.memory.last_message(session_id, "assistant")
        ids = last["meta"].get("memories_used", []) if last else []
        return [m.public() for m in (anexis.memory.get(i) for i in ids) if m]

    @app.get("/tools")
    async def tools():
        return {
            "servers": anexis.mcp.status,
            "tools": [{"name": t.name, "source": t.source, "tier": t.tier, "about": t.description[:100]}
                      for t in anexis.registry.all()],
        }

    @app.get("/models")
    async def models_list():
        """Every provider in use, with the models it really has right now."""
        return await models.survey(anexis.router)

    @app.post("/models")
    async def models_pick(body: dict):
        """Switches a job to a model, after a one word test, and saves it."""
        name, model = str(body.get("provider", "")), str(body.get("model", "")).strip()
        role = body.get("role") if body.get("role") in models.ROLES else "chat"
        provider = next((p for p in anexis.router.providers if p.name == name), None)
        if provider is None or not model or len(model) > 200 or any(c in model for c in "\n\r\"'"):
            raise HTTPException(400, "Pick a provider and a model from /model")
        problem = await models.try_model(provider, model, role)
        if problem:
            return {"ok": False, "error": problem}
        models.use(settings, anexis.router, name, role, model, first=role == "chat")
        anexis.model_notes = []
        try:
            models.save(settings)
            saved = str(settings.settings_file)
        except (OSError, ValueError) as e:
            saved = f"not saved ({e}), it lasts until the next restart"
        return {"ok": True, "provider": name, "model": model, "role": role, "saved": saved}

    @app.get("/doctor")
    async def doctor_report():
        return await doctor(anexis)

    return app
