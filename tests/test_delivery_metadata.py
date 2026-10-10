"""Offline sync/background integration gates for selection and quota evidence."""

from __future__ import annotations

import threading

import pytest

from agy_mcp.adapters.base import AdapterRunResult, BaseAdapter
from agy_mcp.bridge import _run
from agy_mcp.config import Config
from agy_mcp.doctor import DoctorReport
from agy_mcp.models import BridgeRequest, CanonicalEvent, Capability
from agy_mcp.safety import SafetyPolicy
from agy_mcp.session_store import SessionStore
from agy_mcp.supervisor import Supervisor


class EvidenceAdapter(BaseAdapter):
    backend = "agy"

    def __init__(
        self,
        subtype="upstream_resource_exhausted",
        text="quota exhausted for project.",
        exit_code=0,
    ):
        super().__init__(safety=SafetyPolicy())
        self.subtype = subtype
        self.text = text
        self.exit_code = exit_code
        self.finished = threading.Event()

    def _probe(self):
        return Capability(
            backend="agy",
            bin_path="/fake/agy",
            authenticated=True,
            model="default",
            supports_print=True,
            supports_model=True,
        )

    def build_command(self, request, *, log_path):
        return ["/fake/agy", f"--model={request.model}"]

    def run(self, request, *, event_sink=None, **kwargs):
        events = [
            CanonicalEvent(
                type="system",
                subtype="init",
                metadata={
                    "backend": "agy",
                    "model": "default",
                    "forwarded_model": request.model,
                    "forwarded_model_source": "constructed_argv",
                },
            ),
            CanonicalEvent(
                type="system", subtype="print_starting", metadata={"model": request.model}
            ),
            CanonicalEvent(type="error", subtype=self.subtype, text=self.text),
        ]
        if event_sink is not None:
            for event in events:
                event_sink.emit(event)
        self.finished.set()
        return AdapterRunResult(
            events=events,
            session_id=request.session_id or "session",
            exit_code=self.exit_code,
            duration_ms=1,
            stdout_tail="",
            stderr_tail="",
            log_path=None,
            artifacts=[],
            had_upstream_error=True,
            upstream_error_text=self.text,
        )


@pytest.mark.parametrize("session_id", [None, "prior"])
@pytest.mark.parametrize("exit_code", [0, 1])
def test_sync_failure_keeps_quota_and_selection_without_all_messages(
    monkeypatch, tmp_path, session_id, exit_code
):
    adapter = EvidenceAdapter(exit_code=exit_code)
    monkeypatch.setattr("agy_mcp.bridge._build_adapter", lambda *args, **kwargs: adapter)
    response = _run(
        BridgeRequest(
            prompt="review", cwd=str(tmp_path), backend="agy", model="chosen", session_id=session_id
        ),
        Config(),
        SafetyPolicy(),
    )
    assert not response.success
    assert response.all_messages == []
    assert response.adapter.quota["kind"] == "quota_exhausted"
    assert response.adapter.quota["requested_model"] == "chosen"
    assert response.adapter.quota["remaining_quota"] is None
    assert response.adapter.model_selection["configured"] == "default"
    assert response.adapter.model_selection["requested"] == "chosen"
    assert response.adapter.model_selection["forwarded"] == "chosen"
    assert response.adapter.model_selection["observed_cli_selectors"] == ["chosen"]
    assert response.adapter.model_selection["effective"] is None


def test_background_quota_and_provenance_survive_reload(tmp_path):
    adapter = EvidenceAdapter()
    store = SessionStore(tmp_path / "sessions")
    supervisor = Supervisor(
        config=Config(),
        safety=SafetyPolicy(),
        store=store,
        adapter_factory=lambda *args, **kwargs: (adapter, []),
    )
    response = supervisor.start(
        BridgeRequest(prompt="review", cwd=str(tmp_path), backend="agy", model="chosen")
    )
    assert response.success and response.status == "running"
    assert response.adapter.model_selection["requested"] == "chosen"
    assert response.adapter.model_selection["forwarded"] is None
    assert adapter.finished.wait(2)
    # Joining the owned mock thread is deterministic; no live CLI/process.
    handle = supervisor._jobs.get(response.job_id)
    if handle is not None:
        handle.thread.join(2)
    record = supervisor.status(response.job_id)
    assert record.status == "upstream_error"
    assert record.extra["quota"]["kind"] == "quota_exhausted"
    assert record.extra["model_selection"]["forwarded"] == "chosen"
    assert record.extra["model_selection"]["effective"] is None
    assert record.extra["lifecycle"]["validation"] == "not_reported"
    assert record.extra["lifecycle"]["parent_acceptance"] == "not_recorded"
    reloaded = Supervisor(config=Config(), safety=SafetyPolicy(), store=SessionStore(store.root))
    assert reloaded.status(response.job_id).extra == record.extra


def test_auth_failure_is_not_subscription_quota(monkeypatch, tmp_path):
    adapter = EvidenceAdapter(
        subtype="upstream_unauthenticated", text="quota exhausted is not the auth issue"
    )
    monkeypatch.setattr("agy_mcp.bridge._build_adapter", lambda *args, **kwargs: adapter)
    response = _run(
        BridgeRequest(prompt="review", cwd=str(tmp_path), backend="agy", model="chosen"),
        Config(),
        SafetyPolicy(),
    )
    assert not response.success
    assert response.adapter.quota is None


class EmitThenRaiseAdapter(EvidenceAdapter):
    def run(self, request, **kwargs):
        super().run(request, **kwargs)
        raise RuntimeError("adapter crashed after emitting diagnostics")


def test_sync_exception_preserves_emitted_diagnostics(monkeypatch, tmp_path):
    adapter = EmitThenRaiseAdapter()
    monkeypatch.setattr("agy_mcp.bridge._build_adapter", lambda *args, **kwargs: adapter)
    response = _run(
        BridgeRequest(prompt="review", cwd=str(tmp_path), backend="agy", model="chosen"),
        Config(),
        SafetyPolicy(),
    )
    assert not response.success
    assert "adapter crashed" in response.error
    assert response.adapter.quota is not None
    assert response.adapter.quota["kind"] == "quota_exhausted"
    assert response.adapter.model_selection["forwarded"] == "chosen"


def test_background_exception_preserves_emitted_diagnostics_and_reload(tmp_path):
    adapter = EmitThenRaiseAdapter()
    store = SessionStore(tmp_path / "sessions")
    supervisor = Supervisor(
        config=Config(),
        safety=SafetyPolicy(),
        store=store,
        adapter_factory=lambda *args, **kwargs: (adapter, []),
    )
    response = supervisor.start(
        BridgeRequest(prompt="review", cwd=str(tmp_path), backend="agy", model="chosen")
    )
    assert adapter.finished.wait(2)
    handle = supervisor._jobs.get(response.job_id)
    if handle is not None:
        handle.thread.join(2)
    record = supervisor.status(response.job_id)
    assert record.status == "failed"
    assert record.extra["lifecycle"]["adapter_returned"] is False
    assert record.extra["lifecycle"]["termination_reason"] == "adapter_error"
    assert record.extra["quota"] is not None
    assert record.extra["quota"]["kind"] == "quota_exhausted"
    assert record.extra["model_selection"]["forwarded"] == "chosen"
    assert record.last_event_at is not None
    assert len(store.read_events(response.job_id)) == 3
    assert (
        Supervisor(config=Config(), safety=SafetyPolicy(), store=store)
        .status(response.job_id)
        .extra
        == record.extra
    )


def test_healthy_doctor_does_not_imply_quota_available():
    report = DoctorReport(healthy=True).to_dict()
    assert report["healthy"] is True
    assert report["quota"]["availability"] == "unknown"
    assert report["quota"]["remaining_quota"] is None
    assert report["quota"]["source"] == "not_probed"
