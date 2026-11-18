import httpx

from tests.fakes import call


async def collect(client, text, answer=None, **kw):
    events = []
    async for event in client.chat(text, **kw):
        events.append(event)
        if event["type"] == "confirm" and answer is not None:
            await client.confirm(event["id"], answer)
    return events


async def test_chat_streams_text_then_done(live):
    _, client = await live("Hello there")
    events = await collect(client, "hi")
    assert [e["type"] for e in events] == ["text", "done"]
    assert events[0]["delta"] == "Hello there" and events[1]["session_id"]


async def test_health_reports_name_memory_and_tools(live):
    anexis, client = await live()
    anexis.memory.add("fact", "Likes tea")
    health = await client.health()
    assert health["name"] == "Anexis" and health["memories"] == 1 and health["tools"] > 10


async def test_only_requests_meant_for_this_machine_are_answered(live):
    _, client = await live("hi")
    async with httpx.AsyncClient(base_url=client.url) as http:
        assert (await http.get("/health")).status_code == 200
        assert (await http.get("/health", headers={"Host": "evil.example"})).status_code == 403
        assert (await http.get("/health", headers={"Origin": "https://evil.example"})).status_code == 403


async def test_remembering_the_same_thing_twice_keeps_one_copy(live):
    anexis, client = await live()
    first = await client.remember("I have chem lab on fridays")
    again = await client.remember("I have chem lab on fridays")
    assert first["id"] == again["id"] and anexis.memory.count() == 1


async def test_pinned_memories_are_always_true_facts(live):
    anexis, client = await live()
    saved = await client.remember("My name is Sam", pinned=True)
    assert saved["pinned"] and anexis.memory.pinned()[0].text == "My name is Sam"


async def test_dangerous_tool_waits_for_a_yes_from_the_cli(live, settings):
    _, client = await live(call("run_shell", command="touch approved.txt"), "Done.")
    events = await collect(client, "run the shell command", answer=True)
    confirm = next(e for e in events if e["type"] == "confirm")
    assert confirm["tool"] == "run_shell" and confirm["args"] == {"command": "touch approved.txt"}
    assert (settings.workspace / "approved.txt").exists()


async def test_dangerous_tool_does_not_run_on_a_no(live, settings):
    _, client = await live(call("run_shell", command="touch denied.txt"), "Okay.")
    await collect(client, "run the shell command", answer=False)
    assert not (settings.workspace / "denied.txt").exists()


async def test_an_unanswered_question_times_out_as_a_no(live, settings):
    settings.confirm_timeout = 0.2
    _, client = await live(call("run_shell", command="touch late.txt"), "Timed out.")
    events = await collect(client, "run the shell command")  # never answers
    assert events[-1]["type"] == "done" and not (settings.workspace / "late.txt").exists()


async def test_memory_can_be_added_searched_explained_and_forgotten(live):
    _, client = await live("Thursday.")
    saved = await client.remember("Chemistry lab is on Thursday")
    assert [m["text"] for m in await client.memories("chemistry")] == ["Chemistry lab is on Thursday"]
    done = (await collect(client, "when is chemistry lab"))[-1]
    assert [m["id"] for m in await client.why(done["session_id"])] == [saved["id"]]
    assert (await client.forget(saved["id"]))["forgotten"] is True
    assert await client.memories("chemistry") == []


async def test_tools_endpoint_lists_built_ins(live):
    _, client = await live()
    tools = await client.tools()
    assert "code_task" in [t["name"] for t in tools["tools"]]


async def test_doctor_reports_each_part(live):
    _, client = await live()
    parts = {c["part"]: c for c in await client.doctor()}
    assert parts["memory"]["ok"] and "model: fake" in parts
    assert parts["canvas"]["optional"] and not parts["canvas"]["ok"]  # no key: optional, never a failure
    assert parts["model: nvidia"]["ok"] and "NVIDIA_API_KEY" in parts["model: nvidia"]["detail"]


async def test_mode_is_remembered_between_messages(live):
    anexis, client = await live("ok", "ok")
    first = (await collect(client, "hi", mode="work"))[-1]
    await collect(client, "again", session_id=first["session_id"])
    assert anexis.memory.session(first["session_id"])["mode"] == "work"


async def test_one_broken_turn_does_not_take_the_server_down(live):
    _, client = await live()  # no scripted replies: the model call fails
    events = await collect(client, "hi")
    assert events[-1]["type"] == "error"
    assert (await client.health())["name"] == "Anexis"


async def test_missing_extras_never_fail_the_checkup(live, settings):
    import io

    from rich.console import Console

    from anexis.cli.chat import show_doctor

    settings.claude_bin = "/nonexistent/claude"
    _, client = await live()
    checks = await client.doctor()
    claude = next(c for c in checks if c["part"] == "claude code")
    assert not claude["ok"] and claude["optional"]
    required = [c for c in checks if c["part"] in ("config", "memory", "model: fake", "claude code", "canvas")]
    assert show_doctor(Console(file=io.StringIO(), width=200), required) is True


async def test_the_checkup_says_so_when_no_model_is_set_up(live, settings):
    settings.providers = []
    _, client = await live()
    config = next(c for c in await client.doctor() if c["part"] == "config")
    assert not config["ok"] and "model" in config["detail"].lower()
