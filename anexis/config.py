"""Settings: defaults, then anexis.toml, then .env files, then the real environment.

Nothing in here can stop Anexis from starting. A bad value, an unknown setting
or a broken anexis.toml is noted in `notes` (shown by `anexis doctor`) and the
default is used instead.

Keys only come from the environment or a .env file, never from anexis.toml.
A provider or tool whose key is missing is simply left out, it never errors.
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HOST = "127.0.0.1"  # the server only ever listens on this machine. Reach it over SSH.

# Model roles: chat (talking and tools), tools (a quick model just for tool
# calling), coder (code writing), small (memory and summaries), embed (meaning
# search). A missing role uses chat, except embed which then stays off.
DEFAULT_PROVIDERS = [
    {
        "name": "ollama",
        "base_url": "http://localhost:11434/v1",
        "models": {
            "chat": "qwen3:8b",
            "coder": "qwen2.5-coder:7b",
            "small": "qwen3:4b",
            "embed": "nomic-embed-text",
        },
    },
    {
        "name": "nvidia",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "api_key_env": "NVIDIA_API_KEY",
        "embed_input_type": True,
        "models": {
            "chat": "meta/llama-3.3-70b-instruct",
            "embed": "nvidia/nv-embedqa-e5-v5",
        },
    },
]


@dataclass
class Provider:
    name: str
    base_url: str
    api_key_env: str = ""
    api_key: str = ""
    models: dict[str, str] = field(default_factory=dict)
    # Nvidia embedding models want to know if text is a stored passage or a query.
    embed_input_type: bool = False

    @property
    def active(self) -> bool:
        """A provider that needs a key is only used once the key is there."""
        return bool(self.api_key) or not self.api_key_env


@dataclass
class Settings:
    name: str = "Anexis"
    home: Path = Path("~/.anexis")
    workspace: Path = Path("~/anexis/workspace")
    manifest: Path = REPO_ROOT / "tools.yaml"
    port: int = 8765

    providers: list[Provider] = field(default_factory=list)
    request_timeout: float = 300.0
    provider_cooldown: float = 60.0

    recall_k: int = 8
    history_messages: int = 24
    history_chars: int = 24000
    learn: bool = True
    consolidate_minutes: int = 60

    outside_tools: bool = True  # start the tool servers in tools.yaml

    max_steps: int = 8
    max_tools: int = 12
    tool_output_chars: int = 6000
    confirm_timeout: float = 300.0
    # "ask": risky tools wait for a yes in the chat. "full": everything just runs.
    control: str = "ask"
    permissions: dict[str, str] = field(default_factory=dict)  # tool name -> "allow" or "ask"

    claude_bin: str = "claude"
    claude_model: str = ""
    claude_timeout: float = 1800.0
    claude_backoff_minutes: int = 30
    fallback_rounds: int = 12

    env: Mapping[str, str] = field(default_factory=dict, repr=False)
    notes: list[str] = field(default_factory=list)  # config problems that were worked around
    config_file: Path | None = None  # the anexis.toml these settings came from, if any

    def __post_init__(self) -> None:
        self.home = Path(self.home).expanduser()
        self.workspace = Path(self.workspace).expanduser()
        self.manifest = Path(self.manifest).expanduser()
        if self.control not in ("ask", "full"):
            self.notes.append(f'control must be "ask" or "full", not {self.control!r}. Using "ask".')
            self.control = "ask"
        if not self.providers:
            self.providers = [_provider(p, self.env) for p in DEFAULT_PROVIDERS]

    @property
    def settings_file(self) -> Path:
        """Where a change made from the chat (like /model) is saved."""
        return self.config_file or self.home / "anexis.toml"

    @property
    def host(self) -> str:
        return HOST

    @property
    def db_path(self) -> Path:
        return self.home / "anexis.db"

    @property
    def url(self) -> str:
        return f"http://{HOST}:{self.port}"

    def active_providers(self) -> list[Provider]:
        return [p for p in self.providers if p.active]

    def warnings(self) -> list[str]:
        out = list(self.notes)
        if not self.active_providers():
            waiting = [p.api_key_env for p in self.providers if p.api_key_env]
            hint = f"add {' or '.join(waiting)} to ~/.anexis/.env" if waiting else "add a provider in anexis.toml"
            out.append(f"No model is set up yet, so Anexis cannot answer. Install Ollama, or {hint}.")
        return out


def _provider(raw: Mapping, env: Mapping[str, str]) -> Provider:
    key_env = str(raw.get("api_key_env", "") or "")
    return Provider(
        name=str(raw["name"]),
        base_url=str(raw["base_url"]).rstrip("/"),
        api_key_env=key_env,
        api_key=env.get(key_env, "") if key_env else "",
        models={str(k): str(v) for k, v in dict(raw.get("models", {})).items() if v},
        embed_input_type=bool(raw.get("embed_input_type", False)),
    )


def read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip().removeprefix("export ").strip()] = value
    return out


def find_config(home: Path) -> Path | None:
    for candidate in (Path.cwd() / "anexis.toml", home / "anexis.toml"):
        if candidate.is_file():
            return candidate
    return None


_UNSET = object()
_SECTIONS = ("memory", "agent", "coder", "llm", "tools", "server")
_NOT_FROM_FILE = {"home", "env", "notes", "providers", "permissions", "config_file"}


def load_settings(env: Mapping[str, str] | None = None, config_path=_UNSET) -> Settings:
    real = dict(os.environ if env is None else env)
    home = Path(real.get("ANEXIS_HOME", "~/.anexis")).expanduser()

    merged: dict[str, str] = {}
    dotenvs = [home / ".env"] + ([REPO_ROOT / ".env", Path.cwd() / ".env"] if env is None else [])
    for path in dotenvs:
        merged.update(read_dotenv(path))
    merged.update(real)  # the real environment always wins

    notes: list[str] = []
    if config_path is _UNSET:
        explicit = merged.get("ANEXIS_CONFIG")
        config_path = Path(explicit) if explicit else find_config(home)
    cfg: dict = {}
    if config_path:
        try:
            cfg = tomllib.loads(Path(config_path).read_text())
        except (OSError, tomllib.TOMLDecodeError) as e:
            notes.append(f"Could not read {config_path} ({e}). Using the defaults.")

    flat: dict = {}
    for key in ("name", "workspace", "manifest"):
        if key in cfg:
            flat[key] = cfg[key]
    for name in _SECTIONS:
        section = cfg.get(name, {})
        if isinstance(section, dict):
            flat.update(section)
    if isinstance(cfg.get("permissions"), dict):
        flat["permissions"] = {str(k): str(v) for k, v in cfg["permissions"].items()}

    providers = None
    if isinstance(cfg.get("providers"), list):
        try:
            providers = [_provider(p, merged) for p in cfg["providers"]]
        except (KeyError, TypeError, AttributeError) as e:
            notes.append(f"A [[providers]] entry in anexis.toml is missing name or base_url ({e}). Using the default providers.")

    if "ANEXIS_WORKSPACE" in merged:
        flat["workspace"] = merged["ANEXIS_WORKSPACE"]
    if merged.get("ANEXIS_PORT", "").isdigit():
        flat["port"] = int(merged["ANEXIS_PORT"])
    if merged.get("ANEXIS_OUTSIDE_TOOLS", "").lower() in ("0", "false", "no", "off"):
        flat["outside_tools"] = False
    if merged.get("ANEXIS_CONTROL"):
        flat["control"] = merged["ANEXIS_CONTROL"].lower()

    known = {f.name: f for f in fields(Settings)}
    clean: dict = {}
    for key, value in flat.items():
        if key == "host":
            notes.append("host is ignored: the server only listens on this machine. Use SSH to reach it.")
        elif key not in known or (key in _NOT_FROM_FILE and key != "permissions"):
            notes.append(f"Unknown setting {key!r} in anexis.toml was ignored.")
        else:
            clean[key] = value
    for key in ("port", "recall_k", "history_messages", "history_chars", "consolidate_minutes",
                "max_steps", "max_tools", "tool_output_chars", "claude_backoff_minutes", "fallback_rounds"):
        if key in clean and not isinstance(clean[key], int):
            notes.append(f"{key} must be a whole number, not {clean[key]!r}. Using the default.")
            del clean[key]

    return Settings(home=home, env=merged, notes=notes, config_file=Path(config_path) if config_path else None,
                    **({"providers": providers} if providers else {}), **clean)
