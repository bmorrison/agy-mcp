"""Antigravity brain-directory transcript reader.

Reads ``transcript.jsonl`` from the Antigravity CLI's brain directory
(~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl)
to provide post-mortem diagnostics and live progress summaries.
"""

from __future__ import annotations

import json
import logging
import os
import re
import stat
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from agy_mcp.utils import open_transcript_no_follow

_LOG = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AGY_BRAIN_DIR = Path.home() / ".gemini" / "antigravity-cli" / "brain"

# Conservative validation for conversation UUIDs (canonical 8-4-4-4-12 hex).
_CONVERSATION_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
    r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Hard cap on transcript file size to prevent OOM.
_MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024  # 50 MB

# Regex to extract prompt text wrapped in <USER_REQUEST>...</USER_REQUEST>
_USER_REQUEST_RE = re.compile(r"<USER_REQUEST>(.*?)</USER_REQUEST>", re.DOTALL)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class TranscriptStep:
    """A single parsed step from a transcript.jsonl file."""

    step_index: int
    source: str
    type: str
    status: str = ""
    content: str | None = None
    thinking: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    created_at: str | None = None
    is_truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class TranscriptProgress:
    """Lightweight summary computed from parsed transcript steps."""

    conversation_id: str
    total_steps: int
    tool_call_count: int
    tool_breakdown: dict[str, int]
    thinking_cycle_count: int
    user_prompt_count: int
    first_prompt_snippet: str | None
    last_activity_at: str | None
    elapsed_seconds: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Path resolution & sanitization
# ---------------------------------------------------------------------------


def resolve_transcript_path(
    conversation_id: str,
    *,
    brain_root: Path | None = None,
) -> Path:
    """Resolve the transcript path from a conversation UUID.

    Returns the path to ``transcript.jsonl`` (the compact, token-efficient
    version). Does NOT use ``transcript_full.jsonl`` — it can be very large.
    """
    if not isinstance(conversation_id, str) or not _CONVERSATION_ID_RE.fullmatch(conversation_id):
        raise ValueError(
            f"invalid conversation_id: must be a canonical UUID (8-4-4-4-12 hex), got {conversation_id!r}"
        )
    root = brain_root if brain_root is not None else AGY_BRAIN_DIR
    return root / conversation_id / ".system_generated" / "logs" / "transcript.jsonl"


def _extract_prompt_text(content: str) -> str:
    """Extract clean user prompt text, stripping <USER_REQUEST> wrapper if present."""
    match = _USER_REQUEST_RE.search(content)
    if match:
        return match.group(1).strip()
    return content.strip()


def _redact_args(args: Any, redact_fn: Callable[[str], str]) -> Any:
    """Recursively redact string values inside tool_calls arguments."""
    if isinstance(args, str):
        return redact_fn(args)
    if isinstance(args, dict):
        return {k: _redact_args(v, redact_fn) for k, v in args.items()}
    if isinstance(args, list):
        return [_redact_args(item, redact_fn) for item in args]
    return args


# ---------------------------------------------------------------------------
# Reading & Parsing
# ---------------------------------------------------------------------------


def read_transcript(
    transcript_path: Path,
    max_bytes: int = 200_000,
    *,
    redact_fn: Callable[[str], str] | None = None,
) -> list[TranscriptStep]:
    """Read and parse the transcript JSONL, returning bounded steps.

    - Rejects symlinks (security: no following into arbitrary paths).
    - Rejects files > 50 MB.
    - Caps read at ``max_bytes``.
    - Applies ``redact_fn`` to ``content``, ``thinking``, and tool argument strings.
    - Skips malformed lines gracefully.
    """

    def _identity(text: str) -> str:
        return text

    redact = redact_fn if redact_fn is not None else _identity

    try:
        st = os.lstat(transcript_path)
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise OSError(f"failed to inspect transcript path: {exc}") from exc

    if stat.S_ISLNK(st.st_mode):
        raise OSError(f"refusing to read symlinked transcript: {transcript_path}")
    if not stat.S_ISREG(st.st_mode):
        raise OSError(f"refusing to read non-regular transcript file: {transcript_path}")
    if st.st_size > _MAX_TRANSCRIPT_BYTES:
        raise ValueError(
            f"transcript file exceeds {_MAX_TRANSCRIPT_BYTES} bytes ({st.st_size} bytes); refusing to read"
        )

    fp = open_transcript_no_follow(transcript_path)
    steps: list[TranscriptStep] = []
    total_bytes_read = 0
    had_malformed_line = False

    try:
        for line in fp:
            line_bytes = len(line.encode("utf-8", errors="replace"))
            total_bytes_read += line_bytes
            if total_bytes_read > max_bytes and steps:
                break

            stripped = line.strip()
            if not stripped:
                continue

            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError:
                if not had_malformed_line:
                    _LOG.warning("skipping malformed transcript line in %s", transcript_path)
                    had_malformed_line = True
                continue

            if not isinstance(payload, dict):
                continue

            step_idx = payload.get("step_index")
            if not isinstance(step_idx, int):
                step_idx = len(steps)

            source = str(payload.get("source") or "")
            step_type = str(payload.get("type") or "")
            status = str(payload.get("status") or "")

            raw_content = payload.get("content")
            content = redact(str(raw_content)) if raw_content is not None else None

            raw_thinking = payload.get("thinking")
            thinking = redact(str(raw_thinking)) if raw_thinking is not None else None

            raw_tool_calls = payload.get("tool_calls")
            tool_calls: list[dict[str, Any]] = []
            if isinstance(raw_tool_calls, list):
                for tc in raw_tool_calls:
                    if isinstance(tc, dict):
                        tc_name = str(tc.get("name") or "")
                        tc_args = tc.get("args")
                        safe_args = (
                            _redact_args(tc_args, redact)
                            if isinstance(tc_args, (dict, list, str))
                            else {}
                        )
                        tool_calls.append({"name": tc_name, "args": safe_args})

            created_at = payload.get("created_at")
            if created_at is not None:
                created_at = str(created_at)

            is_truncated = bool(payload.get("is_truncated", False))

            steps.append(
                TranscriptStep(
                    step_index=step_idx,
                    source=source,
                    type=step_type,
                    status=status,
                    content=content,
                    thinking=thinking,
                    tool_calls=tool_calls,
                    created_at=created_at,
                    is_truncated=is_truncated,
                )
            )
    finally:
        fp.close()

    return steps


# ---------------------------------------------------------------------------
# Progress summarization
# ---------------------------------------------------------------------------


def _parse_iso_timestamp(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        clean = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(clean)
    except (ValueError, TypeError):
        return None


def summarize_progress(
    conversation_id: str,
    steps: list[TranscriptStep],
) -> TranscriptProgress:
    """Compute a lightweight progress summary from parsed steps."""
    total_steps = len(steps)
    tool_call_count = 0
    tool_breakdown: dict[str, int] = {}
    thinking_cycle_count = 0
    user_prompt_count = 0
    first_prompt_snippet: str | None = None

    valid_timestamps: list[datetime] = []

    for step in steps:
        if step.thinking:
            thinking_cycle_count += 1

        if step.tool_calls:
            tool_call_count += len(step.tool_calls)
            for tc in step.tool_calls:
                name = tc.get("name") or "unknown"
                tool_breakdown[name] = tool_breakdown.get(name, 0) + 1

        if step.source == "USER_EXPLICIT" or step.type == "USER_INPUT":
            user_prompt_count += 1
            if first_prompt_snippet is None and step.content:
                clean_text = _extract_prompt_text(step.content)
                first_prompt_snippet = clean_text[:200]

        if step.created_at:
            dt = _parse_iso_timestamp(step.created_at)
            if dt is not None:
                valid_timestamps.append(dt)

    last_activity_at: str | None = None
    elapsed_seconds: float | None = None

    if valid_timestamps:
        last_dt = max(valid_timestamps)
        first_dt = min(valid_timestamps)
        last_activity_at = last_dt.isoformat().replace("+00:00", "Z")
        elapsed_seconds = max(0.0, (last_dt - first_dt).total_seconds())
    elif steps and steps[-1].created_at:
        last_activity_at = steps[-1].created_at

    return TranscriptProgress(
        conversation_id=conversation_id,
        total_steps=total_steps,
        tool_call_count=tool_call_count,
        tool_breakdown=tool_breakdown,
        thinking_cycle_count=thinking_cycle_count,
        user_prompt_count=user_prompt_count,
        first_prompt_snippet=first_prompt_snippet,
        last_activity_at=last_activity_at,
        elapsed_seconds=elapsed_seconds,
    )


__all__ = [
    "AGY_BRAIN_DIR",
    "TranscriptProgress",
    "TranscriptStep",
    "read_transcript",
    "resolve_transcript_path",
    "summarize_progress",
]
