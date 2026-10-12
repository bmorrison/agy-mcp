"""Internal bounded runner shared by Antigravity metadata probes.

POSIX cleanup covers the spawn-owned process group, not escaped sessions.
Windows retains the shared best-effort group/leader cascade; it does not use a
Job Object and cannot guarantee termination of uncontained writers/readers.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from typing import Any

from agy_mcp.utils import prepare_subprocess_command

MAX_PROBE_OUTPUT_BYTES = 1024 * 1024
INVALID_OUTPUT_EXIT = -1000  # Capture failure, distinct from negative signal exits.


def _cleanup_owned_process(
    proc: subprocess.Popen,
    owned_pgid: int | None,
    *,
    shutdown: Callable[..., Any] | None = None,
) -> None:
    """Terminate before reader-owned pipes close; also clean an exited leader's group.

    The PGID is captured at spawn with start_new_session, never looked up after
    reaping. Descendants that escape that group are not contained by this helper.
    """
    if os.name == "posix" and proc.pid in (os.getpgrp(), os.getpid(), 0, 1, None):
        return
    safe_group = (
        os.name == "posix"
        and isinstance(owned_pgid, int)
        and owned_pgid == proc.pid
        and owned_pgid > 1
        and owned_pgid not in (os.getpgrp(), os.getpid())
    )
    if hasattr(proc, "poll") and proc.poll() is None:
        try:
            if os.name != "posix" or safe_group:
                if shutdown is None:
                    from agy_mcp.adapters.base import _shutdown_cascade

                    shutdown = _shutdown_cascade
                shutdown(proc, terminate_grace=0.5, kill_grace=0.5)
            else:
                # No established group ownership: target only the owned leader.
                proc.terminate()
                try:
                    proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=0.5)
        except Exception:
            pass

    if safe_group:
        try:
            os.killpg(owned_pgid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except OSError:
            pass
        time.sleep(0.02)
        try:
            os.killpg(owned_pgid, signal.SIGKILL)
        except OSError:
            pass


class _StreamCapture:
    """Reader-owned bounded bytes and explicit overflow/read-failure evidence."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.overflow = False
        self.failed = False
        self.eof = False
        self.complete = threading.Event()


def _read_bounded_stream(
    stream: Any, cap: int, capture: _StreamCapture, stop: threading.Event
) -> None:
    """Drain without retaining excess bytes; only this reader closes its pipe."""
    try:
        # Nonblocking POSIX pipes let an escaped descendant holding a write end
        # open be abandoned without a stuck reader or BufferedReader close lock.
        nonblocking = os.name == "posix" and hasattr(stream, "fileno")
        if nonblocking:
            try:
                os.set_blocking(stream.fileno(), False)
            except (OSError, ValueError):  # in-memory test streams
                nonblocking = False
        while not stop.is_set():
            try:
                chunk = stream.read(4096)
            except BlockingIOError:
                chunk = None
            if chunk is None and nonblocking:
                stop.wait(0.01)
                continue
            if not chunk:
                capture.eof = True
                break
            if not isinstance(chunk, (bytes, bytearray)):
                capture.failed = True
                break
            available = cap - len(capture.data)
            if len(chunk) > available:
                capture.overflow = True
            capture.data.extend(chunk[:available])
    except Exception:
        capture.failed = True
    finally:
        try:
            stream.close()
        except Exception:
            pass
        capture.complete.set()


def run_bounded_process(
    cmd: list[str],
    *,
    env: dict[str, str],
    timeout: float,
    max_output_bytes: int = MAX_PROBE_OUTPUT_BYTES,
    cleanup: Callable[[subprocess.Popen, int | None], None] | None = None,
) -> tuple[int | None, str, str]:
    """Run one owned command; reject overflow, invalid UTF-8 and incomplete EOF.

    The command wait deadline is followed by bounded cleanup/drain grace. Pipes
    are reader-owned: termination always precedes closure. ``cleanup`` preserves
    the quota caller's existing private cleanup/patch seam during extraction.
    """
    # adapters.__init__ eagerly imports agy, which also uses this helper.
    # Defer the base import until both modules have finished initializing.
    from agy_mcp.adapters.base import _process_group_kwargs

    kwargs = _process_group_kwargs()
    popen_arg, _wrapped = prepare_subprocess_command(cmd, env)

    try:
        proc = subprocess.Popen(
            popen_arg,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            bufsize=0,
            env=env,
            **kwargs,
        )
    except OSError as exc:
        return (-1, "", f"failed to execute probe: {exc}")

    owned_pgid = (
        proc.pid
        if os.name == "posix"
        and kwargs.get("start_new_session") is True
        and isinstance(getattr(proc, "pid", None), int)
        else None
    )
    captures = [_StreamCapture(), _StreamCapture()]
    stop = threading.Event()
    readers = [
        threading.Thread(
            target=_read_bounded_stream,
            args=(stream, max_output_bytes, capture, stop),
            daemon=True,
        )
        for stream, capture in zip((proc.stdout, proc.stderr), captures, strict=True)
    ]
    started: list[threading.Thread] = []
    timed_out = False
    deadline = time.monotonic() + timeout
    try:
        for reader in readers:
            reader.start()
            started.append(reader)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
        else:
            try:
                proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                timed_out = True
    finally:
        # Closing BufferedReader here used to deadlock behind a silent
        # reader. Kill first, then bounded drain, then stop reader-owned IO.
        (cleanup or _cleanup_owned_process)(proc, owned_pgid)
        drain_deadline = time.monotonic() + 0.5
        for reader in started:
            reader.join(timeout=max(0.0, drain_deadline - time.monotonic()))
        stop.set()
        for reader in started:
            reader.join(timeout=0.1)
        # Pipes without a started reader have no competing IO owner.
        for stream, reader in zip((proc.stdout, proc.stderr), readers, strict=True):
            if reader not in started:
                stream.close()

    if timed_out:
        return (-1, "", "timeout")
    if any(
        not capture.complete.is_set() or not capture.eof or capture.failed for capture in captures
    ):
        return (INVALID_OUTPUT_EXIT, "", "probe output capture did not complete")
    if any(capture.overflow for capture in captures):
        return (INVALID_OUTPUT_EXIT, "", "probe stdout or stderr exceeds maximum size")
    try:
        stdout, stderr = (bytes(capture.data).decode("utf-8") for capture in captures)
    except UnicodeDecodeError:
        return (INVALID_OUTPUT_EXIT, "", "probe output is not valid UTF-8")
    return (proc.returncode, stdout, stderr)
