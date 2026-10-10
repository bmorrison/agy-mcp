"""Quota projection fixtures grounded in agy's canonical upstream errors."""

import threading

import pytest

from agy_mcp.adapters.agy import AgyPrintBackend, _handle_klog_line
from agy_mcp.adapters.base import _RunContext
from agy_mcp.diagnostics import project_quota_diagnostic
from agy_mcp.models import CanonicalEvent
from agy_mcp.safety import SafetyPolicy


def test_project_quota_diagnostic_known_upstream_error():
    ctx = _RunContext(
        stdout_buf=[],
        stderr_buf=[],
        events=[],
        seen_session_id=[None],
        stop_event=threading.Event(),
        sink=None,
        transcript_seen=set(),
    )
    _handle_klog_line(
        "E0527 12:00:00.000 1 log.go:1] "
        "RESOURCE_EXHAUSTED (code 429): quota exhausted for project.",
        ctx,
        AgyPrintBackend(safety=SafetyPolicy()),
    )
    assert ctx.events[0].subtype == "upstream_resource_exhausted"
    assert project_quota_diagnostic(
        ctx.events,
        requested_backend="agy",
        requested_model="flash",
        safety=SafetyPolicy(),
    ) == {
        "kind": "quota_exhausted",
        "upstream_subtype": "upstream_resource_exhausted",
        "requested_backend": "agy",
        "requested_model": "flash",
        "evidence": "quota exhausted for project.",
        "remaining_quota": None,
        "reset_at": None,
        "retry_after_seconds": None,
    }


def project(events, *, backend="agy", model=None):
    return project_quota_diagnostic(
        events,
        requested_backend=backend,
        requested_model=model,
        safety=SafetyPolicy(),
    )


@pytest.mark.parametrize(
    "subtype,text,kind",
    [
        ("upstream_resource_exhausted", "quota exceeded for project", "quota_exhausted"),
        ("upstream_resource_exhausted", "rate limit exceeded", "rate_limited"),
        ("upstream_resource_exhausted", "rate-limited", "rate_limited"),
        ("upstream_resource_exhausted", "out of memory", "resource_exhausted_unknown"),
        ("upstream_resource_exhausted", None, "resource_exhausted_unknown"),
        ("upstream_resource_exhausted", "quota check failed", "resource_exhausted_unknown"),
        (
            "upstream_resource_exhausted",
            "quota exhausted; rate limited",
            "resource_exhausted_unknown",
        ),
        (
            "upstream_agent_executor_error",
            "RESOURCE_EXHAUSTED (code 429): quota exhausted for project.",
            "quota_exhausted",
        ),
        (
            "upstream_agent_executor_error",
            "RESOURCE_EXHAUSTED (code 8): rate limit exceeded",
            "rate_limited",
        ),
        (
            "upstream_agent_executor_error",
            "RESOURCE_EXHAUSTED (code 8): memory exhausted",
            "resource_exhausted_unknown",
        ),
    ],
)
def test_project_quota_diagnostic_classification(subtype, text, kind):
    diagnostic = project([CanonicalEvent(type="error", subtype=subtype, text=text)])
    assert diagnostic["kind"] == kind
    assert diagnostic["upstream_subtype"] == subtype
    assert diagnostic["requested_model"] is None
    assert diagnostic["remaining_quota"] is None
    assert diagnostic["reset_at"] is None
    assert diagnostic["retry_after_seconds"] is None


@pytest.mark.parametrize(
    "event_type,subtype,text",
    [
        ("user", "upstream_resource_exhausted", "quota exhausted"),
        ("assistant", "upstream_resource_exhausted", "quota exhausted"),
        ("result", "upstream_error", "RESOURCE_EXHAUSTED (code 429): quota exhausted"),
        ("system", "init", "RESOURCE_EXHAUSTED (code 429): quota exhausted"),
        ("error", "upstream_unauthenticated", "quota exhausted"),
        ("error", "upstream_permission_denied", "quota exhausted"),
        ("error", "upstream_failed_precondition", "quota exhausted"),
        ("error", "auth_error", "quota exhausted"),
        ("error", "upstream_agent_executor_error", "UNAUTHENTICATED (code 401): quota exhausted"),
        (
            "error",
            "upstream_agent_executor_error",
            "prompt mentioned RESOURCE_EXHAUSTED (code 429): quota exhausted",
        ),
        ("error", None, "quota exhausted"),
    ],
)
def test_project_quota_diagnostic_ignores_untrusted_or_nonresource_errors(
    event_type, subtype, text
):
    assert project([CanonicalEvent(type=event_type, subtype=subtype, text=text)]) is None


def test_project_quota_diagnostic_empty_events():
    assert project([]) is None


@pytest.mark.parametrize("reverse", [False, True])
def test_project_quota_diagnostic_unknown_does_not_hide_explicit_evidence(reverse):
    events = [
        CanonicalEvent(type="error", subtype="upstream_resource_exhausted", text="out of memory"),
        CanonicalEvent(type="error", subtype="upstream_resource_exhausted", text="quota exhausted"),
    ]
    if reverse:
        events.reverse()
    assert project(events)["kind"] == "quota_exhausted"


def test_project_quota_diagnostic_first_explicit_wins_ties():
    events = [
        CanonicalEvent(type="error", subtype="upstream_resource_exhausted", text="rate limited"),
        CanonicalEvent(type="error", subtype="upstream_resource_exhausted", text="quota exhausted"),
    ]
    assert project(events)["kind"] == "rate_limited"


def test_project_quota_diagnostic_redacts_without_mutating_source():
    text = "quota exhausted Authorization: Bearer secretvalue /Users/alice/project"
    event = CanonicalEvent(type="error", subtype="upstream_resource_exhausted", text=text)
    diagnostic = project([event], backend="/Users/alice/agy", model="Bearer secretvalue")
    assert diagnostic["evidence"] == "quota exhausted Authorization: *** *** ~/project"
    assert diagnostic["requested_backend"] == "~/agy"
    assert diagnostic["requested_model"] == "Bearer ***"
    assert event.text == text


def test_project_quota_diagnostic_does_not_parse_unverified_timing_or_counter():
    event = CanonicalEvent(
        type="error",
        subtype="upstream_resource_exhausted",
        text="quota exhausted; retry after 60 seconds; reset_at=2026-10-11T00:00:00Z; remaining=0",
        metadata={"retry_after_seconds": 60, "remaining_quota": 0},
    )
    diagnostic = project([event])
    assert diagnostic["remaining_quota"] is None
    assert diagnostic["reset_at"] is None
    assert diagnostic["retry_after_seconds"] is None
