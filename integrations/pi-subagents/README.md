# AGY checkpoint adapter for Pi

Optional local Pi package: `agy-reviewer` runs AGY through provider `agy-mcp`,
without an intermediary Pi worker/model. Python agy-mcp still owns execution,
safety, redaction and CLI conversation evidence. Pi-subagents owns native runs,
result artifacts and notifications. Nothing here changes the Python MCP tools.

**Status:** experimental; offline wire/native/hardening gates are independently
reviewed. See the [implementation plan](../../docs/plans/add-pi-subagents-checkpoint-adapter.md)
for package, release, CI and PR acceptance. No live AGY trial or production-readiness
claim is made. Do not load into a production session without a separately authorized
upstream trial and operator acceptance.

## Prerequisites and operator setup

- **Linux or macOS only**, with a filesystem supporting POSIX private modes,
  no-follow opens, atomic rename and directory sync. Windows and other platforms
  reject with `unsupported_platform` before tool/provider registration or state
  access; there is no less-private durability fallback. This restriction applies
  to this optional adapter, not the Python agy-mcp package.
- Node **>=22.19**, a Pi **1.2.0-compatible** host and its `pi-ai`/`typebox` peers.
- Load one trusted, **Chord-compatible corrected pi-subagents owner** with the
  inspected external-job/follow-up API. Uncorrected published `0.77.0` alone is
  insufficient for the tested Pi 1.2 host. The adapter's public provider library
  is pinned to `0.77.0`; its bytes match the corrected owner's public module.
- Installed `agymcp` (agy-mcp) and an installed/authenticated Antigravity CLI
  supporting the backend's fresh/resumed, sandbox and print contracts. Automated
  tests substitute execution; they do not establish live authentication or flags.
- Authorize repository/source transmission and any quota-consuming AGY inference
  separately. The advisory profile is **not an OS-enforced read-only sandbox**.

The following are **operator instructions**, not commands this package runs or
permission for an assistant to install, change settings or execute inference:

```sh
# From an authorized checkout; provision only the optional Node package.
(cd integrations/pi-subagents && npm ci --ignore-scripts)
# After remaining acceptance gates, register the local package with Pi.
pi install ./integrations/pi-subagents
```

Local package dependencies are your responsibility. Pi records the local source
in its package settings; the loaded owner discovers the manifest's `./agents`
directory. Keep the corrected owner loaded separately: depending on its public
library does not load its extension. Restart/reload only with operator approval,
then check ordinary agent discovery for `agy-reviewer`. Do not copy a second user
agent or load duplicate owners/providers to work around a discovery failure.
Project-local installs require Pi project trust. No root npm workspace or Python
installation change is needed.

### Operator-only environment

Set these in the host environment **before** the relevant assignment starts,
not through agent options or task text:

| Variable | Meaning / default |
| --- | --- |
| `AGY_PI_MODEL` | Exact supported AGY selector; unset preserves CLI-default policy, not an effective-model attestation. |
| `AGY_PI_TURN_TIMEOUT_SECONDS` | Integer **1..300**, default `300`; unsupported values reject before inference. |
| `AGY_PI_STATE_ROOT` | Absolute private root; default Pi agent directory's `agy-subagents/`, partitioned by owning session UUID. |
| `AGY_PI_MCP_COMMAND` | Trusted executable, default `agymcp`; no shell interpretation. |
| `AGY_PI_MCP_ARGS` | JSON array of at most 16 strings, default `[]`; not a shell command. |

The adapter creates its own lazy stdio MCP connection, not your host's ambient
MCP server. It inherits the operator environment and overrides
`AGY_MCP_SESSION_ROOT` to the owning session directory's `mcp-jobs/`. Do not put
secrets in task text or command arguments. Changing cwd, timeout or model policy
on an existing lineage fails closed; there is no model/backend fallback.

Fixed AGY policy: `backend=agy`, `mode=review`, `sandbox=true`,
`allow_write=false`, `worktree=false`, `output_protocol=raw`. These are advisory
intent/upstream restrictions, not universal filesystem confinement. A Pi-owned
worktree, if selected by the caller, is a different layer; its canonical cwd
must remain identical across this assignment's follow-ups.

## Native launch, checkpoint and explicit reply

After authorized setup/acceptance, ordinary tools are used; no manual AGY job or
conversation UUID handling is required. Replace `<run-id>` with the **exact Pi
run UUID returned by launch**, and keep its index (normally `0`):

```js
subagent({ agent: "agy-reviewer", task: "Review the requested change without edits; ask if scope is unclear.", cwd: "/path/to/repo" })
// A question/progress/blocked checkpoint completes this Pi turn, not the assignment.
agy_subagent_control({ action: "status", runId: "<run-id>", index: 0 })
subagent({ action: "resume", id: "<run-id>", index: 0, message: "Supervisor reply: use the documented contract." })
```

A reply is an explicit **new Pi run**, retaining the observed AGY conversation,
canonical cwd, frozen policy and exact lineage. Keep the new run's UUID for the
next reply/control. No implicit latest/prefix/history/new-thread fallback,
automatic reply or autonomous continuation exists. Concurrent/stale resumes,
missing context and uncertain prior dispatch reject rather than double-start.

AGY must return exactly one fenced object (whitespace outside allowed):

```agy-checkpoint
{"version":1,"kind":"question","message":"Which behavior is authoritative?","artifacts":[]}
```

Only `version`, `kind`, `message`, `artifacts` are accepted. Kinds are
`question`, `progress`, `blocked`, `completed`. Limits: response 60,000 UTF-8
bytes, message 48,000 bytes, at most 16 textual artifact references of 2,048
bytes each. Malformed/oversized replies fail, never silently truncate or trigger
another model turn. Artifacts are untrusted text: the adapter does not open
files, visit URLs or execute them.

Every valid kind is native **turn completed**. Semantic assignment state is
`waiting_for_supervisor` for question/progress, `blocked` for blocked, and
`completed` for final. Operational failures are not invented blocked messages.
Output begins with the kind/state and useful message, includes an incomplete
marker for nonfinal checkpoints, ordinary resume example and complete JSON fence.
Workflow gates must parse that fence or inspect `status.semanticState` before
advancing. Even a final assignment leaves **parent acceptance unrecorded**.

### Host-mode and deadline boundary

A functioning UI-capable host (TUI or public-SDK-bound RPC) lets the owner deliver
its genuine native completion notice/wake to a truly idle supervisor. Offline
proof uses a functional RPC UI binding, not fake `hasUI` or synthetic events.
Terminal-only UI can degrade in RPC. JSON/print without UI use the owner's
**queued auto-drain** while the supervisor is busy; they do not promise a
separate truly idle wake. The adapter adds no notification/polling model loop.

The agent's supported Pi default is **600,000 ms** per turn; AGY is **<=300 s**.
A shorter native timeout/stop may end observation before AGY ends, losing normal
notification delivery; it is unsupported as a delivery guarantee and **does not
cancel AGY**. Provider metadata/admission operations use original **90 s** scopes
(85 s work +5 s settlement), with physical requests <=60 s and remaining budget.
Joining a flight cannot renew it. Shutdown shares one 10 s work /15 s total
epoch and one first-entry settlement allowance, not a fresh allowance per job.
Synchronous filesystem calls are not hard-preemptible; deadlines are not an OS
hard-real-time guarantee.

## Busy guidance and cancellation

```js
agy_subagent_control({ action: "queue", runId: "<latest-run-id>", index: 0,
  messageId: "guidance-1", message: "Check the documented race before the next reply." })
// Queue only persists; it does not wake, resume, launch or spend inference.
agy_subagent_control({ action: "status", runId: "<latest-run-id>", index: 0 })
agy_subagent_control({ action: "cancel", runId: "<latest-run-id>", index: 0 })
```

Queue IDs are caller-required/idempotent with exact content digest; same ID with
different content rejects. The next explicit resume commits an authoritative
ordered snapshot. Later enqueues wait for a future turn. Receipts:
`queued`, `forwarded`, `dispatch_unknown`, `not_delivered`. `forwarded` means the
exact snapshot start was acknowledged/correlated, **not consumption/compliance**.
Forwarded guidance is not replayed. A final checkpoint makes unsnapshotted
messages `not_delivered`; only an explicit successful follow-up can reopen it.

Controls are current-Pi-session-owned and return both requested and latest
run/index, bodyless semantic/lifecycle status and complete receipt history.
An old run can observe the latest assignment; destructive cancel of a stale
run rejects. Native output recaps whole receipt objects within **64 KiB UTF-8
JSON**, with exact included IDs and explicit omitted counts; complete current
bodyless history remains in control status. Saved turn output is immutable;
previously committed oversized outputs are not migrated.

Actual upstream cancel requires the **existing live owning MCP generation's
strict start acknowledgment and exact active local lease**. Matching a record,
PID, marker or attempted send is not adoption permission. `cancellation.signalled`
is a receipt, not death; inspect `terminalCorrelated` and backend evidence.
Lost ACK/restarted/foreign jobs cannot be cancelled by another connection.
Native local stop, SDK abort and MCP close do not prove AGY termination.

## Private state, recovery and limits

State is lazy/session-owned, directories `0700`, files `0600`, bounded atomic
JSON versions/manifests. Keep the owning session/connection alive while idle.
Private state holds canonical cwd, checkpoint text and **sensitive guidance
bodies/frozen snapshots**; controls omit bodies/raw cwd/env/tasks/rejected output.
This is not isolation from hostile same-user programs. Python-owned job artifacts
and immutable/obsolete version files have separate disk costs; the limits below
are not an aggregate storage quota or automatic pruning policy.

- 2 MiB per state JSON file; 32 assignments per owner; 64 turns per assignment.
- 256 lifetime receipts per assignment; IDs <=4,096 UTF-8 bytes.
- 20 pending guidance messages; each body <=4,096 bytes; total pending <=64 KiB.

Overflow fails without deleting evidence. Exclusive locks/leases never use age,
PID disappearance/reuse or guessed owner death for automatic takeover. Clean
completed-checkpoint restart can explicitly resume exact saved lineage;
recovered unfinished claims/queued delivery project uncertainty, not dispatch or
cancel authority. There is **no stale-lock cleanup command**. Maintenance needs
separate operator authorization, positively dead owner evidence and correlated
terminal/no-dispatch upstream evidence. Do not purge state to force a new thread.
Session shutdown is bounded/best-effort; detached durability across crashes is
not guaranteed. Preserve records when diagnosing failures.

Unsupported: live steer/stdin, writer profiles/AGY authority overrides, arbitrary
provider options, automatic retries/fallbacks/lease recovery, native Pi child
models/tools/skills/extensions/structured-output/fork-context inside AGY, and
intermediary LLMs. Native required-extension ceilings that demand extensions
inside all runners can refuse this external runner; never bypass them.

## Offline validation and corrected-owner provenance

The test-only MIT npm capture is
`test/support/pi-subagents-owner-0.77.0-chord-compatible.tgz`, described in
`test/support/owner-artifact.json`. SHA-256:
`034cb85bdaeb1dc9753cd8679f0cf0cfe8b8dedc0fa2e13c9ccb62663b37bcf0`.
It is an operator-approved corrected installed-package capture, **not** a
published corrected release or an invented source revision. Local/native tests
and the isolated CI job use these exact archive bytes, verify safe members and
module hashes, and verify public-library equality before loading. They never
borrow an installed developer owner or patch code. The fixture is not shipped
in this package; installing the adapter alone does not supply a corrected owner.

With an already-provisioned authorized Python test environment:

```sh
export AGY_PI_TEST_PYTHON="$(uv run --no-sync python -c 'import sys; print(sys.executable)')"
npm --prefix integrations/pi-subagents run typecheck
# Full configured suite (or complementary bounded partitions used by CI):
npm --prefix integrations/pi-subagents test
(cd integrations/pi-subagents && npm pack --dry-run --json --ignore-scripts --offline)
```

CI provisions only its disposable locked environments, no real API credentials,
AGY/model/doctor/quota calls or live smoke. Tests use scripted Pi models/fake AGY,
actual Python public wire/redaction/command/store behavior and the real corrected
owner/public SDK RPC/JSON hosts. Offline proof is not live upstream readiness.
The production npm payload is only `package.json`, `src/`, `agents/`, this README;
Node/state/fixtures stay out of Python wheel/sdist contracts. No publishing or
persistent user configuration is automated.
