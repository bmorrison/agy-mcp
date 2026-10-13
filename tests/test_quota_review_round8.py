"""Incomplete detection must recover on later reads, not retry inside a flight."""

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from test_quota import make_synthetic_detection_probe

from agy_mcp.adapters import agy


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
@pytest.mark.parametrize("flag", ["--help", "--version"])
@pytest.mark.parametrize("failure", ["timeout", "overflow", "invalid-utf8", "nonzero"])
def test_later_normal_quota_read_retries_transient_detection(tmp_path, monkeypatch, flag, failure):
    marker = tmp_path / "synthetic-transient-failure"
    marker.write_text("synthetic failure enabled")
    operations = {
        "timeout": "time.sleep(60)",
        "overflow": "sys.stdout.write(' ' * (1024 * 1024 + 8192))",
        "invalid-utf8": "sys.stdout.buffer.write(b'\\xff')",
        "nonzero": "print('1.3.3'); raise SystemExit(1)",
    }
    special = (
        f"if {flag!r} in a and pathlib.Path({str(marker)!r}).exists():\n"
        f"    {operations[failure]}\n"
        "    raise SystemExit(0)"
    )
    if failure == "timeout":
        # Leave enough startup time to record argv before the intentional hang.
        timeout_name = "AGY_HELP_TIMEOUT_S" if flag == "--help" else "AGY_VERSION_TIMEOUT_S"
        monkeypatch.setattr(agy, timeout_name, 0.5)
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    first = probe.get()
    assert not first.success
    first_calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert sum(call == [flag] for call in first_calls) == 1
    assert not any("--print=/quota" in call for call in first_calls)
    marker.unlink()  # The executable/auth identity has not changed.
    second = probe.get()
    assert second.success and not second.cached
    assert probe.get().cached
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert sum(call == [flag] for call in calls) == 2
    assert sum("--print=/quota" in call for call in calls) == 1


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
def test_missing_print_capability_blocks_metadata_and_recovers_later(tmp_path, monkeypatch):
    marker = tmp_path / "synthetic-incomplete-help"
    marker.write_text("synthetic incomplete help enabled")
    special = (
        f"if '--help' in a and pathlib.Path({str(marker)!r}).exists():\n"
        "    print('Usage: --version')\n"
        "    raise SystemExit(0)"
    )
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    first = probe.get()
    assert not first.success and first.status == "unsupported"
    assert not any("--print=/quota" in json.loads(line)["argv"] for line in log.read_text().splitlines())
    marker.unlink()
    assert probe.get().success


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
def test_failed_detection_coalesces_without_same_flight_retry(tmp_path, monkeypatch):
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch)
    entered, release, joined = threading.Event(), threading.Event(), threading.Event()
    original = probe.adapter._run_probe
    help_calls = 0

    def run(cmd, **kwargs):
        nonlocal help_calls
        if "--help" in cmd:
            help_calls += 1
            if help_calls == 1:
                entered.set()
                assert release.wait(5)
                raise agy._CapabilityProbeError("synthetic transient detection failure")
        return original(cmd, **kwargs)

    monkeypatch.setattr(probe.adapter, "_run_probe", run)
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
    assert not first.success and not second.success
    assert first.status == second.status
    assert help_calls == 1  # Existing waiters share failure, not a new detection attempt.
    assert probe.get().success  # A later normal request may retry the incomplete proof.
    assert help_calls == 2
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert sum("--print=/quota" in call for call in calls) == 1
