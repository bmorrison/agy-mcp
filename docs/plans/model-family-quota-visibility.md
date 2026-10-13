# Model-family quota visibility: proven CLI route and implementation plan

Status: implemented and independently accepted in source; lab recorded/validated.
Source acceptance performed no commit, push, release, installation, deployment
restart, or plan archive. The operator subsequently authorized opening a PR;
publish the scoped changes on `feat/model-family-quota-visibility` against the
fork's `main`. Deployment changes, release and plan archival remain unapproved.
Date: 2026-10-12.

## Execution progress

- [x] Resolve plan; read repository/lab instructions; preserve starting changes.
- [x] Baseline: 736 tests passed (17.99s) using the existing outside-iCloud
  `/private/tmp/agy-model-tests.ud5QzG/venv/bin/python`, `PYTHONPATH=src`.
  The checkout `.venv` has dataless dependency files and its import probe timed
  out before any assertions; no dependency installation or config change made.
- [x] Schema/parser and dedicated runner/cache, with focused acceptance tests.
- [x] Async MCP integration and typed tool-discovery/failure tests.
- [x] README variants, architecture/workflow docs, bundled skills/drift checks.
- [x] Independent review, full checks, fresh stdio/live quota acceptance.
- [x] Orchestration-lab record and final requirement audit.

Implementation topology: multi-seam, exclusive component ownership. Core
(schema/parser/runner/cache/tests) is one tightly coupled quota protocol seam;
MCP integration and documentation are separate seams. Parent owns integration,
review, acceptance, plan progress, and lab recording. Publication was initially
withheld; a subsequent operator request now authorizes the scoped PR commit/push,
not a release or deployment change.

| Lane | Owner/route | Writable boundary | Isolation | Gate/handoff |
| --- | --- | --- | --- | --- |
| Core | Gemini Flash trial → Gemini Pro repair → native SOL critical lifecycle repair | `quota.py`, quota models in `models.py`, `tests/test_quota.py`; approved bounded capability/environment seam in `adapters/agy.py`, focused capability tests, optional shared internal `probe_process.py` | `/private/tmp/agy-quota-20261012/implementation` | core tests + lint; source diff and report before integration |
| MCP | Separate native SOL integration stage after verified core handoff | `server.py`, `tests/test_mcp_server.py` | same implementation worktree, serial ownership | async/discovery/failure tests; no core edits without parent approval |
| README | Local Qwen Pi/MTP, fresh bounded mechanical trial | root README plus EN/JA/ZH-TW variants | `/private/tmp/agy-quota-20261012/readmes` | four synchronized tool tables/counts; no code changes |
| Integration/docs | Parent, after component handoffs | reviewed file integration; architecture/workflow/skill docs | original checkout | full tests/lint, live tool, fresh review, lab validation |

README text preparation may run before stage 4 because the fixed tool contract
is already established and independent of core implementation; its final
claims are checked against accepted code. All core dependencies remain ordered.
Routing at initial dispatch: Gemini shared quota 94.69% weekly / 98.99% five-hour remaining;
Claude/GPT weekly 0%. Native `openai-codex/gpt-6.1-sol` and local
`omlx/Qwen3.8-27B-pi-4bit-mtp-mlx` are registered; local execution is a bounded
trial, not a blanket capability claim. Hosted serving revision/hardware and
actual billing remain unknown. Estimated delivery 30–60 minutes, not a hard
local deadline; intervene for scope/protocol failures or persistent failed
repairs, not ordinary slow generation.

Progress evidence:
- Local README run `867749b7-80a5-432a-ae23-eb015dd4bee3` completed in
  927.461s; parent accepted the four-file mechanical diff after correcting one
  Japanese five-hour wording typo. All four tables contain 13 unique tool rows.
- Initial core dispatch was rejected before execution by sensitive-surface prompt
  screening; a same-protocol wording correction launched
  `job_1791836745_2dcd5efe1313`, completed in 618s. Its 69 core/model tests passed,
  but parent activated 14 failing protocol/security/lifecycle/cache regressions
  (`/private/tmp/agy-quota-20261012/logs/core-review-red.log`); core not accepted.
  A first parent gate used the original checkout by mistake (exit 4, no tests);
  the corrected isolated-worktree invocation passed 69.
- Stronger Gemini Pro repair `job_1791837816_eff075f3a194` ended after 151.887s
  with `incomplete_response: empty output`, CLI exit 0, no source changes or
  checks reported. State/results preserved. One supported same-session MCP
  continuation `job_1791838147_0e8c25aaf7d1` recovered successfully after 644s;
  no execution-mode switch was used to recover that infrastructure failure.
  Parent independently passed 104 checks (90 core/model + 14 original activated
  regressions), then activated 5 further failures with real-process containment:
  pipe-close timeout deadlock, silent overflow acceptance, character-vs-byte cap,
  null conversation evidence, and introduction-release prerelease gating.
  `/private/tmp/agy-quota-20261012/logs/core-lifecycle-red.log` retains Red.
  This is a reproduced source-quality defect, not an active infrastructure
  blocker. Native workflow `d69e6cf8-ecfc-4a67-a58e-36778c13d014` owns bounded
  core repair → separate async MCP integration → fresh read-only review.
  Core child `0a56876b-57d1-4e2b-a248-b9077dc46a92` reported 151 focused checks
  passed; parent accepted a narrowly scoped adapter environment extension:
  `_scrub_probe_env` must force `AGY_CLI_DISABLE_AUTO_UPDATE=1`, since inherited
  help/version detection otherwise cannot meet the quota path's no-update
  contract. Add a focused capability regression; preserve other adapter behavior.
  This is temporary subprocess policy, not a persistent configuration change.
  No core merge yet. Cleanup validation covers POSIX owned process-group
  descendants, not deliberately escaped sessions; no Windows Job Object/tree
  guarantee or live Windows validation is claimed.
- Native core completed with 162 core/frozen and 262 expanded adapter checks;
  separate MCP child `e45aeb9d-af4b-45f3-b0a2-174e00a14dd2` passed 273 integration
  checks and repository lint. Fresh reviewer `d81b4816-c7f0-4349-8948-b80f5e9466ae`
  returned BLOCK: inherited help/version detection still used unbounded capture
  without owned-group cleanup and omitted configured extra environment scrubbing.
  Reviewer had no execution tool; parent independently activated both findings
  as 5 failing real-process checks (`logs/detection-review-red.log`). Retained
  core worker revival `e227cb20-2167-4706-a160-796549dd1542` now owns this bounded
  dependency-seam repair, not a repeat of completed implementation. Approved one
  shared internal process helper if needed; no server/models/docs expansion.
  Explicit probe/adapter safety-policy incompatibility must fail closed before
  any CLI probe, without mutating the shared adapter. Equivalent policies work.
  Repair and final source acceptance subsequently completed below.
- README integration and architecture/workflow/installation/bundled-skill text
  preparation are complete; package/canonical skill drift check passed 3 tests.
  Final documentation claims were checked against accepted implementation.
- Retained detection repair passed all 5 newly activated cases. Parent independently
  ran 417 focused cases and all 24 frozen regressions; full isolated suite passed
  888 (35.18s). Retained reviewer `be567288-e81d-42d9-9176-7b8174477028` resolved
  both P1 findings, no new blockers, verdict OK with notes. Reviewer was source-only
  (no execution tool); parent independently executed the checks.
- Integrated exactly 8 verified source/test paths into the original checkout:
  `quota.py`, shared internal `probe_process.py`, quota models, server, agy adapter,
  quota tests, capability tests, MCP tests. Preserved unrelated untracked plans.
  Original-checkout full suite: **888 passed in 34.51s**; all 24 frozen checks plus
  3 skill-drift cases passed; `ruff check src tests` and `git diff --check` clean.
- Fresh-source stdio offline smoke discovered 13 typed tools, verified restricted
  input/default/force/cache behavior, two metadata-only fixture queries, no jobs,
  and unchanged doctor `not_probed` balance diagnostics.
  Authorized live smoke made exactly one real quota query at `2026-10-12T21:58:40Z`:
  CLI 1.3.3, all 5 usage counters zero, zero turns, empty conversation, zero sessions.
  Durable [acceptance receipt](evidence/agy-quota-acceptance-2026-10-12.json).
  Observed Gemini weekly 92.98% / five-hour 88.09%; Claude/GPT weekly 0% and disabled
  five-hour fraction null. Dated snapshots only: do not attribute changes to this
  task or infer request counts/billing/availability/native OpenAI quota.
- Canonical lab run: `run-3c016fbe-b5ce-5423-b3a9-e80e5e06251d`; observation:
  `agent-orchestration-lab/observations/2026-10-12-agy-quota-visibility-closeout.md`.
  Recorded actual source-event IDs/AGY dispatches, failures, recoveries, parent
  repairs and unknowns without duplicate retained-session counting. Measured
  elapsed through recording cutoff: 6350.923s (105.85min), exceeding the initial
  estimate. Actual billing, energy, hosted hardware/serving revisions, internal
  AGY calls and full quota/active-time allocation remain unknown/null; later
  recording/checker/final-response counters are an explicit coverage gap.
  `python3 scripts/check_lab.py`: lint passed, **51 tests passed**; retained warnings
  describe incomplete measurements, not inferred zero cost.
- Final audit maps all design/acceptance requirements to the source, promoted
  synthetic cases, full tests, receipts and documented limits. No further code
  edits before the initial publication. Only CLI 1.3.3/macOS was live-tested; Windows and
  escaped-session cleanup remain unguaranteed, binary/account fingerprint limits
  remain documented, and deployed MCP processes were not reloaded/reinstalled.
- Publication follow-up: operator requested "Please open a PR." Scope is the
  accepted feature, tests, synchronized documentation, this plan and its two
  reviewed credential-free evidence receipts. Exclude unrelated untracked plans
  and the separate orchestration lab. Base: `bmorrison/agy-mcp:main`; head:
  `feat/model-family-quota-visibility`. No merge, release or deployment restart.
- PR #4 repair follow-up (2026-10-12): the operator authorized verification,
  confirmed fixes in one commit, resolving addressed threads, and Codex re-review.
  All four findings reproduced: mutable auth-evidence mtimes (P1), losing valid
  help capabilities after failed version capture (P2), generic policy phrases in
  successful bucket descriptions (P2), and repeated forced capability detection
  before joining a refresh (P2). Initial targeted gate: **10 failed, 4 passed**.
  Repairs use stable auth-evidence kind/path (not account identity), retain valid
  help while leaving failed version capture unverified, require explicit slash
  context, and reserve the flight before detection. Independent edge review also
  reproduced and repaired a forced waiter accepting a normal leader's cache hit.
  Added 17 regression cases, including interrupted/invalidated preparation and
  deterministic joins during both detection and quota execution. Updated two old
  test assumptions: version failure must not erase valid help, and MCP callers
  must join before cache-key preparation. Focused/frozen gate: **205 passed in
  17.00s**; full suite: **905 passed in 36.08s**; lint and whitespace clean.
  Fresh-source offline stdio smoke verified 13 tools,
  zero inference, zero jobs, cache/force behavior and balance-independent doctor.
  Prior live receipts and orchestration recording cutoff remain unchanged; no
  additional real quota query, credential read, deployment refresh or merge.
- Codex review round 2 reviewed `a2f9534` and raised three new findings: Windows
  batch launchers bypassing preparation (P1), single-flight waits covering only
  quota execution rather than detection (P2), and treating absent auth evidence
  as confirmed logout (P2). The operator authorized repeating the repair/review
  cycle until current-head Codex green, without merge/deployment changes.
  Parent reproduced **8 failing cases** (one .exe control passed): Windows
  .cmd/.bat preparation at the mocked subprocess boundary, premature waiter
  expiration in a deterministic full-budget simulation, actual synthetic CLI
  outcomes with absent auth evidence, and probe-created auth evidence.
  Windows now uses the existing `shell=False` launcher preparation helper;
  native Windows execution remains untested. The quota command deadline stays
  30s; waiters allow 80s for initial detection, one evidence-driven re-detection
  and bounded cleanup/drain. Unknown auth evidence now permits the bounded CLI
  query, with actual CLI auth errors/timeouts classified rather than invented.
  Previously unknown evidence revealed by metadata may scope a fresh result,
  but cached balances are never rebound and known context/policy changes remain
  rejected. Added 12 regression cases, including rekeying coalesced waiters and
  rejecting new evidence during a cache read. Updated old auth-gating assumptions
  and strengthened the explicit waiter-timeout test. **308 focused/frozen passed
  in 16.87s; 917 full tests passed in 36.75s**; lint, whitespace and fresh-source
  offline stdio smoke passed. Earlier live receipts/lab cutoff remain unchanged.
- Codex review round 3 reviewed `9fa9c5e` and raised one further P2: nonzero
  help/version exits could still authorize quota when output looked valid.
  Parent reproduced all **12 cases**: help/version, stdout/stderr, and exit codes
  1/2/127. Detection now rejects every nonzero exit without trusting its output;
  successful help capabilities remain available if only version detection fails.
  **320 focused/frozen checks passed in 18.65s; 929 full tests passed in 37.26s**;
  lint, whitespace and fresh offline stdio smoke passed. This repair proceeds to
  another current-head Codex review under the operator's until-green instruction.
  No additional live query, deployment change, merge or original-receipt rewrite.
- Codex review round 4 reviewed `1b1d797` and raised three further P2s: trusting
  help-derived versions after unparseable version output, starting snapshot TTL
  after post-command validation, and scanning valid description text as policy
  errors before parsing. Parent reproduced **16 failures with 2 passing policy
  controls**. Repairs require recognized successful `--version` output while
  retaining ordinary help capabilities, carry monotonic observation time through
  publication/coalescing, and validate successful JSON before textual policy
  classification. Age now includes validation delay even on uncached results;
  TTL never restarts at publication. Added 19 cases, including coalesced waiter
  age after its own validation; replaced a clock-read-count-dependent TTL test
  with an explicit clock. **339 focused/frozen passed in 17.45s; 948 full tests
  passed in 35.37s**; lint, whitespace and fresh offline stdio smoke passed.
  Another current-head Codex review follows; original live/lab receipts remain
  unchanged and no deployment or merge is authorized.
- Codex review round 5 reviewed `564ee45` and raised one P2: a forced refresh
  after an in-place upgrade ran redundant detection and could combine newly
  discovered auth with a stale unknown-evidence key. Parent reproduced the
  duplicate and failed refresh; a non-forced replacement was a passing control.
  Independent boundary checking also reproduced accepting a binary that rewrote
  itself during version detection. Detection now distinguishes fresh from cached
  capabilities, avoids the duplicate replacement refresh, and compares executable
  fingerprints across actual metadata detection to reject mid-probe replacement.
  Added four cases: **3 failed, 1 passed** before repair; **343 focused/frozen
  passed in 20.58s; 952 full tests passed in 39.71s** afterward. Lint, whitespace
  and fresh offline stdio smoke passed. Another current-head Codex review follows;
  the original live/lab receipts and deployment/merge restrictions are unchanged.
- Codex review round 6 reviewed `8e6fe0a` and raised two server-level P2s:
  shared adapter mutation and metadata starvation behind inference capacity.
  The claimed persistent ordinary-inference outage did not reproduce: canonical
  routing constructs fresh adapters. Confirmed defects were poisoning doctor's
  cached capabilities and preventing even cached metadata workers from starting
  while all eight inference slots were held. A separate boundary test reproduced
  reset allowing an old in-flight result to publish. Initial gate: **4 failed,
  1 passed**, including the passing ordinary-routing control. Metadata now owns
  a separate configured adapter and independent per-loop eight-worker capacity.
  Config/safety changes and explicit doctor refresh/reset invalidate its cache;
  reset also invalidates in-flight publication. Updated lifecycle/limiter tests
  and the fake probe's invalidation interface. **441 focused/frozen passed in
  27.34s; 957 full tests passed in 35.61s**; lint, whitespace and fresh offline
  stdio smoke passed. Another current-head Codex review follows without rewriting
  original live/lab receipts, changing deployment, or merging.

## Goal

Expose remaining Antigravity subscription quota and reset times through a
read-only `agy_quota` MCP tool, without starting an inference turn. Preserve
upstream groups and both weekly and five-hour windows rather than inventing
independent budgets for every model family.

## 1. Live proof

Environment: macOS arm64, installed `agy` 1.3.3, agy-mcp 0.1.8.

Successful commands:

```sh
agy --print=/quota --output-format json --print-timeout 45s
agy --print=/usage --output-format json --print-timeout 45s
```

Durable evidence: [JSON captures and MCP dry run](evidence/agy-quota-proof-2026-10-12.json).
The captures contain observation times, argv, exit codes, elapsed times,
CLI responses, and passed assertions. Both commands:

- Exited 0, with `status="SUCCESS"` and empty stderr.
- Returned `command.name="usage"` and identical `command.data` snapshots.
- Reported `num_turns=0`, empty `conversation_id`, and all usage counters zero.
- Supplied structured groups/buckets, valid fractions, and UTC reset timestamps
  for active buckets. Elapsed times were 3.716s and 4.864s respectively.

Snapshot from the retained proof (not a persistent account balance):

| Upstream group | Members stated by upstream | Window | Remaining | Reset (UTC) |
| --- | --- | --- | --- | --- |
| Gemini Models | Gemini Flash, Gemini Pro | weekly | 94.69% | 2026-10-17T21:20:50Z |
| Gemini Models | Gemini Flash, Gemini Pro | 5h | 98.99% | 2026-10-13T01:09:50Z |
| Claude and GPT models | Claude Opus, Claude Sonnet, GPT-OSS | weekly | 0% | 2026-10-13T00:05:55Z |
| Claude and GPT models | Claude Opus, Claude Sonnet, GPT-OSS | 5h | disabled | not supplied |

The disabled bucket includes a numeric fraction but no reset timestamp. Its
fraction must not be presented as usable quota: upstream explicitly says the
five-hour limit does not currently apply because the weekly limit was reached.

Upstream describes models within each group as sharing weekly and five-hour
limits; consumption is proportional to token cost. These are percentages, not
remaining request counts. Gemini Flash and Pro are not independent budgets in
this observed account. Claude and GPT also share a group.

An earlier successful `/quota` snapshot reported Gemini at 95.53% / 99.94%.
Balances changed before the retained repeatability check. Other usage and
upstream update timing were not isolated; do not attribute the change to these
metadata probes or infer consumption from snapshot differences.

Additional support: `agy changelog` says release 1.1.11 introduced headless
`/usage`, `/quota`, and other read-only commands with structured JSON, without
starting an agent turn, spending quota, or leaving a conversation. Release
1.2.15 notes machine output uses UTC reset times. Older versions were not live
tested; release notes are capability evidence, not cross-version certification.

### Current MCP boundary

A live MCP call to `agy` with `PROMPT="/quota"`, `backend="agy"`,
`dry_run=true`, and `debug=true` returned a command preview whose print argument
starts with `[System Context]` and places `/quota` below `[User Request]`.
No inference was executed for this check.

Source anchor: `src/agy_mcp/adapters/agy.py`,
`AgyPrintBackend._prepare_prompt` / `build_command`. Every prompt receives a
mode preamble; the command also includes normal session/project flags. Thus
sending `/quota` through the existing inference tool is not the proven headless
route. Do not work around this by asking a model to report account balances.

At proof time, `docs/subagent-workflows.md` correctly said no balance probe was implemented;
this does not imply upstream lacks balances. The prior conversational claim
that no CLI numeric quota interface exists is disproven by this test.

## 2. Recommended design

Use the supported CLI command, not credential extraction, reverse-engineered
RPC calls, a desktop-editor dependency, or inference exhaustion probes.

### Tool contract

Add `agy_quota(force_refresh: bool = False)`. It always queries the configured
Antigravity (`agy`) binary; it accepts no prompt, model, session, arbitrary
command, extra environment, or backend fallback. Standalone Gemini CLI quota
and pay-as-you-go API billing are outside this tool's scope.

Proposed typed response in `src/agy_mcp/models.py`:

- `success`, `error`, and a bounded `status` such as `ok`, `unsupported`,
  `unavailable`, `auth_error`, `timeout`, or `invalid_response`.
- `backend="agy"`, detected `cli_version`, `source="agy:/quota"`.
- `observed_at` (UTC time when the successful response was received),
  `cached`, and `age_seconds`.
- `groups[]`: upstream name, description, and `buckets[]`.
- Each bucket: upstream `id`, `name`, `window`, `disabled`,
  `remaining_fraction`, `reset_at`, and optionally its redacted description.

Keep raw floating-point precision for active fractions; clients may format
percentages. Treat absent fractions/reset times as unknown, not zero. For a
disabled bucket expose `disabled=true` and normalized `remaining_fraction=null`
(and preserve its explanatory description), so clients cannot confuse it with
an available balance. Preserve new upstream group/window labels; do not encode
the two groups observed here as permanent rules or infer membership by model
name alone. No absolute token/request allowance or dollar value is inferred.

The tool reports a quota snapshot, not a guarantee that inference will succeed.
Auth, outages, rate limits, credits, and account policy remain separate.

### Dedicated probe

Create `src/agy_mcp/quota.py` with separate parsing, bounded subprocess
execution, and cache responsibilities:

1. Resolve the binary using configured adapter detection, not a second hardcoded
   path. Verify supported headless-command capability before attempting a quota
   request. Use the documented 1.1.11 introduction as a conservative version
   gate, optionally confirming through headless `/help` on known supporting
   builds. Unknown/older versions return `unsupported`; never risk submitting
   a slash command as inference on an unverified build.
2. Invoke fixed argv: `<resolved agy> --print=/quota --output-format json
   --print-timeout 20s`. No mode preamble, conversation, continue, new-project,
   model, write/permission overrides, or user-controlled arguments.
3. Use `SafetyPolicy.scrub_environment`, honoring configured extra scrub names.
   Ensure any discovered command-disabling environment switches cannot cause
   inference fall-through; fail closed rather than bypassing an operator policy.
   Let the CLI use its own existing auth. Do not read credentials or keychain
   contents, initiate login, or mutate auth/configuration.
4. Use `adapters/base.py` process-group and shutdown helpers with an outer
   deadline (e.g. 30s), bounded stdout/stderr capture, and cleanup on all paths.
   Do not launch background jobs, tail transcripts, or create worktrees.
   Test the scrubbed environment explicitly: the retained live CLI probes used
   the shell environment, not a newly implemented production runner.
5. Require exit 0, expected command identity, a successful structured envelope,
   zero turns/tokens, and no conversation. Reject prose, truncated/oversized JSON,
   malformed schema, nonfinite/out-of-range numbers, and contradictory disabled
   states. Validate timestamps while allowing missing upstream values. Unexpected
   inference metadata is a protocol violation, never an accepted quota result.
6. Return only allowlisted, validated fields with string redaction. Bound and
   redact errors; do not persist raw CLI logs or arbitrary extra response fields.
   Never retry automatically or silently fall back to RPCs, another model, or
   the standalone Gemini backend.

### Cache and concurrency

Start with an in-memory 30-second successful-snapshot cache and a single-flight
refresh. Use monotonic time for TTL, UTC for observation timestamps, and bound
probe concurrency. `force_refresh` bypasses the cached result but coalesces an
already-running refresh. Scope/invalidate by resolved binary/version and auth
context. Do not read secrets to identify accounts. If account identity is not
safely available, document bounded cache staleness and explicit force refresh
on account switches; never advertise an account-specific cache guarantee.

A failed refresh returns an explicit failure, not a stale success. Do not cache
failures as healthy snapshots or persist balances to disk in the MVP.

## 3. Implementation sequence and ownership boundaries

1. **Schema and parser:** new `quota.py` pure parser and quota response models;
   new `tests/test_quota.py` fixtures derived from the observed shape but with
   synthetic values/timestamps. Keep account snapshots out of shipped fixtures.
2. **Runner and cache:** implement the dedicated command path, safety policy,
   deadlines, process cleanup, and single-flight cache. No changes to ordinary
   inference prompt preparation or error-derived diagnostics.
3. **MCP integration:** register async `agy_quota_tool` in `server.py`, dispatch
   blocking probe work through `anyio.to_thread.run_sync`, and integrate cache
   reset with `_reset_state_for_tests`. Add schema and failure-contract coverage
   to `tests/test_mcp_server.py`. Avoid blocking the server event loop.
4. **Documentation:** update `docs/subagent-workflows.md`, tool tables in README
   variants and `docs/architecture.md`, and relevant bundled skill usage text.
   Distinguish the new live balances from error-derived `adapter.quota` /
   `JobRecord.extra.quota`. Update drift checks where needed.
5. **Acceptance:** offline tests, lint, full suite, then fresh-process stdio MCP
   list/call smoke and one operator-approved live `agy_quota` call. Capture
   zero-turn/token/no-conversation metadata without running inference. Review
   the diff before publication. Restart/reinstall running deployments only with
   operator authorization; no commit, push, or release is implied by this plan.

Keep `agy_doctor` installation/auth checks non-inference and balance-independent
by default. It can mention the dedicated tool without adding network work to
every doctor call. Preserve the existing error-derived quota diagnostics and
all no-automatic-routing guarantees.

## 4. Acceptance checks

- Both observed shared groups and both windows survive the parser accurately.
- Zero is real exhaustion evidence for that bucket; absent is unknown; disabled
  is not availability, even if upstream includes a positive fraction.
- Unknown groups/windows are retained without invented memberships or balances.
- Test null/missing fields, empty groups, duplicate/contradictory bucket data,
  invalid timestamp, bool-as-number, NaN/Infinity, out-of-range fractions,
  unsupported version, malformed/oversized output, and wrong command envelopes.
- Fixed argv has no inference preamble or session flags. No credential reads,
  shell interpolation, permission escalation, login, dependency install, or
  arbitrary raw stdout/stderr exposure occurs. Validate redaction with sentinel
  secrets in mock descriptions/errors.
- Mock missing binary/auth failure/timeout/nonzero exit; test subtree cleanup
  and zero orphan processes. Unknown upstream formats fail visibly.
- Test TTL expiry, force refresh, account/binary invalidation rules, concurrent
  refresh coalescing, event-loop responsiveness, and failed-refresh behavior.
- MCP tool discovery exposes the typed schema; existing doctor, inference,
  lifecycle, and diagnostics tests retain their contracts.

Planned commands after implementation:

```sh
.venv/bin/python -m pytest tests/test_quota.py tests/test_mcp_server.py tests/test_delivery_metadata.py tests/test_diagnostics.py
.venv/bin/python -m pytest
.venv/bin/ruff check src tests
```

During the initial proof (before implementation), only this plan and its proof
artifact were added. The completed implementation/acceptance is recorded above.
Existing unrelated untracked plan documents were left untouched; this plan stays
in `docs/plans/` and has not been archived.
