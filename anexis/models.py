"""Which model does which job, picked from what each provider really has.

Providers retire models: a name that worked last month answers "gone" today.
So nothing here trusts a fixed name. The list comes live from the provider,
`/model` in the chat picks from it (after a one word test), and on startup a
model that is gone is swapped for the closest one the provider still has.
Every change is saved to anexis.toml, so it sticks.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import tomllib

from anexis.llm import OpenAIProvider, ProviderError

ROLES = ("chat", "tools", "coder", "small", "embed")

# Used only to suggest a model when the saved one is gone.
NOT_FOR_CHAT = re.compile(r"embed|rerank|guard|safety|whisper|tts|asr|ocr|parse|retriev|clip|nv-|bge|e5|diffusion|flux|sdxl", re.I)
PREFER = {
    "chat": [r"llama-?[4-9]", r"llama-3\.[3-9]", r"qwen-?3", r"deepseek", r"mistral-(small|medium|large)", r"gpt-oss", r"instruct", r"chat"],
    "embed": [r"nv-embed", r"embedqa", r"e5", r"bge", r"arctic", r"embed"],
    "tools": [r"gpt-oss-20b", r"nemotron.*nano", r"mistral-small", r"qwen-?3.*a3b", r"qwen-?3[:-]?8b", r"llama-3\.[1-9]-8b", r"8b-instruct", r"qwen-?3[:-]?4b"],
}


def suggest(available: list[str], role: str, like: str = "") -> str:
    """A reasonable model for a job out of what the provider has, or "".
    `like` is the model being replaced: one from the same maker comes first
    (a gone mistralai/... model is replaced by another mistralai/... one)."""
    patterns = PREFER.get(role, PREFER["chat"])
    pool = list(available) if role == "embed" else [m for m in available if not NOT_FOR_CHAT.search(m)]
    maker = like.split("/", 1)[0] + "/" if "/" in like else ""
    same = [m for m in pool if maker and m.startswith(maker)]
    for group in ([same, pool] if same else [pool]):
        for pattern in patterns:
            hits = sorted(m for m in group if re.search(pattern, m, re.I))
            if hits:
                return max(hits, key=_size)
    return ""


def _size(name: str) -> float:
    """The "70b" in a name: among lookalikes the biggest is a fair guess at the best."""
    found = re.search(r"(\d+(?:\.\d+)?)b\b", name, re.I)
    return float(found.group(1)) if found else 0.0


def chat_models(available: list[str]) -> list[str]:
    """The ones worth offering for talking: no embedding, safety or speech models."""
    return [m for m in available if not NOT_FOR_CHAT.search(m)]


def _known(available: list[str]) -> set[str]:
    # Ollama lists "name:tag", and a name without a tag means ":latest".
    return set(available) | {m.removesuffix(":latest") for m in available}


async def look(provider: OpenAIProvider) -> dict:
    """One provider: the models it is set to use, what it has right now, and which are gone."""
    out = {"name": provider.name, "models": dict(provider.cfg.models), "available": [], "missing": [], "error": ""}
    try:
        out["available"] = sorted(m for m in await provider.models() if m)
    except ProviderError as e:
        out["error"] = str(e)[:300]
        return out
    known = _known(out["available"])
    out["missing"] = sorted({m for m in provider.cfg.models.values() if m and m not in known})
    return out


async def survey(router) -> list[dict]:
    return list(await asyncio.gather(*(look(p) for p in router.providers)))


TEST_TOOL = {"type": "function", "function": {
    "name": "time_now", "description": "Current date and time.", "parameters": {"type": "object", "properties": {}}}}


async def try_model(provider: OpenAIProvider, model: str, role: str = "chat") -> str:
    """A tiny real test. Returns "" when the model works, else what went wrong.
    Chat models get a tool with it, since Anexis needs tools: a model the
    provider will not give tools to does not count as working."""
    try:
        if role == "embed":
            await provider.embed(model, ["hello"], "query")
            return ""
        messages = [{"role": "user", "content": "What time is it? Use the time_now tool."}]
        reply = await provider.chat(model, messages, [TEST_TOOL], stream=False)
        if not reply.content.strip() and not reply.tool_calls:
            return "it answered with nothing"
    except ProviderError as e:
        return str(e)[:300]
    return ""


def use(settings, router, provider_name: str, role: str, model: str, first: bool = False) -> None:
    """Switches a job to a model right away (the router reads the same settings),
    and moves that provider to the front when asked. Save with `save`."""
    provider = next(p for p in settings.providers if p.name == provider_name)
    if model:
        provider.models[role] = model
    else:
        provider.models.pop(role, None)
    if first:
        settings.providers.remove(provider)
        settings.providers.insert(0, provider)
        router.providers.sort(key=lambda p: 0 if p.name == provider_name else 1)
    router._resting_until.pop(provider_name, None)  # give it a fresh chance
    router.toolless = {pair for pair in router.toolless if pair[0] != provider_name}


async def heal(settings, router) -> list[str]:
    """Swaps models a provider no longer has for its closest current ones, and
    saves. A job with no stand in is cleared, so it falls back to the chat
    model. Returns one line per change, for the chat to show."""
    notes = []
    for seen in await survey(router):
        if seen["error"] or not seen["missing"]:
            continue
        for role, model in list(seen["models"].items()):
            if model not in seen["missing"]:
                continue
            if seen["name"] == "ollama" and model == "anexis":
                notes.append("ollama: the anexis model is not built yet. Run: anexis ollama")
                continue
            pick = suggest(seen["available"], role, like=model)
            if role == "chat" and not pick:
                notes.append(f"{seen['name']}: {model} is gone and nothing close was found. Pick one with /model.")
                continue
            use(settings, router, seen["name"], role, pick)
            notes.append(f"{seen['name']}: {model} is gone, {role} now uses {pick}" if pick
                         else f"{seen['name']}: {model} is gone, {role} now uses the chat model")
    if notes and any("now uses" in n for n in notes):
        save(settings)
    return notes


# ---- saving to anexis.toml --------------------------------------------------

def _value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(_value(v) for v in value) + "]"
    return json.dumps(str(value))  # a JSON string is a valid TOML string


def dump(data: dict) -> str:
    """Settings as TOML: plain values on top, then providers in the order they
    are tried, then the sections."""
    def table(values: dict) -> list[str]:
        return [f"{k} = {_value(v)}" for k, v in values.items() if not isinstance(v, dict)]

    lines = ["# Anexis settings. Models picked with /model in the chat are saved here too.", ""]
    lines += table({k: v for k, v in data.items() if k != "providers"})
    for provider in data.get("providers", []):
        lines += ["", "[[providers]]", *table(provider)]
        if provider.get("models"):
            lines += ["[providers.models]", *table(provider["models"])]
    for name, section in data.items():
        if isinstance(section, dict) and section:
            lines += ["", f"[{name}]", *table(section)]
    text = "\n".join(lines) + "\n"
    tomllib.loads(text)  # never write a file Anexis could not read back
    return text


def save(settings) -> None:
    """Writes the providers as they are now into anexis.toml. Everything else in
    the file is kept, and the old file is kept as anexis.toml.bak first."""
    path = settings.settings_file
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, tomllib.TOMLDecodeError):
        data = {}
    data["providers"] = [
        {"name": p.name, "base_url": p.base_url,
         **({"api_key_env": p.api_key_env} if p.api_key_env else {}),
         **({"embed_input_type": True} if p.embed_input_type else {}),
         "models": {r: m for r, m in p.models.items() if m}}
        for p in settings.providers
    ]
    text = dump(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        shutil.copy2(path, path.with_name(path.name + ".bak"))
    path.write_text(text, encoding="utf-8")
