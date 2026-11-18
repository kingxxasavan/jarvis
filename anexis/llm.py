"""Talking to models.

OpenAIProvider is one client for any server that speaks the OpenAI style chat
API (Ollama, Nvidia and most others do). Router picks which provider answers
and moves to the next one when one breaks.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx
import numpy as np

from anexis.config import Provider, Settings


class ProviderError(Exception):
    """The provider could not answer. `emitted` says if text already reached the user."""

    def __init__(self, message: str, emitted: bool = False):
        super().__init__(message)
        self.emitted = emitted


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict


@dataclass
class ChatResult:
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    provider: str = ""
    model: str = ""

    def message(self) -> dict:
        """This reply as an assistant message, ready to append to the history."""
        msg: dict = {"role": "assistant", "content": self.content}
        if self.tool_calls:
            msg["tool_calls"] = [
                {
                    "id": c.id,
                    "type": "function",
                    "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
                }
                for c in self.tool_calls
            ]
        return msg


class ThinkFilter:
    """Drops <think>...</think> blocks from a stream, even when a tag is split
    across chunks. Some local models print their reasoning this way."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, text: str) -> str:
        self.buf += text
        out: list[str] = []
        while True:
            tag = self.CLOSE if self.inside else self.OPEN
            at = self.buf.find(tag)
            if at >= 0:
                if not self.inside:
                    out.append(self.buf[:at])
                self.buf = self.buf[at + len(tag) :]
                self.inside = not self.inside
                continue
            # Hold back a tail that might be the first half of a tag.
            keep = 0
            for n in range(min(len(tag) - 1, len(self.buf)), 0, -1):
                if self.buf.endswith(tag[:n]):
                    keep = n
                    break
            cut = len(self.buf) - keep
            if not self.inside:
                out.append(self.buf[:cut])
            self.buf = self.buf[cut:]
            return "".join(out)

    def flush(self) -> str:
        rest = "" if self.inside else self.buf
        self.buf = ""
        return rest


def _arguments(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except (TypeError, ValueError):
        return {"_unparsed": str(raw)}


def _calls(raw_calls) -> list[ToolCall]:
    calls = []
    for i, c in enumerate(raw_calls or []):
        fn = c.get("function") or {}
        if fn.get("name"):
            calls.append(ToolCall(c.get("id") or f"call_{i}", fn["name"], _arguments(fn.get("arguments"))))
    return calls


class OpenAIProvider:
    def __init__(self, cfg: Provider, timeout: float = 300.0, transport: httpx.AsyncBaseTransport | None = None):
        self.cfg = cfg
        self.name = cfg.name
        headers = {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}
        self.http = httpx.AsyncClient(
            base_url=cfg.base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout, connect=5.0),
            transport=transport,
        )

    async def close(self) -> None:
        await self.http.aclose()

    async def chat(
        self,
        model: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        on_text: Callable[[str], None] | None = None,
        stream: bool = True,
    ) -> ChatResult:
        body: dict = {"model": model, "messages": messages, "stream": stream}
        if tools:
            body["tools"] = tools
        emitted = False
        try:
            if not stream:
                resp = await self.http.post("/chat/completions", json=body)
                _raise_for(resp)
                msg = resp.json()["choices"][0]["message"]
                filt = ThinkFilter()
                text = (filt.feed(msg.get("content") or "") + filt.flush()).strip()
                if text and on_text:
                    on_text(text)
                return ChatResult(text, _calls(msg.get("tool_calls")), self.name, model)

            filt = ThinkFilter()
            parts: list[str] = []
            partial: dict[int, dict] = {}
            ordered: list[dict] = []

            def emit(piece: str) -> None:
                nonlocal emitted
                if piece:
                    parts.append(piece)
                    if on_text:
                        emitted = True
                        on_text(piece)

            async with self.http.stream("POST", "/chat/completions", json=body) as resp:
                if resp.status_code >= 400:
                    await resp.aread()
                    _raise_for(resp)
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    choices = json.loads(data).get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    if delta.get("content"):
                        emit(filt.feed(delta["content"]))
                    for tc in delta.get("tool_calls") or []:
                        index, call_id = tc.get("index", 0), tc.get("id")
                        slot = partial.get(index)
                        if slot is None or (call_id and slot["id"] and call_id != slot["id"]):
                            # Some servers reuse index 0 for every call, so a
                            # new id means a new call, not more of the last one.
                            slot = {"id": "", "name": "", "args": ""}
                            partial[index] = slot
                            ordered.append(slot)
                        fn = tc.get("function") or {}
                        slot["id"] = tc.get("id") or slot["id"]
                        slot["name"] = fn.get("name") or slot["name"]
                        args = fn.get("arguments")
                        slot["args"] += args if isinstance(args, str) else json.dumps(args) if args else ""
            emit(filt.flush())
            calls = [
                ToolCall(s["id"] or f"call_{i}", s["name"], _arguments(s["args"]))
                for i, s in enumerate(ordered)
                if s["name"]
            ]
            return ChatResult("".join(parts).strip(), calls, self.name, model)
        except ProviderError as e:
            e.emitted = emitted
            raise
        except (httpx.HTTPError, ValueError, KeyError, IndexError) as e:
            raise ProviderError(f"{self.name}: {type(e).__name__}: {e}", emitted) from e

    async def embed(self, model: str, texts: list[str], kind: str = "passage") -> list[list[float]]:
        body: dict = {"model": model, "input": texts}
        if self.cfg.embed_input_type:
            body["input_type"] = kind
        try:
            resp = await self.http.post("/embeddings", json=body)
            _raise_for(resp)
            return [row["embedding"] for row in resp.json()["data"]]
        except (httpx.HTTPError, ValueError, KeyError) as e:
            raise ProviderError(f"{self.name}: {type(e).__name__}: {e}") from e

    async def models(self) -> list[str]:
        """Model names the provider says it has. Raises ProviderError if unreachable."""
        try:
            resp = await self.http.get("/models", timeout=8.0)
            _raise_for(resp)
            return [m.get("id", "") for m in resp.json().get("data", [])]
        except (httpx.HTTPError, ValueError) as e:
            raise ProviderError(f"{self.name}: {type(e).__name__}: {e}") from e


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code >= 400:
        raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:300]}")


# ---- the router -----------------------------------------------------------

NO_TOOLS = re.compile(r"does not support tools|tools? (is|are) not supported|not support (tool|function)", re.I)


class AllProvidersFailed(Exception):
    pass


class Router:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.providers = [
            OpenAIProvider(p, settings.request_timeout, transport) for p in settings.active_providers()
        ]
        self._resting_until: dict[str, float] = {}
        self.toolless: set[tuple[str, str]] = set()
        self.last_errors: dict[str, str] = {}

    async def close(self) -> None:
        for p in self.providers:
            await p.close()

    def has_role(self, role: str) -> bool:
        """True when some provider has a model picked for exactly this job."""
        return any(p.cfg.models.get(role) for p in self.providers)

    def _model(self, provider: OpenAIProvider, role: str) -> str | None:
        models = provider.cfg.models
        return models.get(role) or models.get("chat")

    def _order(self) -> list[OpenAIProvider]:
        """Healthy providers first. Resting ones go last instead of being
        dropped, so there is always something to try."""
        now = time.monotonic()
        healthy = [p for p in self.providers if self._resting_until.get(p.name, 0) <= now]
        resting = [p for p in self.providers if p not in healthy]
        return healthy + resting

    def _rest(self, provider: OpenAIProvider, error: Exception) -> None:
        self._resting_until[provider.name] = time.monotonic() + self.settings.provider_cooldown
        self.last_errors[provider.name] = str(error)

    async def chat(
        self,
        role: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        on_text: Callable[[str], None] | None = None,
    ) -> ChatResult:
        errors: list[str] = []
        for provider in self._order():
            model = self._model(provider, role)
            if not model:
                continue
            try:
                result = await self._ask(provider, model, messages, tools, on_text)
                self._resting_until.pop(provider.name, None)
                return result
            except ProviderError as e:
                self._rest(provider, e)
                if e.emitted:
                    # Half a reply is already on screen. Switching now would
                    # show two different answers glued together.
                    raise
                errors.append(str(e) if provider.name in str(e) else f"{provider.name}: {e}")
        raise AllProvidersFailed("No model answered. " + " | ".join(errors or ["no providers configured"]))

    async def _ask(self, provider: OpenAIProvider, model: str, messages, tools, on_text) -> ChatResult:
        if (provider.name, model) in self.toolless:
            tools = None
        try:
            result = await provider.chat(model, messages, tools, on_text, stream=True)
        except ProviderError as e:
            if not tools or e.emitted or not NO_TOOLS.search(str(e)):
                raise
            # This model cannot use tools at all. A plain answer beats no answer,
            # and it is remembered so the failed call is not repeated every turn.
            self.toolless.add((provider.name, model))
            return await provider.chat(model, messages, None, on_text, stream=True)
        if tools and not result.content and not result.tool_calls:
            # Some servers drop tool calls while streaming. Ask again plainly.
            result = await provider.chat(model, messages, tools, on_text, stream=False)
        return result

    async def embed(self, texts: list[str], kind: str = "passage") -> tuple[str, list[np.ndarray]] | None:
        """Vectors for the texts plus a tag naming who made them, or None when
        nobody can embed. Vectors from different models never get compared."""
        for provider in self._order():
            model = provider.cfg.models.get("embed")
            if not model:
                continue
            try:
                raw = await provider.embed(model, texts, kind)
                return f"{provider.name}:{model}", [np.asarray(v, dtype=np.float32) for v in raw]
            except ProviderError as e:
                self.last_errors[provider.name] = str(e)
        return None

    async def status(self) -> list[dict]:
        out = []
        for provider in self.providers:
            entry = {"name": provider.name, "models": provider.cfg.models, "ok": True, "missing": []}
            try:
                have = await provider.models()
                wanted = set(provider.cfg.models.values())
                # Ollama lists "name:tag"; a config without a tag means ":latest".
                known = set(have) | {h.removesuffix(":latest") for h in have}
                entry["missing"] = sorted(m for m in wanted if m not in known)
            except ProviderError as e:
                entry.update(ok=False, error=str(e))
            out.append(entry)
        return out
