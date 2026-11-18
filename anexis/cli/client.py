"""Talks to the Anexis server over HTTP on this machine."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx


class AnexisClient:
    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def _http(self, timeout: float | None = 60.0) -> httpx.AsyncClient:
        # trust_env off: a proxy set in the shell must never get the chat to localhost.
        return httpx.AsyncClient(base_url=self.url, timeout=timeout, trust_env=False)

    async def _call(self, method: str, path: str, timeout: float | None = 60.0, **kw):
        async with self._http(timeout) as http:
            resp = await http.request(method, path, **kw)
            resp.raise_for_status()
            return resp

    async def health(self) -> dict:
        return (await self._call("GET", "/health", timeout=10)).json()

    async def chat(self, text: str, session_id: str | None = None, mode: str | None = None) -> AsyncIterator[dict]:
        body = {"text": text, "session_id": session_id, "mode": mode}
        async with self._http(None) as http, http.stream("POST", "/chat", json=body) as resp:
            if resp.status_code >= 400:
                await resp.aread()
                resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.strip():
                    yield json.loads(line)

    async def stop(self, session_id: str | None = None) -> int:
        body = {"session_id": session_id} if session_id else {}
        return (await self._call("POST", "/chat/stop", json=body)).json()["stopped"]

    async def confirm(self, ask_id: str, allow: bool) -> None:
        await self._call("POST", "/confirm", json={"id": ask_id, "allow": allow})

    async def events(self) -> AsyncIterator[dict]:
        async with self._http(None) as http, http.stream("GET", "/events") as resp:
            async for line in resp.aiter_lines():
                if line.strip():
                    yield json.loads(line)

    async def sessions(self) -> list[dict]:
        return (await self._call("GET", "/sessions")).json()

    async def messages(self, session_id: str) -> list[dict]:
        async with self._http(10) as http:
            resp = await http.get(f"/sessions/{session_id}/messages")
        return resp.json().get("messages", []) if resp.status_code == 200 else []

    async def clear(self, session_id: str) -> bool:
        return (await self._call("DELETE", f"/sessions/{session_id}")).json()["deleted"]

    async def memories(self, query: str = "", kind: str = "") -> list[dict]:
        return (await self._call("GET", "/memory", params={"q": query, "kind": kind})).json()

    async def remember(self, text: str, kind: str = "fact", pinned: bool = False) -> dict:
        return (await self._call("POST", "/memory", json={"text": text, "kind": kind, "pinned": pinned})).json()

    async def forget(self, memory_id: int) -> dict:
        return (await self._call("DELETE", f"/memory/{memory_id}")).json()

    async def why(self, session_id: str) -> list[dict]:
        return (await self._call("GET", "/why", params={"session_id": session_id})).json()

    async def tools(self) -> dict:
        return (await self._call("GET", "/tools")).json()

    async def doctor(self) -> list[dict]:
        return (await self._call("GET", "/doctor", timeout=120)).json()
