"""JARVIS device agent.

    python main.py setup              create .venv and install requirements
    python main.py pair <code>        connect this computer (code from Settings > Devices)
    python main.py                    run the agent (same as: python main.py run)
    python main.py doctor             check the connection and installed tools
    python main.py autostart on|off   start with this computer
    python main.py test               run the test suite
"""

from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
import venv
from logging.handlers import RotatingFileHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
IS_WIN = os.name == "nt"


def venv_python(windowless: bool = False) -> Path:
    if IS_WIN:
        return VENV / "Scripts" / ("pythonw.exe" if windowless else "python.exe")
    return VENV / "bin" / "python"


def in_venv() -> bool:
    return Path(sys.prefix).resolve() == VENV.resolve()


def relaunch_in_venv() -> None:
    """Every command except setup runs with the venv's interpreter."""
    if in_venv():
        return
    if not venv_python().exists():
        sys.exit("Run `python main.py setup` first.")
    try:
        code = subprocess.call([str(venv_python()), str(Path(__file__).resolve()), *sys.argv[1:]])
    except KeyboardInterrupt:
        code = 0
    sys.exit(code)


def cmd_setup(_: argparse.Namespace) -> None:
    if sys.version_info < (3, 10):
        sys.exit("Python 3.10 or newer is required.")
    if not VENV.exists():
        print("Creating .venv ...")
        venv.create(VENV, with_pip=True)
    py = str(venv_python())
    subprocess.check_call([py, "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
    subprocess.check_call([py, "-m", "pip", "install", "--quiet", "-r", str(HERE / "requirements.txt")])
    print("\nSetup complete.\n"
          "Next: in JARVIS open Settings > Devices > Add device, then run the `python main.py pair <code>` it shows.")


def cmd_pair(args: argparse.Namespace) -> None:
    from jarvis_agent.api import ApiError, DeviceApi
    from jarvis_agent.config import decode_pairing_code, read_env, write_env

    try:
        values = decode_pairing_code(args.code)
    except ValueError as exc:
        sys.exit(str(exc))
    api = DeviceApi(values["SUPABASE_URL"], values["SUPABASE_KEY"], values["DEVICE_TOKEN"])
    try:
        api.claim(0)
    except ApiError as exc:
        sys.exit(f"Pairing failed: {exc}")
    finally:
        api.close()
    keep = {k: v for k, v in read_env().items() if k not in values}
    write_env({**values, **keep})
    print(f"Paired as '{values['DEVICE_NAME']}'. Start the agent with: python main.py")


def setup_logging() -> None:
    data = HERE / "data"
    data.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    file = RotatingFileHandler(data / "agent.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    file.setFormatter(fmt)
    handlers: list[logging.Handler] = [file]
    if sys.stdout is not None:  # pythonw has no console
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        handlers.append(console)
    logging.basicConfig(level=logging.INFO, handlers=handlers)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def cmd_run(_: argparse.Namespace) -> None:
    from jarvis_agent.config import Config
    from jarvis_agent.runner import Runner

    setup_logging()
    log = logging.getLogger("jarvis")
    cfg = Config.load()
    runner = Runner(cfg)
    try:
        info = runner.announce()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not reach JARVIS yet (%s); will keep trying", exc)
        info = {"name": cfg.device_name}
    runner.start_stream()
    tools = [t.name for t in runner.registry.all() if not t.hidden]
    log.info("JARVIS agent online as '%s' with %d abilities: %s", info.get("name"), len(tools), ", ".join(tools))
    if runner.registry.errors:
        log.warning("plugins that did not load: %s", runner.registry.errors)
    if runner.stream:
        from jarvis_agent.stream.server import status_line

        log.info("Apps streaming: %s", status_line(runner.stream))
    log.info("Workspace: %s   (Ctrl+C to stop)", cfg.workspace)
    try:
        runner.loop()
    except KeyboardInterrupt:
        pass
    finally:
        runner.shutdown()
        log.info("stopped")


def cmd_doctor(_: argparse.Namespace) -> None:
    import shutil

    from jarvis_agent import VERSION
    from jarvis_agent.api import ApiError, DeviceApi
    from jarvis_agent.coding import available
    from jarvis_agent.config import Config, mask
    from jarvis_agent.runner import build_registry, platform_label

    print(f"JARVIS agent {VERSION} on {platform_label()}, Python {sys.version.split()[0]}")
    cfg = Config.load()
    print(f"  device       {cfg.device_name}")
    print(f"  supabase     {cfg.supabase_url}")
    print(f"  token        {mask(cfg.device_token)}")
    api = DeviceApi(cfg.supabase_url, cfg.supabase_key, cfg.device_token)
    try:
        api.claim(0)
        print("  connection   OK")
    except ApiError as exc:
        print(f"  connection   FAILED: {exc}")
    finally:
        api.close()
    for name, path in available(cfg.codex_bin, cfg.claude_bin).items():
        print(f"  {name:<12} {path or 'not installed'}")
    for tool in ("git", "gh"):
        print(f"  {tool:<12} {shutil.which(tool) or 'not installed'}")
    from jarvis_agent.stream.chrome import find_chrome
    from jarvis_agent.stream.tunnel import find_cloudflared

    print(f"  streaming    {'on' if cfg.stream_enabled else 'off (JARVIS_STREAM=off)'}")
    print(f"  chrome       {find_chrome(cfg.chrome_bin) or 'not installed (needed for the Apps browser)'}")
    print(f"  cloudflared  {find_cloudflared() or 'not installed: winget install --id Cloudflare.cloudflared'}")
    print(f"  downloads    {cfg.downloads_dir}")
    print(f"  vscode       {('vscode.dev/tunnel/' + cfg.vscode_tunnel) if cfg.vscode_tunnel else 'not set (VSCODE_TUNNEL)'}")
    print(f"  workspace    {cfg.workspace}")
    reg = build_registry(cfg)
    print(f"  abilities    {', '.join(t.name for t in reg.all())}")
    for name, problem in reg.errors.items():
        print(f"  plugin {name}: {problem}")


AUTOSTART_NAME = "JARVIS Agent"


def cmd_autostart(args: argparse.Namespace) -> None:
    command = f'"{venv_python(windowless=True)}" "{HERE / "main.py"}" run'
    if IS_WIN:
        import winreg

        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
        with key:
            if args.state == "on":
                winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, command)
                print("The agent now starts hidden when you sign in to Windows. Logs: agent/data/agent.log")
            else:
                try:
                    winreg.DeleteValue(key, AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
                print("Autostart is off.")
        return
    unit_dir = Path.home() / ".config" / "systemd" / "user"
    unit = unit_dir / "jarvis-agent.service"
    if args.state == "on":
        unit_dir.mkdir(parents=True, exist_ok=True)
        unit.write_text(
            "[Unit]\nDescription=JARVIS device agent\nAfter=network-online.target\n\n"
            f"[Service]\nExecStart={venv_python()} {HERE / 'main.py'} run\nRestart=always\nRestartSec=5\n\n"
            "[Install]\nWantedBy=default.target\n",
            encoding="utf-8",
        )
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
        subprocess.run(["systemctl", "--user", "enable", "--now", "jarvis-agent"], check=False)
        print("Installed as a systemd user service. To keep it running while logged out: sudo loginctl enable-linger $USER")
    else:
        subprocess.run(["systemctl", "--user", "disable", "--now", "jarvis-agent"], check=False)
        unit.unlink(missing_ok=True)
        print("Autostart is off.")


def cmd_test(_: argparse.Namespace) -> None:
    sys.exit(subprocess.call([sys.executable, "-m", "pytest", "-q", str(HERE / "tests")]))


def main() -> None:
    parser = argparse.ArgumentParser(description="JARVIS device agent")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("setup")
    pair = sub.add_parser("pair")
    pair.add_argument("code")
    sub.add_parser("run")
    sub.add_parser("doctor")
    auto = sub.add_parser("autostart")
    auto.add_argument("state", choices=["on", "off"])
    sub.add_parser("test")
    args = parser.parse_args()
    command = args.command or "run"
    if command != "setup":
        relaunch_in_venv()
    sys.path.insert(0, str(HERE))
    {"setup": cmd_setup, "pair": cmd_pair, "run": cmd_run, "doctor": cmd_doctor,
     "autostart": cmd_autostart, "test": cmd_test}[command](args)


if __name__ == "__main__":
    main()
