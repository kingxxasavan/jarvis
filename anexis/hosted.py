"""Hosted models with an API key: Ollama cloud and Nvidia.

    anexis ollama cloud [model]    Ollama's models, gpt-oss:120b unless you name one
    anexis nvidia [model]          Nvidia's models, a Mistral one that works unless you name one

The key is asked for with hidden typing when it is not in ~/.anexis/.env yet.
Models are tried for real (with a tool call, since Anexis needs tools) before
anything is saved, and the first that works is used. Only then the key goes in
~/.anexis/.env (readable only by you) and anexis.toml points at the provider.
A refused key or a network problem changes nothing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from anexis.config import Provider

_transport = None  # tests stand in for the provider's website here


@dataclass
class Hosted:
    name: str
    title: str
    url: str
    key: str              # the env var the key lives in
    keys_at: str          # where to make one
    models: list[str]     # tried in this order when no model is named
    family: str = ""      # also try what the live list has from this family, after `models`
    embed: str = ""
    embed_input_type: bool = False


OLLAMA_CLOUD = Hosted("ollama-cloud", "Ollama cloud", "https://ollama.com/v1", "OLLAMA_API_KEY",
                      "ollama.com/settings/keys", ["gpt-oss:120b"])
NVIDIA = Hosted(
    "nvidia", "Nvidia", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY", "build.nvidia.com",
    # Mistral models Nvidia hosts with tool calling, best fit first. The live list
    # is checked too, so a renamed or newer Mistral model is found as well.
    ["mistralai/mistral-small-4-119b-2603", "mistralai/mistral-large-3-675b-instruct-2512",
     "mistralai/mistral-large-4-1t-a52b", "mistralai/mistral-medium-3-instruct"],
    family=r"mistralai/(mistral|magistral|mixtral)", embed="nvidia/nv-embedqa-e5-v5", embed_input_type=True,
)
MAX_TRIES = 6


def save_key(home, name: str, value: str) -> None:
    """Puts NAME=value in ~/.anexis/.env (replacing an old one), readable only by you."""
    path = home / ".env"
    lines = [line for line in (path.read_text().splitlines() if path.is_file() else [])
             if not line.strip().removeprefix("export ").startswith(f"{name}=")]
    lines.append(f"{name}={value}")
    home.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o600)


def candidates(spec: Hosted, available: list[str]) -> list[str]:
    """Models to try, best first: the known good ones the provider still lists,
    then the rest of the family it lists, newest looking names first."""
    from anexis.models import NOT_FOR_CHAT

    if not available:  # the list could not be read: try the known ones blind
        return spec.models[:MAX_TRIES]
    have = set(available)
    known = [m for m in spec.models if m in have]
    family = sorted((m for m in available if spec.family and re.search(spec.family, m, re.I)
                     and not NOT_FOR_CHAT.search(m) and m not in known), reverse=True)
    return (known + family)[:MAX_TRIES] or spec.models[:MAX_TRIES]


async def setup(settings, spec: Hosted, model: str | None, say=print, ask=None) -> bool:
    from anexis.llm import OpenAIProvider, ProviderError
    from anexis.models import save, try_model

    key, typed = settings.env.get(spec.key, "").strip(), False
    if not key and ask:
        key, typed = ask(f"  your {spec.title} API key (from {spec.keys_at}, hidden while typing): ").strip(), True
    if not key:
        say(f"  needs your {spec.title} API key. Make one at {spec.keys_at}, then run this again and paste it"
            f" when asked (or put {spec.key}=... in ~/.anexis/.env).")
        return False

    provider = Provider(spec.name, spec.url, spec.key, key, {}, spec.embed_input_type)
    client = OpenAIProvider(provider, timeout=120, transport=_transport)
    try:
        available: list[str] = []
        if not model:
            try:
                available = await client.models()
            except ProviderError:
                available = []
        tries = [model] if model else candidates(spec, available)
        chosen, last = "", ""
        for name in tries:
            say(f"  trying {name}...")
            last = await try_model(client, name)
            if not last:
                chosen = name
                break
            say(f"    no: {last[:160]}")
    finally:
        await client.close()

    if not chosen:
        refused = re.search(r"HTTP 40[13]\b", last)  # the provider said no, not a proxy or the network
        hint = f" The key was refused, check it at {spec.keys_at}." if refused else " Check the server's network, or name a model."
        say(f"  nothing worked.{hint} Nothing was changed.")
        return False

    if typed:
        save_key(settings.home, spec.key, key)
    provider.models = {"chat": chosen, **({"embed": spec.embed} if spec.embed and (not available or spec.embed in available) else {})}
    settings.providers[:] = [provider]
    save(settings)
    say(f"  done. anexis now talks with {chosen} on {spec.title}, saved in {settings.settings_file}"
        f" (the key is in ~/.anexis/.env, not in that file). /model in the chat picks another.")
    return True
