"""Further Codex regressions: Windows launchers, refresh waits and auth evidence."""

import io
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import pytest
from test_quota import FakeAdapter, make_synthetic_detection_probe, make_synthetic_quota_json

from agy_mcp import probe_process, quota, utils
from agy_mcp.adapters import agy, base
from agy_mcp.adapters.agy import AgyAuthSource
from agy_mcp.quota import QuotaProbe


@pytest.mark.parametrize("suffix", ["cmd", "bat", "exe"])
def test_metadata_runner_prepares_windows_launchers(monkeypatch, suffix):
    monkeypatch.setattr(utils, "is_windows", lambda: True)
    monkeypatch.setattr(base, "_process_group_kwargs", lambda: {"creationflags": 0})
    argv = [rf"C:\Synthetic CLI\agy.{suffix}", "--print=/quota", "--output-format", "json"]
    env = {"COMSPEC": r"C:\Windows\System32\cmd.exe", "AGY_CLI_DISABLE_AUTO_UPDATE": "1"}
    expected, wrapped = utils.prepare_subprocess_command(argv, env)
    proc = MagicMock(pid=12345, returncode=0)
    proc.poll.return_value = 0
    proc.stdout, proc.stderr = io.BytesIO(b"synthetic"), io.BytesIO(b"")
    popen = MagicMock(return_value=proc)
    monkeypatch.setattr(probe_process.subprocess, "Popen", popen)
    assert probe_process.run_bounded_process(argv, env=env, timeout=1, cleanup=lambda *args: None) == (
        0, "synthetic", "",
    )
    assert wrapped is (suffix != "exe")
    assert popen.call_args.args[0] == expected
    assert popen.call_args.kwargs.get("shell", False) is False
    assert popen.call_args.kwargs["env"] == env
    assert popen.call_args.kwargs["creationflags"] == 0
    assert argv[0].endswith(suffix)  # Preparation must not mutate the caller's argv.


@pytest.mark.parametrize("detection_rounds", [1, 2])
def test_waiter_allows_initial_detection_and_quota_to_complete(monkeypatch, detection_rounds):
    probe = QuotaProbe(FakeAdapter())
    entered, release = threading.Event(), threading.Event()
    original_key = probe._get_cache_key
    first = True
    budgets = []

    def key(**kwargs):
        nonlocal first
        if first:
            first = False
            entered.set()
            assert release.wait(5)
        return original_key(**kwargs)

    monkeypatch.setattr(probe, "_get_cache_key", key)
    monkeypatch.setattr(probe, "_execute_command", lambda path: (0, make_synthetic_quota_json(), ""))
    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(probe.get, True)
        try:
            assert entered.wait(2)
            with probe._lock:
                flight = next(iter(probe._in_flight_map.values()))
            original_wait = flight.done.wait
            # Simulate the full help/version + quota budget plus cleanup;
            # revealing auth evidence can require a second detection round.
            # A 35-second waiter must expire before either legitimate result.
            full_budget = (
                detection_rounds * (agy.AGY_HELP_TIMEOUT_S + agy.AGY_VERSION_TIMEOUT_S)
                + quota.QUOTA_PROCESS_DEADLINE_S + 5
            )

            def wait(timeout=None):
                budgets.append(timeout)
                if timeout < full_budget:
                    return False
                release.set()
                return original_wait(2)

            monkeypatch.setattr(flight.done, "wait", wait)
            waiter = pool.submit(probe.get, True)
            response = waiter.result(timeout=3)
        finally:
            release.set()
        assert leader.result(timeout=3).success
    assert response.success, response
    assert budgets and budgets[0] >= full_budget


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
@pytest.mark.parametrize("outcome", ["success", "auth_error", "timeout"])
def test_absent_auth_evidence_still_attempts_bounded_metadata(tmp_path, monkeypatch, outcome):
    special = ""
    if outcome == "auth_error":
        special = (
            "if '--print=/quota' in a:\n"
            "    sys.stderr.write('auth error: credentials unavailable; Authorization: Bearer SYNTHETIC_AUTH_SECRET')\n"
            "    raise SystemExit(1)"
        )
    elif outcome == "timeout":
        special = "if '--print=/quota' in a: time.sleep(60)"
        monkeypatch.setattr(quota, "QUOTA_PROCESS_DEADLINE_S", 0.15)
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    monkeypatch.setattr(agy, "detect_agy_auth_source", lambda: None)
    monkeypatch.setattr(quota, "detect_agy_auth_source", lambda: None)
    monkeypatch.setattr(probe, "_detect_auth_context", QuotaProbe._detect_auth_context.__get__(probe))
    response = probe.get()
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert sum("--print=/quota" in call for call in calls) == 1
    assert response.status == ("ok" if outcome == "success" else outcome)
    assert response.success is (outcome == "success")
    assert "SYNTHETIC_AUTH_SECRET" not in (response.error or "")
    if outcome == "success":
        assert probe.get().cached
    else:
        assert probe._cached_response is None


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
@pytest.mark.parametrize("stage", ["help", "quota"])
def test_auth_evidence_created_by_metadata_probe_does_not_reject_success(tmp_path, monkeypatch, stage):
    marker = tmp_path / "synthetic-keyring-evidence"
    flag = "--help" if stage == "help" else "--print=/quota"
    special = f"if {flag!r} in a: pathlib.Path({str(marker)!r}).write_text('synthetic auth evidence')"
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)

    def source():
        return AgyAuthSource(kind="keyring_log", path=tmp_path) if marker.exists() else None

    monkeypatch.setattr(agy, "detect_agy_auth_source", source)
    monkeypatch.setattr(quota, "detect_agy_auth_source", source)
    monkeypatch.setattr(probe, "_detect_auth_context", QuotaProbe._detect_auth_context.__get__(probe))
    response = probe.get()
    assert response.success, response
    assert probe.get().cached
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert sum("--print=/quota" in call for call in calls) == 1
    assert sum(call == ["--help"] for call in calls) <= 2
    assert sum(call == ["--version"] for call in calls) <= 2


def test_auth_discovery_during_cache_read_cannot_publish_old_balance(monkeypatch):
    adapter = FakeAdapter(authenticated=False)
    probe = QuotaProbe(adapter)
    evidence = ["none"]
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: evidence[0])
    execute = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    monkeypatch.setattr(probe, "_execute_command", execute)
    assert probe.get().success
    original_key = probe._get_cache_key
    keys = 0

    def key(**kwargs):
        nonlocal keys
        keys += 1
        if keys == 2:  # New evidence appears after taking a cached response.
            evidence[0] = "keyring_log:synthetic-new-evidence"
            adapter.fake_authenticated = True
        return original_key(**kwargs)

    monkeypatch.setattr(probe, "_get_cache_key", key)
    result = probe.get()
    assert not result.success and result.status == "unavailable"
    assert probe._cached_response is None
    assert execute.call_count == 1
    assert probe.get().success
    assert execute.call_count == 2


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
def test_auth_discovery_rekeys_result_for_coalesced_waiter(tmp_path, monkeypatch):
    marker = tmp_path / "synthetic-discovered-auth"
    special = (
        "if '--print=/quota' in a:\n"
        f"    pathlib.Path({str(marker)!r}).write_text('synthetic evidence')"
    )
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)

    def source():
        return AgyAuthSource(kind="keyring_log", path=tmp_path) if marker.exists() else None

    monkeypatch.setattr(agy, "detect_agy_auth_source", source)
    monkeypatch.setattr(quota, "detect_agy_auth_source", source)
    monkeypatch.setattr(probe, "_detect_auth_context", QuotaProbe._detect_auth_context.__get__(probe))
    original_execute = probe._execute_command
    entered, release, joined = threading.Event(), threading.Event(), threading.Event()

    def execute(path):
        entered.set()
        assert release.wait(5)
        return original_execute(path)

    monkeypatch.setattr(probe, "_execute_command", execute)
    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(probe.get, True)
        try:
            assert entered.wait(2)
            with probe._lock:
                flight = next(iter(probe._in_flight_map.values()))
            original_wait = flight.done.wait

            def wait(timeout=None):
                joined.set()
                return original_wait(timeout)

            monkeypatch.setattr(flight.done, "wait", wait)
            waiter = pool.submit(probe.get, True)
            assert joined.wait(2)
        finally:
            release.set()
        assert leader.result(timeout=3).success
        assert waiter.result(timeout=3).success
    assert not probe._in_flight_map
    assert probe.get().cached
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert sum("--print=/quota" in call for call in calls) == 1
