"""PR #4 regressions: auth evidence, detection, policy and refresh coalescing."""

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from test_quota import (
    FakeAdapter,
    make_synthetic_detection_probe,
    make_synthetic_quota_data,
    make_synthetic_quota_json,
)

from agy_mcp.adapters import agy
from agy_mcp.adapters.agy import AgyAuthSource
from agy_mcp.models import BridgeRequest
from agy_mcp.quota import QuotaProbe, is_slash_disabled_error


@pytest.mark.parametrize("kind", ["keyring_log", "oauth_creds"])
def test_auth_evidence_rewritten_by_probe_does_not_invalidate_snapshot(tmp_path, monkeypatch, kind):
    source = tmp_path / "synthetic-auth-evidence"
    if kind == "keyring_log":
        source.mkdir()
    else:
        source.write_text("synthetic presence only")
    monkeypatch.setattr(
        "agy_mcp.quota.detect_agy_auth_source",
        lambda: AgyAuthSource(kind=kind, path=source),
    )
    probe = QuotaProbe(FakeAdapter())
    calls = []

    def execute(path):
        calls.append(path)
        old_mtime = source.stat().st_mtime_ns
        if kind == "keyring_log":
            (source / "cli-synthetic.log").write_text("synthetic log rotation")
        else:
            source.write_text("synthetic token refresh only")
        os.utime(source, ns=(old_mtime + 1_000_000_000, old_mtime + 1_000_000_000))
        return 0, make_synthetic_quota_json(), ""

    monkeypatch.setattr(probe, "_execute_command", execute)
    assert probe.get().success
    assert probe.get().cached
    assert len(calls) == 1


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
@pytest.mark.parametrize("mode", ["timeout", "overflow", "invalid-utf8"])
def test_failed_version_probe_preserves_valid_help_for_inference(tmp_path, monkeypatch, mode):
    from agy_mcp.probe_process import MAX_PROBE_OUTPUT_BYTES

    operations = {
        "timeout": "time.sleep(60)",
        "overflow": f"sys.stdout.write(' ' * {MAX_PROBE_OUTPUT_BYTES + 8192})",
        "invalid-utf8": "sys.stdout.buffer.write(b'\\xff')",
    }
    special = f"if '--version' in a:\n    {operations[mode]}\n    raise SystemExit(0)"
    monkeypatch.setattr(agy, "AGY_VERSION_TIMEOUT_S", 0.1)
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    response = probe.get()
    assert not response.success and response.status == "unsupported"
    cap = probe.adapter.detect()
    assert cap.version is None and cap.supports_print and cap.supports_print_timeout
    assert cap.raw_help and cap.warnings
    # Construction only: never run an inference command in this regression.
    argv = probe.adapter.build_command(BridgeRequest(prompt="synthetic"), log_path=None)
    assert any(arg.startswith("--print=") for arg in argv)
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert calls == [["--help"], ["--version"]]


@pytest.mark.parametrize("authority", ["policy", "operator", "admin"])
def test_disabled_bucket_description_is_not_slash_policy(authority, monkeypatch):
    data = make_synthetic_quota_data()
    bucket = data["command"]["data"]["groups"][1]["buckets"][1]
    bucket["description"] = f"Five-hour access is disabled by {authority}"
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(probe, "_execute_command", lambda path: (0, json.dumps(data), ""))
    response = probe.get()
    assert response.success
    assert response.groups[1].buckets[1].disabled
    assert response.groups[1].buckets[1].remaining_fraction is None


@pytest.mark.parametrize("text", [
    "Error: slash commands are disabled by policy",
    "Error: slash-commands disabled by admin",
    "Error: slash commands are not permitted",
    "Error: slash commands are not allowed",
])
def test_explicit_slash_policy_still_fails_closed(text):
    assert is_slash_disabled_error("", text)


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
@pytest.mark.parametrize("stage", ["detection", "quota"])
def test_forced_refresh_coalesces_detection_as_well_as_quota(tmp_path, monkeypatch, stage):
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch)
    entered, release, joined = threading.Event(), threading.Event(), threading.Event()
    from agy_mcp import quota

    original_flight = quota._InFlight

    class ObservedFlight(original_flight):
        def __init__(self):
            super().__init__()
            original_wait = self.done.wait
            counter_lock = threading.Lock()
            count = 0

            def wait(timeout=None):
                nonlocal count
                with counter_lock:
                    count += 1
                    if count == 5:
                        joined.set()
                return original_wait(timeout)

            self.done.wait = wait

    monkeypatch.setattr(quota, "_InFlight", ObservedFlight)
    if stage == "detection":
        original = probe.adapter._run_probe

        def run(cmd, **kwargs):
            if "--help" in cmd:
                entered.set()
                assert release.wait(5)
            return original(cmd, **kwargs)

        monkeypatch.setattr(probe.adapter, "_run_probe", run)
    else:
        original = probe._execute_command

        def run(path):
            entered.set()
            assert release.wait(5)
            return original(path)

        monkeypatch.setattr(probe, "_execute_command", run)

    with ThreadPoolExecutor(max_workers=6) as pool:
        leader = pool.submit(probe.get, True)
        try:
            assert entered.wait(2)
            started = threading.Barrier(6)

            def wait():
                started.wait(2)
                return probe.get(force_refresh=True)

            waiters = [pool.submit(wait) for _ in range(5)]
            started.wait(2)
            assert joined.wait(2)  # All five callers joined before preparation/execution ends.
        finally:
            release.set()
        results = [future.result(timeout=5) for future in [leader, *waiters]]
    assert all(result.success for result in results)
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert sum(call == ["--help"] for call in calls) == 1
    assert sum(call == ["--version"] for call in calls) == 1
    assert sum("--print=/quota" in call for call in calls) == 1


@pytest.mark.parametrize("mode", ["invalidate", "interrupt"])
def test_preparation_flight_releases_waiters_without_publishing_invalid_success(monkeypatch, mode):
    probe = QuotaProbe(FakeAdapter())
    entered, release, joined = threading.Event(), threading.Event(), threading.Event()
    original_detect = probe.adapter.detect
    detections = 0
    results, interruptions = [], []

    def detect(**kwargs):
        nonlocal detections
        detections += 1
        if detections == 1:
            entered.set()
            assert release.wait(5)
            if mode == "interrupt":
                raise KeyboardInterrupt("synthetic preparation interrupt")
        return original_detect(**kwargs)

    def lead():
        try:
            results.append(probe.get(force_refresh=True))
        except KeyboardInterrupt:
            interruptions.append(True)

    monkeypatch.setattr(probe.adapter, "detect", detect)
    monkeypatch.setattr(probe, "_execute_command", lambda path: (0, make_synthetic_quota_json(), ""))
    leader = threading.Thread(target=lead)
    waiter = threading.Thread(target=lambda: results.append(probe.get(force_refresh=True)))
    leader.start()
    try:
        assert entered.wait(2)
        with probe._lock:
            flight = next(iter(probe._in_flight_map.values()))
        original_wait = flight.done.wait

        def wait(timeout=None):
            joined.set()
            return original_wait(timeout)

        monkeypatch.setattr(flight.done, "wait", wait)
        waiter.start()
        assert joined.wait(2)
        if mode == "invalidate":
            probe.invalidate()
    finally:
        release.set()
        leader.join(3)
        if waiter.ident is not None:
            waiter.join(3)
    assert not leader.is_alive() and not waiter.is_alive()
    assert len(results) == (1 if mode == "interrupt" else 2)
    assert all(not response.success for response in results)
    assert interruptions == ([True] if mode == "interrupt" else [])
    assert probe._cached_response is None and not probe._in_flight_map
    assert probe.get().success  # A failed/interrupted preparation never strands the next call.


def test_forced_waiter_does_not_accept_normal_leaders_cache_hit(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    executions = []

    def execute(path):
        executions.append(path)
        return 0, make_synthetic_quota_json(), ""

    monkeypatch.setattr(probe, "_execute_command", execute)
    assert probe.get().success
    original_key = probe._get_cache_key
    entered, release, joined = threading.Event(), threading.Event(), threading.Event()
    first = True

    def key(**kwargs):
        nonlocal first
        if first:
            first = False
            entered.set()
            assert release.wait(5)
        return original_key(**kwargs)

    monkeypatch.setattr(probe, "_get_cache_key", key)
    with ThreadPoolExecutor(max_workers=2) as pool:
        normal = pool.submit(probe.get)
        try:
            assert entered.wait(2)
            with probe._lock:
                flight = next(iter(probe._in_flight_map.values()))
            original_wait = flight.done.wait

            def wait(timeout=None):
                joined.set()
                return original_wait(timeout)

            monkeypatch.setattr(flight.done, "wait", wait)
            forced = pool.submit(probe.get, True)
            assert joined.wait(2)
        finally:
            release.set()
        assert normal.result(timeout=5).cached
        response = forced.result(timeout=5)
    assert response.success and not response.cached
    assert len(executions) == 2
