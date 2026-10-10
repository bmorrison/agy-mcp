"""Prefix byte-budget and sample-scoped freshness contracts."""

import json
import os
from pathlib import Path

import pytest

from agy_mcp import transcript
from agy_mcp.server import _reset_state_for_tests, agy_transcript_tool
from agy_mcp.transcript import read_transcript, read_transcript_sample, summarize_progress

UUID = "e2b77526-da2f-4c64-aaf8-ddd08767e6f9"


def record(timestamp="2026-08-18T10:00:00Z", content="hello"):
    return (
        json.dumps({"content": content, "created_at": timestamp}, ensure_ascii=False) + "\n"
    ).encode()


def test_read_transcript_first_oversized_line_respects_raw_budget(tmp_path: Path):
    path = tmp_path / "transcript.jsonl"
    path.write_bytes(record(content="x" * 2000))
    assert read_transcript(path, max_bytes=1000) == []
    result = read_transcript_sample(path, max_bytes=1000)
    assert result.sample.bytes_read == 1000
    assert result.sample.partial_line_bytes == 1000
    assert result.sample.truncated and not result.sample.complete


def test_read_transcript_sample_bounds_actual_invalid_line_reads(tmp_path, monkeypatch):
    path = tmp_path / "transcript.jsonl"
    path.write_bytes(b"bad\n" * 1000 + record())
    original_read = os.read
    read_sizes = []

    def tracked_read(fd, count):
        data = original_read(fd, count)
        read_sizes.append(len(data))
        return data

    monkeypatch.setattr(transcript.os, "read", tracked_read)
    result = read_transcript_sample(path, 1000)
    assert sum(read_sizes) == result.sample.bytes_read == 1000
    assert result.steps == []
    assert result.sample.malformed_line_count == 250
    assert result.sample.truncated and not result.sample.complete


def test_read_transcript_sample_exact_budget_and_empty_file(tmp_path):
    path = tmp_path / "transcript.jsonl"
    data = record()
    path.write_bytes(data)
    result = read_transcript_sample(path, len(data))
    assert len(result.steps) == 1
    assert result.sample.complete and not result.sample.truncated
    assert result.sample.byte_start == 0
    assert result.sample.byte_end == len(data)
    assert result.sample.file_size_before == result.sample.file_size_after == len(data)
    path.write_bytes(b"")
    result = read_transcript_sample(path)
    assert result.steps == []
    assert result.sample.availability == "available" and result.sample.complete


def test_read_transcript_sample_partial_append_then_completed_line(tmp_path):
    path = tmp_path / "transcript.jsonl"
    data = record()
    path.write_bytes(data + b'{"content":"pending"}')
    partial = read_transcript_sample(path)
    assert len(partial.steps) == 1
    assert partial.sample.partial_line_bytes == len(b'{"content":"pending"}')
    assert not partial.sample.complete and not partial.sample.truncated
    with path.open("ab") as fp:
        fp.write(b"\n")
    complete = read_transcript_sample(path)
    assert len(complete.steps) == 2 and complete.sample.complete


def test_read_transcript_sample_multibyte_and_invalid_utf8(tmp_path):
    path = tmp_path / "transcript.jsonl"
    data = record(content="雪")
    path.write_bytes(data)
    cutoff = data.index("雪".encode()) + 1
    partial = read_transcript_sample(path, cutoff)
    assert partial.steps == []
    assert partial.sample.bytes_read == cutoff
    assert partial.sample.partial_line_bytes == cutoff
    assert partial.sample.malformed_line_count == 0
    assert read_transcript_sample(path).steps[0].content == "雪"
    path.write_bytes(b'{"content":"\xff"}\n' + record())
    result = read_transcript_sample(path)
    assert len(result.steps) == 1
    assert result.sample.malformed_line_count == 1 and not result.sample.complete


def test_read_transcript_sample_malformed_and_non_object_json(tmp_path):
    path = tmp_path / "transcript.jsonl"
    path.write_bytes(b"{bad}\n[]\n\n" + record())
    result = read_transcript_sample(path)
    assert len(result.steps) == 1
    assert result.sample.malformed_line_count == 2
    assert not result.sample.complete


def test_read_transcript_sample_append_during_read_compares_descriptor(tmp_path, monkeypatch):
    path = tmp_path / "transcript.jsonl"
    first = record()
    path.write_bytes(first)
    original_read = os.read

    def append_read(fd, count):
        data = original_read(fd, count)
        with path.open("ab") as fp:
            fp.write(record("2026-08-18T11:00:00Z"))
        return data

    monkeypatch.setattr(transcript.os, "read", append_read)
    result = read_transcript_sample(path, 5000)
    assert len(result.steps) == 1
    assert result.sample.bytes_read == len(first)
    assert result.sample.size_changed and result.sample.truncated
    assert result.sample.file_size_after > result.sample.file_size_before
    assert not result.sample.complete


def test_read_transcript_sample_descriptor_size_limit_after_path_check(tmp_path, monkeypatch):
    path = tmp_path / "transcript.jsonl"
    path.write_bytes(record())
    original_open = transcript.open_transcript_no_follow

    def grow_then_open(target):
        with target.open("ab") as fp:
            fp.truncate(transcript._MAX_TRANSCRIPT_BYTES + 1)
        return original_open(target)

    monkeypatch.setattr(transcript, "open_transcript_no_follow", grow_then_open)
    with pytest.raises(ValueError, match="exceeds"):
        read_transcript_sample(path)


@pytest.mark.parametrize("mode", ["progress", "transcript"])
@pytest.mark.parametrize("exists", [True, False])
def test_agy_transcript_empty_missing_sample_envelopes(tmp_path, monkeypatch, mode, exists):
    _reset_state_for_tests()
    monkeypatch.setattr(transcript, "AGY_BRAIN_DIR", tmp_path)
    path = transcript.resolve_transcript_path(UUID)
    if exists:
        path.parent.mkdir(parents=True)
        path.write_bytes(b"")
    result = agy_transcript_tool(conversation_id=UUID, mode=mode)
    assert result.success and result.step_count == 0
    assert result.sample["availability"] == ("available" if exists else "missing")
    assert result.sample["complete"] is exists
    assert result.sample["bytes_read"] == 0
    assert result.sample["scope"] == "prefix"


@pytest.mark.parametrize("mode", ["progress", "transcript"])
def test_agy_transcript_small_large_budget_stale_prefix_negative_control(
    tmp_path, monkeypatch, mode
):
    _reset_state_for_tests()
    monkeypatch.setattr(transcript, "AGY_BRAIN_DIR", tmp_path)
    path = transcript.resolve_transcript_path(UUID)
    path.parent.mkdir(parents=True)
    first = record(content="x" * 1000)
    assert len(first) > 1000
    path.write_bytes(record() + first + record("2026-08-18T11:00:00Z"))
    small = agy_transcript_tool(conversation_id=UUID, mode=mode, max_bytes=1000)
    large = agy_transcript_tool(conversation_id=UUID, mode=mode, max_bytes=5000)
    assert small.step_count == 1 and large.step_count == 3
    assert small.sample["truncated"] and not small.sample["complete"]
    assert large.sample["complete"] and not large.sample["truncated"]
    assert small.sample["counts_scope"] == large.sample["counts_scope"] == "sample"
    assert small.sample["last_activity_at_scope"] == "sample"
    if mode == "progress":
        assert small.progress["last_activity_at"] == "2026-08-18T10:00:00Z"
        assert large.progress["last_activity_at"] == "2026-08-18T11:00:00Z"
    else:
        assert small.transcript[-1]["created_at"] == "2026-08-18T10:00:00Z"
        assert large.transcript[-1]["created_at"] == "2026-08-18T11:00:00Z"


def test_read_transcript_sample_append_between_polls_does_not_invent_freshness(tmp_path):
    path = tmp_path / "transcript.jsonl"
    first = record()
    path.write_bytes(first)
    before = read_transcript_sample(path, len(first))
    with path.open("ab") as fp:
        fp.write(record("2026-08-18T11:00:00Z"))
    after = read_transcript_sample(path, len(first))
    assert before.sample.complete and after.sample.truncated
    assert (
        summarize_progress(UUID, before.steps).last_activity_at
        == summarize_progress(UUID, after.steps).last_activity_at
    )
    assert after.sample.file_size_after > before.sample.file_size_after
