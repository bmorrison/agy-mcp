"""Quota visibility protocol seam for Google Antigravity CLI (`agy --print=/quota`).

Safe-account-identity limitation:
Because private account credentials, OAuth tokens, and emails must never be
read or inspected, QuotaProbe cannot identify the active account ID directly.
Therefore, if an operator switches accounts out-of-band while the agy binary,
CLI version, and auth-evidence source kind/path remain unchanged, the probe may
return a cached snapshot up to 30 seconds old unless ``force_refresh=True`` is passed.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Any

from agy_mcp.adapters.agy import (
    AGY_BINARY_NAME,
    AGY_HELP_TIMEOUT_S,
    AGY_VERSION_TIMEOUT_S,
    AgyPrintBackend,
    detect_agy_auth_source,
)
from agy_mcp.adapters.base import (
    BaseAdapter,
    _shutdown_cascade,
)
from agy_mcp.models import (
    QuotaBucket,
    QuotaGroup,
    QuotaStatus,
    QuotaToolResponse,
)
from agy_mcp.probe_process import (
    INVALID_OUTPUT_EXIT as _INVALID_OUTPUT_EXIT,
)
from agy_mcp.probe_process import (
    MAX_PROBE_OUTPUT_BYTES,
    run_bounded_process,
)
from agy_mcp.probe_process import (
    _cleanup_owned_process as _cleanup_probe_process,
)
from agy_mcp.probe_process import (
    _read_bounded_stream as _read_bounded_stream,
)
from agy_mcp.probe_process import (
    _StreamCapture as _StreamCapture,
)
from agy_mcp.safety import SafetyPolicy
from agy_mcp.utils import utc_now_iso

MIN_SUPPORTED_AGY_VERSION: tuple[int, int, int] = (1, 1, 11)
QUOTA_COMMAND_TIMEOUT_S: float = 20.0
QUOTA_PROCESS_DEADLINE_S: float = 30.0
MAX_OUTPUT_BYTES: int = MAX_PROBE_OUTPUT_BYTES
CACHE_TTL_SECONDS: float = 30.0
QUOTA_SOURCE: str = "agy:/quota"
_MAX_ERROR_CHARS: int = 2048
_CacheKey = tuple[str, str | None, str | None, bool, tuple[Any, ...]]


def _refresh_wait_budget_s() -> float:
    # Initial help/version plus one evidence-driven re-detection (for example,
    # a previously undetected keyring login revealed by metadata itself), quota,
    # and cleanup/drain grace for all five subprocesses. The quota command's
    # own 30-second deadline is unchanged.
    return QUOTA_PROCESS_DEADLINE_S + 2 * (AGY_HELP_TIMEOUT_S + AGY_VERSION_TIMEOUT_S) + 10.0


def _snapshot_age(observed_mono: float) -> float:
    return max(0.0, round(time.monotonic() - observed_mono, 3))


def _safety_config_signature(
    safety: SafetyPolicy,
) -> tuple[frozenset[str], tuple[str, ...], frozenset[str]]:
    config = safety.config
    return (
        frozenset(name.casefold() for name in config.scrub_extra_env),
        tuple(config.redact_extra_patterns),
        frozenset(value for value in config.denylist_extra if value),
    )


def _bounded_error(text: str, safety: SafetyPolicy | None) -> str:
    # Redact complete structural secrets (e.g. PEM) before cutting the message.
    return (safety.redact(text) if safety else text)[:_MAX_ERROR_CHARS]


_RECOGNIZED_VERSION_RE = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc|dev|pre)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$"
)

_AUTH_ERROR_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"auth error", re.IGNORECASE),
    re.compile(r"unauthenticated", re.IGNORECASE),
    re.compile(r"permission_denied", re.IGNORECASE),
    re.compile(r"oauth", re.IGNORECASE),
    re.compile(r"login", re.IGNORECASE),
    re.compile(r"not logged in", re.IGNORECASE),
    re.compile(r"credentials", re.IGNORECASE),
    re.compile(r"account ineligible", re.IGNORECASE),
    re.compile(r"keyring", re.IGNORECASE),
)

_SLASH_DISABLE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"slash[\s_-]?commands?\s+(?:are\s+)?disabled", re.IGNORECASE),
    re.compile(r"slash[\s_-]?commands?\s+(?:are\s+)?not\s+permitted", re.IGNORECASE),
    re.compile(r"slash[\s_-]?commands?\s+(?:are\s+)?not\s+allowed", re.IGNORECASE),
)


class QuotaParseError(ValueError):
    """Raised when the CLI response envelope or structured quota data fails validation."""


def _reject_duplicate_keys_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise QuotaParseError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def parse_version_tuple(version_str: str | None) -> tuple[int, int, int] | None:
    """Extract (major, minor, patch) from a strictly recognized version string."""
    if not version_str:
        return None
    m = _RECOGNIZED_VERSION_RE.fullmatch(version_str.strip())
    if not m:
        return None
    try:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def is_version_supported(version_str: str | None) -> bool:
    """Return True if version_str is recognized and >= MIN_SUPPORTED_AGY_VERSION (1.1.11)."""
    parsed = parse_version_tuple(version_str)
    if parsed is None:
        return False
    match = _RECOGNIZED_VERSION_RE.fullmatch(version_str.strip())
    return parsed > MIN_SUPPORTED_AGY_VERSION or (
        parsed == MIN_SUPPORTED_AGY_VERSION and match is not None and match.group(4) is None
    )


def parse_and_validate_utc_timestamp(val: Any) -> str | None:
    """Parse and validate that val is an ISO timestamp with explicit timezone.

    Returns normalized UTC ISO 8601 string (%Y-%m-%dT%H:%M:%SZ),
    or None if val is None or empty.
    Raises ValueError if val is invalid or lacks timezone info (naive).
    """
    if val is None or val == "":
        return None
    if not isinstance(val, str):
        raise ValueError(f"timestamp must be a string, got {type(val).__name__}: {val!r}")

    clean = val.strip()
    try:
        dt = datetime.fromisoformat(clean)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"invalid ISO timestamp {val!r}: {exc}") from exc

    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError(f"timestamp must be timezone-aware UTC, got naive timestamp: {val!r}")

    dt_utc = dt.astimezone(timezone.utc)
    return dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_remaining_fraction(val: Any, *, disabled: bool) -> float | None:
    """Validate remaining_fraction.

    Validates raw fraction first (finite number in [0.0, 1.0], not bool).
    If disabled=True, returns None (normalized fraction null).
    If disabled=False:
      - None or missing: returns None (unknown).
      - Strict number (not bool), finite, 0.0 <= val <= 1.0.
    """
    if val is None:
        return None
    if type(val) is bool:
        raise ValueError(f"remaining_fraction must be a number, not bool: {val!r}")
    if not isinstance(val, (int, float)):
        raise ValueError(f"remaining_fraction must be numeric, got {type(val).__name__}: {val!r}")
    f_val = float(val)
    if not math.isfinite(f_val):
        raise ValueError(f"remaining_fraction must be finite, got: {f_val}")
    if f_val < 0.0 or f_val > 1.0:
        raise ValueError(f"remaining_fraction must be between 0.0 and 1.0, got: {f_val}")
    if disabled:
        return None
    return f_val


def parse_quota_envelope(
    data: dict[str, Any],
    *,
    safety: SafetyPolicy | None = None,
) -> list[QuotaGroup]:
    """Validate the structured quota envelope and return normalized QuotaGroup list."""
    if not isinstance(data, dict):
        raise QuotaParseError(f"JSON root must be an object, got {type(data).__name__}")

    status = data.get("status")
    if status != "SUCCESS":
        raise QuotaParseError(f"envelope status must be SUCCESS, got {status!r}")

    if "conversation_id" not in data:
        raise QuotaParseError("missing conversation_id in quota response")
    conv_id = data["conversation_id"]
    if conv_id != "":
        raise QuotaParseError(f"conversation_id must be empty in quota probe, got {conv_id!r}")

    if "num_turns" not in data:
        raise QuotaParseError("missing num_turns in quota response")
    num_turns = data["num_turns"]
    if type(num_turns) is not int or num_turns != 0:
        raise QuotaParseError(f"num_turns must be 0, got {num_turns!r}")

    if "usage" not in data:
        raise QuotaParseError("missing usage in quota response")
    usage = data["usage"]
    if not isinstance(usage, dict) or not usage:
        raise QuotaParseError("missing or empty usage object")

    required_counters = ("input_tokens", "output_tokens", "total_tokens")
    for counter in required_counters:
        if counter not in usage:
            raise QuotaParseError(f"usage missing required token counter {counter!r}")

    for k, v in usage.items():
        if type(v) is bool or not isinstance(v, (int, float)) or v != 0:
            raise QuotaParseError(f"usage counter {k!r} must be 0, got {v!r}")

    command = data.get("command")
    if not isinstance(command, dict):
        raise QuotaParseError("missing command object")
    cmd_name = command.get("name")
    if cmd_name not in ("usage", "quota"):
        raise QuotaParseError(f"unexpected command name {cmd_name!r}")
    cmd_data = command.get("data")
    if not isinstance(cmd_data, dict):
        raise QuotaParseError("missing command data object")

    groups_raw = cmd_data.get("groups")
    if groups_raw is None or not isinstance(groups_raw, list):
        raise QuotaParseError("command data missing 'groups' list")

    seen_group_names: set[str] = set()
    seen_bucket_ids: set[str] = set()
    groups: list[QuotaGroup] = []

    for g in groups_raw:
        if not isinstance(g, dict):
            raise QuotaParseError("group must be an object")
        raw_name = g.get("name")
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise QuotaParseError("group missing valid name")
        if raw_name in seen_group_names:
            raise QuotaParseError(f"duplicate group name: {raw_name!r}")
        seen_group_names.add(raw_name)

        redacted_name = safety.redact(raw_name) if safety else raw_name

        desc = g.get("description")
        if desc is not None and not isinstance(desc, str):
            raise QuotaParseError(f"group {raw_name!r} description must be string or null")
        redacted_desc = safety.redact(desc) if (desc and safety) else desc

        buckets_raw = g.get("buckets")
        if buckets_raw is None or not isinstance(buckets_raw, list):
            raise QuotaParseError(f"group {raw_name!r} missing 'buckets' list")

        buckets: list[QuotaBucket] = []
        seen_group_windows: set[str] = set()

        for b in buckets_raw:
            if not isinstance(b, dict):
                raise QuotaParseError("bucket must be an object")
            raw_b_id = b.get("id")
            if not isinstance(raw_b_id, str) or not raw_b_id.strip():
                raise QuotaParseError("bucket missing valid id")
            if raw_b_id in seen_bucket_ids:
                raise QuotaParseError(f"duplicate bucket id: {raw_b_id!r}")
            seen_bucket_ids.add(raw_b_id)

            raw_b_name = b.get("name")
            if not isinstance(raw_b_name, str) or not raw_b_name.strip():
                raise QuotaParseError(f"bucket {raw_b_id!r} missing valid name")

            raw_window = b.get("window")
            if not isinstance(raw_window, str) or not raw_window.strip():
                raise QuotaParseError(f"bucket {raw_b_id!r} missing valid window")
            if raw_window in seen_group_windows:
                raise QuotaParseError(f"duplicate window {raw_window!r} in group {raw_name!r}")
            seen_group_windows.add(raw_window)

            disabled_val = b.get("disabled", False)
            if type(disabled_val) is not bool:
                raise QuotaParseError(
                    f"bucket {raw_b_id!r} disabled must be boolean, got {type(disabled_val).__name__}"
                )
            is_disabled = disabled_val

            raw_b_desc = b.get("description")
            if raw_b_desc is not None and not isinstance(raw_b_desc, str):
                raise QuotaParseError(f"bucket {raw_b_id!r} description must be string or null")

            raw_frac = b.get("remaining_fraction")
            try:
                frac = validate_remaining_fraction(raw_frac, disabled=is_disabled)
            except ValueError as exc:
                raise QuotaParseError(f"bucket {raw_b_id!r} invalid fraction: {exc}") from exc

            raw_reset = b.get("reset_time") if "reset_time" in b else b.get("reset_at")
            reset_values = [b[key] for key in ("reset_time", "reset_at") if key in b]
            if is_disabled and any(value not in (None, "") for value in reset_values):
                raise QuotaParseError(
                    f"disabled bucket {raw_b_id!r} cannot have reset timestamp: {reset_values!r}"
                )
            try:
                reset_at = parse_and_validate_utc_timestamp(raw_reset)
                if "reset_time" in b and "reset_at" in b:
                    if parse_and_validate_utc_timestamp(b["reset_at"]) != reset_at:
                        raise ValueError("reset_time and reset_at disagree")
            except ValueError as exc:
                raise QuotaParseError(f"bucket {raw_b_id!r} invalid timestamp: {exc}") from exc

            redacted_b_id = safety.redact(raw_b_id) if safety else raw_b_id
            redacted_b_name = safety.redact(raw_b_name) if safety else raw_b_name
            redacted_b_window = safety.redact(raw_window) if safety else raw_window
            redacted_b_desc = safety.redact(raw_b_desc) if (raw_b_desc and safety) else raw_b_desc

            buckets.append(
                QuotaBucket(
                    id=redacted_b_id,
                    name=redacted_b_name,
                    window=redacted_b_window,
                    disabled=is_disabled,
                    remaining_fraction=frac,
                    reset_at=reset_at,
                    description=redacted_b_desc,
                )
            )

        groups.append(
            QuotaGroup(
                name=redacted_name,
                description=redacted_desc,
                buckets=buckets,
            )
        )

    return groups


def parse_quota_json(
    raw_text: str,
    *,
    safety: SafetyPolicy | None = None,
) -> list[QuotaGroup]:
    """Parse raw CLI JSON output into normalized QuotaGroup list."""
    if not isinstance(raw_text, str):
        raise QuotaParseError(f"raw_text must be str, got {type(raw_text).__name__}")
    try:
        output_bytes = len(raw_text.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise QuotaParseError("quota output is not valid UTF-8") from exc
    if output_bytes > MAX_OUTPUT_BYTES:
        raise QuotaParseError(
            f"quota output exceeds maximum size of {MAX_OUTPUT_BYTES} bytes ({output_bytes} given)"
        )
    if not raw_text.strip():
        raise QuotaParseError("quota output is empty")

    try:
        data = json.loads(raw_text, object_pairs_hook=_reject_duplicate_keys_hook)
    except QuotaParseError:
        raise
    except json.JSONDecodeError as exc:
        raise QuotaParseError(f"malformed JSON: {exc}") from exc

    return parse_quota_envelope(data, safety=safety)


def parse_quota_response(
    raw_text: str,
    *,
    cli_version: str | None = None,
    safety: SafetyPolicy | None = None,
    observed_at: str | None = None,
) -> QuotaToolResponse:
    """Pure parser helper returning a complete typed QuotaToolResponse."""
    redacted_cli_ver = safety.redact(cli_version) if (cli_version and safety) else cli_version
    try:
        groups = parse_quota_json(raw_text, safety=safety)
        return QuotaToolResponse(
            success=True,
            status="ok",
            error=None,
            backend="agy",
            cli_version=redacted_cli_ver,
            source=QUOTA_SOURCE,
            observed_at=observed_at or utc_now_iso(),
            cached=False,
            age_seconds=0.0,
            groups=groups,
        )
    except QuotaParseError as exc:
        redacted_err = safety.redact(str(exc)) if safety else str(exc)
        return QuotaToolResponse(
            success=False,
            status="invalid_response",
            error=_bounded_error(f"invalid quota response: {redacted_err}", safety),
            backend="agy",
            cli_version=redacted_cli_ver,
            source=QUOTA_SOURCE,
            groups=[],
        )
    except Exception as exc:
        redacted_err = safety.redact(str(exc)) if safety else str(exc)
        return QuotaToolResponse(
            success=False,
            status="invalid_response",
            error=_bounded_error(f"unexpected parse error: {redacted_err}", safety),
            backend="agy",
            cli_version=redacted_cli_ver,
            source=QUOTA_SOURCE,
            groups=[],
        )


def check_slash_commands_disabled(env: dict[str, str] | None = None) -> bool:
    """Return True if environment indicates slash commands are disabled."""
    env_to_check = env if env is not None else os.environ
    for key in (
        "AGY_DISABLE_SLASH_COMMANDS",
        "ANTIGRAVITY_DISABLE_SLASH_COMMANDS",
        "AGY_NO_SLASH_COMMANDS",
        "AGY_NO_SLASH",
    ):
        if env_to_check.get(key, "").strip().lower() in ("1", "true", "yes", "on"):
            return True
    return False


def is_slash_disabled_error(stdout: str, stderr: str) -> bool:
    """Detect if output text reports that slash commands are disabled."""
    combined = f"{stdout}\n{stderr}"
    return any(p.search(combined) for p in _SLASH_DISABLE_PATTERNS)


def is_auth_error(text: str) -> bool:
    """Detect authentication or permission errors in CLI output."""
    return any(p.search(text) for p in _AUTH_ERROR_PATTERNS)


def _cleanup_owned_process(proc: subprocess.Popen, owned_pgid: int | None) -> None:
    """Keep the quota cleanup/patch seam while sharing the owned-process runner."""
    _cleanup_probe_process(proc, owned_pgid, shutdown=_shutdown_cascade)


class _InFlight:
    """Single-flight execution state for concurrent refresh callers."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.response: QuotaToolResponse | None = None
        self.key: _CacheKey | None = None
        self.observed_mono: float | None = None


class QuotaProbe:
    """Probes Antigravity subscription quota via `agy --print=/quota`.

    Features:
    - Conservative version gate (>= 1.1.11) before probe execution.
    - 30-second in-memory cache with monotonic TTL.
    - Single-flight refresh coalescing; different contexts are serialized too.
    - Explicit failure on failed refresh (never returns stale success).
    - Invalidation on binary path, CLI version, auth context, or policy changes.
    - Fail-closed on discovered slash-disable operator policies.
    - Owned-group cleanup and bounded capture on all execution paths.

    An explicit safety policy must match the actual Agy adapter's effective
    configuration. Incompatible policies fail before detection without mutating
    the supplied adapter; separate policies with equivalent settings are valid.

    POSIX containment covers descendants that remain in the spawned session's
    group, not children that create a new session/group. Windows uses the shared
    best-effort CTRL_BREAK/leader-kill cascade, not a Job Object; neither escaped
    children nor stuck Windows pipe readers have a universal zero-orphan guarantee.
    """

    def __init__(
        self,
        adapter: BaseAdapter | None = None,
        safety: SafetyPolicy | None = None,
    ) -> None:
        if adapter is None:
            self.adapter: BaseAdapter = AgyPrintBackend(safety=safety)
        else:
            self.adapter = adapter
        self.safety = safety or getattr(self.adapter, "safety", None) or SafetyPolicy()

        self._lock = threading.Lock()
        self._detect_lock = threading.Lock()
        self._generation = 0
        self._binary_identity: tuple[Any, ...] | None = None
        self._auth_identity: str | None = None
        self._cached_response: QuotaToolResponse | None = None
        self._cached_mono: float = 0.0
        self._cached_key: _CacheKey | None = None
        self._in_flight_map: dict[_CacheKey | None, _InFlight] = {}

    def invalidate(self) -> None:
        """Explicitly clear the in-memory cache."""
        with self._lock:
            self._generation += 1
            self._cached_response = None
            self._cached_mono = 0.0
            self._cached_key = None

    @staticmethod
    def _binary_fingerprint(bin_path: str) -> tuple[Any, ...]:
        try:
            stat = os.stat(bin_path)
            return (
                bin_path,
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            )
        except OSError:
            return (bin_path, None)

    def _get_cache_key(self, *, refresh: bool = False) -> _CacheKey:
        if not self._detect_lock.acquire(timeout=QUOTA_PROCESS_DEADLINE_S + 5.0):
            raise TimeoutError("timed out waiting for quota capability detection")
        try:
            policy = _safety_config_signature(self.safety)
            if isinstance(self.adapter, AgyPrintBackend):
                if _safety_config_signature(self.adapter.safety) != policy:
                    raise ValueError("quota and adapter safety policies are incompatible")
            auth_context = self._detect_auth_context()
            refreshed = refresh or self._binary_identity is None or auth_context != self._auth_identity
            before_identity = None
            if refreshed and isinstance(self.adapter, AgyPrintBackend):
                before_identity = self._binary_fingerprint(
                    self.adapter.locate_binary(AGY_BINARY_NAME) or ""
                )
            cap = self.adapter.detect(refresh=refreshed)
            # BaseAdapter caches capabilities indefinitely. Re-detect before a
            # changed executable can inherit a supported predecessor's version.
            resolved = (
                self.adapter.locate_binary(AGY_BINARY_NAME) or ""
                if isinstance(self.adapter, AgyPrintBackend)
                else cap.bin_path or ""
            )
            identity = self._binary_fingerprint(resolved)
            if before_identity is not None and identity != before_identity:
                raise ValueError("quota executable changed during capability detection")
            if resolved != cap.bin_path or (
                not refreshed
                and self._binary_identity is not None
                and identity != self._binary_identity
            ):
                # Only cached capabilities need a replacement-driven refresh.
                # A forced/auth-driven refresh already inspected this executable.
                probe_identity = identity
                cap = self.adapter.detect(refresh=True)
                identity = self._binary_fingerprint(cap.bin_path or "")
                if identity != probe_identity:
                    raise ValueError("quota executable changed during capability detection")
            self._binary_identity = identity
            self._auth_identity = auth_context
            return (
                cap.bin_path or "",
                cap.version,
                auth_context,
                check_slash_commands_disabled(),
                (identity, cap.authenticated, policy),
            )
        finally:
            self._detect_lock.release()

    def _detect_auth_context(self) -> str:
        """Auth evidence, not account identity; metadata can change during probes."""
        try:
            source = detect_agy_auth_source()
            if source is None:
                return "none"
            # Log rotation and OAuth refresh are effects of the CLI itself, not
            # account switches. Never use their mutable mtimes as cache identity.
            # Stable source kind/path and evidence disappearance remain signals;
            # undetectable account switches require TTL expiry or force refresh.
            return f"{source.kind}:{source.path}"
        except Exception:
            return "unknown"

    @staticmethod
    def _same_probe_context(before: _CacheKey, after: _CacheKey | None) -> bool:
        if before == after:
            return True
        if after is None:
            return False
        # Absence of local auth evidence is unknown, not a bound account.
        # Metadata can reveal a valid keyring login itself. Accept only this
        # one-way discovery, never loss/change of known evidence or changes to
        # the executable, version, slash policy or safety configuration.
        return (
            before[2] in {"none", "unknown"}
            and after[2] not in {None, "none", "unknown"}
            and before[4][1] is False
            and after[4][1] is True
            and before[:2] == after[:2]
            and before[3] == after[3]
            and before[4][0] == after[4][0]
            and before[4][2] == after[4][2]
        )

    def _failure(
        self, status: QuotaStatus, message: str, key: _CacheKey | None = None
    ) -> QuotaToolResponse:
        return QuotaToolResponse(
            success=False,
            status=status,
            error=_bounded_error(message, self.safety),
            cli_version=self.safety.redact(key[1]) if key and key[1] else None,
        )

    def get(self, force_refresh: bool = False) -> QuotaToolResponse:
        """Return a bounded single-flight snapshot, never publish changed-context data."""
        if self.adapter.backend != "agy":
            return self._failure("unsupported", "quota requires the Antigravity adapter")
        wait_started: float | None = None
        while True:
            with self._lock:
                generation = self._generation
                flight = next(iter(self._in_flight_map.values()), None)
                if flight is None:
                    # Reserve the entire refresh, including capability detection.
                    # Other callers must join before running forced help/version.
                    flight = _InFlight()
                    self._in_flight_map[None] = flight
                    leader = True
                else:
                    leader = False
            if leader:
                return self._refresh(flight, generation, force_refresh)

            if wait_started is None:
                wait_started = time.monotonic()
            remaining = _refresh_wait_budget_s() - (time.monotonic() - wait_started)
            if remaining <= 0 or not flight.done.wait(timeout=remaining):
                return self._failure(
                    "timeout", "timed out waiting for in-flight quota probe", flight.key
                )
            if flight.key is not None:
                try:
                    valid_key = self._get_cache_key()
                except Exception:
                    return self._failure(
                        "unavailable", "quota context changed during refresh", flight.key
                    )
                if valid_key != flight.key:
                    # Different contexts remain serialized. Refresh the new
                    # context, rather than reuse the old flight's response.
                    continue
            with self._lock:
                valid = generation == self._generation
            if not valid:
                return self._failure(
                    "unavailable", "quota context changed during refresh", flight.key
                )
            if flight.response is not None:
                if force_refresh and flight.response.cached:
                    # A normal leader may only have read the cache. Joining it
                    # cannot satisfy a forced caller's request for fresh data.
                    continue
                response = copy.deepcopy(flight.response)
                if response.success and flight.observed_mono is not None:
                    response.age_seconds = _snapshot_age(flight.observed_mono)
                return response
            return self._failure(
                "unavailable", "in-flight probe terminated without response", flight.key
            )

    def _refresh(
        self, flight: _InFlight, generation: int, force_refresh: bool
    ) -> QuotaToolResponse:
        # Preparation is part of the flight. Release waiters even if detection
        # raises BaseException, not just if quota execution is interrupted.
        response = self._failure("unavailable", "quota probe interrupted")
        current_key = valid_key = None
        cache_hit = False
        try:
            try:
                current_key = self._get_cache_key(refresh=force_refresh)
            except Exception as exc:
                self.invalidate()
                response = self._failure("unavailable", f"failed to determine cache key: {exc}")
            else:
                with self._lock:
                    self._in_flight_map.pop(None, None)
                    self._in_flight_map[current_key] = flight
                    flight.key = current_key
                    if (
                        not force_refresh
                        and not current_key[3]
                        and self._cached_response is not None
                        and self._cached_key == current_key
                    ):
                        age = time.monotonic() - self._cached_mono
                        if age < CACHE_TTL_SECONDS:
                            response = copy.deepcopy(self._cached_response).model_copy(
                                update={"cached": True, "age_seconds": max(0.0, round(age, 3))}
                            )
                            cache_hit = True
                            flight.observed_mono = self._cached_mono
                if current_key[3]:
                    response = self._failure(
                        "unsupported", "slash commands disabled by operator policy", current_key
                    )
                elif not cache_hit:
                    response = self._run_probe(current_key)
                    if response.success:
                        # Match observed_at before post-command detection can
                        # delay publication; TTL must not restart after it.
                        flight.observed_mono = time.monotonic()
                valid_key = self._get_cache_key()
        except Exception as exc:
            response = self._failure(
                "unavailable", f"unexpected probe execution error: {exc}", current_key
            )
            try:
                valid_key = self._get_cache_key()
            except Exception:
                valid_key = None
        finally:
            with self._lock:
                reserved_key = flight.key
                try:
                    context_matches = current_key is not None and (
                        valid_key == current_key if cache_hit
                        else self._same_probe_context(current_key, valid_key)
                    )
                    if current_key is not None and (
                        generation != self._generation or not context_matches
                    ):
                        response = self._failure(
                            "unavailable", "quota context changed during refresh", current_key
                        )
                    elif context_matches:
                        # Publish and let waiters validate the newly discovered
                        # evidence, not the pre-command unknown auth heuristic.
                        flight.key = valid_key
                    if response.success:
                        assert flight.observed_mono is not None
                        response.age_seconds = _snapshot_age(flight.observed_mono)
                        if not cache_hit:
                            self._cached_response = copy.deepcopy(response)
                            self._cached_mono = flight.observed_mono
                            self._cached_key = valid_key
                    else:
                        self._cached_response = None
                        self._cached_mono = 0.0
                        self._cached_key = None
                    flight.response = response
                finally:
                    self._in_flight_map.pop(reserved_key, None)
                    flight.done.set()
        return copy.deepcopy(response)

    def _run_probe(self, current_key: _CacheKey) -> QuotaToolResponse:
        bin_path, version, _, slash_disabled, _ = current_key

        if slash_disabled or check_slash_commands_disabled():
            return QuotaToolResponse(
                success=False,
                status="unsupported",
                error=_bounded_error("slash commands disabled by operator policy", self.safety),
                backend="agy",
                cli_version=self.safety.redact(version) if version else None,
                source=QUOTA_SOURCE,
            )

        if not bin_path:
            return QuotaToolResponse(
                success=False,
                status="unavailable",
                error=_bounded_error(
                    f"{AGY_BINARY_NAME!r} binary not found on PATH or via AGY_BIN", self.safety
                ),
                backend="agy",
                cli_version=None,
                source=QUOTA_SOURCE,
            )

        if not is_version_supported(version):
            ver_str = version or "unknown"
            return QuotaToolResponse(
                success=False,
                status="unsupported",
                error=_bounded_error(
                    f"agy version {ver_str!r} is unsupported (minimum 1.1.11 required for /quota)",
                    self.safety,
                ),
                backend="agy",
                cli_version=self.safety.redact(version) if version else None,
                source=QUOTA_SOURCE,
            )

        # Auth capability is a local-evidence heuristic: missing/stale logs do
        # not prove logout. Let the bounded command use existing CLI auth, then
        # classify actual auth errors or timeout without initiating login.
        if not self._same_probe_context(current_key, self._get_cache_key()):
            return self._failure(
                "unavailable", "quota context changed before execution", current_key
            )

        exit_code, stdout, stderr = self._execute_command(bin_path)

        if exit_code == _INVALID_OUTPUT_EXIT:
            return self._failure("invalid_response", stderr, current_key)

        if exit_code != 0 and is_slash_disabled_error(stdout, stderr):
            return QuotaToolResponse(
                success=False,
                status="unsupported",
                error=_bounded_error("slash commands disabled by operator policy", self.safety),
                backend="agy",
                cli_version=self.safety.redact(version) if version else None,
                source=QUOTA_SOURCE,
            )

        if exit_code is None or exit_code == -1:
            if "timeout" in stderr.lower():
                return QuotaToolResponse(
                    success=False,
                    status="timeout",
                    error=_bounded_error(
                        f"quota probe timed out after {int(QUOTA_PROCESS_DEADLINE_S)}s", self.safety
                    ),
                    backend="agy",
                    cli_version=self.safety.redact(version) if version else None,
                    source=QUOTA_SOURCE,
                )
            bounded_err = _bounded_error(stderr or "process terminated", self.safety)
            return QuotaToolResponse(
                success=False,
                status="unavailable",
                error=_bounded_error(f"quota probe failed: {bounded_err}", self.safety),
                backend="agy",
                cli_version=self.safety.redact(version) if version else None,
                source=QUOTA_SOURCE,
            )

        if exit_code != 0:
            combined_err = (stderr.strip() + "\n" + stdout.strip()).strip()
            bounded_err = _bounded_error(combined_err, self.safety)
            if is_auth_error(combined_err):
                return QuotaToolResponse(
                    success=False,
                    status="auth_error",
                    error=_bounded_error(
                        f"authentication failure: {bounded_err or 'unauthenticated'}", self.safety
                    ),
                    backend="agy",
                    cli_version=self.safety.redact(version) if version else None,
                    source=QUOTA_SOURCE,
                )
            return QuotaToolResponse(
                success=False,
                status="unavailable",
                error=_bounded_error(
                    f"agy --print=/quota exited with code {exit_code}: {bounded_err}", self.safety
                ),
                backend="agy",
                cli_version=self.safety.redact(version) if version else None,
                source=QUOTA_SOURCE,
            )

        try:
            groups = parse_quota_json(stdout, safety=self.safety)
        except QuotaParseError as exc:
            # Validated successful JSON takes precedence over arbitrary
            # descriptions/diagnostics. Scan prose only when validation fails.
            if is_slash_disabled_error(stdout, stderr):
                return self._failure(
                    "unsupported", "slash commands disabled by operator policy", current_key
                )
            return QuotaToolResponse(
                success=False,
                status="invalid_response",
                error=_bounded_error(f"invalid quota response: {exc}", self.safety),
                backend="agy",
                cli_version=self.safety.redact(version) if version else None,
                source=QUOTA_SOURCE,
            )
        except Exception as exc:
            return QuotaToolResponse(
                success=False,
                status="invalid_response",
                error=_bounded_error(f"unexpected parse error: {exc}", self.safety),
                backend="agy",
                cli_version=self.safety.redact(version) if version else None,
                source=QUOTA_SOURCE,
            )

        return QuotaToolResponse(
            success=True,
            status="ok",
            error=None,
            backend="agy",
            cli_version=self.safety.redact(version) if version else None,
            source=QUOTA_SOURCE,
            observed_at=utc_now_iso(),
            cached=False,
            age_seconds=0.0,
            groups=groups,
        )

    def _execute_command(self, bin_path: str) -> tuple[int | None, str, str]:
        cmd = [
            bin_path,
            "--print=/quota",
            "--output-format",
            "json",
            "--print-timeout",
            f"{int(QUOTA_COMMAND_TIMEOUT_S)}s",
        ]
        env = self.safety.scrub_environment(dict(os.environ))
        env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "1"
        return run_bounded_process(
            cmd, env=env, timeout=QUOTA_PROCESS_DEADLINE_S,
            max_output_bytes=MAX_OUTPUT_BYTES, cleanup=_cleanup_owned_process,
        )


__all__ = [
    "CACHE_TTL_SECONDS",
    "MAX_OUTPUT_BYTES",
    "MIN_SUPPORTED_AGY_VERSION",
    "QUOTA_COMMAND_TIMEOUT_S",
    "QUOTA_PROCESS_DEADLINE_S",
    "QUOTA_SOURCE",
    "QuotaParseError",
    "QuotaProbe",
    "check_slash_commands_disabled",
    "is_auth_error",
    "is_slash_disabled_error",
    "is_version_supported",
    "parse_and_validate_utc_timestamp",
    "parse_quota_envelope",
    "parse_quota_json",
    "parse_quota_response",
    "parse_version_tuple",
    "validate_remaining_fraction",
]
