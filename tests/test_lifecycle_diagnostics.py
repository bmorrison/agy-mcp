"""Durable supervisor diagnostics; all adapter/process interactions are mocked."""

import threading
from pathlib import Path

import pytest

from agy_mcp.adapters.base import AdapterRunResult
from agy_mcp.config import Config
from agy_mcp.models import BridgeRequest, CanonicalEvent
from agy_mcp.session_store import SessionStore
from agy_mcp.supervisor import Supervisor


@pytest.fixture
def supervisor(tmp_path, monkeypatch):
    monkeypatch.setattr("agy_mcp.supervisor._process_start_signature", lambda pid: "owner")
    return Supervisor(store=SessionStore(tmp_path / "sessions"), config=Config())


def _result(*, exit_code=0, events=None, **kwargs):
    return AdapterRunResult(
        events=events or [],
        session_id="session",
        exit_code=exit_code,
        duration_ms=1,
        stdout_tail="",
        stderr_tail="",
        log_path=None,
        artifacts=[{"path": "change.patch"}],
        **kwargs,
    )


def _finalize(supervisor, tmp_path, result, *, cancelled=False, run_error=None):
    record = supervisor.store.create_job(cwd=str(tmp_path), extra={"preserved": True})
    cancel = threading.Event()
    if cancelled:
        cancel.set()
    supervisor._finalize(
        job_id=record.job_id,
        result=result,
        run_error=run_error,
        cancel_event=cancel,
        request=BridgeRequest(prompt="test", cwd=str(tmp_path)),
        route_warnings=[],
    )
    return supervisor.status(record.job_id)


@pytest.mark.parametrize("event_type", ["error", "result"])
def test_finalize_persists_explicit_wrapper_timeout(supervisor, tmp_path, event_type):
    event = CanonicalEvent(type=event_type, subtype="wrapper_timeout", text="deadline")
    record = _finalize(supervisor, tmp_path, _result(exit_code=-15, events=[event]))
    assert record.status == "failed"
    assert record.extra["lifecycle"]["termination_reason"] == "wrapper_timeout"
    assert record.extra["lifecycle"]["adapter_returned"] is True
    assert record.artifacts == [{"path": "change.patch"}]
    assert record.extra["preserved"] is True


@pytest.mark.parametrize(
    "result,cancelled,run_error,status,reason",
    [
        (_result(), False, None, "completed", "completed"),
        (_result(), True, None, "completed", "completed"),
        (_result(exit_code=None), True, None, "cancelled", "cancelled"),
        (_result(exit_code=2), False, None, "failed", "nonzero_exit"),
        (
            _result(exit_code=2, events=[CanonicalEvent(type="error", text="timeout")]),
            False,
            None,
            "failed",
            "nonzero_exit",
        ),
        (
            _result(had_upstream_error=True, upstream_error_text="upstream"),
            False,
            None,
            "upstream_error",
            "upstream_error",
        ),
        (
            _result(had_incomplete_error=True, incomplete_error_text="empty output"),
            False,
            None,
            "failed",
            "incomplete_response",
        ),
        (
            _result(had_incomplete_error=True, incomplete_error_text="missing footer"),
            False,
            None,
            "failed",
            "incomplete_response",
        ),
        (None, False, "adapter crashed", "failed", "adapter_error"),
    ],
)
def test_finalize_cause_and_acceptance_boundary(
    supervisor,
    tmp_path,
    result,
    cancelled,
    run_error,
    status,
    reason,
):
    record = _finalize(supervisor, tmp_path, result, cancelled=cancelled, run_error=run_error)
    diagnostics = record.extra["lifecycle"]
    assert record.status == status
    assert diagnostics["termination_reason"] == reason
    assert diagnostics["cancel_requested"] is cancelled
    assert diagnostics["adapter_returned"] is (result is not None)
    assert diagnostics["validation"] == "not_reported"
    assert diagnostics["parent_acceptance"] == "not_recorded"
    assert diagnostics["evidence"] == {
        "events": record.events_path,
        "stdout": record.stdout_path,
        "stderr": record.stderr_path,
        "log": record.log_path,
    }
    # References must not claim the named evidence was written or is complete.
    assert not Path(supervisor.store.get_job(record.job_id).stdout_path).exists()
    reloaded = Supervisor(store=supervisor.store, config=Config()).status(record.job_id)
    assert reloaded.extra["lifecycle"] == diagnostics


@pytest.mark.parametrize("identity,expected", [("owner", "running"), ("stale", "failed")])
def test_restart_preserves_foreign_identity_protection(supervisor, monkeypatch, identity, expected):
    record = supervisor.store.create_job(
        extra={
            "supervisor": {
                "pid": 123,
                "instance_id": "foreign",
                "process_start_signature": identity,
            }
        }
    )
    monkeypatch.setattr("agy_mcp.supervisor._process_start_signature", lambda pid: "owner")
    public = supervisor.status(record.job_id)
    assert public.status == expected
    if expected == "running":
        assert "lifecycle" not in public.extra
    else:
        diagnostics = public.extra["lifecycle"]
        assert diagnostics["termination_reason"] == "worker_lost"
        assert diagnostics["cancel_requested"] is None
        assert diagnostics["adapter_returned"] is None
        assert diagnostics["parent_acceptance"] == "not_recorded"
        assert supervisor.store.get_job(record.job_id).extra["lifecycle"] == diagnostics


def _adapter(run):
    from types import SimpleNamespace

    from agy_mcp.models import Capability

    return SimpleNamespace(
        detect=lambda: Capability(
            backend="agy",
            bin_path="/mock/agy",
            authenticated=True,
            supports_log_file=True,
        ),
        run=run,
    )


def test_worker_exception_keeps_real_evidence_and_diagnostics(supervisor, tmp_path):
    def run(request, *, stdout_path, stderr_path, log_path, event_sink, cancel_event):
        stdout_path.write_text("partial output", encoding="utf-8")
        stderr_path.write_text("stderr evidence", encoding="utf-8")
        log_path.write_text("log evidence", encoding="utf-8")
        event_sink.emit(CanonicalEvent(type="assistant", text="observed progress"))
        raise RuntimeError("Authorization: Bearer abcdef123456abcdef123456abcdef")

    supervisor._adapter_factory = lambda *args: (_adapter(run), [])
    response = supervisor.start(BridgeRequest(prompt="test", cwd=str(tmp_path)))
    assert response.success
    # Join the registered worker rather than poll status while it finalizes.
    with supervisor._lock:
        handle = supervisor._jobs.get(response.job_id)
    if handle is not None:
        handle.thread.join(timeout=3)
        assert not handle.thread.is_alive()
    public = supervisor.status(response.job_id)
    persisted = supervisor.store.get_job(response.job_id)
    assert public.status == "failed"
    assert "abcdef123456" not in public.error
    assert public.extra["lifecycle"]["termination_reason"] == "adapter_error"
    assert public.extra["lifecycle"]["adapter_returned"] is False
    assert Path(persisted.stdout_path).read_text(encoding="utf-8") == "partial output"
    assert Path(persisted.stderr_path).read_text(encoding="utf-8") == "stderr evidence"
    assert Path(persisted.log_path).read_text(encoding="utf-8") == "log evidence"
    assert [e.text for e in supervisor.read_events(response.job_id)] == ["observed progress"]


def test_running_and_late_cancel_observation(supervisor, tmp_path):
    entered = threading.Event()
    release = threading.Event()

    def run(request, **kwargs):
        entered.set()
        assert release.wait(timeout=3)
        return _result()

    supervisor._adapter_factory = lambda *args: (_adapter(run), [])
    response = supervisor.start(BridgeRequest(prompt="test", cwd=str(tmp_path)))
    assert entered.wait(timeout=3)
    with supervisor._lock:
        handle = supervisor._jobs[response.job_id]
    try:
        running = supervisor.status(response.job_id)
        assert running.extra["lifecycle"]["termination_reason"] == "running"
        assert running.extra["lifecycle"]["adapter_returned"] is None
        assert supervisor.cancel(response.job_id)
    finally:
        release.set()
        handle.thread.join(timeout=3)
    assert not handle.thread.is_alive()
    public = supervisor.status(response.job_id)
    assert public.status == "completed"
    assert public.extra["lifecycle"]["cancel_requested"] is True
    assert public.extra["lifecycle"]["termination_reason"] == "completed"


def test_worker_start_failure_diagnostics(supervisor, tmp_path, monkeypatch):
    def fail_start(thread):
        raise RuntimeError("mock thread failure")

    monkeypatch.setattr("agy_mcp.supervisor.threading.Thread.start", fail_start)
    supervisor._adapter_factory = lambda *args: (_adapter(lambda *args, **kwargs: _result()), [])
    response = supervisor.start(
        BridgeRequest(prompt="test", cwd=str(tmp_path)),
        job_id="job_start_failure",
    )
    assert not response.success
    public = supervisor.status("job_start_failure")
    assert public.status == "failed"
    assert public.finished_at is not None
    assert public.extra["lifecycle"]["termination_reason"] == "worker_start_failed"
    assert public.extra["lifecycle"]["adapter_returned"] is False


def test_terminal_diagnostics_share_atomic_update(supervisor, tmp_path, monkeypatch):
    snapshots = []
    update = supervisor.store.update_job

    def capture(record):
        snapshots.append(record.model_dump())
        return update(record)

    monkeypatch.setattr(supervisor.store, "update_job", capture)
    record = _finalize(supervisor, tmp_path, _result())
    assert len(snapshots) == 1
    assert snapshots[0]["status"] == "completed"
    assert snapshots[0]["artifacts"] == [{"path": "change.patch"}]
    assert snapshots[0]["extra"]["lifecycle"] == record.extra["lifecycle"]
