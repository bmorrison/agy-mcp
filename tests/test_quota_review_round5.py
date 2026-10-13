"""Codex round-five regressions for version evidence, age and policy parsing."""

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from test_quota import (
    FakeAdapter,
    make_synthetic_detection_probe,
    make_synthetic_quota_data,
    make_synthetic_quota_json,
)

from agy_mcp import quota
from agy_mcp.models import BridgeRequest
from agy_mcp.quota import QuotaProbe


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
@pytest.mark.parametrize("output", [
    "", "versión: 1.3.3", "Antigravity CLI version: 1.3.3", "startup banner without version",
])
def test_unparseable_version_cannot_use_help_version_for_quota(tmp_path, monkeypatch, output):
    special = f"if '--version' in a:\n    print({output!r})\n    raise SystemExit(0)"
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    response = probe.get()
    assert not response.success and response.status == "unsupported"
    cap = probe.adapter.detect()
    assert cap.version is None and cap.supports_print
    assert cap.raw_help and "1.3.3" in cap.raw_help
    # Ordinary inference construction still works; never execute it here.
    argv = probe.adapter.build_command(BridgeRequest(prompt="synthetic"), log_path=None)
    assert any(arg.startswith("--print=") for arg in argv)
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert calls == [["--help"], ["--version"]]


@pytest.mark.parametrize("check", ["age", "expiry"])
def test_cache_age_starts_at_observation_not_post_command_validation(monkeypatch, check):
    clock = [100.0]
    monkeypatch.setattr(quota, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: "synthetic-stable")
    original_key = probe._get_cache_key
    command_done, delayed = False, False

    def execute(path):
        nonlocal command_done
        command_done = True
        return 0, make_synthetic_quota_json(), ""

    execute_mock = MagicMock(side_effect=execute)

    def key(**kwargs):
        nonlocal delayed
        result = original_key(**kwargs)
        if command_done and not delayed:
            delayed = True
            clock[0] += 20  # Legitimate post-command help/version validation.
        return result

    monkeypatch.setattr(probe, "_execute_command", execute_mock)
    monkeypatch.setattr(probe, "_get_cache_key", key)
    first = probe.get()
    assert first.success and not first.cached
    if check == "age":
        assert first.age_seconds == 20
        clock[0] = 125
        cached = probe.get()
        assert cached.success and cached.cached and cached.age_seconds == 25
        assert execute_mock.call_count == 1
    else:
        clock[0] = 131  # 31s after observation, only 11s after validation.
        fresh = probe.get()
        assert fresh.success and not fresh.cached
        assert execute_mock.call_count == 2


@pytest.mark.parametrize("location", ["data", "group", "bucket"])
@pytest.mark.parametrize("description", [
    "Slash commands are disabled for this bucket",
    "Slash commands are not permitted for this group",
    "Slash commands are not allowed in the upstream description",
])
def test_valid_quota_descriptions_are_not_policy_errors(monkeypatch, location, description):
    data = make_synthetic_quota_data()
    target = data["command"]["data"]
    if location != "data":
        target = target["groups"][1]
        if location == "bucket":
            target = target["buckets"][1]
    target["description"] = description
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(probe, "_execute_command", lambda path: (0, json.dumps(data), ""))
    response = probe.get()
    assert response.success, response
    assert response.groups[1].buckets[1].disabled
    assert response.groups[1].buckets[1].remaining_fraction is None


@pytest.mark.parametrize("exit_code", [0, 1])
def test_unstructured_slash_policy_errors_still_fail_closed(monkeypatch, exit_code):
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(
        probe, "_execute_command", lambda path: (exit_code, "Error: slash commands are disabled", "")
    )
    result = probe.get()
    assert not result.success and result.status == "unsupported"


def test_valid_quota_json_takes_precedence_over_policy_text_in_stderr(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(
        probe, "_execute_command",
        lambda path: (0, make_synthetic_quota_json(), "slash commands are disabled for some buckets"),
    )
    assert probe.get().success


def test_coalesced_waiter_age_includes_its_validation_delay(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(quota, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: "synthetic-stable")
    original_key = probe._get_cache_key
    keys = 0
    entered, release, joined = threading.Event(), threading.Event(), threading.Event()

    def key(**kwargs):
        nonlocal keys
        keys += 1
        if keys == 3:
            clock[0] = 120  # Leader's post-command validation.
        elif keys == 4:
            clock[0] = 125  # Waiter's validation before receiving the result.
        return original_key(**kwargs)

    def execute(path):
        entered.set()
        assert release.wait(5)
        return 0, make_synthetic_quota_json(), ""

    execute_mock = MagicMock(side_effect=execute)
    monkeypatch.setattr(probe, "_get_cache_key", key)
    monkeypatch.setattr(probe, "_execute_command", execute_mock)
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
        first, second = leader.result(timeout=3), waiter.result(timeout=3)
    assert first.success and not first.cached and first.age_seconds == 20
    assert second.success and not second.cached and second.age_seconds == 25
    assert execute_mock.call_count == 1
