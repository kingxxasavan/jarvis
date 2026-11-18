"""Who holds the port. An older Anexis (like the PC edition run on a server,
which wants a token) can still be running on 8765 with its pid file gone.
The new one must find it by the port, replace it, and say so."""

import asyncio
import socket
import subprocess
import sys
import time

import pytest

from anexis.cli import main as cli
from anexis.proc import is_anexis_server, port_owner

# A stand in server: answers every request with 401, like the old token protected Anexis.
OLD = """
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(401); self.end_headers(); self.wfile.write(b'Wrong or missing token')
http.server.HTTPServer(('0.0.0.0', int(sys.argv[1])), H).serve_forever()
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def holder(port: int, *words: str) -> subprocess.Popen:
    proc = subprocess.Popen([sys.executable, "-c", OLD, str(port), *words])
    for _ in range(100):
        if port_owner(port) == proc.pid:
            return proc
        time.sleep(0.05)
    proc.kill()
    raise AssertionError("stand in server did not start")


@pytest.fixture
def on_port(settings, monkeypatch):
    settings.port = free_port()
    settings.home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("ANEXIS_HOME", str(settings.home))
    monkeypatch.setenv("ANEXIS_PORT", str(settings.port))
    monkeypatch.setenv("ANEXIS_WORKSPACE", str(settings.workspace))
    monkeypatch.setenv("ANEXIS_OUTSIDE_TOOLS", "off")
    started = []
    yield started
    for proc in started:
        proc.kill()
    cli.stop_server(settings)


def test_the_port_owner_is_found(on_port, settings):
    old = holder(settings.port, "anexis", "serve")
    on_port.append(old)
    assert port_owner(settings.port) == old.pid and is_anexis_server(old.pid)


def test_stop_finds_an_old_anexis_by_its_port_without_a_pid_file(on_port, settings):
    old = holder(settings.port, "anexis", "serve")
    on_port.append(old)
    assert not cli.pid_file(settings).exists()
    assert cli.stop_server(settings) is True
    assert old.wait(timeout=10) is not None


async def test_starting_replaces_an_old_anexis_that_holds_the_port(on_port, settings, capsys):
    old = holder(settings.port, "anexis", "serve")
    on_port.append(old)
    client = await cli.start_server(settings)
    assert (await client.health())["edition"] == "server"
    assert old.poll() is not None  # the old one is gone
    assert "older anexis" in capsys.readouterr().out


async def test_a_port_taken_by_some_other_program_is_explained_not_crashed_into(on_port, settings):
    other = holder(settings.port, "something", "else")
    on_port.append(other)
    with pytest.raises(SystemExit) as stopped:
        await cli.start_server(settings)
    said = str(stopped.value)
    assert str(settings.port) in said and "ANEXIS_PORT" in said and str(other.pid) in said
    await asyncio.sleep(0.2)
    assert other.poll() is None  # never touched


def test_serve_explains_a_taken_port_instead_of_crashing(on_port, settings):
    other = holder(settings.port, "something", "else")
    on_port.append(other)
    with pytest.raises(SystemExit) as stopped:
        cli.cmd_serve(settings, None)
    assert "ANEXIS_PORT" in str(stopped.value) and other.poll() is None
