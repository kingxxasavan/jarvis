import base64
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jarvis_agent import registry as reg  # noqa: E402
from jarvis_agent.coding import parse_claude_event, parse_codex_event  # noqa: E402
from jarvis_agent.config import decode_pairing_code  # noqa: E402
from jarvis_agent.registry import Registry, Tool, ToolContext, schema, validate_plugin_tool  # noqa: E402
from jarvis_agent.runner import Runner, jsonable  # noqa: E402
from jarvis_agent.tools.plugins import check_draft  # noqa: E402
from jarvis_agent.tools.projects import Workspace  # noqa: E402
from jarvis_agent.tools.system import find_app, play_youtube, open_url  # noqa: E402


def code_for(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def ctx() -> ToolContext:
    return ToolContext(job_id="j", log=lambda k, t: None, cancelled=lambda: False)


# Pairing ------------------------------------------------------------------------

def test_pairing_code_round_trip():
    values = decode_pairing_code(code_for({"u": "https://x.supabase.co/", "k": "pk", "t": "tok", "n": "Laptop"}))
    assert values == {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_KEY": "pk", "DEVICE_TOKEN": "tok", "DEVICE_NAME": "Laptop"}


@pytest.mark.parametrize("payload", [{"u": "http://x", "k": "k", "t": "t"}, {"u": "https://x", "k": "k"}])
def test_pairing_code_rejects_bad_codes(payload):
    with pytest.raises(ValueError):
        decode_pairing_code(code_for(payload))
    with pytest.raises(ValueError):
        decode_pairing_code("not base64 at all!")


# Workspace safety ------------------------------------------------------------------

def test_project_paths_stay_in_workspace(tmp_path):
    ws = Workspace(tmp_path.resolve())
    assert ws.project("My Cool App!").name == "my-cool-app"
    assert ws.project("../../etc").parent == tmp_path.resolve()
    with pytest.raises(ValueError):
        ws.project("///")


def test_private_files_are_never_read(tmp_path):
    ws = Workspace(tmp_path.resolve())
    proj = ws.project("demo")
    proj.mkdir()
    (proj / ".env").write_text("SECRET=1")
    (proj / "app.py").write_text("print(1)")
    assert ws.read_project_file({"project": "demo", "path": "app.py"}, ctx())["content"] == "print(1)"
    for bad in (".env", "../outside.txt", "node_modules"):
        with pytest.raises(PermissionError):
            ws.read_project_file({"project": "demo", "path": bad}, ctx())


# Coding agent output ------------------------------------------------------------

def test_codex_events():
    assert parse_codex_event(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "Built it"}})) == ("say", "Built it")
    assert parse_codex_event(json.dumps({"type": "item.started", "item": {"type": "command_execution", "command": "npm test"}})) == ("cmd", "$ npm test")
    kind, text = parse_codex_event(json.dumps({"type": "item.completed", "item": {"type": "file_change", "changes": [{"path": "a.py", "kind": "add"}]}}))
    assert kind == "file" and "a.py" in text
    assert parse_codex_event(json.dumps({"type": "turn.failed", "error": {"message": "boom"}})) == ("error", "boom")
    assert parse_codex_event(json.dumps({"type": "turn.started"})) is None


def test_claude_events():
    msg = {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Write", "input": {"file_path": "x.py"}}]}}
    assert parse_claude_event(json.dumps(msg)) == ("file", "Write x.py")
    assert parse_claude_event(json.dumps({"type": "result", "result": "Done", "is_error": False})) == ("say", "Done")


# Device tools --------------------------------------------------------------------

def test_app_matching_prefers_exact_then_prefix():
    entries = {"Visual Studio Code": Path("a"), "Visual Studio Installer": Path("b"), "Spotify": Path("c")}
    assert find_app("visual studio code", entries)[0] == "Visual Studio Code"
    assert find_app("spot", entries)[0] == "Spotify"
    assert find_app("photoshop", entries) is None


def test_url_and_video_validation():
    with pytest.raises(ValueError):
        open_url({"url": "file:///C:/Windows"}, ctx())
    with pytest.raises(ValueError):
        play_youtube({"video_id": "not-an-id"}, ctx())


# Plugins ---------------------------------------------------------------------------

GOOD = '''"""Says hello."""
TOOL = {"name": "say_hello", "description": "Greets someone by name.", "parameters": {"type": "object", "properties": {"who": {"type": "string"}}}}
def run(args):
    return {"greeting": "Hello " + args.get("who", "there")}
'''


def test_plugin_contract_validation():
    assert validate_plugin_tool({"name": "x_y", "description": "does a thing", "parameters": {"type": "object", "properties": {}}}, "x_y") is None
    assert validate_plugin_tool({"name": "other", "description": "does a thing", "parameters": {"type": "object", "properties": {}}}, "x_y")
    assert validate_plugin_tool("nope", "x_y")


def test_draft_check_runs_isolated(tmp_path):
    good = tmp_path / "plugin.py"
    good.write_text(GOOD)
    assert check_draft(good, "say_hello")["valid"] is True
    bad = tmp_path / "bad.py"
    bad.write_text("raise RuntimeError('import side effect')")
    verdict = check_draft(bad, "say_hello")
    assert verdict["valid"] is False and "RuntimeError" in verdict["problem"]


def test_enabled_plugins_load_and_broken_ones_are_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(reg, "PLUGIN_DIR", tmp_path)
    monkeypatch.setattr(reg, "ENABLED_FILE", tmp_path / "enabled.json")
    (tmp_path / "say_hello.py").write_text(GOOD)
    (tmp_path / "broken.py").write_text("TOOL = 5")
    reg.write_enabled(["say_hello", "broken", "open_app"])
    builtin = Tool("open_app", "x", schema(), lambda a, c: None)
    r = Registry(builtins=[builtin])
    r.reload_plugins()
    assert r.get("say_hello").run({"who": "Sir"}, ctx()) == {"greeting": "Hello Sir"}
    assert "broken" in r.errors and "open_app" in r.errors
    assert {t["name"] for t in r.manifest()} == {"open_app", "say_hello"}


# Runner ----------------------------------------------------------------------------

class FakeApi:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.finished = {}
        self.done = threading.Event()

    def claim(self, n):
        out, self.jobs = self.jobs[:n], self.jobs[n:]
        return out

    def finish(self, job_id, ok, result, error):
        self.finished[job_id] = (ok, result, error)
        if len(self.finished) == 2:
            self.done.set()

    def log(self, *a):
        pass

    def status(self, job_id):
        return "running"

    def hello(self, *a):
        return {"name": "Test"}

    def close(self):
        pass


def test_runner_reports_success_and_failure():
    runner = Runner.__new__(Runner)
    echo = Tool("echo", "echo", schema(), lambda a, c: {"echo": a.get("x")})
    runner.registry = Registry(builtins=[echo])
    runner.api = FakeApi([{"id": "1", "tool": "echo", "args": {"x": 5}}, {"id": "2", "tool": "missing", "args": {}}])
    from concurrent.futures import ThreadPoolExecutor
    runner.pool = ThreadPoolExecutor(2)
    runner.running, runner.lock, runner.stop = set(), threading.Lock(), threading.Event()
    runner.manifest_dirty = threading.Event()
    runner._stream_pending = None
    runner.restart_wanted = False
    threading.Thread(target=runner.loop, daemon=True).start()
    assert runner.api.done.wait(5)
    runner.stop.set()
    assert runner.api.finished["1"] == (True, {"echo": 5}, None)
    ok, _, error = runner.api.finished["2"]
    assert ok is False and "no tool called missing" in error


def test_results_are_json_safe():
    assert jsonable({"p": Path("a")}) == {"p": "a"}
    big = jsonable("x" * 400_000)
    assert big["truncated"] is True


# App streaming -------------------------------------------------------------------

from jarvis_agent.stream import auth as stream_auth  # noqa: E402
from jarvis_agent.stream.chrome import to_url  # noqa: E402
from jarvis_agent.tools.apps import clean_name, unique_path  # noqa: E402


def test_stream_passes():
    secret = stream_auth.new_secret()
    good = stream_auth.sign(secret, "stream")
    assert stream_auth.verify(secret, good, "stream")
    assert not stream_auth.verify(secret, good, "files")
    assert not stream_auth.verify("another-secret", good, "stream")
    assert not stream_auth.verify(secret, stream_auth.sign(secret, "stream", ttl=-1), "stream")
    payload, mac = good.split(".")
    assert not stream_auth.verify(secret, payload + "x." + mac, "stream")
    assert not stream_auth.verify(secret, None, "stream")


def test_remote_addresses():
    assert to_url("example.com") == "https://example.com"
    assert to_url("https://open.spotify.com") == "https://open.spotify.com"
    assert to_url("iron man suit").startswith("https://www.google.com/search?q=iron+man+suit")
    for bad in ("file:///C:/Windows", "chrome://settings", "javascript:alert(1)", "ftp://x.org"):
        with pytest.raises(ValueError):
            to_url(bad)


def test_download_names_are_safe(tmp_path):
    assert clean_name("..\..\evil.exe") == "_.._evil.exe"
    assert clean_name("a%2Fb.txt") == "a_b.txt"
    (tmp_path / "f.zip").write_text("x")
    assert unique_path(tmp_path, "f.zip").name == "f (1).zip"


# Folders and stream delivery -----------------------------------------------------

from jarvis_agent.tools import files as folder_tools  # noqa: E402


def test_folders(tmp_path, monkeypatch):
    import re

    # pytest's temp folder is itself inside AppData, which the real rules refuse.
    monkeypatch.setattr(folder_tools, "DENY", re.compile(r"[\/]\.ssh([\/]|$)"))
    monkeypatch.setattr(folder_tools, "known_folder", lambda name: tmp_path / "Desk" if name.lower() == "desktop" else None)
    out = folder_tools.create_folder({"path": "Desktop/School/APUSH"}, ctx())
    assert out["created"] and (tmp_path / "Desk" / "School" / "APUSH").is_dir()
    assert folder_tools.create_folder({"path": "Desktop/School/APUSH"}, ctx())["created"] is False
    assert "[folder] School" in folder_tools.list_folder({"path": "Desktop"}, ctx())["items"]


def test_private_and_system_folders_are_refused():
    import os

    bad = ["AppData/Roaming/x", "~/.ssh/keys", "Documents/../AppData/Local/x"]
    if os.environ.get("SystemRoot"):
        bad.append(os.path.join(os.environ["SystemRoot"], "Temp", "jarvis"))
    for path in bad:
        with pytest.raises(PermissionError):
            folder_tools.resolve(path)
    with pytest.raises(ValueError):
        folder_tools.resolve("")
    assert folder_tools.resolve("Desktop/Windows stuff").name == "Windows stuff"  # a user folder named like a system one is fine


def test_viewer_queue_keeps_sound_short_and_frames_newest():
    import asyncio

    from jarvis_agent.stream.server import AUDIO, FRAME, Client

    async def run():
        c = Client(ws=None)  # type: ignore[arg-type]
        for i in range(40):
            c.push(AUDIO + bytes([i]))
        c.push('{"type":"tabs"}')
        c.offer(FRAME + b"old")
        c.offer(FRAME + b"new")
        audio = [d for d in c.queue if isinstance(d, bytes)]
        assert len(audio) == Client.MAX_QUEUED_AUDIO and audio[0][1] == 15  # oldest dropped
        assert c.frame == FRAME + b"new"

    asyncio.run(run())


# Reading files into chat ------------------------------------------------------------

def test_read_file_turns_documents_into_text(tmp_path, monkeypatch):
    import zipfile

    import openpyxl

    from jarvis_agent.tools import files

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Budget"
    ws.append(["Item", "Cost, USD"])
    ws.append(["Hosting", 12])
    wb.save(tmp_path / "sheet.xlsx")
    with zipfile.ZipFile(tmp_path / "doc.docx", "w") as z:
        z.writestr("word/document.xml", "<w:document><w:p><w:t>First line</w:t></w:p><w:p><w:t>Second &amp; last</w:t></w:p></w:document>")
    (tmp_path / ".env").write_text("SECRET=1")

    f = files.Files(tmp_path)
    sheet = f.read_file({"path": "sheet.xlsx"}, ctx())
    assert sheet["sheets"][0]["name"] == "Budget"
    assert 'Item,"Cost, USD"' in sheet["content"] and "Hosting,12" in sheet["content"]
    assert f.read_file({"path": str(tmp_path / "doc.docx")}, ctx())["content"].split() == ["First", "line", "Second", "&", "last"]
    with pytest.raises(PermissionError):
        f.read_file({"path": str(tmp_path / ".env")}, ctx())
    with pytest.raises(FileNotFoundError):
        f.read_file({"path": "missing.xlsx"}, ctx())


# Desktop, downloads and Claude Code sessions -----------------------------------------

def test_desktop_pointer_maps_fractions_to_screen_pixels():
    from jarvis_agent.stream.desktop import DesktopScreen

    async def nothing(_):
        return None

    d = DesktopScreen(nothing, nothing)
    d.monitor = {"left": -1920, "top": 0, "width": 1920, "height": 1080}
    assert d._point({"nx": 0, "ny": 0}) == (-1920, 0)
    assert d._point({"nx": 1, "ny": 1}) == (-1, 1079)
    assert d._point({"nx": 5, "ny": -2}) == (-1, 0)


def test_finished_chrome_download_gets_its_real_name(tmp_path):
    from jarvis_agent.stream.chrome import ChromeBrowser

    async def nothing(_):
        return None

    got = []
    b = ChromeBrowser(tmp_path / "p", tmp_path, "", nothing, nothing, on_downloaded=got.append)
    (tmp_path / "report.pdf").write_text("old")
    (tmp_path / "1234").write_text("new")
    final = b._finish_download("1234", "report.pdf")
    assert final == tmp_path / "report (1).pdf" and final.read_text() == "new"
    assert b._finish_download("missing", "x.pdf") is None


def test_claude_session_id_is_captured():
    from jarvis_agent.coding import session_of

    assert session_of(json.dumps({"type": "system", "subtype": "init", "session_id": "abc-123"})) == "abc-123"
    assert session_of(json.dumps({"type": "thread.started", "thread_id": "t-9"})) == "t-9"
    assert session_of("not json") == ""


def test_code_folders_resolve(tmp_path, monkeypatch):
    from jarvis_agent.config import JARVIS_REPO

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = Workspace(tmp_path / "JarvisProjects")
    assert ws.folder("jarvis") == JARVIS_REPO
    assert ws.folder("My Site") == tmp_path / "JarvisProjects" / "my-site"
    (tmp_path / "Desktop" / "School").mkdir(parents=True)
    assert ws.folder("Desktop/School") == (tmp_path / "Desktop" / "School").resolve()
    with pytest.raises(PermissionError):
        ws.folder(str(tmp_path / ".ssh"))


def test_plugin_installs_from_saved_code(tmp_path, monkeypatch):
    from jarvis_agent.tools import plugins

    monkeypatch.setattr(plugins, "DRAFT_DIR", tmp_path / "drafts")
    monkeypatch.setattr(plugins, "PLUGIN_DIR", tmp_path)
    monkeypatch.setattr(reg, "PLUGIN_DIR", tmp_path)
    monkeypatch.setattr(reg, "ENABLED_FILE", tmp_path / "enabled.json")
    monkeypatch.setattr(plugins, "write_enabled", reg.write_enabled)
    monkeypatch.setattr(plugins, "read_enabled", reg.read_enabled)
    reloaded = []
    p = plugins.Plugins("", "", builtin_names=lambda: set(), reload=lambda: reloaded.append(1))
    code = 'TOOL = {"name": "say_hi", "description": "Says hello to someone.", "parameters": {"type": "object", "properties": {}}}\n' \
           "def run(args):\n    return 'hi'\n"
    assert p.enable({"name": "say_hi", "code": code}, ctx())["enabled"] == "say_hi"
    assert (tmp_path / "say_hi.py").read_text() == code and reloaded


# No approval by default, writing files, uploads into web pages ------------------------

def test_approval_only_when_ask_first():
    t = Tool("run_coding_agent", "builds things", schema(), lambda a, c: None, long_running=True, approval=True)
    assert "approval" not in Registry(builtins=[t]).manifest()[0]
    assert Registry(builtins=[t], ask_first=True).manifest()[0]["approval"] is True


def test_write_file_creates_folders_and_refuses_secrets(tmp_path, monkeypatch):
    from jarvis_agent.tools import files

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    f = files.Files(tmp_path)
    out = f.write_file({"path": "JarvisProjects/site/index.html", "content": "<h1>hi</h1>"}, ctx())
    assert (tmp_path / "JarvisProjects" / "site" / "index.html").read_text() == "<h1>hi</h1>" and out["replaced"] is False
    f.write_file({"path": "JarvisProjects/site/index.html", "content": "!", "append": True}, ctx())
    assert (tmp_path / "JarvisProjects" / "site" / "index.html").read_text() == "<h1>hi</h1>!"
    for bad in ("project/.env", "keys/server.pem"):
        with pytest.raises(PermissionError):
            f.write_file({"path": bad, "content": "x"}, ctx())
    with pytest.raises(PermissionError):
        f.write_file({"path": ".ssh/config", "content": "x"}, ctx())


def test_file_picker_only_takes_uploaded_files(tmp_path):
    import asyncio

    from jarvis_agent.stream.chrome import ChromeBrowser

    calls = []

    class FakeCdp:
        async def call(self, method, params=None, session=None, timeout=15):
            calls.append((method, params, session))
            return {}

    async def nothing(_):
        return None

    b = ChromeBrowser(tmp_path / "p", tmp_path, "", nothing, nothing)
    b.cdp = FakeCdp()
    b.uploads_dir.mkdir()
    (b.uploads_dir / "a.pdf").write_text("x")
    (b.uploads_dir / "b.pdf").write_text("y")
    b.chooser = {"session": "s1", "node": 7, "mode": "selectSingle"}
    asyncio.run(b.choose_files(["a.pdf", "b.pdf"]))
    assert calls == [("DOM.setFileInputFiles", {"files": [str((b.uploads_dir / "a.pdf").resolve())], "backendNodeId": 7}, "s1")]
    b.chooser = {"session": "s1", "node": 7, "mode": "selectMultiple"}
    with pytest.raises(ValueError):
        asyncio.run(b.choose_files(["../../etc/passwd"]))
    with pytest.raises(RuntimeError):
        asyncio.run(b.choose_files(["a.pdf"]))  # the chooser was used up
