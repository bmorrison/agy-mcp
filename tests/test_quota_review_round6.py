"""Refresh replacement regressions: fresh versus cached capability evidence."""

import json
import os
from pathlib import Path

import pytest
from test_quota import make_synthetic_detection_probe

from agy_mcp import quota
from agy_mcp.adapters import agy
from agy_mcp.adapters.agy import AgyAuthSource
from agy_mcp.quota import QuotaProbe


def _calls(log):
    return [json.loads(line)["argv"] for line in log.read_text().splitlines()]


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
@pytest.mark.parametrize("force", [False, True])
def test_replaced_binary_needs_only_one_detection_pair(tmp_path, monkeypatch, force):
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch)
    assert probe.get().success
    binary = Path(probe.adapter.bin_override)
    binary.write_text(binary.read_text().replace("1.3.3", "1.3.4"))
    log.write_text("")
    response = probe.get(force_refresh=force)
    assert response.success and response.cli_version == "1.3.4"
    calls = _calls(log)
    assert sum(call == ["--help"] for call in calls) == 1
    assert sum(call == ["--version"] for call in calls) == 1
    assert sum("--print=/quota" in call for call in calls) == 1


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
def test_forced_replacement_refresh_with_new_auth_evidence_succeeds(tmp_path, monkeypatch):
    upgrade, evidence = tmp_path / "synthetic-upgrade", tmp_path / "synthetic-auth-evidence"
    special = (
        f"if '--help' in a and pathlib.Path({str(upgrade)!r}).exists():\n"
        f"    pathlib.Path({str(evidence)!r}).write_text('synthetic auth evidence')"
    )
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)

    def source():
        return AgyAuthSource(kind="keyring_log", path=tmp_path) if evidence.exists() else None

    monkeypatch.setattr(agy, "detect_agy_auth_source", source)
    monkeypatch.setattr(quota, "detect_agy_auth_source", source)
    monkeypatch.setattr(probe, "_detect_auth_context", QuotaProbe._detect_auth_context.__get__(probe))
    assert probe.get().success  # Populate both binary fingerprint and cached capabilities.
    binary = Path(probe.adapter.bin_override)
    binary.write_text(binary.read_text().replace("1.3.3", "1.3.4"))
    upgrade.write_text("synthetic upgrade enabled")
    log.write_text("")
    response = probe.get(force_refresh=True)
    assert response.success, response
    assert response.cli_version == "1.3.4"
    assert probe.get().cached
    calls = _calls(log)
    # One initial pair plus at most one pair for actual auth evidence discovery.
    assert sum(call == ["--help"] for call in calls) <= 2
    assert sum(call == ["--version"] for call in calls) <= 2
    assert sum("--print=/quota" in call for call in calls) == 1


@pytest.mark.skipif(os.name != "posix", reason="synthetic executable")
def test_binary_changing_during_fresh_detection_never_authorizes_quota(tmp_path, monkeypatch):
    special = (
        "if '--version' in a:\n"
        "    p=pathlib.Path(sys.argv[0])\n"
        "    p.write_text(p.read_text().replace('1.3.3', '1.0.0'))\n"
        "    print('1.3.3')\n"
        "    raise SystemExit(0)"
    )
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    response = probe.get(force_refresh=True)
    assert not response.success and response.status == "unavailable"
    assert probe._cached_response is None
    assert not any("--print=/quota" in call for call in _calls(log))
