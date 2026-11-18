from anexis.config import HOST, load_settings


def test_defaults_work_with_nothing_set_up(tmp_path):
    s = load_settings(env={"ANEXIS_HOME": str(tmp_path)}, config_path=None)
    assert s.host == HOST == "127.0.0.1" and s.port == 8765 and s.control == "ask"
    assert [p.name for p in s.active_providers()] == ["ollama"]  # nvidia waits for its key, quietly
    assert s.notes == []


def test_a_key_in_the_env_file_turns_a_provider_on(tmp_path):
    (tmp_path / ".env").write_text("NVIDIA_API_KEY='nvapi-x'\n")
    s = load_settings(env={"ANEXIS_HOME": str(tmp_path)}, config_path=None)
    assert [p.name for p in s.active_providers()] == ["ollama", "nvidia"]


def test_a_broken_config_file_never_stops_anexis(tmp_path):
    bad = tmp_path / "anexis.toml"
    bad.write_text("this is [not toml\n")
    s = load_settings(env={"ANEXIS_HOME": str(tmp_path)}, config_path=bad)
    assert s.port == 8765 and "Could not read" in s.notes[0]
    assert s.warnings()  # shown by doctor and at the top of the chat


def test_unknown_and_bad_settings_are_ignored_and_noted(tmp_path):
    cfg = tmp_path / "anexis.toml"
    cfg.write_text('[agent]\ncontrol = "yolo"\nmax_steps = "lots"\nwhat = 1\n[server]\nhost = "0.0.0.0"\nport = 9000\n')
    s = load_settings(env={"ANEXIS_HOME": str(tmp_path)}, config_path=cfg)
    assert s.control == "ask" and s.max_steps == 8 and s.port == 9000 and s.host == "127.0.0.1"
    joined = " ".join(s.notes)
    assert "yolo" in joined and "max_steps" in joined and "'what'" in joined and "host is ignored" in joined


def test_providers_can_be_replaced_in_the_config(tmp_path):
    cfg = tmp_path / "anexis.toml"
    cfg.write_text('[[providers]]\nname = "mine"\nbase_url = "http://x/v1/"\n[providers.models]\nchat = "m"\n')
    s = load_settings(env={"ANEXIS_HOME": str(tmp_path)}, config_path=cfg)
    assert [(p.name, p.base_url, p.models) for p in s.providers] == [("mine", "http://x/v1", {"chat": "m"})]


def test_no_model_at_all_is_a_warning_not_a_crash(tmp_path):
    cfg = tmp_path / "anexis.toml"
    cfg.write_text('[[providers]]\nname = "cloud"\nbase_url = "http://x"\napi_key_env = "NOPE"\n')
    s = load_settings(env={"ANEXIS_HOME": str(tmp_path)}, config_path=cfg)
    assert s.active_providers() == [] and "No model" in s.warnings()[-1]
