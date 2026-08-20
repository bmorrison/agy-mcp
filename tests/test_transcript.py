"""Unit tests for transcript.py and agy_transcript tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from agy_mcp.safety import SafetyPolicy
from agy_mcp.server import _reset_state_for_tests, agy_transcript_tool
from agy_mcp.session_store import SessionStore
from agy_mcp.transcript import (
    TranscriptStep,
    read_transcript,
    resolve_transcript_path,
    summarize_progress,
)

VALID_UUID = "e2b77526-da2f-4c64-aaf8-ddd08767e6f9"

FIXTURE_JSONL = """\
{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-08-18T10:00:00Z","content":"<USER_REQUEST>Refactor authentication module</USER_REQUEST>"}
{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE","created_at":"2026-08-18T10:00:01Z"}
{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-18T10:00:05Z","thinking":"Planning step 1 with key Bearer sk-1234567890abcdef","tool_calls":[{"name":"view_file","args":{"path":"/Users/alice/auth.py","token":"secret_val"}}]}
{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-18T10:00:10Z","thinking":"Executing edit","tool_calls":[{"name":"replace_file_content","args":{"TargetFile":"auth.py"}}]}
"""


def test_resolve_transcript_path_valid():
    p = resolve_transcript_path(VALID_UUID)
    assert p.parts[-4:] == (VALID_UUID, ".system_generated", "logs", "transcript.jsonl")


def test_resolve_transcript_path_invalid():
    with pytest.raises(ValueError, match="invalid conversation_id"):
        resolve_transcript_path("not-a-uuid")
    with pytest.raises(ValueError, match="invalid conversation_id"):
        resolve_transcript_path("../../../etc/passwd")


def test_read_transcript_parses_fixture(tmp_path: Path):
    t_file = tmp_path / "transcript.jsonl"
    t_file.write_text(FIXTURE_JSONL, encoding="utf-8")

    steps = read_transcript(t_file)
    assert len(steps) == 4
    assert steps[0].source == "USER_EXPLICIT"
    assert steps[0].content == "<USER_REQUEST>Refactor authentication module</USER_REQUEST>"
    assert steps[2].thinking == "Planning step 1 with key Bearer sk-1234567890abcdef"
    assert len(steps[2].tool_calls) == 1
    assert steps[2].tool_calls[0]["name"] == "view_file"


def test_read_transcript_redacts_content(tmp_path: Path):
    t_file = tmp_path / "transcript.jsonl"
    t_file.write_text(FIXTURE_JSONL, encoding="utf-8")

    def mock_redact(text: str) -> str:
        return text.replace("sk-1234567890abcdef", "[REDACTED]").replace("/Users/alice", "~")

    steps = read_transcript(t_file, redact_fn=mock_redact)
    assert "[REDACTED]" in (steps[2].thinking or "")
    assert steps[2].tool_calls[0]["args"]["path"] == "~/auth.py"


def test_read_transcript_skips_malformed_lines(tmp_path: Path):
    content = (
        FIXTURE_JSONL
        + "\n{NOT VALID JSON}\n"
        + '{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-08-18T10:00:15Z"}\n'
    )
    t_file = tmp_path / "transcript.jsonl"
    t_file.write_text(content, encoding="utf-8")

    steps = read_transcript(t_file)
    assert len(steps) == 5


def test_read_transcript_caps_bytes(tmp_path: Path):
    t_file = tmp_path / "transcript.jsonl"
    t_file.write_text(FIXTURE_JSONL * 10, encoding="utf-8")

    steps = read_transcript(t_file, max_bytes=200)
    assert len(steps) < 40


def test_read_transcript_rejects_symlink(tmp_path: Path):
    target = tmp_path / "real.jsonl"
    target.write_text(FIXTURE_JSONL, encoding="utf-8")
    link = tmp_path / "symlink.jsonl"
    link.symlink_to(target)

    with pytest.raises(OSError, match="symlinked"):
        read_transcript(link)


def test_read_transcript_returns_empty_on_missing(tmp_path: Path):
    assert read_transcript(tmp_path / "nonexistent.jsonl") == []


def test_summarize_progress():
    steps = [
        TranscriptStep(
            step_index=0,
            source="USER_EXPLICIT",
            type="USER_INPUT",
            content="<USER_REQUEST>Fix bug in API</USER_REQUEST>",
            created_at="2026-08-18T10:00:00Z",
        ),
        TranscriptStep(
            step_index=1,
            source="MODEL",
            type="PLANNER_RESPONSE",
            thinking="Analyzing code",
            tool_calls=[{"name": "grep_search", "args": {}}],
            created_at="2026-08-18T10:00:05Z",
        ),
        TranscriptStep(
            step_index=2,
            source="MODEL",
            type="PLANNER_RESPONSE",
            thinking="Editing file",
            tool_calls=[{"name": "replace_file_content", "args": {}}],
            created_at="2026-08-18T10:00:15Z",
        ),
    ]
    prog = summarize_progress(VALID_UUID, steps)
    assert prog.total_steps == 3
    assert prog.tool_call_count == 2
    assert prog.tool_breakdown == {"grep_search": 1, "replace_file_content": 1}
    assert prog.thinking_cycle_count == 2
    assert prog.user_prompt_count == 1
    assert prog.first_prompt_snippet == "Fix bug in API"
    assert prog.last_activity_at == "2026-08-18T10:00:15Z"
    assert prog.elapsed_seconds == 15.0


def test_agy_transcript_tool_modes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _reset_state_for_tests()
    brain = tmp_path / "brain"
    t_dir = brain / VALID_UUID / ".system_generated" / "logs"
    t_dir.mkdir(parents=True)
    (t_dir / "transcript.jsonl").write_text(FIXTURE_JSONL, encoding="utf-8")

    monkeypatch.setattr("agy_mcp.transcript.AGY_BRAIN_DIR", brain)

    resp_prog = agy_transcript_tool(conversation_id=VALID_UUID, mode="progress")
    assert resp_prog.success is True
    assert resp_prog.mode == "progress"
    assert resp_prog.progress is not None
    assert resp_prog.progress["total_steps"] == 4

    resp_full = agy_transcript_tool(conversation_id=VALID_UUID, mode="transcript")
    assert resp_full.success is True
    assert resp_full.mode == "transcript"
    assert resp_full.transcript is not None
    assert len(resp_full.transcript) == 4


def test_agy_transcript_tool_invalid_args():
    _reset_state_for_tests()
    r1 = agy_transcript_tool(conversation_id=VALID_UUID, mode="invalid_mode")
    assert r1.success is False
    assert "mode must be 'progress' or 'transcript'" in (r1.error or "")

    r2 = agy_transcript_tool(conversation_id="not-a-uuid")
    assert r2.success is False
    assert "invalid conversation_id" in (r2.error or "")


def test_agy_transcript_tool_job_id_resolution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _reset_state_for_tests()
    session_root = tmp_path / "sessions"
    store = SessionStore(session_root)
    job_id = "job_1234567890_abcdef123456"
    store.create_job(job_id=job_id, session_id=VALID_UUID, backend="agy", cwd=".")

    brain = tmp_path / "brain"
    t_dir = brain / VALID_UUID / ".system_generated" / "logs"
    t_dir.mkdir(parents=True)
    (t_dir / "transcript.jsonl").write_text(FIXTURE_JSONL, encoding="utf-8")

    from agy_mcp import server
    from agy_mcp.config import Config
    from agy_mcp.supervisor import Supervisor

    cfg = Config()
    cfg.session_store.root = str(session_root)
    safety = SafetyPolicy.from_config(cfg)
    supervisor = Supervisor(store=store, config=cfg, safety=safety)

    server._config = cfg
    server._safety = safety
    server._store = store
    server._supervisor = supervisor

    monkeypatch.setattr("agy_mcp.transcript.AGY_BRAIN_DIR", brain)

    resp = agy_transcript_tool(job_id=job_id, mode="progress")
    assert resp.success is True
    assert resp.conversation_id == VALID_UUID
    assert resp.progress is not None
    assert resp.progress["total_steps"] == 4
