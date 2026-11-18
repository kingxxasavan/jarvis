"""Builds every part of Anexis and holds them together.

    Settings ─> Memory (SQLite)   Router (models)   Registry (tools)
                    └──────────────┬───────┴───────────────┘
                                 Agent (the chat loop)
                                   │
                         server.py (HTTP on 127.0.0.1)
                                   │
                         cli (the terminal chat)

Background jobs, each one failing on its own without touching the rest:
tool servers starting, hourly memory upkeep, hourly Canvas sync.
"""

from __future__ import annotations

import asyncio

from anexis.agent import Agent
from anexis.config import Settings
from anexis.events import EventBus
from anexis.llm import Router
from anexis.memory.learn import Learner, consolidate
from anexis.memory.store import Memory
from anexis.tools import canvas, register_builtin
from anexis.tools.code import ClaudeRunner, OwnCoder, make_code_tool
from anexis.tools.mcp import MCPManager
from anexis.tools.registry import Registry


class AnexisApp:
    def __init__(self, settings: Settings, router=None):
        self.settings = settings
        settings.home.mkdir(parents=True, exist_ok=True)
        settings.workspace.mkdir(parents=True, exist_ok=True)
        self.memory = Memory(settings.db_path)
        self.events = EventBus()
        self.router = router or Router(settings)
        self.registry = Registry()
        register_builtin(self.registry, settings)
        self.claude = ClaudeRunner(settings, self.memory)
        self.coder = OwnCoder(settings, self.memory, self.router, self.registry)
        self.registry.add(make_code_tool(self.claude, self.coder))
        self.mcp = MCPManager(settings, self.registry)
        self.learner = Learner(self.memory, self.router)
        self.agent = Agent(settings, self.memory, self.router, self.registry, self.learner, self.events)
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        # Tool servers can take a while the first time (they download), so the
        # server answers right away and tools join as they come up.
        self._tasks.append(asyncio.create_task(self._start_tools()))
        if self.settings.consolidate_minutes > 0:
            self._tasks.append(asyncio.create_task(self._upkeep()))
        if canvas.configured(self.settings):
            self._tasks.append(asyncio.create_task(self._canvas()))

    async def _start_tools(self) -> None:
        try:
            if self.settings.outside_tools:
                await self.mcp.start()
            await self.registry.embed_all(self.router)
        except Exception as e:  # a broken tool server must never take Anexis down
            self.memory.log("tools_failed", {"error": f"{type(e).__name__}: {e}"[:300]})

    async def _upkeep(self) -> None:
        while True:
            await asyncio.sleep(self.settings.consolidate_minutes * 60)
            try:
                self.memory.log("consolidate", await consolidate(self.memory, self.router))
            except Exception as e:
                self.memory.log("consolidate_failed", {"error": f"{type(e).__name__}: {e}"[:300]})

    async def _canvas(self) -> None:
        """Keeps the assignment list in step with Canvas: soon after starting, then hourly."""
        await asyncio.sleep(5)
        while True:
            client = canvas.client_for(self.settings, canvas._transport)
            if client is None:
                return
            try:
                self.memory.log("canvas_sync", await canvas.sync(self.memory, client))
            except Exception as e:  # the school site being down must never hurt anything else
                self.memory.log("canvas_sync_failed", {"error": f"{type(e).__name__}: {e}"[:300]})
            finally:
                await client.close()
            await asyncio.sleep(3600)

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.agent.drain()
        await self.mcp.stop()
        await self.router.close()
        self.memory.close()
