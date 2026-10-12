"""Tests for agy_mcp.quota — quota protocol seam, pure parser, runner, and cache."""

from __future__ import annotations

import copy
import io
import json
import os
import signal
import subprocess
import sys
import threading
import time
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from agy_mcp.adapters.agy import AgyAuthSource
from agy_mcp.adapters.base import BaseAdapter
from agy_mcp.models import (
    Capability,
    QuotaBucket,
    QuotaGroup,
    QuotaToolResponse,
)
from agy_mcp.quota import (
    MAX_OUTPUT_BYTES,
    MIN_SUPPORTED_AGY_VERSION,
    QUOTA_COMMAND_TIMEOUT_S,
    QUOTA_PROCESS_DEADLINE_S,
    QuotaParseError,
    QuotaProbe,
    check_slash_commands_disabled,
    is_auth_error,
    is_slash_disabled_error,
    is_version_supported,
    parse_and_validate_utc_timestamp,
    parse_quota_envelope,
    parse_quota_json,
    parse_quota_response,
    parse_version_tuple,
    validate_remaining_fraction,
)
from agy_mcp.safety import SafetyPolicy

# ---------------------------------------------------------------------------
# Synthetic fixtures (derived from observed structure, synthetic values)
# ---------------------------------------------------------------------------


def make_synthetic_quota_data() -> dict:
    """Return a synthetic, valid quota envelope dict."""
    return {
        "status": "SUCCESS",
        "conversation_id": "",
        "num_turns": 0,
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "thinking_tokens": 0,
            "cache_read_tokens": 0,
            "total_tokens": 0,
        },
        "command": {
            "name": "usage",
            "data": {
                "description": "Synthetic quota test description",
                "groups": [
                    {
                        "name": "Synthetic Alpha Models",
                        "description": "Models in Alpha group: Alpha Flash, Alpha Pro",
                        "buckets": [
                            {
                                "id": "alpha-weekly",
                                "name": "Weekly Limit Remaining",
                                "description": "Weekly allowance bucket",
                                "window": "weekly",
                                "remaining_fraction": 0.854321,
                                "reset_time": "2026-10-18T12:00:00Z",
                            },
                            {
                                "id": "alpha-5h",
                                "name": "Five Hour Limit Remaining",
                                "description": "5h smoothing bucket",
                                "window": "5h",
                                "remaining_fraction": 0.991234,
                                "reset_time": "2026-10-12T18:00:00Z",
                            },
                        ],
                    },
                    {
                        "name": "Synthetic Beta Models",
                        "description": "Models in Beta group: Beta-1, Beta-2",
                        "buckets": [
                            {
                                "id": "beta-weekly",
                                "name": "Weekly Limit Remaining",
                                "description": "Weekly exhausted bucket",
                                "window": "weekly",
                                "remaining_fraction": 0.0,
                                "reset_time": "2026-10-13T04:00:00Z",
                            },
                            {
                                "id": "beta-5h",
                                "name": "Five Hour Limit Remaining",
                                "description": "5h disabled limit bucket",
                                "window": "5h",
                                "disabled": True,
                                "remaining_fraction": 1.0,
                            },
                        ],
                    },
                ],
            },
        },
    }


def make_synthetic_quota_json() -> str:
    return json.dumps(make_synthetic_quota_data())


class FakeAdapter(BaseAdapter):
    """Controllable test adapter for QuotaProbe."""

    backend = "agy"

    def __init__(
        self,
        *,
        bin_path: str = "/mock/bin/agy",
        version: str = "1.3.3",
        authenticated: bool = True,
        safety: SafetyPolicy | None = None,
    ) -> None:
        super().__init__(safety=safety)
        self.fake_bin_path = bin_path
        self.fake_version = version
        self.fake_authenticated = authenticated

    def detect(self, *, refresh: bool = False) -> Capability:
        return Capability(
            bin_path=self.fake_bin_path,
            backend="agy",
            version=self.fake_version,
            authenticated=self.fake_authenticated,
            supports_print=True,
            supports_print_timeout=True,
        )

    def _probe(self) -> Capability:
        return self.detect()

    def build_command(self, request, *, log_path=None):
        return [self.fake_bin_path]

    def run(self, request, **kwargs):
        raise NotImplementedError("run is not used by QuotaProbe")


# ---------------------------------------------------------------------------
# 1. Pure Parser & Acceptance Checks
# ---------------------------------------------------------------------------


def test_parse_valid_synthetic_payload():
    raw_json = make_synthetic_quota_json()
    groups = parse_quota_json(raw_json)
    assert len(groups) == 2

    # Group 1
    g1 = groups[0]
    assert g1.name == "Synthetic Alpha Models"
    assert g1.description == "Models in Alpha group: Alpha Flash, Alpha Pro"
    assert len(g1.buckets) == 2

    b1_weekly = g1.buckets[0]
    assert b1_weekly.id == "alpha-weekly"
    assert b1_weekly.window == "weekly"
    assert b1_weekly.disabled is False
    assert b1_weekly.remaining_fraction == pytest.approx(0.854321)
    assert b1_weekly.reset_at == "2026-10-18T12:00:00Z"

    b1_5h = g1.buckets[1]
    assert b1_5h.id == "alpha-5h"
    assert b1_5h.window == "5h"
    assert b1_5h.disabled is False
    assert b1_5h.remaining_fraction == pytest.approx(0.991234)
    assert b1_5h.reset_at == "2026-10-12T18:00:00Z"

    # Group 2
    g2 = groups[1]
    assert g2.name == "Synthetic Beta Models"
    assert len(g2.buckets) == 2

    b2_weekly = g2.buckets[0]
    assert b2_weekly.id == "beta-weekly"
    assert b2_weekly.disabled is False
    # Zero is real exhaustion evidence, preserved
    assert b2_weekly.remaining_fraction == 0.0
    assert b2_weekly.reset_at == "2026-10-13T04:00:00Z"

    # Disabled bucket: fraction normalized to None, reset_at is None
    b2_5h = g2.buckets[1]
    assert b2_5h.id == "beta-5h"
    assert b2_5h.disabled is True
    assert b2_5h.remaining_fraction is None
    assert b2_5h.reset_at is None


def test_parse_quota_response_helper():
    raw_json = make_synthetic_quota_json()
    resp = parse_quota_response(raw_json, cli_version="1.3.3")
    assert resp.success is True
    assert resp.status == "ok"
    assert resp.error is None
    assert resp.cli_version == "1.3.3"
    assert resp.source == "agy:/quota"
    assert resp.cached is False
    assert resp.age_seconds == 0.0
    assert len(resp.groups) == 2
    # Dict-like access
    assert resp["success"] is True
    assert len(resp["groups"]) == 2


def test_parse_preserves_new_upstream_groups_and_windows():
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"] = [
        {
            "name": "Gamma Experimental Group",
            "description": "Novel architecture",
            "buckets": [
                {
                    "id": "gamma-biweekly",
                    "name": "Biweekly Pool",
                    "window": "bi-weekly",
                    "remaining_fraction": 0.5,
                    "reset_time": "2026-10-25T00:00:00Z",
                }
            ],
        }
    ]
    groups = parse_quota_envelope(data)
    assert len(groups) == 1
    assert groups[0].name == "Gamma Experimental Group"
    assert groups[0].buckets[0].window == "bi-weekly"
    assert groups[0].buckets[0].remaining_fraction == 0.5


def test_parse_missing_fraction_and_reset_treated_as_unknown():
    data = make_synthetic_quota_data()
    # Bucket with no fraction and no reset time
    data["command"]["data"]["groups"][0]["buckets"] = [
        {
            "id": "unknown-bucket",
            "name": "Unknown Window",
            "window": "daily",
            # remaining_fraction omitted
            # reset_time omitted
        }
    ]
    groups = parse_quota_envelope(data)
    b = groups[0].buckets[0]
    assert b.remaining_fraction is None
    assert b.reset_at is None
    assert b.disabled is False


def test_parse_empty_groups_and_buckets():
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"] = []
    assert parse_quota_envelope(data) == []

    data["command"]["data"]["groups"] = [
        {
            "name": "Empty Group",
            "description": None,
            "buckets": [],
        }
    ]
    groups = parse_quota_envelope(data)
    assert len(groups) == 1
    assert groups[0].name == "Empty Group"
    assert groups[0].buckets == []


def test_parse_rejects_prose_and_malformed_json():
    with pytest.raises(QuotaParseError, match="malformed JSON"):
        parse_quota_json("Gemini Models Weekly Limit Remaining 95%")
    with pytest.raises(QuotaParseError, match="malformed JSON"):
        parse_quota_json('{"status": "SUCCESS", "conversation_id":')
    with pytest.raises(QuotaParseError, match="quota output is empty"):
        parse_quota_json("   \n\t")
    with pytest.raises(QuotaParseError, match="JSON root must be an object"):
        parse_quota_json("[1, 2, 3]")
    with pytest.raises(QuotaParseError, match="raw_text must be str"):
        parse_quota_json(12345)  # type: ignore[arg-type]


def test_parse_rejects_oversized_output():
    huge = '{"status": "SUCCESS"}' + (" " * (MAX_OUTPUT_BYTES + 1))
    with pytest.raises(QuotaParseError, match="quota output exceeds maximum size"):
        parse_quota_json(huge)


def test_parse_rejects_non_success_status():
    data = make_synthetic_quota_data()
    data["status"] = "FAILED"
    with pytest.raises(QuotaParseError, match="status must be SUCCESS"):
        parse_quota_envelope(data)

    del data["status"]
    with pytest.raises(QuotaParseError, match="status must be SUCCESS"):
        parse_quota_envelope(data)


def test_parse_rejects_nonzero_turns():
    data = make_synthetic_quota_data()
    data["num_turns"] = 1
    with pytest.raises(QuotaParseError, match="num_turns must be 0"):
        parse_quota_envelope(data)


def test_parse_rejects_nonempty_conversation_id():
    data = make_synthetic_quota_data()
    data["conversation_id"] = "12345678-1234-1234-1234-123456789abc"
    with pytest.raises(QuotaParseError, match="conversation_id must be empty"):
        parse_quota_envelope(data)


def test_parse_rejects_nonzero_tokens():
    data = make_synthetic_quota_data()
    data["usage"]["input_tokens"] = 10
    with pytest.raises(QuotaParseError, match="usage counter 'input_tokens' must be 0"):
        parse_quota_envelope(data)

    data = make_synthetic_quota_data()
    data["usage"]["total_tokens"] = 5
    with pytest.raises(QuotaParseError, match="usage counter 'total_tokens' must be 0"):
        parse_quota_envelope(data)


def test_parse_rejects_wrong_command_name():
    data = make_synthetic_quota_data()
    data["command"]["name"] = "chat"
    with pytest.raises(QuotaParseError, match="unexpected command name 'chat'"):
        parse_quota_envelope(data)


def test_parse_rejects_duplicate_fields():
    # Duplicate group name
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"].append(
        copy.deepcopy(data["command"]["data"]["groups"][0])
    )
    with pytest.raises(QuotaParseError, match="duplicate group name"):
        parse_quota_envelope(data)

    # Duplicate bucket id across groups
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"][1]["buckets"][0]["id"] = "alpha-weekly"
    with pytest.raises(QuotaParseError, match="duplicate bucket id"):
        parse_quota_envelope(data)

    # Duplicate window within same group
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"][0]["buckets"][1]["window"] = "weekly"
    with pytest.raises(QuotaParseError, match="duplicate window 'weekly'"):
        parse_quota_envelope(data)


def test_parse_rejects_boolean_as_number():
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"][0]["buckets"][0]["remaining_fraction"] = True
    with pytest.raises(QuotaParseError, match="remaining_fraction must be a number, not bool"):
        parse_quota_envelope(data)

    data = make_synthetic_quota_data()
    data["usage"]["total_tokens"] = False
    with pytest.raises(QuotaParseError, match="usage counter 'total_tokens' must be 0"):
        parse_quota_envelope(data)


def test_parse_rejects_nan_and_infinity():
    assert validate_remaining_fraction(None, disabled=False) is None
    with pytest.raises(ValueError, match="remaining_fraction must be finite"):
        validate_remaining_fraction(float("nan"), disabled=False)
    with pytest.raises(ValueError, match="remaining_fraction must be finite"):
        validate_remaining_fraction(float("inf"), disabled=False)
    with pytest.raises(ValueError, match="remaining_fraction must be finite"):
        validate_remaining_fraction(float("-inf"), disabled=False)


def test_parse_rejects_out_of_range_fractions():
    with pytest.raises(ValueError, match="between 0.0 and 1.0"):
        validate_remaining_fraction(-0.01, disabled=False)
    with pytest.raises(ValueError, match="between 0.0 and 1.0"):
        validate_remaining_fraction(1.0001, disabled=False)
    with pytest.raises(ValueError, match="between 0.0 and 1.0"):
        validate_remaining_fraction(100, disabled=False)


def test_parse_timestamp_timezone_aware_utc():
    # Valid UTC ISO strings
    assert parse_and_validate_utc_timestamp("2026-10-18T12:00:00Z") == "2026-10-18T12:00:00Z"
    assert parse_and_validate_utc_timestamp("2026-10-18T12:00:00+00:00") == "2026-10-18T12:00:00Z"
    # Offset converted to UTC
    assert parse_and_validate_utc_timestamp("2026-10-18T08:00:00-04:00") == "2026-10-18T12:00:00Z"
    # None or empty
    assert parse_and_validate_utc_timestamp(None) is None
    assert parse_and_validate_utc_timestamp("") is None

    # Naive timestamp rejected
    with pytest.raises(ValueError, match="must be timezone-aware UTC, got naive timestamp"):
        parse_and_validate_utc_timestamp("2026-10-18T12:00:00")

    # Non-timestamp strings rejected
    with pytest.raises(ValueError, match="invalid ISO timestamp"):
        parse_and_validate_utc_timestamp("tomorrow")
    with pytest.raises(ValueError, match="timestamp must be a string"):
        parse_and_validate_utc_timestamp(12345)


def test_parse_rejects_contradictory_disabled_state():
    data = make_synthetic_quota_data()
    # Disabled bucket with an active reset timestamp is contradictory
    data["command"]["data"]["groups"][1]["buckets"][1]["disabled"] = True
    data["command"]["data"]["groups"][1]["buckets"][1]["reset_time"] = "2026-10-18T12:00:00Z"
    with pytest.raises(QuotaParseError, match="disabled bucket .* cannot have reset timestamp"):
        parse_quota_envelope(data)

    # Disabled must be boolean
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"][1]["buckets"][1]["disabled"] = "yes"
    with pytest.raises(QuotaParseError, match="disabled must be boolean"):
        parse_quota_envelope(data)


def test_parse_redacts_sensitive_strings_in_descriptions():
    safety = SafetyPolicy()
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"][0]["description"] = (
        "Internal project for /Users/john_doe/.ssh/id_rsa with token AIzaSyD123456789"
    )
    data["command"]["data"]["groups"][0]["buckets"][0]["description"] = (
        "Bucket for secret key sk-ant-api03-abcdef123456"
    )
    groups = parse_quota_envelope(data, safety=safety)
    g_desc = groups[0].description
    b_desc = groups[0].buckets[0].description

    assert "/Users/john_doe/" not in g_desc
    assert "~/" in g_desc or "[REDACTED" in g_desc
    assert "sk-ant-api03" not in b_desc


# ---------------------------------------------------------------------------
# 2. Version Gate & Capability Checks
# ---------------------------------------------------------------------------


def test_version_tuple_parsing():
    assert parse_version_tuple("1.3.3") == (1, 3, 3)
    assert parse_version_tuple("1.1.11") == (1, 1, 11)
    assert parse_version_tuple("1.1.11-beta.1") == (1, 1, 11)
    assert parse_version_tuple("2.0.0+build123") == (2, 0, 0)
    assert parse_version_tuple(None) is None
    assert parse_version_tuple("invalid") is None


def test_version_gate_requirements():
    assert MIN_SUPPORTED_AGY_VERSION == (1, 1, 11)
    assert is_version_supported("1.1.11") is True
    assert is_version_supported("1.2.0") is True
    assert is_version_supported("1.3.3") is True
    assert is_version_supported("2.0.0") is True

    # Older builds must be rejected
    assert is_version_supported("1.1.10") is False
    assert is_version_supported("1.0.0") is False
    assert is_version_supported("0.9.5") is False
    assert is_version_supported(None) is False
    assert is_version_supported("") is False


def test_probe_refuses_unsupported_version_without_executing_command():
    adapter = FakeAdapter(version="1.0.0")
    probe = QuotaProbe(adapter=adapter)

    with patch.object(probe, "_execute_command") as mock_exec:
        resp = probe.get()
        assert mock_exec.call_count == 0

    assert resp.success is False
    assert resp.status == "unsupported"
    assert "minimum 1.1.11 required" in (resp.error or "")
    assert resp.cli_version == "1.0.0"


def test_probe_refuses_missing_binary():
    adapter = FakeAdapter(bin_path="")
    probe = QuotaProbe(adapter=adapter)

    with patch.object(probe, "_execute_command") as mock_exec:
        resp = probe.get()
        assert mock_exec.call_count == 0

    assert resp.success is False
    assert resp.status == "unavailable"
    assert "binary not found" in (resp.error or "")


# ---------------------------------------------------------------------------
# 3. Runner, Fixed Argv, Safety & Error Classification
# ---------------------------------------------------------------------------


def test_fixed_command_argv_and_no_inference_flags():
    adapter = FakeAdapter(bin_path="/custom/path/to/agy", version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    captured_cmds: list[list[str]] = []

    def mock_popen(cmd, *args, **kwargs):
        captured_cmds.append(cmd)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.pid = 12345
        mock_proc.stdout = io.BytesIO(make_synthetic_quota_json().encode())
        mock_proc.stderr = io.BytesIO(b"")
        mock_proc.poll.return_value = 0
        mock_proc.wait.return_value = 0
        return mock_proc

    with patch("subprocess.Popen", side_effect=mock_popen):
        resp = probe.get()

    assert resp.success is True
    assert len(captured_cmds) == 1
    expected_cmd = [
        "/custom/path/to/agy",
        "--print=/quota",
        "--output-format",
        "json",
        "--print-timeout",
        f"{int(QUOTA_COMMAND_TIMEOUT_S)}s",
    ]
    assert captured_cmds[0] == expected_cmd

    # Ensure no inference preamble or session flags leaked into argv
    joined = " ".join(captured_cmds[0])
    for bad_flag in (
        "--mode",
        "--conversation",
        "--continue",
        "--new-project",
        "--model",
        "[System Context]",
        "[User Request]",
    ):
        assert bad_flag not in joined


def test_safety_environment_scrubbing_during_execution():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    passed_env: dict[str, str] = {}

    def mock_popen(cmd, *args, **kwargs):
        passed_env.update(kwargs.get("env", {}))
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.pid = 12345
        mock_proc.stdout = io.BytesIO(make_synthetic_quota_json().encode())
        mock_proc.stderr = io.BytesIO(b"")
        mock_proc.poll.return_value = 0
        mock_proc.wait.return_value = 0
        return mock_proc

    with (
        patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "sk-secret-openai-12345",
                "ANTHROPIC_API_KEY": "sk-ant-secret-67890",
                "NORMAL_VAR": "harmless_value",
            },
            clear=False,
        ),
        patch("subprocess.Popen", side_effect=mock_popen),
    ):
        resp = probe.get()

    assert resp.success is True
    assert passed_env.get("OPENAI_API_KEY") == "***"
    assert passed_env.get("ANTHROPIC_API_KEY") == "***"
    assert "sk-secret-openai-12345" not in passed_env.values()
    assert "sk-ant-secret-67890" not in passed_env.values()
    assert passed_env.get("NORMAL_VAR") == "harmless_value"


def test_fail_closed_on_discovered_slash_disable_env_policy():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    with (
        patch.dict(os.environ, {"AGY_DISABLE_SLASH_COMMANDS": "1"}, clear=False),
        patch.object(probe, "_execute_command") as mock_exec,
    ):
        assert check_slash_commands_disabled() is True
        resp = probe.get()
        assert mock_exec.call_count == 0

    assert resp.success is False
    assert resp.status == "unsupported"
    assert "slash commands disabled by operator policy" in (resp.error or "")


def test_fail_closed_on_discovered_slash_disable_cli_output():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    assert is_slash_disabled_error("Error: slash commands are disabled", "") is True

    with patch.object(
        probe,
        "_execute_command",
        return_value=(1, "", "Error: slash commands are disabled on this enterprise cluster"),
    ):
        resp = probe.get()

    assert resp.success is False
    assert resp.status == "unsupported"
    assert "slash commands disabled by operator policy" in (resp.error or "")


def test_auth_error_exit_classification():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    assert is_auth_error("Print mode: auth error: invalid credentials") is True
    assert is_auth_error("UNAUTHENTICATED (code 16): session expired") is True

    with patch.object(
        probe,
        "_execute_command",
        return_value=(1, "", "Print mode: auth error: token expired; run agy login"),
    ):
        resp = probe.get()

    assert resp.success is False
    assert resp.status == "auth_error"
    assert "authentication failure" in (resp.error or "")


def test_generic_nonzero_exit_classification():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    with patch.object(
        probe,
        "_execute_command",
        return_value=(2, "", "network socket unreachable"),
    ):
        resp = probe.get()

    assert resp.success is False
    assert resp.status == "unavailable"
    assert "exited with code 2" in (resp.error or "")


def test_timeout_and_process_cleanup():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_proc.stdout = io.BytesIO(b"")
    mock_proc.stderr = io.BytesIO(b"")
    mock_proc.poll.return_value = None
    mock_proc.wait.side_effect = subprocess.TimeoutExpired(
        cmd=["agy"], timeout=QUOTA_PROCESS_DEADLINE_S
    )

    with (
        patch("subprocess.Popen", return_value=mock_proc),
        patch("agy_mcp.quota._shutdown_cascade") as mock_cascade,
    ):
        resp = probe.get()

    assert mock_cascade.call_count >= 1
    assert resp.success is False
    assert resp.status == "timeout"
    assert "quota probe timed out" in (resp.error or "")


def test_process_cleanup_on_unexpected_exception():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_proc.stdout = io.BytesIO(b"")
    mock_proc.stderr = io.BytesIO(b"")
    mock_proc.poll.return_value = None
    mock_proc.wait.side_effect = RuntimeError("unexpected pipe failure")

    with (
        patch("subprocess.Popen", return_value=mock_proc),
        patch("agy_mcp.quota._shutdown_cascade") as mock_cascade,
    ):
        resp = probe.get()

    assert mock_cascade.call_count >= 1
    assert resp.success is False
    assert resp.status == "unavailable"


# ---------------------------------------------------------------------------
# 4. Cache, Monotonic TTL, Force Refresh, Coalescing & Invalidation
# ---------------------------------------------------------------------------


def test_cache_hit_within_30s_ttl():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    mock_exec = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    probe._execute_command = mock_exec  # type: ignore[assignment]

    # First call: cache miss
    resp1 = probe.get()
    assert resp1.success is True
    assert resp1.cached is False
    assert resp1.age_seconds == 0.0
    assert mock_exec.call_count == 1

    # Second call within TTL: cache hit
    resp2 = probe.get()
    assert resp2.success is True
    assert resp2.cached is True
    assert resp2.age_seconds >= 0.0
    assert mock_exec.call_count == 1  # Subprocess not called again


def test_cache_expiry_after_30s_monotonic_ttl():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    mock_exec = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    probe._execute_command = mock_exec  # type: ignore[assignment]

    mono_times = [100.0, 110.0, 131.0]

    with patch("time.monotonic", side_effect=lambda: mono_times.pop(0) if mono_times else 200.0):
        resp1 = probe.get()
        assert resp1.cached is False
        assert mock_exec.call_count == 1

        # At t=110s (age=10s): hit
        resp2 = probe.get()
        assert resp2.cached is True
        assert mock_exec.call_count == 1

        # At t=131s (age=31s > 30s): expired, fresh probe
        resp3 = probe.get()
        assert resp3.cached is False
        assert mock_exec.call_count == 2


def test_force_refresh_bypasses_cache():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    mock_exec = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    probe._execute_command = mock_exec  # type: ignore[assignment]

    resp1 = probe.get(force_refresh=False)
    assert resp1.cached is False
    assert mock_exec.call_count == 1

    resp2 = probe.get(force_refresh=True)
    assert resp2.cached is False
    assert mock_exec.call_count == 2


def test_failed_refresh_returns_explicit_failure_never_stale_success():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    # Initial probe succeeds
    mock_exec = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    probe._execute_command = mock_exec  # type: ignore[assignment]

    resp1 = probe.get()
    assert resp1.success is True
    assert resp1.cached is False

    # Force refresh fails with auth error
    mock_exec.return_value = (1, "", "Print mode: auth error: credentials expired")
    resp2 = probe.get(force_refresh=True)

    # MUST NOT return stale success
    assert resp2.success is False
    assert resp2.status == "auth_error"
    assert "authentication failure" in (resp2.error or "")

    # Subsequent normal get must also not return old stale success
    resp3 = probe.get()
    assert resp3.success is False


def test_cache_invalidation_on_binary_or_version_or_auth_change():
    adapter = FakeAdapter(bin_path="/bin/agy1", version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    mock_exec = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    probe._execute_command = mock_exec  # type: ignore[assignment]

    # Baseline call
    resp1 = probe.get()
    assert resp1.cached is False
    assert mock_exec.call_count == 1

    # Same binary & version -> cache hit
    resp2 = probe.get()
    assert resp2.cached is True
    assert mock_exec.call_count == 1

    # Invalidate by binary path change
    adapter.fake_bin_path = "/bin/agy2"
    resp3 = probe.get()
    assert resp3.cached is False
    assert mock_exec.call_count == 2

    # Invalidate by CLI version change
    adapter.fake_version = "1.4.0"
    resp4 = probe.get()
    assert resp4.cached is False
    assert mock_exec.call_count == 3

    # Invalidate by auth-context change
    with patch(
        "agy_mcp.quota.detect_agy_auth_source",
        return_value=AgyAuthSource(kind="oauth_creds", path=MagicMock(exists=lambda: True, stat=lambda: MagicMock(st_mtime=9999))),
    ):
        resp5 = probe.get()
        assert resp5.cached is False
        assert mock_exec.call_count == 4


def test_explicit_cache_invalidation():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    mock_exec = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    probe._execute_command = mock_exec  # type: ignore[assignment]

    probe.get()
    assert mock_exec.call_count == 1

    probe.invalidate()

    resp = probe.get()
    assert resp.cached is False
    assert mock_exec.call_count == 2


def test_single_flight_force_refresh_coalescing():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    exec_started = threading.Event()
    finish_exec = threading.Event()
    call_count = 0
    lock = threading.Lock()

    def slow_exec(bin_path):
        nonlocal call_count
        with lock:
            call_count += 1
        exec_started.set()
        finish_exec.wait(timeout=5.0)
        return (0, make_synthetic_quota_json(), "")

    probe._execute_command = slow_exec  # type: ignore[assignment]

    results: list[QuotaToolResponse] = []

    def worker(force: bool):
        res = probe.get(force_refresh=force)
        results.append(res)

    t1 = threading.Thread(target=worker, args=(True,))
    t1.start()

    exec_started.wait(timeout=2.0)

    # Launch second thread while first thread is in flight
    t2 = threading.Thread(target=worker, args=(True,))
    t2.start()

    time.sleep(0.05)
    finish_exec.set()

    t1.join(timeout=2.0)
    t2.join(timeout=2.0)

    assert len(results) == 2
    assert results[0].success is True
    assert results[1].success is True
    # Coalescing ensured subprocess executed only once
    assert call_count == 1


# ---------------------------------------------------------------------------
# 5. Pydantic Models & Dict-Like Compatibility
# ---------------------------------------------------------------------------


def test_quota_models_strict_extra_forbid():
    with pytest.raises(ValidationError):
        QuotaBucket(
            id="test",
            name="Test",
            window="weekly",
            unknown_field="fail",  # type: ignore[call-arg]
        )

    with pytest.raises(ValidationError):
        QuotaGroup(
            name="Group",
            extra_field="fail",  # type: ignore[call-arg]
        )

    with pytest.raises(ValidationError):
        QuotaToolResponse(
            success=True,
            extra_field="fail",  # type: ignore[call-arg]
        )


def test_quota_tool_response_dict_like_interface():
    resp = QuotaToolResponse(
        success=True,
        status="ok",
        backend="agy",
        cli_version="1.3.3",
        groups=[
            QuotaGroup(
                name="G1",
                buckets=[QuotaBucket(id="b1", name="B1", window="5h", remaining_fraction=0.5)],
            )
        ],
    )
    assert resp["success"] is True
    assert resp["status"] == "ok"
    assert resp.get("backend") == "agy"
    assert resp.get("nonexistent", "default") == "default"
    assert "groups" in resp
    assert "nonexistent" not in resp
    with pytest.raises(KeyError):
        _ = resp["nonexistent"]


# ---------------------------------------------------------------------------
# 6. Promoted Parent Regression Semantics & Protocol Edge Coverage
# ---------------------------------------------------------------------------


def test_missing_usage_is_not_zero_usage():
    data = make_synthetic_quota_data()
    del data["usage"]
    with pytest.raises(QuotaParseError):
        parse_quota_json(json.dumps(data))


def test_empty_usage_dict_is_rejected():
    data = make_synthetic_quota_data()
    data["usage"] = {}
    with pytest.raises(QuotaParseError):
        parse_quota_json(json.dumps(data))


def test_missing_required_token_counter_is_rejected():
    data = make_synthetic_quota_data()
    del data["usage"]["total_tokens"]
    with pytest.raises(QuotaParseError):
        parse_quota_json(json.dumps(data))


def test_explicit_empty_conversation_evidence_required():
    data = make_synthetic_quota_data()
    del data["conversation_id"]
    with pytest.raises(QuotaParseError):
        parse_quota_json(json.dumps(data))

    data2 = make_synthetic_quota_data()
    data2["conversation_id"] = "active-conv-123"
    with pytest.raises(QuotaParseError):
        parse_quota_json(json.dumps(data2))


def test_identity_strings_are_redacted():
    data = make_synthetic_quota_data()
    group = data["command"]["data"]["groups"][0]
    group["name"] = "Authorization: Bearer group_secret"
    bucket = group["buckets"][0]
    bucket.update(
        id="Authorization: Bearer id_secret",
        name="Authorization: Bearer name_secret",
        window="Authorization: Bearer window_secret",
    )
    result = parse_quota_response(json.dumps(data), safety=SafetyPolicy())
    assert result.success
    public = result.model_dump_json()
    for secret in ("group_secret", "id_secret", "name_secret", "window_secret"):
        assert secret not in public


@pytest.mark.parametrize("bad", [True, float("nan"), float("inf"), "unknown", -1, 2])
def test_disabled_bucket_still_validates_raw_fraction(bad):
    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"][1]["buckets"][1]["remaining_fraction"] = bad
    with pytest.raises(QuotaParseError):
        parse_quota_json(json.dumps(data))


def test_duplicate_json_keys_fail_closed():
    raw = json.dumps(make_synthetic_quota_data()).replace(
        '"status": "SUCCESS"', '"status": "FAILED", "status": "SUCCESS"', 1
    )
    with pytest.raises(QuotaParseError):
        parse_quota_json(raw)


def test_capture_is_bounded_on_both_streams(tmp_path, monkeypatch):
    import agy_mcp.quota as quota_mod

    monkeypatch.setattr(quota_mod, "MAX_OUTPUT_BYTES", 1024)
    binary = tmp_path / "synthetic-agy"
    binary.write_text(
        f"#!{sys.executable}\nimport sys\nsys.stdout.write('x'*65536)\nsys.stderr.write('y'*65536)\n"
    )
    binary.chmod(0o700)
    probe = QuotaProbe(FakeAdapter())
    _, stdout, stderr = probe._execute_command(str(binary))
    assert len(stdout.encode()) <= 1024
    assert len(stderr.encode()) <= 1024


@pytest.mark.skipif(os.name != "posix", reason="POSIX descendant lifecycle check")
def test_successful_leader_exit_does_not_leave_live_descendant(tmp_path):
    pidfile = tmp_path / "child.pid"
    binary = tmp_path / "synthetic-agy"
    binary.write_text(
        f'#!{sys.executable}\nimport subprocess,sys,pathlib\np=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\npathlib.Path({str(pidfile)!r}).write_text(str(p.pid))\nprint("synthetic-success")\n'
    )
    binary.chmod(0o700)
    probe = QuotaProbe(FakeAdapter())
    try:
        code, _, _ = probe._execute_command(str(binary))
        assert code == 0
        child_pid = int(pidfile.read_text())
        try:
            state = (
                subprocess.run(
                    ["ps", "-o", "stat=", "-p", str(child_pid)],
                    capture_output=True,
                    text=True,
                )
                .stdout.strip()
            )
            assert not state or state.startswith("Z"), f"owned descendant still live: {child_pid}, {state}"
        except (PermissionError, OSError):
            # In sandbox environments where ps binary invocation is restricted,
            # verify process termination directly via signal probing.
            time.sleep(0.1)
            try:
                os.kill(child_pid, 0)
                # If kill succeeded, verify it is not lingering
                time.sleep(0.2)
                with pytest.raises(ProcessLookupError):
                    os.kill(child_pid, 0)
            except ProcessLookupError:
                pass
    finally:
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_policy_change_cannot_return_cached_success(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: "stable")
    monkeypatch.setattr(probe, "_run_probe", lambda key: QuotaToolResponse(success=True))
    assert probe.get().success
    monkeypatch.setenv("AGY_DISABLE_SLASH_COMMANDS", "1")
    result = probe.get()
    assert not result.success and result.status == "unsupported"


def test_auth_change_during_flight_never_returns_previous_context(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    context = ["old"]
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: context[0])
    entered, release = threading.Event(), threading.Event()
    calls, results = [], {}

    def run(key):
        calls.append(key[2])
        if key[2] == "old":
            entered.set()
            assert release.wait(5)
        return QuotaToolResponse(success=True, groups=[QuotaGroup(name=key[2])])

    monkeypatch.setattr(probe, "_run_probe", run)
    first = threading.Thread(target=lambda: results.update(old=probe.get()))
    second = threading.Thread(target=lambda: results.update(new=probe.get(force_refresh=True)))
    first.start()
    assert entered.wait(5)
    context[0] = "new"
    second.start()
    release.set()
    first.join(5)
    second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert results["new"].groups[0].name == "new"
    assert calls == ["old", "new"]


def test_unknown_version_suffix_not_a_supported_release():
    assert not is_version_supported("1.3.3 unrecognized-version-format")
    assert not is_version_supported("1.3.3-unknown-suffix")


def test_caller_mutation_does_not_corrupt_cache():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)
    probe._execute_command = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))  # type: ignore[assignment]

    resp1 = probe.get()
    assert len(resp1.groups) == 2
    # Caller mutates groups list
    resp1.groups.clear()
    assert len(resp1.groups) == 0

    # Second call gets from cache
    resp2 = probe.get()
    assert resp2.cached is True
    # Cached copy in probe remains intact
    assert len(resp2.groups) == 2


def test_undetected_auth_attempts_probe_and_classifies_cli_failure():
    adapter = FakeAdapter(version="1.3.3", authenticated=False)
    probe = QuotaProbe(adapter=adapter)

    with patch.object(
        probe, "_execute_command", return_value=(1, "", "auth error: credentials unavailable")
    ) as mock_exec:
        resp = probe.get()
        mock_exec.assert_called_once_with(adapter.fake_bin_path)

    assert resp.success is False
    assert resp.status == "auth_error"
    assert "authentication failure" in (resp.error or "")


def test_cache_key_exception_returns_typed_failure():
    adapter = FakeAdapter(version="1.3.3")
    probe = QuotaProbe(adapter=adapter)

    def failing_detect(*args, **kwargs):
        raise RuntimeError("adapter detection hardware fault")

    adapter.detect = failing_detect  # type: ignore[assignment]
    resp = probe.get()
    assert resp.success is False
    assert resp.status == "unavailable"
    assert "failed to determine cache key" in (resp.error or "")


def test_in_flight_timeout_returns_typed_failure(monkeypatch):
    import agy_mcp.quota as quota_mod

    probe = QuotaProbe(FakeAdapter())
    blocker = threading.Event()

    def hang_probe(key):
        blocker.wait(timeout=10.0)
        return QuotaToolResponse(success=True)

    monkeypatch.setattr(probe, "_run_probe", hang_probe)
    monkeypatch.setattr(quota_mod, "_refresh_wait_budget_s", lambda: 0.1)

    results: list[QuotaToolResponse] = []

    t1 = threading.Thread(target=lambda: results.append(probe.get()))
    t2 = threading.Thread(target=lambda: results.append(probe.get()))

    t1.start()
    time.sleep(0.05)
    t2.start()

    t2.join(timeout=3.0)
    blocker.set()
    t1.join(timeout=3.0)
    t2.join(timeout=3.0)

    assert not t1.is_alive() and not t2.is_alive()
    assert any(r.status == "timeout" for r in results)

# ---------------------------------------------------------------------------
# 7. Deadline / byte-overflow / context lifecycle regressions
# ---------------------------------------------------------------------------


def test_json_parser_caps_utf8_bytes_not_characters(monkeypatch):
    import agy_mcp.quota as quota

    data = make_synthetic_quota_data()
    data["command"]["data"]["groups"][0]["name"] = "群" * 100
    raw = json.dumps(data, ensure_ascii=False)
    monkeypatch.setattr(quota, "MAX_OUTPUT_BYTES", len(raw) + 1)
    with pytest.raises(QuotaParseError, match="bytes"):
        parse_quota_json(raw)


def test_null_conversation_is_not_explicit_empty_evidence():
    data = make_synthetic_quota_data()
    data["conversation_id"] = None
    with pytest.raises(QuotaParseError, match="conversation_id must be empty"):
        parse_quota_json(json.dumps(data))


@pytest.mark.parametrize("version", ["1.1.11-rc", "1.1.11-beta.1", "1.1.11-dev+build"])
def test_introduction_prerelease_never_executes_quota(version):
    probe = QuotaProbe(FakeAdapter(version=version))
    with patch.object(probe, "_execute_command") as execute:
        assert probe.get().status == "unsupported"
        execute.assert_not_called()


def test_supported_version_build_metadata_and_later_prerelease():
    assert is_version_supported("1.1.11+build")
    assert is_version_supported("1.2.0-rc.1")


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic executable")
@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_any_stream_overflow_rejects_valid_json_prefix(tmp_path, monkeypatch, stream):
    import agy_mcp.quota as quota

    raw = make_synthetic_quota_json()
    monkeypatch.setattr(quota, "MAX_OUTPUT_BYTES", len(raw.encode()) + 32)
    binary = tmp_path / "synthetic-agy"
    binary.write_text(
        f"#!{sys.executable}\nimport sys\nsys.stdout.write({raw!r})\n"
        f"sys.{stream}.write(' '*65536)\n"
    )
    binary.chmod(0o700)
    probe = QuotaProbe(FakeAdapter(bin_path=str(binary)))
    result = probe.get()
    assert result.status == "invalid_response" and not result.success
    assert "exceeds maximum size" in result.error
    assert probe._cached_response is None


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic executable")
def test_exact_byte_cap_is_not_overflow(tmp_path, monkeypatch):
    import agy_mcp.quota as quota

    raw = make_synthetic_quota_json()
    monkeypatch.setattr(quota, "MAX_OUTPUT_BYTES", len(raw.encode()))
    binary = tmp_path / "synthetic-agy"
    binary.write_text(f"#!{sys.executable}\nimport sys\nsys.stdout.write({raw!r})\n")
    binary.chmod(0o700)
    assert QuotaProbe(FakeAdapter(bin_path=str(binary))).get().success


@pytest.mark.skipif(os.name != "posix", reason="POSIX controlled process-group containment")
def test_silent_real_process_timeout_is_bounded_and_reaped(tmp_path):
    pidfile = tmp_path / "cli.pid"
    binary = tmp_path / "synthetic-agy"
    binary.write_text(
        f"#!{sys.executable}\nimport os,pathlib,time\n"
        f"pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid()))\ntime.sleep(60)\n"
    )
    binary.chmod(0o700)
    code = (
        "import agy_mcp.quota as q; q.QUOTA_PROCESS_DEADLINE_S=0.2; "
        f"r=q.QuotaProbe()._execute_command({str(binary)!r}); "
        'assert r[0] == -1 and "timeout" in r[2]; print("bounded timeout")'
    )
    runner = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = runner.communicate(timeout=4)
        assert runner.returncode == 0, (out, err)
        assert b"bounded timeout" in out
        with pytest.raises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)
    finally:
        if runner.poll() is None:
            os.killpg(runner.pid, signal.SIGKILL)
        runner.communicate(timeout=2)
        if pidfile.exists():
            try:
                os.killpg(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(os.name != "posix", reason="POSIX owned process group")
@pytest.mark.parametrize("outcome", ["success", "nonzero", "invalid", "timeout", "wait_error"])
def test_owned_descendants_with_inherited_pipes_die_on_all_exits(tmp_path, monkeypatch, outcome):
    import agy_mcp.quota as quota

    pidfile = tmp_path / "child.pid"
    binary = tmp_path / "synthetic-agy"
    # The child ignores TERM and holds both pipes open. Kill must target the
    # saved group even after a successfully reaped leader, then readers drain.
    child_code = (
        "import os,pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        f"pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    tail = {
        "success": f"print({make_synthetic_quota_json()!r})",
        "nonzero": "sys.exit(2)",
        "invalid": "print('not json')",
        "timeout": "time.sleep(60)",
        "wait_error": "time.sleep(60)",
    }[outcome]
    binary.write_text(
        f"#!{sys.executable}\nimport subprocess,sys,pathlib,time\n"
        f"subprocess.Popen([sys.executable,'-c',{child_code!r}])\n"
        f"while not pathlib.Path({str(pidfile)!r}).exists(): time.sleep(0.005)\n{tail}\n"
    )
    binary.chmod(0o700)
    monkeypatch.setattr(quota, "QUOTA_PROCESS_DEADLINE_S", 0.5)
    probe = QuotaProbe(FakeAdapter(bin_path=str(binary)))
    original_wait = subprocess.Popen.wait
    raised = False

    def fail_first_wait(proc, *args, **kwargs):
        nonlocal raised
        if not raised:
            raised = True
            deadline = time.monotonic() + 2
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.005)
            raise RuntimeError("synthetic wait failure")
        return original_wait(proc, *args, **kwargs)

    if outcome == "wait_error":
        monkeypatch.setattr(subprocess.Popen, "wait", fail_first_wait)
    before_threads = set(threading.enumerate())
    started = time.monotonic()
    try:
        result = probe.get()
        assert time.monotonic() - started < 3
        expected = {
            "success": "ok",
            "nonzero": "unavailable",
            "invalid": "invalid_response",
            "timeout": "timeout",
            "wait_error": "unavailable",
        }[outcome]
        assert result.status == expected
        assert pidfile.exists()
        state = subprocess.run(
            ["ps", "-o", "stat=", "-p", pidfile.read_text()],
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert not state or state.startswith("Z"), state
        assert set(threading.enumerate()) <= before_threads
    finally:
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(os.name != "posix", reason="POSIX pipe abandonment bounds")
def test_escaped_descendant_pipe_fails_visibly_without_stuck_reader(tmp_path):
    pidfile = tmp_path / "escaped.pid"
    binary = tmp_path / "synthetic-agy"
    child_code = (
        "import os,pathlib,time; "
        f"pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    binary.write_text(
        f"#!{sys.executable}\nimport subprocess,sys,pathlib,time\n"
        f"subprocess.Popen([sys.executable,'-c',{child_code!r}],start_new_session=True)\n"
        f"while not pathlib.Path({str(pidfile)!r}).exists(): time.sleep(0.005)\n"
        f"print({make_synthetic_quota_json()!r})\n"
    )
    binary.chmod(0o700)
    before_threads = set(threading.enumerate())
    started = time.monotonic()
    try:
        response = QuotaProbe(FakeAdapter(bin_path=str(binary))).get()
        assert not response.success and response.status == "invalid_response"
        assert "capture did not complete" in response.error
        assert time.monotonic() - started < 3
        assert set(threading.enumerate()) <= before_threads
    finally:
        if pidfile.exists():
            try:
                os.killpg(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(os.name != "posix", reason="POSIX PGID safety")
@pytest.mark.parametrize("pgid", [None, 0, 1, -1, "caller", "mismatch"])
def test_cleanup_never_signals_unowned_group(monkeypatch, pgid):
    import agy_mcp.quota as quota

    proc = MagicMock(pid=12345)
    proc.poll.return_value = 0
    if pgid == "caller":
        pgid = os.getpgrp()
    elif pgid == "mismatch":
        pgid = 12346
    with patch.object(quota.os, "killpg") as killpg:
        quota._cleanup_owned_process(proc, pgid)
    killpg.assert_not_called()


@pytest.mark.parametrize("stage", ["pure_parse", "probe_parse", "execution", "detection"])
def test_errors_redact_before_truncation_and_are_bounded(monkeypatch, stage):
    secret = "PEM_SENTINEL_" * 400
    text = f"-----BEGIN PRIVATE KEY-----\n{secret}\n-----END PRIVATE KEY-----"
    if stage == "pure_parse":
        data = make_synthetic_quota_data()
        data["status"] = text
        response = parse_quota_response(json.dumps(data), safety=SafetyPolicy())
    else:
        probe = QuotaProbe(FakeAdapter())
        if stage == "probe_parse":
            data = make_synthetic_quota_data()
            data["status"] = text
            monkeypatch.setattr(probe, "_execute_command", lambda path: (0, json.dumps(data), ""))
        elif stage == "execution":
            monkeypatch.setattr(probe, "_execute_command", lambda path: (2, "", text))
        else:

            def detect(**kwargs):
                raise RuntimeError(text)

            monkeypatch.setattr(probe.adapter, "detect", detect)
        response = probe.get()
    assert not response.success
    assert "PEM_SENTINEL" not in response.error
    assert len(response.error) <= 2048


@pytest.mark.parametrize("bad", [True, False, "0.5", float("nan"), 2])
def test_quota_bucket_validates_fraction_before_pydantic_coercion(bad):
    with pytest.raises(ValidationError):
        QuotaBucket(id="x", name="x", window="weekly", remaining_fraction=bad)


def test_quota_environment_disables_updates_and_scrubs_extra_names(monkeypatch):
    from agy_mcp.config import SafetyConfig

    safety = SafetyPolicy(config=SafetyConfig(scrub_extra_env=["LOCAL_SENTINEL"]))
    probe = QuotaProbe(FakeAdapter(), safety)
    monkeypatch.setenv("LOCAL_SENTINEL", "private-value")
    monkeypatch.setenv("AGY_CLI_DISABLE_AUTO_UPDATE", "0")
    proc = MagicMock(pid=12345)
    proc.poll.return_value = 0
    proc.returncode = 0
    proc.stdout = io.BytesIO(make_synthetic_quota_json().encode())
    proc.stderr = io.BytesIO(b"")
    with patch("subprocess.Popen", return_value=proc) as popen:
        assert probe.get().success
    assert popen.call_count == 1
    kwargs = popen.call_args.kwargs
    assert kwargs["env"]["AGY_CLI_DISABLE_AUTO_UPDATE"] == "1"
    assert kwargs["env"]["LOCAL_SENTINEL"] == "***"
    assert kwargs["stdin"] == subprocess.DEVNULL


def test_binary_replacement_redetects_before_unsupported_execution(tmp_path, monkeypatch):
    class CachedAdapter(FakeAdapter):
        def __init__(self, path):
            super().__init__(bin_path=str(path))
            self.cap = None
            self.refreshes = 0

        def detect(self, *, refresh=False):
            if refresh or self.cap is None:
                self.refreshes += 1
                self.cap = super().detect()
            return self.cap

    binary = tmp_path / "synthetic-agy"
    binary.write_text("supported predecessor")
    adapter = CachedAdapter(binary)
    probe = QuotaProbe(adapter)
    execute = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    monkeypatch.setattr(probe, "_execute_command", execute)
    assert probe.get().success
    adapter.fake_version = "1.0.0"
    binary.write_text("unsupported replacement with changed size")
    result = probe.get()
    assert not result.success and result.status == "unsupported"
    assert execute.call_count == 1
    assert adapter.refreshes == 2


def test_pre_execution_context_change_never_spawns(monkeypatch):
    adapter = FakeAdapter()
    probe = QuotaProbe(adapter)
    key = probe._get_cache_key()
    adapter.fake_version = "1.0.0"
    with patch.object(probe, "_execute_command") as execute:
        assert not probe._run_probe(key).success
    execute.assert_not_called()


@pytest.mark.parametrize("change", ["invalidate", "auth", "policy", "binary", "safety"])
def test_in_flight_context_changes_cannot_republish_success(monkeypatch, change):
    probe = QuotaProbe(FakeAdapter())
    context = ["old"]
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: context[0])
    entered, release = threading.Event(), threading.Event()
    results = []

    def run(key):
        entered.set()
        assert release.wait(5)
        return QuotaToolResponse(success=True)

    monkeypatch.setattr(probe, "_run_probe", run)
    leader = threading.Thread(target=lambda: results.append(probe.get()))
    leader.start()
    try:
        assert entered.wait(2)
        if change == "invalidate":
            probe.invalidate()
        elif change == "auth":
            context[0] = "new"
        elif change == "policy":
            monkeypatch.setenv("AGY_DISABLE_SLASH_COMMANDS", "1")
        elif change == "binary":
            probe.adapter.fake_bin_path = "/different/agy"
        else:
            probe.safety.config.redact_extra_patterns.append("SENTINEL")
    finally:
        release.set()
        leader.join(3)
    assert not leader.is_alive()
    assert len(results) == 1 and not results[0].success
    assert probe._cached_response is None
    assert not probe._in_flight_map


def test_normal_waiter_joins_failed_refresh_instead_of_stale_cache(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(probe, "_run_probe", lambda key: QuotaToolResponse(success=True))
    assert probe.get().success
    entered, release = threading.Event(), threading.Event()

    def fail(key):
        entered.set()
        assert release.wait(5)
        return QuotaToolResponse(success=False, status="auth_error")

    monkeypatch.setattr(probe, "_run_probe", fail)
    results = []
    leader = threading.Thread(target=lambda: results.append(probe.get(force_refresh=True)))
    waiter = threading.Thread(target=lambda: results.append(probe.get()))
    leader.start()
    assert entered.wait(2)
    waiter.start()
    time.sleep(0.05)
    release.set()
    leader.join(3)
    waiter.join(3)
    assert not leader.is_alive() and not waiter.is_alive()
    assert len(results) == 2 and all(r.status == "auth_error" for r in results)


def test_distinct_contexts_are_serialized_with_one_flight(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    context = ["old"]
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: context[0])
    entered, release = threading.Event(), threading.Event()
    calls, results = [], []

    def run(key):
        calls.append(key[2])
        if key[2] == "old":
            entered.set()
            assert release.wait(5)
        return QuotaToolResponse(success=True, groups=[QuotaGroup(name=key[2])])

    monkeypatch.setattr(probe, "_run_probe", run)
    leader = threading.Thread(target=lambda: results.append(probe.get()))
    waiters = [
        threading.Thread(target=lambda: results.append(probe.get(force_refresh=True)))
        for _ in range(4)
    ]
    leader.start()
    assert entered.wait(2)
    context[0] = "new"
    for waiter in waiters:
        waiter.start()
    time.sleep(0.05)
    assert calls == ["old"] and len(probe._in_flight_map) == 1
    release.set()
    leader.join(3)
    for waiter in waiters:
        waiter.join(3)
        assert not waiter.is_alive()
    assert not leader.is_alive()
    assert len(results) == 5
    assert not probe._in_flight_map
    assert all(not r.success or r.groups[0].name == "new" for r in results)


def test_interrupted_leader_always_resolves_waiter(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    entered, release = threading.Event(), threading.Event()
    results, interrupts = [], []

    def interrupt(key):
        entered.set()
        assert release.wait(5)
        raise KeyboardInterrupt("synthetic interrupt")

    def lead():
        try:
            probe.get()
        except KeyboardInterrupt:
            interrupts.append(True)

    monkeypatch.setattr(probe, "_run_probe", interrupt)
    leader = threading.Thread(target=lead)
    waiter = threading.Thread(target=lambda: results.append(probe.get(force_refresh=True)))
    leader.start()
    assert entered.wait(2)
    waiter.start()
    time.sleep(0.05)
    release.set()
    leader.join(3)
    waiter.join(3)
    assert not leader.is_alive() and not waiter.is_alive()
    assert interrupts == [True]
    assert len(results) == 1 and not results[0].success
    assert not probe._in_flight_map


def test_detection_lock_timeout_is_a_typed_failure(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    lock = MagicMock()
    lock.acquire.return_value = False
    monkeypatch.setattr(probe, "_detect_lock", lock)
    result = probe.get()
    assert not result.success and result.status == "unavailable"
    assert "timed out waiting for quota capability detection" in result.error
    lock.release.assert_not_called()


def test_wrong_backend_never_executes_quota(monkeypatch):
    adapter = FakeAdapter()
    adapter.backend = "gemini"
    probe = QuotaProbe(adapter)
    with patch.object(probe, "_execute_command") as execute:
        assert probe.get().status == "unsupported"
    execute.assert_not_called()


@pytest.mark.parametrize("disabled", [True, False])
def test_reset_alias_cannot_hide_contradictory_timestamp(disabled):
    data = make_synthetic_quota_data()
    bucket = data["command"]["data"]["groups"][0]["buckets"][0]
    bucket.update(disabled=disabled, reset_time=None, reset_at="2026-10-18T12:00:00Z")
    with pytest.raises(QuotaParseError):
        parse_quota_envelope(data)


def test_equivalent_reset_aliases_remain_valid():
    data = make_synthetic_quota_data()
    bucket = data["command"]["data"]["groups"][0]["buckets"][0]
    bucket["reset_at"] = "2026-10-18T12:00:00+00:00"
    assert parse_quota_envelope(data)[0].buckets[0].reset_at == "2026-10-18T12:00:00Z"


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic executable")
@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_invalid_utf8_capture_fails_visibly(tmp_path, stream):
    binary = tmp_path / "synthetic-agy"
    binary.write_text(
        f"#!{sys.executable}\nimport sys\nsys.stdout.write({make_synthetic_quota_json()!r})\n"
        f"sys.{stream}.buffer.write(b'\\xff')\n"
    )
    binary.chmod(0o700)
    result = QuotaProbe(FakeAdapter(bin_path=str(binary))).get()
    assert not result.success and result.status == "invalid_response"
    assert "UTF-8" in result.error


def test_auth_metadata_change_refreshes_cached_authenticated_capability(monkeypatch):
    class CachedAuthAdapter(FakeAdapter):
        def __init__(self):
            super().__init__()
            self.cap = None

        def detect(self, *, refresh=False):
            if refresh or self.cap is None:
                self.cap = super().detect()
            return self.cap

    context = ["authenticated"]
    adapter = CachedAuthAdapter()
    probe = QuotaProbe(adapter)
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: context[0])
    execute = MagicMock(return_value=(0, make_synthetic_quota_json(), ""))
    monkeypatch.setattr(probe, "_execute_command", execute)
    assert probe.get().success
    context[0] = "none"
    adapter.fake_authenticated = False
    # Local evidence disappearing invalidates the cache, not CLI credentials.
    # Only the actual command's failure establishes an auth error.
    execute.return_value = (1, "", "auth error: credentials expired")
    assert probe.get().status == "auth_error"
    assert adapter.cap.authenticated is False
    assert execute.call_count == 2


def test_execution_exception_keeps_bounded_redacted_error_and_releases_flight(monkeypatch):
    probe = QuotaProbe(FakeAdapter())

    def execute(path):
        raise RuntimeError("Authorization: Bearer EXECUTION_SECRET")

    monkeypatch.setattr(probe, "_execute_command", execute)
    result = probe.get()
    assert not result.success and result.status == "unavailable"
    assert "unexpected probe execution error" in result.error
    assert "EXECUTION_SECRET" not in result.error
    assert len(result.error) <= 2048
    assert not probe._in_flight_map


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic adapter executable")
def test_real_agy_adapter_rejects_replaced_unsupported_binary(tmp_path, monkeypatch):
    from agy_mcp.adapters import agy

    binary, marker = tmp_path / "synthetic-agy", tmp_path / "quota-invoked"

    def install(version):
        binary.write_text(
            f"#!{sys.executable}\nimport sys,pathlib\n"
            "if '--help' in sys.argv: print('--print --print-timeout')\n"
            f"elif '--version' in sys.argv: print({version!r})\n"
            "else:\n"
            f"    pathlib.Path({str(marker)!r}).write_text('quota invoked')\n"
            f"    print({make_synthetic_quota_json()!r})\n"
        )
        binary.chmod(0o700)

    monkeypatch.setattr(agy, "detect_agy_auth_source", lambda: MagicMock())
    monkeypatch.setattr(agy, "detect_agy_account_issue", lambda: None)
    adapter = agy.AgyPrintBackend(bin_override=str(binary))
    monkeypatch.setattr(adapter, "_discover_model", lambda: None)
    probe = QuotaProbe(adapter)
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: "synthetic-stable")
    install("1.3.3")
    assert probe.get().success and marker.exists()
    marker.unlink()
    install("1.0.0+unsupported-replacement")
    result = probe.get()
    assert not result.success and result.status == "unsupported"
    assert not marker.exists()


def test_signal_exit_is_not_confused_with_capture_failure(monkeypatch):
    probe = QuotaProbe(FakeAdapter())
    monkeypatch.setattr(probe, "_execute_command", lambda path: (-2, "", "interrupted"))
    result = probe.get()
    assert not result.success and result.status == "unavailable"
    assert "exited with code -2" in result.error


# Actual capability children must share the quota runner's safety envelope.

def make_synthetic_detection_probe(
    tmp_path, monkeypatch, *, special="", adapter_safety=None, probe_safety=None,
    default_adapter=False,
):
    from agy_mcp.adapters import agy

    marker = tmp_path / "synthetic-auth-presence"
    marker.write_text("synthetic presence only")
    monkeypatch.setattr(
        agy, "detect_agy_auth_source",
        lambda: AgyAuthSource(kind="oauth_creds", path=marker),
    )
    monkeypatch.setattr(agy, "detect_agy_account_issue", lambda: None)
    monkeypatch.setattr(agy.AgyPrintBackend, "_discover_model", staticmethod(lambda: None))
    log, binary = tmp_path / "metadata-argv.jsonl", tmp_path / "synthetic-agy"
    binary.write_text(
        f"#!{sys.executable}\nimport sys,json,os,pathlib,subprocess,time\n"
        "a=sys.argv[1:]\n"
        f"with pathlib.Path({str(log)!r}).open('a') as f:\n"
        "    f.write(json.dumps({'argv':a,'sentinel_present':'LOCAL_SENTINEL' in os.environ,"
        "'auto_update':os.environ.get('AGY_CLI_DISABLE_AUTO_UPDATE')})+'\\n')\n"
        f"{special}\n"
        "if '--help' in a: print('Antigravity version: 1.3.3\\nUsage: --print --output-format --print-timeout')\n"
        "elif '--version' in a: print('1.3.3')\n"
        f"else: print({make_synthetic_quota_json()!r})\n"
    )
    binary.chmod(0o700)
    if default_adapter:
        probe = QuotaProbe(safety=probe_safety)
        probe.adapter.bin_override = str(binary)
    else:
        adapter = agy.AgyPrintBackend(bin_override=str(binary), safety=adapter_safety)
        probe = QuotaProbe(adapter, probe_safety)
    monkeypatch.setattr(probe, "_detect_auth_context", lambda: "synthetic")
    return probe, log


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic detection executable")
@pytest.mark.parametrize("flag", ["--help", "--version"])
@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_detection_stream_overflow_never_authorizes_quota(tmp_path, monkeypatch, flag, stream):
    from agy_mcp import probe_process

    special = (
        f"if {flag!r} in a:\n"
        "    sys.stdout.write('Antigravity version: 1.3.3\\nUsage: --print\\n')\n"
        f"    sys.{stream}.write(' '*{probe_process.MAX_PROBE_OUTPUT_BYTES + 8192})\n"
        "    raise SystemExit(0)"
    )
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    response = probe.get()
    assert not response.success and response.error
    assert probe._cached_response is None
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert not any("--print=/quota" in call for call in calls)
    cap = probe.adapter.detect()
    assert cap.version is None
    # Help capture failure authorizes nothing. Version capture failure must
    # block quota, but retain valid help capabilities for ordinary inference.
    assert cap.supports_print is (flag == "--version")
    assert any("exceeds maximum size" in warning for warning in cap.warnings)


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic detection executable")
@pytest.mark.parametrize("flag", ["--help", "--version"])
def test_detection_invalid_utf8_never_uses_valid_counterpart(tmp_path, monkeypatch, flag):
    special = (
        f"if {flag!r} in a:\n"
        "    sys.stdout.buffer.write(b'\\xff')\n"
        "    raise SystemExit(0)"
    )
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    assert not probe.get().success
    calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert not any("--print=/quota" in call for call in calls)
    assert any("UTF-8" in warning for warning in probe.adapter.detect().warnings)


@pytest.mark.skipif(os.name != "posix", reason="POSIX owned detection process group")
@pytest.mark.parametrize("flag", ["--help", "--version"])
@pytest.mark.parametrize("mode", ["detached-pipes", "inherited-pipes", "timeout"])
def test_detection_owned_children_die_after_exit_or_silent_timeout(tmp_path, monkeypatch, flag, mode):
    from agy_mcp.adapters import agy

    pidfile = tmp_path / "metadata-child.pid"
    child_code = (
        "import os,pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        f"pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    detached = (
        ",stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL"
        if mode == "detached-pipes" else ""
    )
    special = (
        f"if {flag!r} in a:\n"
        f"    subprocess.Popen([sys.executable,'-c',{child_code!r}]{detached})\n"
        f"    while not pathlib.Path({str(pidfile)!r}).exists(): time.sleep(0.005)\n"
    )
    if mode == "timeout":
        special += "    time.sleep(60)\n"
        monkeypatch.setattr(
            agy, "AGY_HELP_TIMEOUT_S" if flag == "--help" else "AGY_VERSION_TIMEOUT_S", 0.5,
        )
    probe, log = make_synthetic_detection_probe(tmp_path, monkeypatch, special=special)
    before_threads, started = set(threading.enumerate()), time.monotonic()
    try:
        response = probe.get()
        assert time.monotonic() - started < 3
        assert response.success is (mode != "timeout")
        calls = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
        if mode == "timeout":
            assert not any("--print=/quota" in call for call in calls)
            assert any("timed out" in warning for warning in probe.adapter.detect().warnings)
        state = subprocess.run(
            ["ps", "-p", pidfile.read_text(), "-o", "stat="], capture_output=True, text=True,
        ).stdout.strip()
        assert not state or state.startswith("Z"), state
        assert set(threading.enumerate()) <= before_threads
    finally:
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic detection executable")
@pytest.mark.parametrize("policies", ["same", "equivalent", "default-adapter"])
def test_detection_children_omit_extra_scrub_names_and_disable_updates(tmp_path, monkeypatch, policies):
    from agy_mcp.config import SafetyConfig

    monkeypatch.setenv("LOCAL_SENTINEL", "synthetic-private-value")
    monkeypatch.setenv("AGY_CLI_DISABLE_AUTO_UPDATE", "0")
    adapter_policy = SafetyPolicy(config=SafetyConfig(scrub_extra_env=["LOCAL_SENTINEL"]))
    probe_policy = adapter_policy
    if policies == "equivalent":
        probe_policy = SafetyPolicy(config=SafetyConfig(scrub_extra_env=["local_sentinel", "LOCAL_SENTINEL"]))
    probe, log = make_synthetic_detection_probe(
        tmp_path, monkeypatch, adapter_safety=adapter_policy, probe_safety=probe_policy,
        default_adapter=policies == "default-adapter",
    )
    original_adapter_policy = probe.adapter.safety
    assert probe.get().success
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    for flag in ("--help", "--version"):
        found = [entry for entry in calls if flag in entry["argv"]]
        assert found and all(not entry["sentinel_present"] for entry in found)
    assert all(entry["auto_update"] == "1" for entry in calls)
    assert probe.adapter.safety is original_adapter_policy
    assert os.environ["LOCAL_SENTINEL"] == "synthetic-private-value"
    assert os.environ["AGY_CLI_DISABLE_AUTO_UPDATE"] == "0"


@pytest.mark.parametrize("field", ["scrub_extra_env", "redact_extra_patterns"])
def test_incompatible_explicit_safety_fails_before_detection_without_adapter_mutation(field):
    from agy_mcp.adapters.agy import AgyPrintBackend
    from agy_mcp.config import SafetyConfig

    adapter_policy = SafetyPolicy()
    probe_policy = SafetyPolicy(config=SafetyConfig(**{field: ["POLICY_SENTINEL"]}))
    adapter = AgyPrintBackend(bin_override="/never-invoked/agy", safety=adapter_policy)
    probe = QuotaProbe(adapter, probe_policy)
    with patch.object(adapter, "detect") as detect, patch("subprocess.Popen") as popen:
        response = probe.get()
    assert not response.success and response.status == "unavailable"
    assert "safety policies are incompatible" in response.error
    assert "POLICY_SENTINEL" not in response.model_dump_json()
    detect.assert_not_called()
    popen.assert_not_called()
    assert probe.adapter is adapter and adapter.safety is adapter_policy
    assert adapter_policy.config == SafetyConfig()


@pytest.mark.skipif(os.name != "posix", reason="POSIX synthetic detection executable")
@pytest.mark.parametrize("field", ["scrub_extra_env", "redact_extra_patterns"])
def test_later_policy_divergence_cannot_return_cache_or_spawn(tmp_path, monkeypatch, field):
    from agy_mcp.config import SafetyConfig

    adapter_policy, probe_policy = SafetyPolicy(), SafetyPolicy(config=SafetyConfig())
    probe, log = make_synthetic_detection_probe(
        tmp_path, monkeypatch, adapter_safety=adapter_policy, probe_safety=probe_policy,
    )
    assert probe.get().success
    before = log.read_text()
    getattr(probe_policy.config, field).append("POLICY_SENTINEL")
    response = probe.get()
    assert not response.success and response.status == "unavailable"
    assert log.read_text() == before
    assert probe._cached_response is None
    assert probe.adapter.safety is adapter_policy
    assert adapter_policy.config == SafetyConfig()
