"""Settings for the agent, kept in agent/.env (written by `python main.py pair`)."""

from __future__ import annotations

import base64
import json
import os
import platform
from dataclasses import dataclass
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = AGENT_DIR / ".env"
DATA_DIR = AGENT_DIR / "data"
PLUGIN_DIR = AGENT_DIR / "plugins"
DRAFT_DIR = PLUGIN_DIR / "drafts"
JARVIS_REPO = AGENT_DIR.parent  # this checkout of the JARVIS repo, editable from the Code tab


def read_env(path: Path = ENV_FILE) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def write_env(values: dict[str, str], path: Path = ENV_FILE) -> None:
    lines = ["# JARVIS agent settings. Keep this file private: DEVICE_TOKEN controls this computer."]
    lines += [f"{k}={v}" for k, v in values.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)


def decode_pairing_code(code: str) -> dict[str, str]:
    """The website's pairing code is base64url JSON: {u: url, k: key, t: token, n: name}."""
    raw = code.strip()
    raw += "=" * (-len(raw) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")))
    except Exception as exc:  # noqa: BLE001 - any decoding problem means a bad code
        raise ValueError("That pairing code is not valid. Copy it again from Settings > Devices.") from exc
    if not all(isinstance(data.get(k), str) and data.get(k) for k in ("u", "k", "t")):
        raise ValueError("That pairing code is incomplete. Copy it again from Settings > Devices.")
    if not data["u"].startswith("https://"):
        raise ValueError("The pairing code points at a non-HTTPS address; refusing it.")
    return {"SUPABASE_URL": data["u"].rstrip("/"), "SUPABASE_KEY": data["k"], "DEVICE_TOKEN": data["t"], "DEVICE_NAME": data.get("n") or platform.node()}


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_key: str
    device_token: str
    device_name: str
    workspace: Path
    codex_bin: str
    claude_bin: str
    downloads_dir: Path
    stream_enabled: bool
    stream_port: int
    chrome_bin: str
    tunnel_token: str
    stream_public_url: str
    vscode_tunnel: str
    cloud_enabled: bool = True
    cloud_max_mb: int = 50
    audio_device: str = ""
    ask_first: bool = False

    @staticmethod
    def load() -> "Config":
        prefixes = ("JARVIS_", "CODEX_", "CLAUDE_", "CHROME_", "CLOUDFLARE_", "STREAM_", "VSCODE_")
        env = {**read_env(), **{k: v for k, v in os.environ.items() if k.startswith(prefixes)}}
        missing = [k for k in ("SUPABASE_URL", "SUPABASE_KEY", "DEVICE_TOKEN") if not env.get(k)]
        if missing:
            raise SystemExit("This computer is not paired yet. In JARVIS, open Settings > Devices > Add device, "
                             "then run the `python main.py pair <code>` command it shows.")
        workspace = Path(env.get("JARVIS_WORKSPACE") or Path.home() / "JarvisProjects").expanduser().resolve()
        return Config(
            supabase_url=env["SUPABASE_URL"].rstrip("/"),
            supabase_key=env["SUPABASE_KEY"],
            device_token=env["DEVICE_TOKEN"],
            device_name=env.get("DEVICE_NAME", platform.node()),
            workspace=workspace,
            codex_bin=env.get("CODEX_BIN", ""),
            claude_bin=env.get("CLAUDE_BIN", ""),
            downloads_dir=Path(env.get("JARVIS_DOWNLOADS") or Path.home() / "Downloads" / "JARVIS").expanduser().resolve(),
            stream_enabled=env.get("JARVIS_STREAM", "on").lower() not in ("off", "0", "false", "no"),
            stream_port=int(env.get("JARVIS_STREAM_PORT", "8788")),
            chrome_bin=env.get("CHROME_BIN", ""),
            tunnel_token=env.get("CLOUDFLARE_TUNNEL_TOKEN", ""),
            stream_public_url=env.get("STREAM_PUBLIC_URL", ""),
            vscode_tunnel=env.get("VSCODE_TUNNEL", ""),
            cloud_enabled=env.get("JARVIS_CLOUD", "on").lower() not in ("off", "0", "false", "no"),
            cloud_max_mb=int(env.get("JARVIS_CLOUD_MAX_MB", "50") or 50),
            audio_device=env.get("JARVIS_AUDIO_DEVICE", ""),
            ask_first=env.get("JARVIS_ASK_FIRST", "off").lower() in ("on", "1", "true", "yes"),
        )


def mask(secret: str) -> str:
    return "..." + secret[-4:] if len(secret) > 8 else "(set)"
