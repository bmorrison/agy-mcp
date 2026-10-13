# Reliable delegation from Pi, Codex, or another MCP parent

AGY is a separate agent with its own context. The parent owns scope, routing,
validation, integration, and acceptance. These are MCP workflows, not a native
Pi subagent extension: automatic Pi child registration, steering, and completion
wakeups are not supplied by this bridge.

## A bounded assignment

Give the worker an exact cwd, source revision, objective, read/write boundary,
required checks, output artifact, time budget, and stop conditions. Preserve
existing dirty files. Prefer a small review before commissioning an unfamiliar
implementation. Do not send credentials or unnecessary repository content.

```python
# Pseudocode: use your host's registered MCP tools.
start = agy_start(
    PROMPT="Read src/queue.py only. Return at most three reachable defects with file/line evidence. No edits or provider calls.",
    cd="/path/to/repo",
    backend="agy",                 # avoid ambiguous auto routing
    model="<selector-from-agy-models>",
    mode="review",
    sandbox=True,
    worktree=False,
    allow_write=False,
    timeout=300,
    output_protocol="raw",
)
if not start["success"]:
    # Report the error; do not silently redispatch to a different model/backend.
    raise RuntimeError(start["error"])
job_id = start["job_id"]            # retain the exact id, never implicit latest
```

For authorized edits use `mode="execute", allow_write=True, worktree=True`.
The bridge retains the worktree for parent diff review; it does not merge it.
A worktree isolates checkout edits, not all filesystem access. `sandbox=True`
requests upstream terminal restrictions, not guaranteed identical permissions
for terminal and editor tools. Do not bypass a denial with HOME/GIT_CONFIG or
permission changes. `long` does not itself authorize mutations.

## Model evidence is not model identity

`adapter.model` remains a legacy requested/default label. Inspect
`adapter.model_selection`, or `record.extra.model_selection` after a background
job finishes:

- `requested`: explicit request selector, or null.
- `configured`: settings-derived label, or null.
- `forwarded`: selector observed in a constructed argv, or null.
- `forwarding_source`: `constructed_argv` when observed; not proof of acceptance.
- `observed_cli_selectors`: nonempty print-starting log selectors, not startup
  default labels or serving attestations; conflicting values remain visible.
- `effective`: null, with `effective_source="unavailable"`. Current signals do
  not establish which provider model actually served inference.

An unsupported explicit AGY model option fails before inference. Omitting the
selector preserves CLI defaults. Startup metadata can name a configured model
that differs from the forwarded selector; do not confuse those observations.
Fresh/resumed calls both forward explicit selectors. Continuation resumes the
conversation only: supply `cd` each turn, using the retained worktree for an
editing continuation rather than accidentally returning to the main checkout.

## Progress: inspect the sample before judging a stall

At bounded host-scheduled checkpoints:

```python
status = agy_status(job_id=job_id)
progress = agy_transcript(job_id=job_id, mode="progress", max_bytes=200000)
# Check each tool's success before reading its payload.
sample = progress["sample"]
# Count/timestamp fields describe parsed records in this sample only.
# A small incomplete prefix can be old while the worker is busy elsewhere.
```

Both transcript modes return additive `sample` metadata, including empty,
missing, and unbound successful results. It describes availability, prefix
scope, half-open byte range, actual bytes read, before/after descriptor sizes,
size changes, truncation, malformed records, partial trailing bytes, and
completeness. `counts_scope`, `last_activity_at_scope`, and
`elapsed_seconds_scope` are `sample`.

`complete` means stable-size observed file coverage with no skipped malformed
or partial records. It is **not** a snapshot guarantee, whole-session freshness,
or proof that the worker has stopped. Concurrent same-size rewrites and later
appends remain possible. Missing/unbound results are unavailable, not complete
empty transcripts. Parse only newline-complete UTF-8 JSONL records; an oversized
first record can produce zero steps with a truncated sample.

If incomplete, inspect a larger bounded sample (tool ceiling 5 MB) or other
observable evidence before declaring inactivity. The reader remains a prefix
reader, not a cursor/tail subscription. Do not use repeated identical truncated
prefix polls as a stall detector. Supervise through observable actions, results,
and artifacts; hidden model reasoning is not acceptance evidence.

## Stop, retrieve evidence, and accept separately

Cancel an authorized running job with `agy_cancel(job_id=job_id)`. Its signal
receipt is not terminal completion; fetch `agy_status` until the job reaches a
terminal state, within a bounded host budget. Then fetch the explicit result:

```python
result = agy_result(job_id=job_id, include_events=True)
record = result["record"]
# result.success says retrieval succeeded, NOT that the worker succeeded.
worker_status = record["status"]
lifecycle = record["extra"].get("lifecycle")
```

New jobs persist `extra.lifecycle`: termination reason, observed cancellation
flag, whether an adapter returned, and stable store-owned evidence references.
Reasons distinguish explicit wrapper timeout, upstream error, incomplete
response, cancellation, adapter error, nonzero exit, worker loss, and thread
start failure. Existing broad statuses and late-cancel precedence remain.
Legacy records are not backfilled. `last_event_at` is populated at finalization
from returned events or actual sink observations before an adapter exception;
it is not a live heartbeat guarantee. Model/quota diagnostics observed before
an exception remain projectable without fabricating an adapter result.

Evidence references name locations, not guaranteed existing/nonempty artifacts
or a complete partial audit. Failed jobs retain available spool/event evidence;
the bridge does not invent a partial summary or certify changed files.
`validation="not_reported"` and `parent_acceptance="not_recorded"` explicitly
separate worker completion from checks and parent approval. Request an honest
handoff with changed paths, commands, executed assertions, exits, evidence, and
gaps; independently verify it before integration.

## Quota snapshots and error diagnostics are separate

Use `agy_quota(force_refresh=False)` to query the configured Antigravity CLI's
read-only `/quota` JSON metadata (CLI >= 1.1.11). Do not send `PROMPT="/quota"`
through `agy`: its inference preamble prevents headless command dispatch.
The dedicated tool validates zero turns/tokens and no conversation; it does
not start an inference job or silently fall back to another backend/model.

On success, inspect `groups[].buckets[]`: `remaining_fraction` is a raw fraction
in [0, 1], `reset_at` is a UTC timestamp, and `window`/group labels come from
upstream. Missing fraction/reset fields are null. `disabled=true` means that
bucket does not currently apply, even if upstream carried a positive fraction;
the normalized fraction is null. Preserve both weekly and five-hour windows.
Observed Gemini Flash/Pro share one group and Claude/GPT share another; do not
invent separate balances for each family or turn fractions into request counts.
A snapshot is not a guarantee of successful inference or a billing meter.

Metadata uses its own adapter and per-loop eight-worker capacity, separate from
doctor's cached capabilities and the long-running inference queue. Explicit doctor
refresh/reset still invalidates the quota cache; metadata reads do not probe Gemini
or launch inference/jobs.

Successful snapshots are cached in memory for 30 seconds, with `observed_at`,
`cached`, and `age_seconds`. TTL/age start at observation rather than after
post-command validation; even an uncached result can have a nonzero age.
`force_refresh=True` bypasses a cached snapshot and
coalesces an already-running refresh. Failed refreshes return explicit failure,
not stale success. Auth context is fingerprinted without reading private account
contents; account switches without a detectable context change can remain cached
for the TTL. Force refresh after switching accounts. Missing/stale local auth
evidence is inconclusive, not a confirmed logout: the bounded CLI query uses its
existing auth and classifies actual CLI failures. Metadata may reveal previously
unknown auth evidence without rejecting a validated fresh result; cached results
are never rebound to newly discovered evidence. Coalesced callers allow 80 seconds
by default for detection, possible evidence-driven re-detection, quota execution
and cleanup; the quota command's own deadline remains 30 seconds.
Unknown/unsupported formats, auth failures, timeouts, and unavailable binaries
are explicit statuses.
The quota command and CLI detection probes disable auto-update only in their
subprocess environments. Cleanup is validated for POSIX owned-group descendants,
not escaped sessions; Windows tree cleanup has no Job Object guarantee and is
not live-validated here.

`agy_doctor()["report"]["quota"]` still reports `availability="unknown"` and null
remaining/reset/retry fields with `source="not_probed"`. Health checks installation
and auth evidence, not subscription balances, and do not call the balance tool.

For recognized exhaustion error events, synchronous `adapter.quota` and
background `record.extra.quota` provide a redacted diagnostic:

- `kind`: literal `quota_exhausted`, `rate_limited`, or
  `resource_exhausted_unknown` evidence.
- `upstream_subtype`, requested backend/model, and redacted `evidence`.
- `remaining_quota`, `reset_at`, `retry_after_seconds`: explicitly null in this
  implementation, even if unverified text mentions numbers.

Only known canonical resource-exhaustion errors qualify, including recognized
executor wrappers. Prompt/assistant/result mentions, auth failures, account
eligibility, and generic resource shortages do not establish subscription-quota
exhaustion. Unrecognized formats may yield no diagnostic; raw error evidence
still matters. Classification is bounded free-text interpretation, not an
entitlement meter. No automatic retry, model substitution, or post-exhaustion
backend fallback is added. Ask the quota owner before selecting another route;
keep subscription quota, marginal bill, and allocated subscription cost separate.

## Version and deployment caveats

Restart an already-running MCP server through your host's supported lifecycle
to load installed source changes; package files on disk do not update imported
modules. Reinstall user-scope skills only with permission: repository bundles
and packaged copies are synchronized, but existing user installations may be
stale. No runtime configuration or skill installation is performed by these
source changes. `agy_quota` requires a fresh server process that loads the new
tool; existing deployments are not silently restarted or reinstalled. Cursor/tail
progress, native host wakeups/steering, and richer partial audits remain future work.
