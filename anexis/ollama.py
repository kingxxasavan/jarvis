"""`anexis ollama`: makes Ollama on this server the model Anexis talks with.

    anexis ollama                  pick a model that fits this server's memory
    anexis ollama qwen3:30b-a3b    or name one
    anexis ollama cloud            Ollama's hosted models with your Ollama API key,
                                   gpt-oss:120b (a big MoE model) unless you name one.
                                   Nothing is downloaded and the server's memory does not matter.

It starts Ollama if it is not running, pulls the model and the small embedding
model, and builds a local model called "anexis" from it with a big context
window baked in. Ollama's default window is about 4096 tokens and its OpenAI
style API ignores a bigger one asked for per request, so without this Ollama
silently cuts off Anexis's instructions and tool list. Then anexis.toml is
pointed at it (the old file is kept as anexis.toml.bak).
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess

import httpx
import psutil

from anexis.config import Provider
from anexis.proc import start_detached

OLLAMA_URL = "http://127.0.0.1:11434"
ALIAS = "anexis"                 # the model Anexis is set to use
EMBED = "nomic-embed-text"
CONTEXT = 16384                  # tokens: instructions, tools, memories and the chat fit with room to spare
MOE = "gpt-oss:20b"              # mixture of experts: big model knowledge, only ~3.6B weights work per token
MOE_MIN_GB = 15                  # it needs about 14 GB of memory
SMALL = "qwen3:4b"               # for servers with less memory than that


def memory_gb() -> float:
    return psutil.virtual_memory().total / 1024**3


def pick_model(ram_gb: float) -> tuple[str, str]:
    """(model, why) for a server with this much memory."""
    if ram_gb >= MOE_MIN_GB:
        return MOE, f"{MOE}, a mixture of experts model, fits in this server's {ram_gb:.0f} GB"
    return SMALL, (f"this server has {ram_gb:.0f} GB, an MoE model like {MOE} needs about 16 GB, so {SMALL}. "
                   f"To try anyway: anexis ollama {MOE}")


def modelfile(base: str, context: int = CONTEXT) -> str:
    return f"FROM {base}\nPARAMETER num_ctx {context}\n"


async def running(url: str = OLLAMA_URL) -> bool:
    try:
        async with httpx.AsyncClient(timeout=3, trust_env=False) as http:
            return (await http.get(f"{url}/api/version")).status_code == 200
    except httpx.HTTPError:
        return False


def point_at_ollama(settings) -> None:
    """Ollama becomes the only provider, using the "anexis" model for every job
    (one model in memory, no swapping) and the small model for meaning search."""
    settings.providers[:] = [Provider("ollama", f"{OLLAMA_URL.replace('127.0.0.1', 'localhost')}/v1",
                                      models={"chat": ALIAS, "embed": EMBED})]


def _run(argv: list[str], log) -> bool:
    """Runs an ollama command, its progress shown as it goes."""
    log(f"  ollama {' '.join(argv[1:])}")
    return subprocess.run(argv).returncode == 0


async def setup(settings, model: str | None, say=print) -> bool:
    from anexis.models import save

    binary = shutil.which("ollama")
    if not binary:
        say("  Ollama is not installed. Install it with:\n    curl -fsSL https://ollama.com/install.sh | sh\n  then run: anexis ollama")
        return False
    if not await running():
        say("  starting ollama...")
        settings.home.mkdir(parents=True, exist_ok=True)
        start_detached([binary, "serve"], settings.home / "ollama.log")
        for _ in range(60):
            await asyncio.sleep(0.5)
            if await running():
                break
        else:
            say(f"  Ollama did not start. See {settings.home / 'ollama.log'}")
            return False

    if model:
        why = f"{model}, as asked"
    else:
        model, why = pick_model(memory_gb())
    say(f"  model: {why}")
    for name in (model, EMBED):
        if not _run([binary, "pull", name], say):
            say(f"  could not pull {name}. Check the name on ollama.com/library and the network.")
            return False

    file = settings.home / "Modelfile"
    file.write_text(modelfile(model))
    if not _run([binary, "create", ALIAS, "-f", str(file)], say):
        say("  could not build the anexis model.")
        return False

    point_at_ollama(settings)
    save(settings)
    say(f"  done. anexis now talks with {model} on Ollama ({CONTEXT} token window), saved in {settings.settings_file}")
    return True


# ---- Ollama cloud: the hosted models, with an API key -----------------------

async def setup_cloud(settings, model: str | None, say=print, ask=None) -> bool:
    from anexis.hosted import OLLAMA_CLOUD
    from anexis.hosted import setup as setup_hosted

    return await setup_hosted(settings, OLLAMA_CLOUD, model, say, ask)
