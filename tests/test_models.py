"""Picking models from what the provider really has, and getting off a model
the provider retired, instead of failing every reply on it."""

import io
import json
import tomllib

import httpx
from rich.console import Console

from anexis.app import AnexisApp
from anexis.cli.chat import ChatSession
from anexis.config import Provider, load_settings
from anexis.llm import Router
from anexis.models import heal, suggest
from anexis.server import create_app

HAS = ["meta/llama-4-maverick-17b-128e-instruct", "meta/llama-3.1-8b-instruct",
       "nvidia/nv-embedqa-e5-v5", "meta/llama-guard-4-12b", "broken/model"]


def site(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/models"):
        return httpx.Response(200, json={"data": [{"id": m} for m in HAS]})
    body = json.loads(request.content)
    if body["model"] not in HAS or body["model"] == "broken/model":
        return httpx.Response(404, json={"detail": f"Function '{body['model']}': Not found for account"})
    return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})


def nvidia(settings, chat="meta/llama-3.3-70b-instruct"):
    settings.providers = [Provider("nvidia", "https://nv.test/v1", "NVIDIA_API_KEY", "k",
                                   {"chat": chat, "embed": "nvidia/nv-embedqa-e5-v5"})]
    settings.home.mkdir(parents=True, exist_ok=True)
    settings.manifest = settings.home / "none.yaml"
    return Router(settings, httpx.MockTransport(site))


def test_a_close_current_model_is_suggested_and_never_a_guard_or_embed_model():
    assert suggest(HAS, "chat") == "meta/llama-4-maverick-17b-128e-instruct"
    assert suggest(["meta/llama-guard-4-12b", "nvidia/nv-embedqa-e5-v5"], "chat") == ""
    assert suggest(HAS, "embed") == "nvidia/nv-embedqa-e5-v5"


async def test_a_retired_model_is_swapped_and_saved_and_the_rest_of_the_file_kept(settings):
    router = nvidia(settings)
    (settings.home / "anexis.toml").write_text('name = "Jay"\n[agent]\ncontrol = "full"\n')
    notes = await heal(settings, router)
    assert notes == ["nvidia: meta/llama-3.3-70b-instruct is gone, chat now uses meta/llama-4-maverick-17b-128e-instruct"]
    assert router.providers[0].cfg.models["chat"] == "meta/llama-4-maverick-17b-128e-instruct"  # live, no restart
    saved = tomllib.loads((settings.home / "anexis.toml").read_text())
    assert saved["name"] == "Jay" and saved["agent"]["control"] == "full"
    assert saved["providers"][0]["models"]["chat"] == "meta/llama-4-maverick-17b-128e-instruct"
    assert (settings.home / "anexis.toml.bak").exists()
    again = load_settings(env={"ANEXIS_HOME": str(settings.home), "NVIDIA_API_KEY": "k"})
    assert again.providers[0].models["chat"] == "meta/llama-4-maverick-17b-128e-instruct" and again.notes == []


async def test_nothing_changes_when_the_model_is_still_there_or_the_provider_is_down(settings):
    router = nvidia(settings, chat="meta/llama-3.1-8b-instruct")
    assert await heal(settings, router) == [] and not (settings.home / "anexis.toml").exists()
    down = Router(settings, httpx.MockTransport(lambda r: httpx.Response(503)))
    assert await heal(settings, down) == []


def app_client(settings, router):
    anexis = AnexisApp(settings, router=router)
    return anexis, httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(anexis)), base_url="http://127.0.0.1")


async def test_picking_a_model_tests_it_first_and_a_broken_one_changes_nothing(settings):
    anexis, http = app_client(settings, nvidia(settings))
    listed = (await http.get("/models")).json()[0]
    assert listed["missing"] == ["meta/llama-3.3-70b-instruct"] and "meta/llama-3.1-8b-instruct" in listed["available"]

    bad = (await http.post("/models", json={"provider": "nvidia", "model": "broken/model"})).json()
    assert not bad["ok"] and "404" in bad["error"]
    assert settings.providers[0].models["chat"] == "meta/llama-3.3-70b-instruct"

    good = (await http.post("/models", json={"provider": "nvidia", "model": "meta/llama-3.1-8b-instruct"})).json()
    assert good["ok"] and good["saved"].endswith("anexis.toml")
    assert anexis.router.providers[0].cfg.models["chat"] == "meta/llama-3.1-8b-instruct"
    await http.aclose()


class Stub:
    """Stands in for the server in the chat test."""

    def __init__(self):
        self.picked = []

    async def models(self):
        return [{"name": "nvidia", "models": {"chat": "meta/llama-3.3-70b-instruct"}, "available": HAS,
                 "missing": ["meta/llama-3.3-70b-instruct"], "error": ""}]

    async def pick_model(self, provider, model, role="chat"):
        self.picked.append((provider, model, role))
        return {"ok": True, "saved": "/x/anexis.toml"}


async def test_model_in_the_chat_lists_marks_the_gone_one_and_switches_by_number():
    console = Console(file=io.StringIO(), width=120, color_system=None)
    stub = Stub()
    chat = ChatSession(stub, console, lambda q: None)
    await chat.command("model", "")
    out = console.file.getvalue()
    assert "meta/llama-3.3-70b-instruct (gone)" in out
    assert "1  meta/llama-4-maverick-17b-128e-instruct" in out and "llama-guard" not in out
    await chat.command("model", "2")
    await chat.command("model", "maverick coder")
    await chat.command("model", "1 coder")
    assert stub.picked == [("nvidia", "meta/llama-3.1-8b-instruct", "chat"),
                           ("nvidia", "meta/llama-4-maverick-17b-128e-instruct", "coder")]
    assert "chat now uses nvidia meta/llama-3.1-8b-instruct" in console.file.getvalue()


async def test_a_model_that_dies_mid_chat_points_at_model(settings, memory):
    from anexis.agent import Agent
    from anexis.tools import register_builtin
    from anexis.tools.registry import Registry

    router = nvidia(settings, chat="meta/llama-3.3-70b-instruct")  # gone, and no heal ran
    registry = Registry()
    register_builtin(registry)
    settings.learn = False
    result = await Agent(settings, memory, router, registry).run_turn(None, "hi there")
    assert "/model" in result["error"]
