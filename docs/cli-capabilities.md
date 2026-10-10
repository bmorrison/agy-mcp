# agy CLI capabilities (live ground truth)

> Re-run the probe whenever `agy` is updated; capability detections are cached per adapter instance.

## Confirmed flags — local `agy --help` (v1.0.0, probed via `$(command -v agy)`, 2026-05-20)

This table is the wrapper's local compatibility baseline, not a claim
about the newest Google release channel. The official Antigravity CLI
changelog's latest public entry checked on 2026-05-26 is `1.0.2`, with
`1.0.1` fixing OAuth token persistence/auth hangs and `1.0.2` adding
`AGY_CLI_HIDE_ACCOUNT_INFO` plus several sandbox/plugin/statusline fixes.
Google's public docs cover the TUI/auth/install surface, but do not
document a stable JSON/streaming stdout contract for `--print` or
`--log-file`; this wrapper therefore keeps probing the local binary.

| Flag | Purpose |
|---|---|
| `--add-dir` (repeatable) | Add a directory to the workspace |
| `-c` / `--continue` | Continue the most recent conversation |
| `--conversation <id>` | Resume a previous conversation by ID |
| `--dangerously-skip-permissions` | Auto-approve all tool permission requests |
| `-i` / `--prompt-interactive` | Run initial prompt interactively then continue session |
| `--log-file <path>` | Override CLI log file path |
| `--mode <mode>` | Execution mode (e.g. `accept-edits`, `plan`) |
| `--new-project` | Start a fresh project / conversation context |
| `-p` / `--print` / `--prompt` | One-shot non-interactive print mode |
| `--print-timeout <dur>` | Print-mode wait timeout (default `5m0s`) |
| `--sandbox` | Run in sandbox with terminal restrictions enabled |

Subcommands: `changelog`, `install`, `plugin(s)`, `update`, `help`.

## Flags that **do NOT exist** in v1.0.0

- `--model` — model selection lives in `~/.gemini/antigravity-cli/settings.json` under key `model` (label string).
- `--output`, `--output-format`, `--json`, `--stream-json`, `--ndjson` — stdout is plain text only.
- `--version` — confirmed by stdout `1.0.0` only when invoked plainly (no flag).
- `--verbose`, `--quiet`, `--format`.

Detection rule: probe `agy --help`; if `--new-project` or `--mode` are present, the
adapter sets `supports_new_project` and `supports_mode` to True. If absent on older builds,
the adapter omits the flags and records clear warnings.

## Model selection on newer builds

The local `agy 1.3.2 --help` now advertises `--model`; the v1.0.0 table
above remains an older compatibility baseline. The adapter probes an actual
`--model` option declaration and exposes `supports_model` (default false),
not a hardcoded version threshold or an incidental mention in help prose.

When supported, an explicit request model is forwarded exactly once as
`--model=<value>` in a single argv element, including on resumed conversations.
Omitting the model leaves CLI default selection unchanged. On older builds
without the option, an explicit model request fails before inference rather
than silently using the default. No settings files are modified.

The response's adapter `model` metadata reflects the requested model (or a
settings-derived label when omitted), **not proof of actual runtime selection**.
A debug dry-run command preview demonstrates forwarding only; live CLI logs
(e.g. `Print mode: starting ... model=...` and the selected backend label) are
needed to verify actual selection.

Local verification on 2026-10-09 with CLI 1.3.2: an MCP `agy_start` request
for `gemini-3.1-pro-low` logged that exact print-mode model and propagated
`Gemini 3.1 Pro (Low)` to the backend. The read-only task completed with exit
0. This verifies forwarding and execution for that invocation, not the
correctness of the model's task output or other model identifiers.

## Environment variables read by `agy`

Verified by string-mining the Mach-O binary:

| Env var | Effect |
|---|---|
| `AGY_CLI_DISABLE_AUTO_UPDATE` | Prevent the auto-updater from pinging at launch |
| `AGY_CLI_HIDE_ACCOUNT_INFO` | Hide email and plan tier in the CLI header (official changelog 1.0.2) |
| `AGY_BROWSER_WS_URL`, `AGY_BROWSER_ACTIVE_PORT_FILE` | Internal browser-subagent plumbing |
| `ANTIGRAVITY_CONVERSATION_ID` | Inherit an existing conversation ID (CLI honors this) |
| `ANTIGRAVITY_SOURCE_METADATA`, `ANTIGRAVITY_SIDECAR_WEB_PORT`, etc. | Sidecar/IDE bridge state |

Wrapper policy: set `AGY_CLI_DISABLE_AUTO_UPDATE=1` for reproducible CI; honor
`ANTIGRAVITY_CONVERSATION_ID` when caller passes a session. The child process
inherits normal network variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`,
`NO_PROXY`) from the MCP/bridge process unless the caller overrides them via
safe `extra_env` entries.

## Filesystem touched by `agy`

| Path | Purpose | Wrapper interaction |
|---|---|---|
| system keyring | Current official auth store | Not read by wrapper; inferred only from recent successful CLI auth log lines. |
| `~/.gemini/oauth_creds.json` | OAuth tokens used by older builds | **lstat only**; if present, must be a regular file. Unsafe paths are rejected and do not fall back to keyring-log inference. |
| `~/.gemini/settings.json` | Global Gemini-family settings | Read-only: `model.name`. |
| `~/.gemini/antigravity-cli/settings.json` | CLI-specific overrides | Read-only: `model`, `toolPermission`, `artifactReviewPolicy`. |
| `~/.gemini/antigravity-cli/log/cli-*.log` | klog operational log | Replaced per-invocation via `--log-file <tmp>`; tailed for lifecycle events. |
| `~/.gemini/antigravity-cli/conversations/` | Conversation store (empty until use) | Not touched by wrapper. |
| `~/.gemini/antigravity-cli/brain/<uuid>/*.pb`, `implicit/*.pb` | Encrypted protobuf state | Not touched. |
| `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` | Primary conversation transcript (compact step JSONL) | Read-only access by `agy_transcript` tool; parsed and redacted. |
| `~/.gemini/antigravity-cli/log/**/transcript.jsonl` | NDJSON subagent transcript (when present) | Tailed opportunistically; treated as opaque pass-through events. |

## klog landmark lines parsed by the adapter

```
Starting language server process with pid %d
Language server listening on random port at %d for HTTPS (gRPC)
Language server listening on random port at %d for HTTP
CLI app data directory: %s
project: using project "%s" (id=%s) at …
Starting new conversation (agent=%v)
Created conversation %s
Streaming conversation %s
Conversation using project ID: %s
HandleUserInput called with text: %q
Auto-flush: sending %d queued input(s) (combinedLength=%d, media=%d)
SendUserMessage failed: %v
Print mode: starting (promptLength=%d, model=%q, conversationID=%q)
Print mode: conversation=%s, sending message
Print mode: silent auth succeeded
Print mode: resuming conversation %s
Print mode: empty prompt, exiting
Print mode: auth timed out
Print mode: auth error: %v
Print mode: SendUserMessage failed: %v
Trajectory has exceeded max length, clearing %d steps starting from %d
Rewinding conversation %s to step %d
Stopping conversation stream
Language server shutting down
```

`Created conversation <uuid>` is the session-ID anchor; surface it as `SESSION_ID`
in the wrapper response. Auth-failure and upstream API failure lines are mapped
to structured error events; `FAILED_PRECONDITION` commonly includes region or
plan-availability messages such as `User location is not supported`.

## Output behaviour summary

- **stdout**: plain text / markdown produced once at the end of the turn (no token streaming).
- **stderr**: usually empty in print mode; populated on hard failure.
- **--log-file**: klog operational stream; **content-light** but lifecycle-rich.
- **No JSON / NDJSON** anywhere on the public CLI surface.

For the full output strategy and Claude/Codex stream-json mapping, see [`output-strategy.md`](output-strategy.md).
