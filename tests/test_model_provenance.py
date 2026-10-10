"""Offline tests distinguishing selection evidence from inference identity."""

from agy_mcp.adapters.agy import AgyPrintBackend, _system_init_event
from agy_mcp.bridge import _adapter_meta, _dry_run_response
from agy_mcp.models import BridgeRequest, CanonicalEvent, Capability
from agy_mcp.provenance import model_selection
from agy_mcp.safety import SafetyPolicy


def _cap():
    return Capability(
        backend="agy",
        bin_path="/fake/agy",
        model="CLI configured default",
        supports_print=True,
        supports_model=True,
    )


def test_adapter_metadata_exposes_requested_not_effective(monkeypatch):
    adapter = AgyPrintBackend(safety=SafetyPolicy())
    monkeypatch.setattr(adapter, "detect", _cap)
    request = BridgeRequest(prompt="review", model="gemini-3.8-flash-high")
    metadata = _adapter_meta(adapter, request, SafetyPolicy()).model_dump()
    selection = metadata.get("model_selection", {})
    assert selection.get("requested") == request.model
    assert selection.get("configured") == "CLI configured default"
    assert selection.get("forwarded") is None
    assert selection.get("effective") is None
    assert selection.get("effective_source") == "unavailable"


def test_constructed_argv_evidence_is_not_effective_identity():
    request = BridgeRequest(prompt="review", model="chosen")
    selection = model_selection(request, _cap(), SafetyPolicy(), argv=["agy", "--model=chosen"])
    assert selection["forwarded"] == "chosen"
    assert selection["forwarding_source"] == "constructed_argv"
    assert selection["effective"] is None


def test_startup_default_and_conflicting_selectors_do_not_attest_inference():
    events = [
        CanonicalEvent(type="system", subtype="init", metadata={"model": "default"}),
        CanonicalEvent(type="system", subtype="print_starting", metadata={"model": "first"}),
        CanonicalEvent(type="system", subtype="print_starting", metadata={"model": "second"}),
        CanonicalEvent(type="system", subtype="print_starting", metadata={"model": None}),
    ]
    selection = model_selection(
        BridgeRequest(prompt="review", model="first"), _cap(), SafetyPolicy(), events=events
    )
    assert selection["observed_cli_selectors"] == ["first", "second"]
    assert selection["forwarded"] is None
    assert selection["effective"] is None


def test_omitted_selector_does_not_convert_configured_default_to_forwarding():
    selection = model_selection(
        BridgeRequest(prompt="review"), _cap(), SafetyPolicy(), argv=["agy"]
    )
    assert selection["requested"] is None
    assert selection["forwarded"] is None
    assert selection["configured"] == "CLI configured default"
    assert selection["effective"] is None


def test_model_evidence_is_redacted():
    secret = "Bearer abcdefghijklmnopqrstuvwxyz"
    cap = _cap().model_copy(update={"model": secret})
    selection = model_selection(
        BridgeRequest(prompt="review", model=secret),
        cap,
        SafetyPolicy(),
        argv=["agy", f"--model={secret}"],
    )
    assert "abcdefghijklmnopqrstuvwxyz" not in str(selection)
    assert selection["requested"] == "Bearer ***"


def test_unknown_or_wrong_backend_init_is_not_forwarding_evidence():
    event = CanonicalEvent(
        type="system",
        subtype="init",
        metadata={
            "backend": "gemini",
            "forwarded_model": "chosen",
            "forwarded_model_source": "constructed_argv",
        },
    )
    selection = model_selection(
        BridgeRequest(prompt="review", model="chosen"), _cap(), SafetyPolicy(), events=[event]
    )
    assert selection["forwarded"] is None


def test_dry_run_proves_command_not_runtime(monkeypatch, tmp_path):
    adapter = AgyPrintBackend(safety=SafetyPolicy())
    monkeypatch.setattr(adapter, "detect", _cap)
    response = _dry_run_response(
        BridgeRequest(prompt="review", model="chosen", debug=True, dry_run=True),
        adapter,
        tmp_path,
        SafetyPolicy(),
        [],
    )
    selection = response.adapter.model_dump().get("model_selection", {})
    assert selection.get("forwarded") == "chosen"
    assert selection.get("effective") is None


def test_init_records_actual_constructed_selector_for_continuation(monkeypatch):
    adapter = AgyPrintBackend(safety=SafetyPolicy())
    cap = _cap().model_copy(update={"supports_conversation": True})
    monkeypatch.setattr(adapter, "detect", lambda: cap)
    request = BridgeRequest(prompt="review", model="chosen", session_id="prior")
    argv = adapter.build_command(request, log_path=None)
    event = _system_init_event(request=request, cap=cap, argv=argv)
    assert event.metadata["forwarded_model"] == "chosen"
    selection = model_selection(request, cap, SafetyPolicy(), events=[event])
    assert selection["forwarded"] == "chosen"
    assert selection["effective"] is None
