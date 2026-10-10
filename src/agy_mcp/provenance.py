"""Honest model-selection evidence, separate from effective inference identity."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agy_mcp.models import BridgeRequest, CanonicalEvent, Capability
from agy_mcp.safety import SafetyPolicy


def model_selection(
    request: BridgeRequest,
    capability: Capability | None,
    safety: SafetyPolicy,
    *,
    events: Sequence[CanonicalEvent] = (),
    argv: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Project observed command/log evidence without claiming an effective model.

    ``forwarded`` means a selector was present in a constructed command, not
    that the CLI accepted it or the provider used that model. Startup/default
    labels and print-starting selectors are not serving attestations.
    """
    requested = safety.redact(request.model) if request.model is not None else None
    configured = (
        safety.redact(capability.model)
        if capability is not None and capability.model is not None
        else None
    )
    forwarded: str | None = None
    if request.model is not None and argv is not None:
        if list(argv).count(f"--model={request.model}") == 1:
            forwarded = requested
    observed: list[str] = []
    for event in events:
        if event.type != "system":
            continue
        if event.subtype == "init":
            selector = event.metadata.get("forwarded_model")
            if (
                requested is not None
                and isinstance(selector, str)
                and safety.redact(selector) == requested
                and event.metadata.get("forwarded_model_source") == "constructed_argv"
                and event.metadata.get("backend") in ("agy", "gemini")
                and (capability is None or event.metadata.get("backend") == capability.backend)
            ):
                forwarded = requested
        elif event.subtype == "print_starting":
            selector = event.metadata.get("model")
            if isinstance(selector, str) and selector:
                safe_selector = safety.redact(selector)
                if safe_selector not in observed:
                    observed.append(safe_selector)
    return {
        "requested": requested,
        "configured": configured,
        "forwarded": forwarded,
        "forwarding_source": "constructed_argv" if forwarded is not None else None,
        "observed_cli_selectors": observed,
        "effective": None,
        "effective_source": "unavailable",
    }


__all__ = ["model_selection"]
