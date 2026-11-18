"""`anexis ollama`: pull an MoE model that fits, build "anexis" from it with a
big context window, and point Anexis at it."""

import json
import tomllib

import httpx

from anexis import ollama
from anexis.config import load_settings
from anexis.llm import Router
from anexis.models import heal

FAKE = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_OLLAMA_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
sys.exit(1 if os.environ.get("FAKE_OLLAMA_FAIL") in sys.argv else 0)
"""


def fake_ollama(tmp_path, monkeypatch, ram=32):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "ollama").write_text(FAKE)
    (bin_dir / "ollama").chmod(0o755)
    log = tmp_path / "ollama.log"
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_OLLAMA_LOG", str(log))
    monkeypatch.setattr(ollama, "memory_gb", lambda: ram)

    async def up(url=ollama.OLLAMA_URL):
        return True

    monkeypatch.setattr(ollama, "running", up)
    return lambda: [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def test_an_moe_model_when_the_server_has_the_memory_for_it():
    assert ollama.pick_model(32)[0] == "gpt-oss:20b"
    assert ollama.pick_model(15.5)[0] == "gpt-oss:20b"
    model, why = ollama.pick_model(8)
    assert model == "qwen3:4b" and "anexis ollama gpt-oss:20b" in why


def test_the_context_window_is_baked_into_the_model():
    assert ollama.modelfile("gpt-oss:20b") == "FROM gpt-oss:20b\nPARAMETER num_ctx 16384\n"


async def test_setup_pulls_builds_and_points_anexis_at_ollama(settings, tmp_path, monkeypatch):
    calls = fake_ollama(tmp_path, monkeypatch)
    settings.home.mkdir(parents=True)
    (settings.home / "anexis.toml").write_text(
        '[[providers]]\nname = "nvidia"\nbase_url = "https://x/v1"\napi_key_env = "NVIDIA_API_KEY"\n'
        '[providers.models]\nchat = "meta/llama-3.3-70b-instruct"\n[agent]\ncontrol = "full"\n')
    said = []
    assert await ollama.setup(settings, None, said.append) is True
    assert calls() == [["pull", "gpt-oss:20b"], ["pull", "nomic-embed-text"],
                       ["create", "anexis", "-f", str(settings.home / "Modelfile")]]
    assert "num_ctx 16384" in (settings.home / "Modelfile").read_text()
    saved = tomllib.loads((settings.home / "anexis.toml").read_text())
    assert [p["name"] for p in saved["providers"]] == ["ollama"]  # just ollama now
    assert saved["providers"][0]["models"] == {"chat": "anexis", "embed": "nomic-embed-text"}
    assert saved["agent"]["control"] == "full"  # the rest of the file is kept
    again = load_settings(env={"ANEXIS_HOME": str(settings.home)})
    assert [p.name for p in again.active_providers()] == ["ollama"] and again.notes == []


async def test_a_named_model_is_used_as_asked(settings, tmp_path, monkeypatch):
    calls = fake_ollama(tmp_path, monkeypatch, ram=8)
    settings.home.mkdir(parents=True)
    assert await ollama.setup(settings, "qwen3:30b-a3b", lambda line: None)
    assert calls()[0] == ["pull", "qwen3:30b-a3b"]


async def test_a_failed_pull_changes_no_settings(settings, tmp_path, monkeypatch):
    fake_ollama(tmp_path, monkeypatch)
    monkeypatch.setenv("FAKE_OLLAMA_FAIL", "gpt-oss:20b")
    settings.home.mkdir(parents=True)
    said = []
    assert await ollama.setup(settings, None, said.append) is False
    assert not (settings.home / "anexis.toml").exists() and "could not pull" in said[-1]


async def test_no_ollama_says_how_to_install_it(settings, monkeypatch):
    monkeypatch.setenv("PATH", "/nonexistent")
    said = []
    assert await ollama.setup(settings, None, said.append) is False
    assert "https://ollama.com/install.sh" in said[0]


async def test_a_missing_anexis_model_points_at_the_command_instead_of_being_swapped(settings):
    settings.home.mkdir(parents=True)
    tags = {"data": [{"id": "qwen3:4b"}, {"id": "nomic-embed-text:latest"}]}
    router = Router(settings, httpx.MockTransport(lambda r: httpx.Response(200, json=tags)))
    assert await heal(settings, router) == ["ollama: the anexis model is not built yet. Run: anexis ollama"]
    assert settings.providers[0].models["chat"] == "anexis"
