"""Offline characterization of sandbox / env-boundary behaviour (A4 lane).

Straightforward, non-live checks that pin the frozen baseline behaviour so
later changes to any of these seams are visible:

1. ``AgyPrintBackend._build_subprocess_env`` — host-inherited identity
   values (HOME, GIT_CONFIG_GLOBAL) pass through to the child byte-identical;
   secret names (OPENAI_API_KEY) are replaced with the redaction placeholder;
   the wrapper forces ``AGY_CLI_DISABLE_AUTO_UPDATE=1`` regardless of the
   host value; the caller's ``os.environ`` mapping is never mutated.
2. ``bridge._parse_extra_env`` leniently rejects wrapper-runtime-controlled
   names (``GIT_CONFIG_NOSYSTEM``) and reports the rejected entry; the strict
   ``BridgeRequest.extra_env`` validator rejects the same names via
   ``ValidationError``. Caller overrides are distinct from inherited host
   values, but both sides go through the same by-name scrub.
3. ``AgyPrintBackend.build_command`` forwards exactly one ``--sandbox`` when
   ``request.sandbox`` and the probed capability support it (mocked
   capability — no binary is spawned).

No live binaries, no provider calls, no production edits: these tests
characterize the frozen baseline; they are not a Red for a defect.
"""

from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from agy_mcp.adapters.agy import AgyPrintBackend
from agy_mcp.bridge import _parse_extra_env
from agy_mcp.models import BridgeRequest, Capability
from agy_mcp.safety import SafetyPolicy
from agy_mcp.utils import REDACTION_PLACEHOLDER

# ---------------------------------------------------------------------------
# 1. Subprocess env: inherited identity values pass through, secrets scrubbed
# ---------------------------------------------------------------------------


def test_subprocess_env_preserves_host_identity_and_scrubs_secrets(monkeypatch):
    """HOST identity vars forward byte-identical; secrets become the
    placeholder; auto-update is forced off; original environ is unmutated."""

    monkeypatch.setenv("HOME", "/synthetic/home")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/synthetic/gitconfig")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-host-secret-123")
    monkeypatch.setenv("AGY_CLI_DISABLE_AUTO_UPDATE", "0")

    backend = AgyPrintBackend(safety=SafetyPolicy())
    env = backend._build_subprocess_env(BridgeRequest(prompt="hi"))

    # A fresh mapping: the live environ object is never returned / mutated.
    assert env is not os.environ
    # Host identity values are forwarded byte-identical (not secret names).
    assert env["HOME"] == "/synthetic/home"
    assert env["GIT_CONFIG_GLOBAL"] == "/synthetic/gitconfig"
    # Secret names are replaced with the placeholder, not deleted.
    assert REDACTION_PLACEHOLDER == "***"
    assert env["OPENAI_API_KEY"] == REDACTION_PLACEHOLDER
    # Wrapper-owned control is written after the merge: a hostile host
    # value of "0" cannot re-enable the child's auto-update.
    assert env["AGY_CLI_DISABLE_AUTO_UPDATE"] == "1"
    # The original environ keeps the host's own values.
    assert os.environ["HOME"] == "/synthetic/home"
    assert os.environ["GIT_CONFIG_GLOBAL"] == "/synthetic/gitconfig"
    assert os.environ["OPENAI_API_KEY"] == "sk-host-secret-123"
    assert os.environ["AGY_CLI_DISABLE_AUTO_UPDATE"] == "0"


def test_subprocess_env_distinguishes_host_values_from_caller_overrides(monkeypatch):
    """Caller ``extra_env`` overrides an inherited host value for the same
    name; both sides still pass the same by-name scrub."""

    monkeypatch.setenv("SYNTH_HOST_VAR", "from-host")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-host-secret-123")

    backend = AgyPrintBackend(safety=SafetyPolicy())
    request = BridgeRequest(
        prompt="hi",
        extra_env={"SYNTH_HOST_VAR": "from-caller", "AGY_MCP_CUSTOM": "caller-only"},
    )
    env = backend._build_subprocess_env(request)

    # Caller override wins over the inherited host value for the same name.
    assert env["SYNTH_HOST_VAR"] == "from-caller"
    # Caller-only names appear in the child env.
    assert env["AGY_MCP_CUSTOM"] == "caller-only"
    # A secret smuggled via extra_env is still scrubbed by name.
    secret_request = BridgeRequest(
        prompt="hi",
        extra_env={"OPENAI_API_KEY": "sk-caller-secret"},
    )
    env2 = backend._build_subprocess_env(secret_request)
    assert env2["OPENAI_API_KEY"] == REDACTION_PLACEHOLDER


# ---------------------------------------------------------------------------
# 2. --extra-env parsing (lenient CLI) vs extra_env validation (strict MCP)
# ---------------------------------------------------------------------------


def test_parse_extra_env_rejects_runtime_controls_and_reports_them():
    accepted, rejected = _parse_extra_env(["GIT_CONFIG_NOSYSTEM=1"])
    assert accepted == {}
    assert rejected == ["GIT_CONFIG_NOSYSTEM=1"]

    # A benign name is accepted; the runtime-controlled one is dropped and
    # reported rather than silently lost.
    accepted, rejected = _parse_extra_env(["AGY_TEST_MARKER=ok", "HOME=/nope"])
    assert accepted == {"AGY_TEST_MARKER": "ok"}
    assert rejected == ["HOME=/nope"]


def test_bridge_request_extra_env_strictly_rejects_runtime_controls():
    with pytest.raises(ValidationError, match="controls wrapper runtime"):
        BridgeRequest(prompt="hi", extra_env={"HOME": "/synthetic/home"})
    with pytest.raises(ValidationError):
        BridgeRequest(prompt="hi", extra_env={"GIT_CONFIG_GLOBAL": "/synthetic/gitconfig"})
    with pytest.raises(ValidationError):
        BridgeRequest(prompt="hi", extra_env={"GIT_CONFIG_SYSTEM": "/synthetic/sysconfig"})
    with pytest.raises(ValidationError):
        BridgeRequest(prompt="hi", extra_env={"GIT_CONFIG_NOSYSTEM": "1"})
    # A normal name sails through the strict validator.
    request = BridgeRequest(prompt="hi", extra_env={"AGY_MCP_CUSTOM": "ok"})
    assert request.extra_env == {"AGY_MCP_CUSTOM": "ok"}


# ---------------------------------------------------------------------------
# 3. --sandbox argv forwarding (mocked capability; no binary spawned)
# ---------------------------------------------------------------------------


def test_build_command_forwards_sandbox_exactly_once(monkeypatch):
    cap = Capability(
        bin_path="/opt/bin/agy",
        backend="agy",
        supports_print=True,
        supports_sandbox=True,
    )
    monkeypatch.setattr(AgyPrintBackend, "detect", lambda self: cap)
    backend = AgyPrintBackend()

    argv = backend.build_command(BridgeRequest(prompt="hi", sandbox=True), log_path=None)
    assert argv.count("--sandbox") == 1

    argv = backend.build_command(BridgeRequest(prompt="hi", sandbox=False), log_path=None)
    assert "--sandbox" not in argv

    # A build that does not advertise --sandbox never receives the flag,
    # even when the caller asks for it.
    unsupported = Capability(
        bin_path="/opt/bin/agy",
        backend="agy",
        supports_print=True,
        supports_sandbox=False,
    )
    monkeypatch.setattr(AgyPrintBackend, "detect", lambda self: unsupported)
    argv = backend.build_command(BridgeRequest(prompt="hi", sandbox=True), log_path=None)
    assert "--sandbox" not in argv
