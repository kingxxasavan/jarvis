import io

from rich.console import Console

from anexis.cli.chat import ChatSession, header, parse_command
from tests.fakes import call


def screen():
    return Console(file=io.StringIO(), width=100, force_terminal=False, color_system=None)


async def test_a_reply_is_shown_indented_with_the_tools_it_used(live, settings):
    settings.control = "full"
    _, client = await live(call("calculate", expression="6*7"), "It is 42.\nEasy one.")
    console = screen()
    chat = ChatSession(client, console, lambda q: None)
    reply = await chat.send("what is 6 times 7")
    out = console.file.getvalue()
    assert reply == "It is 42.\nEasy one."
    assert "  [tool] calculate expression=6*7" in out
    assert "  It is 42.\n  Easy one." in out
    assert "calculate" in out.splitlines()[-1] and "s ·" in out.splitlines()[-1]
    assert chat.session_id


async def test_a_risky_tool_asks_in_the_chat_and_a_no_stops_it(live, settings):
    _, client = await live(call("run_shell", command="touch x"), "Ok, I did not.")
    asked = []

    async def no(question):
        asked.append(question)
        return False

    console = screen()
    await ChatSession(client, console, no).send("make x")
    assert asked and "allow?" in asked[0]
    assert "run_shell wants to run" in console.file.getvalue()
    assert not (settings.workspace / "x").exists()


async def test_slash_commands_reach_the_server(live):
    _, client = await live()
    console = screen()
    chat = ChatSession(client, console, lambda q: None)
    assert await chat.command("remember", "I take chem on tuesdays")
    assert await chat.command("memory", "chem")
    assert "I take chem on tuesdays" in console.file.getvalue()
    assert await chat.command("tools", "")
    assert "built in" in console.file.getvalue()
    assert await chat.command("quit", "") is False


def test_commands_and_the_header_line():
    assert parse_command("/memory chem lab") == ("memory", "chem lab")
    assert parse_command("hello") == (None, "hello")
    line = header({"name": "Anexis", "providers": ["nvidia"], "chat_models": {"nvidia": "meta/llama-3.3-70b-instruct"},
                   "memories": 3, "tools": 30, "control": "ask"})
    assert line == "anexis · nvidia llama-3.3-70b-instruct · 3 memories · 30 tools · ask"
