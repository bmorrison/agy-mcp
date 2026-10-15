"""Offline stdio fixture: real server/safety/store/bridge, injected AGY execution only."""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from agy_mcp import bridge, server
from agy_mcp.adapters.agy import AgyPrintBackend, _handle_klog_line
from agy_mcp.adapters.base import AdapterRunResult, _RunContext
from agy_mcp.config import Config
from agy_mcp.models import CanonicalEvent, Capability
from agy_mcp.safety import SafetyPolicy
from agy_mcp.session_store import SessionStore
from agy_mcp.supervisor import Supervisor

EVIDENCE = Path(os.environ["AGY_PI_TEST_EVIDENCE"])
LOCK = threading.Lock()
CONVERSATION = "12345678-1234-4234-8234-123456789abc"
process_evidence = os.environ.get("AGY_PI_TEST_PROCESS_EVIDENCE")
if process_evidence:
    with Path(process_evidence).open("a", encoding="utf-8") as process_file:
        process_file.write(json.dumps({"pid": os.getpid()}) + "\n")
    Path(process_evidence).chmod(0o600)


def evidence(data):
    with LOCK:
        with EVIDENCE.open("a", encoding="utf-8") as file:
            file.write(json.dumps(data) + "\n")


class RecordingAgy(AgyPrintBackend):
    def _probe(self):
        missing = os.environ.get("AGY_PI_TEST_MISSING_FLAG", "")
        return Capability(
            bin_path="/offline/fake-agy-never-executed", backend="agy", authenticated=True,
            version="fixture", model=os.environ.get("AGY_PI_TEST_CONFIGURED_MODEL"),
            supports_print=True, supports_model=missing != "model",
            supports_new_project=missing != "new-project",
            supports_conversation=missing != "conversation",
            supports_sandbox=missing != "sandbox", supports_print_timeout=True,
        )

    def build_command(self, request, *, log_path):
        # Delegate, do not fake production flag construction or redaction.
        argv = super().build_command(request, log_path=log_path)
        evidence({"event": "command", "dry_run": request.dry_run, "debug": request.debug,
                  "sandbox": "--sandbox" in argv, "fresh": "--new-project" in argv,
                  "conversation": next((v for v in argv if v.startswith("--conversation=")), None),
                  "model": next((v for v in argv if v.startswith("--model=")), None)})
        return argv

    def run(self, request, *, log_path=None, stdout_path=None, stderr_path=None,
            event_sink=None, cancel_event=None):
        self.build_command(request, log_path=log_path)
        evidence({"event": "execution", "session_id": request.session_id,
                  "mode": request.mode, "backend": request.backend,
                  "sandbox": request.sandbox, "allow_write": request.allow_write,
                  "worktree": request.worktree, "cwd": str(request.cwd),
                  "model": request.model, "timeout": request.timeout,
                  "output_protocol": request.output_protocol})
        ctx = _RunContext(stdout_buf=[], stderr_buf=[], events=[],
                          seen_session_id=[request.session_id], stop_event=threading.Event(),
                          sink=event_sink, transcript_seen=set())
        sid = request.session_id or CONVERSATION
        self._emit(ctx, CanonicalEvent(type="system", subtype="init", session_id=sid))
        if os.environ.get("AGY_PI_TEST_INIT_ONLY") != "1":
            line = (f"Print mode: resuming conversation {sid}" if request.session_id
                    else f"Created conversation {sid}")
            _handle_klog_line(line, ctx, self)
        end = time.monotonic() + float(os.environ.get("AGY_PI_TEST_DELAY", "0"))
        while time.monotonic() < end:
            if cancel_event is not None and cancel_event.wait(0.01):
                self._emit(ctx, CanonicalEvent(type="result", subtype="cancelled", session_id=sid))
                return AdapterRunResult(events=ctx.events, session_id=sid, exit_code=-15,
                                        duration_ms=0, stdout_tail="", stderr_tail="",
                                        log_path=None, artifacts=[])
        completion_root = os.environ.get("AGY_PI_TEST_COMPLETION_ROOT")
        if completion_root:
            index = 2 if request.session_id else 1
            release = Path(completion_root) / f"completion-{index}"
            deadline = time.monotonic() + 25
            while not release.exists():
                if time.monotonic() > deadline:
                    raise RuntimeError("fixture_completion_release_timeout")
                if cancel_event is not None and cancel_event.wait(0.01):
                    return AdapterRunResult(events=ctx.events, session_id=sid, exit_code=-15,
                                            duration_ms=0, stdout_tail="", stderr_tail="",
                                            log_path=None, artifacts=[])
            evidence({"event": "fixture_completed", "index": index})
        kind = "completed" if request.session_id else "question"
        text = '```agy-checkpoint\n' + json.dumps({"version": 1, "kind": kind,
                "message": os.environ.get("AGY_PI_TEST_CHECKPOINT_MESSAGE",
                    "Review complete." if request.session_id else "Which behavior is authoritative?"),
                "artifacts": []}) + '\n```'
        self._emit(ctx, CanonicalEvent(type="assistant", subtype="text", text=text, session_id=sid))
        self._emit(ctx, CanonicalEvent(type="result", subtype="success", session_id=sid))
        return AdapterRunResult(events=ctx.events, session_id=sid, exit_code=0,
                                duration_ms=0, stdout_tail=text, stderr_tail="",
                                log_path=None, artifacts=[])


cfg = Config()
cfg.execute.worktree_default = False
cfg.session_store.root = os.environ["AGY_MCP_SESSION_ROOT"]
safety = SafetyPolicy.from_config(cfg)
store = SessionStore(Path(cfg.session_store.root))
adapter = RecordingAgy(safety=safety)


def factory(request, config, policy):
    return adapter, []


bridge._select_backend = factory
server._config = cfg
server._safety = safety
server._store = store
server._supervisor = Supervisor(store=store, config=cfg, safety=safety, adapter_factory=factory)
original_cancel = server._supervisor.cancel


def recording_cancel(job_id):
    evidence({"name": "agy_cancel", "job_id": job_id})
    return original_cancel(job_id)


server._supervisor.cancel = recording_cancel
# These are never used by this fixture; fail closed if a test accidentally calls them.
for name in ("agy_doctor", "agy_quota"):
    server.mcp._tool_manager._tools.pop(name)
if os.environ.get("AGY_PI_TEST_COMPLETION_ROOT"):
    evidence({"event": "fixture_process", "pid": os.getpid()})
server.mcp.run(transport="stdio")
