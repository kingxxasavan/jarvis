"""`anexis nvidia`: find a Mistral model on Nvidia that really works with
tools, with the owner's key, and switch to it."""

import json
import tomllib

import httpx

from anexis import hosted
from anexis.config import load_settings

LISTED = ["meta/llama-3.1-8b-instruct", "mistralai/mistral-small-4-119b-2603", "mistralai/mistral-large-3-675b-instruct-2512",
          "mistralai/magistral-medium-2609", "nvidia/nv-embedqa-e5-v5", "meta/llama-guard-4-12b"]


def nvidia(monkeypatch, works=("mistralai/mistral-large-3-675b-instruct-2512",), listed=LISTED):
    tried = []

    def site(request):
        if request.headers.get("authorization") != "Bearer nv-key":
            return httpx.Response(401, json={"detail": "Unauthorized"})
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": m} for m in listed]}) if listed else httpx.Response(500)
        body = json.loads(request.content)
        tried.append(body["model"])
        assert body["tools"][0]["function"]["name"] == "time_now"  # tested with a real tool
        if body["model"] not in works:
            return httpx.Response(400, json={"detail": "This model does not support tool calling"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "time_now", "arguments": "{}"}}]}}]})

    monkeypatch.setattr(hosted, "_transport", httpx.MockTransport(site))
    return tried


async def test_the_first_mistral_model_that_works_with_tools_is_used(settings, monkeypatch):
    tried = nvidia(monkeypatch)
    settings.home.mkdir(parents=True)
    said = []
    assert await hosted.setup(settings, hosted.NVIDIA, None, said.append, ask=lambda q: "nv-key")
    assert tried == ["mistralai/mistral-small-4-119b-2603", "mistralai/mistral-large-3-675b-instruct-2512"]
    saved = tomllib.loads((settings.home / "anexis.toml").read_text())["providers"]
    assert saved == [{"name": "nvidia", "base_url": "https://integrate.api.nvidia.com/v1", "api_key_env": "NVIDIA_API_KEY",
                      "embed_input_type": True,
                      "models": {"chat": "mistralai/mistral-large-3-675b-instruct-2512", "embed": "nvidia/nv-embedqa-e5-v5"}}]
    assert "NVIDIA_API_KEY=nv-key" in (settings.home / ".env").read_text()
    assert "no: HTTP 400" in said[1]
    again = load_settings(env={"ANEXIS_HOME": str(settings.home)})
    assert [(p.name, p.models["chat"]) for p in again.active_providers()] == [("nvidia", "mistralai/mistral-large-3-675b-instruct-2512")]


async def test_a_newer_mistral_model_in_the_live_list_is_found_too(settings, monkeypatch):
    listed = ["mistralai/mistral-small-5-2611", "mistralai/mistral-tiny-embed", "meta/llama-4"]
    tried = nvidia(monkeypatch, works=("mistralai/mistral-small-5-2611",), listed=listed)
    settings.home.mkdir(parents=True)
    settings.env = {"NVIDIA_API_KEY": "nv-key"}
    assert await hosted.setup(settings, hosted.NVIDIA, None, lambda line: None)
    assert tried == ["mistralai/mistral-small-5-2611"]  # never an embed model, never another maker
    assert settings.providers[0].models == {"chat": "mistralai/mistral-small-5-2611"}  # no embed model listed


async def test_when_the_list_cannot_be_read_the_known_ones_are_tried(settings, monkeypatch):
    tried = nvidia(monkeypatch, works=("mistralai/mistral-small-4-119b-2603",), listed=[])
    settings.home.mkdir(parents=True)
    settings.env = {"NVIDIA_API_KEY": "nv-key"}
    assert await hosted.setup(settings, hosted.NVIDIA, None, lambda line: None)
    assert tried == ["mistralai/mistral-small-4-119b-2603"]


async def test_a_named_model_is_the_only_one_tried(settings, monkeypatch):
    tried = nvidia(monkeypatch, works=())
    settings.home.mkdir(parents=True)
    settings.env = {"NVIDIA_API_KEY": "nv-key"}
    said = []
    assert not await hosted.setup(settings, hosted.NVIDIA, "meta/llama-3.1-8b-instruct", said.append)
    assert tried == ["meta/llama-3.1-8b-instruct"] and "Nothing was changed" in said[-1]
    assert not (settings.home / "anexis.toml").exists()


async def test_a_wrong_key_changes_nothing(settings, monkeypatch):
    nvidia(monkeypatch)
    settings.home.mkdir(parents=True)
    said = []
    assert not await hosted.setup(settings, hosted.NVIDIA, None, said.append, ask=lambda q: "bad")
    assert "key was refused" in said[-1] and not (settings.home / ".env").exists()
