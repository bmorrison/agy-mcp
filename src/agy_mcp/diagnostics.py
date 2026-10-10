"""Pure, redacted projections of adapter error evidence (no quota probes)."""

from __future__ import annotations

import re
from collections.abc import Sequence

from agy_mcp.models import CanonicalEvent
from agy_mcp.safety import SafetyPolicy

_RESOURCE_WRAPPER = re.compile(r"^RESOURCE_EXHAUSTED \(code \d+\):\s*(.*)$", re.DOTALL)
_QUOTA_EXHAUSTED = re.compile(r"\bquota (?:exhausted|exceeded)\b", re.IGNORECASE)
_RATE_LIMITED = re.compile(r"\brate[ -]limit(?:ed| exceeded| reached)?\b", re.IGNORECASE)


def project_quota_diagnostic(
    events: Sequence[CanonicalEvent],
    *,
    requested_backend: str,
    requested_model: str | None,
    safety: SafetyPolicy,
) -> dict[str, object] | None:
    """Project trusted exhaustion errors, never prompts or terminal summaries.

    Quota means only the literal error claim, not subscription entitlement.
    Explicit quota/rate evidence wins over generic exhaustion; first explicit
    evidence wins ties. Conflicting claims in one message remain unknown.
    Counters and timing stay null: this seam has no verified numeric source.
    """
    selected: dict[str, object] | None = None
    for event in events:
        if event.type != "error":
            continue
        text = event.text or ""
        if event.subtype == "upstream_agent_executor_error":
            match = _RESOURCE_WRAPPER.fullmatch(text)
            if match is None:
                continue
            message = match.group(1)
        elif event.subtype == "upstream_resource_exhausted":
            message = text
        else:
            continue

        # Classify the redacted evidence too: a secret cannot act as a signal.
        evidence = safety.redact(message)
        quota = bool(_QUOTA_EXHAUSTED.search(evidence))
        rate = bool(_RATE_LIMITED.search(evidence))
        if quota and not rate:
            kind = "quota_exhausted"
        elif rate and not quota:
            kind = "rate_limited"
        else:
            kind = "resource_exhausted_unknown"
        diagnostic: dict[str, object] = {
            "kind": kind,
            "upstream_subtype": event.subtype,
            "requested_backend": safety.redact(requested_backend),
            "requested_model": (
                safety.redact(requested_model) if requested_model is not None else None
            ),
            "evidence": safety.redact(text),
            "remaining_quota": None,
            "reset_at": None,
            "retry_after_seconds": None,
        }
        if selected is None or (
            selected["kind"] == "resource_exhausted_unknown"
            and kind != "resource_exhausted_unknown"
        ):
            selected = diagnostic
    return selected
