import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { AssignmentStore, type TurnRecord, type DispatchPhase, type AssignmentState } from "../src/state.js";
import { ProviderDeadline } from "../src/deadline.js";
import { canonicalJson, sha256Utf8, deriveOperation, type OperationInput, type ExecutionConfig } from "../src/contracts.js";
import { checkpointState, type CheckpointKind } from "../src/checkpoint.js";
const OWNER = "10000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000002";
const CONVERSATION = "30000000-0000-4000-8000-000000000003";
const config: ExecutionConfig = { backend: "agy", mode: "review", sandbox: true, allow_write: false, worktree: false, output_protocol: "raw", timeout: 300, model: null };
function fixture(t: TestContext) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-state-test-"));
  const root = path.join(scratch, "state"); const scope = new ProviderDeadline();
  const store = new AssignmentStore(root, OWNER, "/fixture/session.jsonl");
  t.after(() => { scope.dispose(); fs.rmSync(scratch, { recursive: true, force: true }); });
  return { scratch, root, store, scope };
}
function claim(runId = "run-1", parent: TurnRecord | null = null, owner = OWNER): OperationInput {
  const requestDigest = parent ? sha256Utf8("opaque raw reply") : null;
  return { ownerSessionId: owner, runId, stepIndex: 0, parentProviderJobId: parent?.jobId ?? null, requestId: requestDigest ? `follow-up-${requestDigest.slice(0, 48)}` : null, requestDigest, promptDigest: sha256Utf8("assembled system/task, not the raw reply"), cwd: "/fixture", executionConfigDigest: sha256Utf8(canonicalJson(config)), queue: [] };
}
function patch(t: TurnRecord, phase: DispatchPhase, state: AssignmentState = "running", backendStatus: string | null = null) {
  return { phase, semanticState: state, checkpoint: null, output: null, conversationId: t.conversationId, errorCode: null, evidence: { backendStatus, exitCode: null } };
}
function start(store: AssignmentStore, scope: ProviderDeadline, run = "run-1", owner = OWNER): TurnRecord { return store.claimTurn(claim(run, null, owner), config, scope).turn; }
function follow(store: AssignmentStore, scope: ProviderDeadline, parent: TurnRecord, run = "run-2", owner = OWNER): TurnRecord {
  return store.claimTurn(claim(run, parent, owner), config, scope, { runId: parent.claim.runId, stepIndex: parent.claim.stepIndex }).turn;
}
function terminal(store: AssignmentStore, scope: ProviderDeadline, turn: TurnRecord, kind: CheckpointKind = "question"): TurnRecord {
  if (turn.phase === "claimed") turn = store.markDispatching(turn.jobId, scope);
  const checkpoint = { version: 1 as const, kind, message: "Validated answer", artifacts: [] };
  return store.saveTurn(turn.jobId, { phase: "terminal", semanticState: checkpointState(kind), checkpoint, output: `immutable ${kind} output for ${turn.claim.runId}`, conversationId: turn.expectedConversation ?? CONVERSATION, errorCode: null, evidence: { backendStatus: "completed", exitCode: 0, ...(turn.evidence.cancelSignalled === undefined ? {} : { cancelSignalled: turn.evidence.cancelSignalled }) } }, scope);
}
function manifest(store: AssignmentStore): any { return JSON.parse(fs.readFileSync(path.join(store.ownerDirectory, "manifest.json"), "utf8")); }
function writeManifest(store: AssignmentStore, m: unknown) { fs.writeFileSync(path.join(store.ownerDirectory, "manifest.json"), JSON.stringify(m), { mode: 0o600 }); }
function lease(store: AssignmentStore, turn: TurnRecord): string { return path.join(store.ownerDirectory, `${turn.assignmentId}.lease`); }
function receipts(store: AssignmentStore, scope: ProviderDeadline, id: string) { return store.getQueueReceipts(id, scope).map(r => r.state); }

test("PR5 platform: unsupported hosts reject before state filesystem access", t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const mkdir = t.mock.method(fs, "mkdirSync", () => { throw new Error("unexpected filesystem access"); });
  try {
    for (const platform of ["win32", "freebsd", "aix"]) {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      assert.throws(() => new AssignmentStore("/unused-private-state", OWNER, null), /unsupported_platform/);
    }
    assert.equal(mkdir.mock.callCount(), 0);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("PR5 validation: each referenced turn is validated once per manifest read; later corruption is not cached", t => {
  const { store, scope } = fixture(t); const first = terminal(store, scope, start(store, scope));
  for (let i = 0; i < 16; i++) store.enqueueMessage(first.jobId, `receipt-${i}`, "private guidance", scope);
  const second = terminal(store, scope, follow(store, scope, first));
  const files = new Set(manifest(store).assignments[0].turns.map((ref: { file: string }) => path.join(store.ownerDirectory, ref.file)));
  const open = fs.openSync; let reads = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    if (files.has(String(args[0]))) reads++;
    return open(...args);
  });
  assert.equal(store.getTurn(second.jobId, scope).jobId, second.jobId);
  // Two manifest loads + their parent read, then requested load + parent read.
  // Receipt-to-snapshot checks must reuse validated records, not reread16times.
  assert.equal(reads, 5);
  const file = manifest(store).assignments[0].turns[1].file;
  const target = path.join(store.ownerDirectory, file); const bytes = fs.readFileSync(target, "utf8");
  const corrupt = JSON.parse(bytes); corrupt.config.model = "changed-frozen-model";
  fs.writeFileSync(target, JSON.stringify(corrupt), { mode: 0o600 });
  assert.throws(() => store.getTurn(second.jobId, scope), /state_turn_invalid/);
  fs.writeFileSync(target, bytes, { mode: 0o600 }); fs.unlinkSync(target);
  assert.throws(() => store.getTurn(second.jobId, scope), /state_unreadable/);
});

test("state.ts lazy private creation, frozen records, bodyless observations, no raw task/env retention", t => {
  const { store, scope, root } = fixture(t); assert.equal(fs.existsSync(root), false);
  const turn = start(store, scope); assert.equal(turn.jobId.length, 39);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700); assert.equal(fs.statSync(store.ownerDirectory).mode & 0o777, 0o700);
  const raw = "sensitive guidance 😀";
  const receipt = store.enqueueMessage(turn.jobId, "message-1", raw, scope);
  assert.equal(receipt.state, "queued"); assert.equal(Object.hasOwn(receipt, "message"), false);
  assert.equal(store.listActiveTurns(scope).length, 1);
  assert.ok(!JSON.stringify(store.getAssignmentStatus(turn.jobId, scope)).includes(raw));
  assert.ok(!JSON.stringify(store.listActiveTurns(scope)).includes(raw));
  assert.ok(Object.isFrozen(turn.claim)); assert.ok(Object.isFrozen(turn.queueSnapshot));
  for (const file of fs.readdirSync(store.ownerDirectory).filter(f => f.endsWith(".json"))) {
    assert.equal(fs.statSync(path.join(store.ownerDirectory, file)).mode & 0o777, 0o600);
    const body = fs.readFileSync(path.join(store.ownerDirectory, file), "utf8");
    assert.ok(!body.includes("assembled system/task")); assert.ok(!body.includes("opaque raw reply")); assert.ok(!body.includes("AGY_MCP"));
  }
});

test("state.ts full immutable retry lineage freezes queue before derivation; repeated raw replies are parent scoped", t => {
  const { store, scope } = fixture(t); const first = terminal(store, scope, start(store, scope));
  store.enqueueMessage(first.jobId, "m1", "first body", scope);
  const second = follow(store, scope, first); store.enqueueMessage(first.jobId, "m2", "later body", scope);
  const retry = store.claimTurn(claim("run-2", first), config, scope, { runId: "run-1", stepIndex: 0 });
  assert.equal(retry.fresh, false); assert.deepEqual(retry.turn, second); assert.equal(second.queueSnapshot.length, 1);
  assert.deepEqual(second.claim.queue, [{ sequence: 1, messageId: "m1", contentDigest: sha256Utf8("first body") }]);
  assert.notEqual(second.jobId, deriveOperation(claim("run-2", first)).jobId);
  assert.throws(() => { (second.queueSnapshot as any)[0].message = "mutated"; }, TypeError);
  for (const change of [{ promptDigest: sha256Utf8("changed") }, { cwd: "/other" }, { runId: "changed-run" }, { requestDigest: sha256Utf8("changed request") }]) {
    assert.throws(() => store.claimTurn({ ...claim("run-2", first), ...change }, config, scope, { runId: "run-1", stepIndex: 0 }));
  }
  assert.throws(() => store.claimTurn(claim("run-2", first), config, scope, { runId: "wrong", stepIndex: 0 }), /frozen_context_changed/);
  terminal(store, scope, second);
  const unrelated = terminal(store, scope, start(store, scope, "independent"));
  const third = follow(store, scope, unrelated, "independent-reply");
  assert.equal(third.claim.requestId, second.claim.requestId); assert.notEqual(third.assignmentId, second.assignmentId);
});

test("state.ts queue idempotency, message collisions, exact UTF8/order/count/aggregate bounds retain all messages", t => {
  const { store, scope } = fixture(t); const turn = start(store, scope);
  const r = store.enqueueMessage(turn.jobId, "same", "é".repeat(2048), scope);
  assert.deepEqual(store.enqueueMessage(turn.jobId, "same", "é".repeat(2048), scope), r);
  assert.throws(() => store.enqueueMessage(turn.jobId, "same", "different secret body", scope), /message_id_collision/);
  for (const message of ["é".repeat(2049), "\ud800", "\nAGY_PI_OP rejected", " "]) assert.throws(() => store.enqueueMessage(turn.jobId, "bad", message, scope));
  for (let i = 1; i < 16; i++) store.enqueueMessage(turn.jobId, `m${i}`, "a".repeat(4096), scope);
  assert.throws(() => store.enqueueMessage(turn.jobId, "overflow-bytes", "a", scope), /queue_limit/);
  assert.equal(store.getQueueReceipts(turn.jobId, scope).length, 16);
  const small = start(store, scope, "small");
  for (let i = 0; i < 20; i++) store.enqueueMessage(small.jobId, `m${i}`, "x", scope);
  assert.throws(() => store.enqueueMessage(small.jobId, "overflow-count", "x", scope), /queue_limit/);
  assert.deepEqual(store.getQueueReceipts(small.jobId, scope).map(r => r.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(!fs.readFileSync(path.join(store.ownerDirectory, "manifest.json"), "utf8").includes("different secret body"));
});

test("state.ts queue/finalization order, explicit completed reopening, unsnapshotted not_delivered preservation and no forwarded replay", t => {
  const { store, scope } = fixture(t); let first = start(store, scope);
  store.enqueueMessage(first.jobId, "before", "before completion", scope);
  first = terminal(store, scope, first, "completed");
  assert.deepEqual(receipts(store, scope, first.jobId), ["not_delivered"]);
  assert.throws(() => store.enqueueMessage(first.jobId, "after", "after completion", scope), /queue_target_closed/);
  let second = follow(store, scope, first);
  assert.equal(second.queueSnapshot[0].messageId, "before");
  second = store.markDispatching(second.jobId, scope);
  store.enqueueMessage(first.jobId, "late", "late body", scope);
  second = store.saveTurn(second.jobId, patch(second, "acknowledged"), scope);
  assert.deepEqual(receipts(store, scope, second.jobId), ["forwarded", "queued"]);
  const m = manifest(store); assert.equal(m.assignments[0].receipts[0].message, null);
  second = terminal(store, scope, second, "completed");
  assert.deepEqual(receipts(store, scope, second.jobId), ["forwarded", "not_delivered"]);
  const output = first.output;
  const third = follow(store, scope, second, "run-3"); assert.deepEqual(third.queueSnapshot.map(q => q.messageId), ["late"]);
  assert.equal(store.getTurn(first.jobId, scope).output, output);
  assert.equal(store.resolveRunTarget("run-1", 0, scope).latest.jobId, third.jobId);
  assert.equal(store.resolveRunTarget("run-1", 0, scope).requested.jobId, first.jobId);
});

for (const kind of ["question", "progress", "blocked"] as const) test(`state.ts ${kind} leaves later queue pending and permits only latest explicit resume`, t => {
  const { store, scope } = fixture(t); const first = terminal(store, scope, start(store, scope), kind);
  store.enqueueMessage(first.jobId, "m1", "first", scope); let second = follow(store, scope, first);
  store.enqueueMessage(first.jobId, "m2", "later", scope); second = terminal(store, scope, second, kind);
  assert.deepEqual(receipts(store, scope, second.jobId), ["forwarded", "queued"]);
  assert.throws(() => follow(store, scope, first, "stale-new"), /operation_claim_collision/);
  const staleDigest = sha256Utf8("distinct stale request");
  assert.throws(() => store.claimTurn({ ...claim("stale-distinct", first), requestDigest: staleDigest, requestId: `follow-up-${staleDigest.slice(0, 48)}` }, config, scope, { runId: "run-1", stepIndex: 0 }), /invalid_follow_up_parent/);
  const third = follow(store, scope, second, "run-3"); assert.deepEqual(third.queueSnapshot.map(q => q.messageId), ["m2"]);
});

test("state.ts proved local no-dispatch failure releases leases and leaves snapshot not_delivered; restarted claim has no permit", t => {
  const { store, scope, root } = fixture(t); const first = terminal(store, scope, start(store, scope));
  store.enqueueMessage(first.jobId, "m1", "body", scope); const second = follow(store, scope, first);
  const restarted = new AssignmentStore(root, OWNER, "/fixture/session.jsonl");
  assert.equal(restarted.claimTurn(claim("run-2", first), config, scope, { runId: "run-1", stepIndex: 0 }).fresh, false);
  assert.throws(() => restarted.markDispatching(second.jobId, scope), /dispatch_not_authorized/);
  assert.throws(() => restarted.saveTurn(second.jobId, { ...patch(second, "terminal", "failed"), errorCode: "probe_failed" }, scope), /invalid_turn_transition/);
  store.saveTurn(second.jobId, { ...patch(second, "terminal", "failed"), errorCode: "probe_failed" }, scope);
  assert.equal(fs.existsSync(lease(store, second)), false);
  assert.equal(fs.existsSync(path.join(root, "conversations", `${CONVERSATION}.lease`)), false);
  assert.deepEqual(receipts(store, scope, second.jobId), ["not_delivered"]);
  assert.throws(() => follow(store, scope, first, "another-reply"), /operation_claim_collision/);
  assert.throws(() => store.enqueueMessage(second.jobId, "late", "body", scope), /queue_target_closed/);
});

test("state.ts intent ambiguity, restart observation, unknown snapshots cannot replay and absent evidence cannot release", t => {
  const { store, scope, root } = fixture(t); const first = terminal(store, scope, start(store, scope));
  store.enqueueMessage(first.jobId, "m1", "body", scope); const second = follow(store, scope, first);
  store.markDispatching(second.jobId, scope);
  assert.throws(() => store.markDispatching(second.jobId, scope), /dispatch_not_authorized/);
  const restarted = new AssignmentStore(root, OWNER, "/fixture/session.jsonl");
  const observed = restarted.getTurn(second.jobId, scope);
  assert.equal(observed.phase, "dispatch_unknown"); assert.equal(observed.semanticState, "execution_unknown");
  assert.deepEqual(receipts(restarted, scope, second.jobId), ["dispatch_unknown"]);
  assert.equal(restarted.listActiveTurns(scope)[0].phase, "dispatch_unknown");
  assert.throws(() => restarted.withConversationLease(second.jobId, scope, () => 0), /lease_not_owned/);
  assert.throws(() => restarted.markDispatching(second.jobId, scope), /dispatch_not_authorized/);
  assert.throws(() => restarted.enqueueMessage(second.jobId, "late", "body", scope), /queue_target_closed/);
  assert.throws(() => store.saveTurn(second.jobId, patch(second, "terminal", "failed", "unknown"), scope), /terminal_evidence_required/);
  store.saveTurn(second.jobId, { ...patch(second, "dispatch_unknown", "execution_unknown", "unknown"), errorCode: "backend_unknown" }, scope);
  assert.deepEqual(receipts(store, scope, second.jobId), ["dispatch_unknown"]);
  assert.ok(fs.existsSync(lease(store, second)));
  const reconciled = store.saveTurn(second.jobId, patch(second, "acknowledged", "running", "running"), scope);
  assert.deepEqual(receipts(store, scope, second.jobId), ["forwarded"]);
  terminal(store, scope, reconciled); assert.equal(fs.existsSync(lease(store, second)), false);
});

for (const backend of ["failed", "upstream_error", "cancelled", "completed"]) test(`state.ts exact terminal ${backend} proof releases own lease, failed/checkpoint-invalid paths preserve forwarding`, t => {
  const { store, scope } = fixture(t); const first = terminal(store, scope, start(store, scope));
  store.enqueueMessage(first.jobId, "snap", "body", scope); let second = follow(store, scope, first);
  second = store.markDispatching(second.jobId, scope); second = store.saveTurn(second.jobId, patch(second, "acknowledged", "running", "running"), scope);
  store.enqueueMessage(second.jobId, "unsnap", "later", scope);
  const terminalPatch = { ...patch(second, "terminal", backend === "cancelled" ? "cancelled" : "failed", backend), errorCode: backend === "completed" ? "checkpoint_framing" : `backend_${backend}`, evidence: { backendStatus: backend, exitCode: 1 } };
  store.saveTurn(second.jobId, terminalPatch, scope);
  assert.deepEqual(receipts(store, scope, second.jobId), ["forwarded", "not_delivered"]);
  assert.equal(fs.existsSync(lease(store, second)), false);
  assert.throws(() => follow(store, scope, store.getTurn(second.jobId, scope), "late-resume"), /invalid_follow_up_parent/);
  assert.equal(store.listActiveTurns(scope).length, 0);
  assert.deepEqual(store.saveTurn(second.jobId, terminalPatch, scope), store.getTurn(second.jobId, scope));
  assert.throws(() => store.saveTurn(second.jobId, { ...terminalPatch, errorCode: "rewrite" }, scope), /terminal_turn_immutable/);
});

test("state.ts cancel signal true/false and native timeout/shutdown are not terminal proof or forwarding reversal", t => {
  const { store, scope } = fixture(t); const first = terminal(store, scope, start(store, scope));
  store.enqueueMessage(first.jobId, "snap", "body", scope); let second = follow(store, scope, first);
  second = store.markDispatching(second.jobId, scope);
  second = store.saveTurn(second.jobId, { ...patch(second, "dispatching"), evidence: { backendStatus: null, exitCode: null, cancelSignalled: false } }, scope);
  assert.deepEqual(receipts(store, scope, second.jobId), ["queued"]);
  second = store.saveTurn(second.jobId, { ...patch(second, "acknowledged"), evidence: { backendStatus: "running", exitCode: null, cancelSignalled: true } }, scope);
  assert.throws(() => store.saveTurn(second.jobId, { ...patch(second, "terminal", "cancelled", "running"), evidence: { backendStatus: "running", exitCode: null, cancelSignalled: true } }, scope));
  const unknown = store.saveTurn(second.jobId, { ...patch(second, "acknowledged", "execution_unknown", "running"), errorCode: "observation_timeout", evidence: { backendStatus: "running", exitCode: null, cancelSignalled: true } }, scope);
  assert.deepEqual(receipts(store, scope, second.jobId), ["forwarded"]); assert.ok(fs.existsSync(lease(store, second)));
  assert.equal(store.withConversationLease(second.jobId, scope, turn => turn.jobId), second.jobId);
  assert.throws(() => store.saveTurn(second.jobId, patch(second, "acknowledged", "running", "running"), scope), /evidence_regression/);
  terminal(store, scope, unknown);
});

test("state.ts checkpoint/conversation/output/phase inconsistencies fail without raw output persistence", t => {
  const { store, scope } = fixture(t); const first = terminal(store, scope, start(store, scope)); const second = follow(store, scope, first);
  store.markDispatching(second.jobId, scope);
  for (const p of [patch(second, "claimed"), patch(second, "terminal", "running", "completed"), { ...patch(second, "acknowledged"), output: "RAW REJECTED SECRET" }, { ...patch(second, "dispatch_unknown", "running") }, { ...patch(second, "terminal", "failed", "completed"), errorCode: "secret text" }]) assert.throws(() => store.saveTurn(second.jobId, p, scope));
  const checkpoint = { version: 1 as const, kind: "question" as const, message: "valid", artifacts: [] };
  assert.throws(() => store.saveTurn(second.jobId, { ...patch(second, "terminal", "waiting_for_supervisor", "completed"), checkpoint, output: "valid", conversationId: OTHER }, scope), /conversation_lineage_mismatch/);
  assert.ok(!fs.readdirSync(store.ownerDirectory).filter(f => f.endsWith(".json")).some(f => fs.readFileSync(path.join(store.ownerDirectory, f), "utf8").includes("RAW REJECTED SECRET")));
});

test("state.ts other owner/session-file/cwd/config/source/latest target refusal; clean completed restart", t => {
  const { store, scope, root } = fixture(t); const first = terminal(store, scope, start(store, scope));
  const restarted = new AssignmentStore(root, OWNER, "/fixture/session.jsonl");
  assert.deepEqual(restarted.getTurn(first.jobId, scope), first);
  assert.equal(restarted.listActiveTurns(scope).length, 0);
  assert.throws(() => new AssignmentStore(root, OWNER, "/other/session.jsonl").getTurn(first.jobId, scope), /state_manifest_invalid/);
  assert.throws(() => new AssignmentStore(root, OTHER, "/other/session.jsonl").getTurn(first.jobId, scope), /turn_missing/);
  assert.throws(() => store.claimTurn(claim("foreign", null, OTHER), config, scope), /state_identity_invalid/);
  assert.throws(() => store.claimTurn({ ...claim("run-2", first), cwd: "/changed" }, config, scope, { runId: "run-1", stepIndex: 0 }), /frozen_context_changed/);
  assert.throws(() => store.claimTurn(claim("run-2", first), config, scope, { runId: "run-1", stepIndex: 1 }), /invalid_follow_up_parent/);
  assert.throws(() => store.claimTurn(claim("run-2", first), { ...config, model: "other" }, scope, { runId: "run-1", stepIndex: 0 }), /state_identity_invalid/);
  const second = follow(restarted, scope, first); assert.equal(second.expectedConversation, first.conversationId);
  assert.throws(() => follow(store, scope, first, "competing"), /operation_claim_collision/);
  assert.throws(() => store.resolveRunTarget("unknown", 0, scope), /run_target_missing/);
});

test("state.ts shared UUID conversation lease excludes another owner; partial acquisition releases only own new assignment lease", t => {
  const { store, scope, root } = fixture(t); const first = terminal(store, scope, start(store, scope)); const second = follow(store, scope, first);
  const other = new AssignmentStore(root, OTHER, "/other/session.jsonl"); const foreignParent = terminal(other, scope, start(other, scope, "foreign-first", OTHER));
  const token = fs.readFileSync(path.join(root, "conversations", `${CONVERSATION}.lease`, "owner.json"), "utf8");
  assert.throws(() => follow(other, scope, foreignParent, "foreign-reply", OTHER), /conversation_leased/);
  assert.equal(fs.existsSync(lease(other, foreignParent)), false);
  assert.equal(fs.readFileSync(path.join(root, "conversations", `${CONVERSATION}.lease`, "owner.json"), "utf8"), token);
  assert.equal(manifest(other).assignments[0].turns.length, 1);
  terminal(store, scope, second);
  assert.equal(follow(other, scope, foreignParent, "foreign-reply", OTHER).expectedConversation, CONVERSATION);
});

for (const kind of ["empty", "malformed", "foreign", "dead-pid", "symlink"] as const) test(`state.ts ${kind} mutation/assignment/conversation lock refuses takeover`, t => {
  const { store, scope, root } = fixture(t); const first = terminal(store, scope, start(store, scope));
  const lock = path.join(store.ownerDirectory, "mutation.lock"); fs.mkdirSync(lock, { mode: 0o700 });
  const lockToken = path.join(lock, "owner.json"); const token = kind === "malformed" ? "{" : JSON.stringify({ version: 1, ownerSessionId: OTHER, pid: kind === "dead-pid" ? 99999999 : process.pid, nonce: "foreign" });
  if (kind === "symlink") fs.symlinkSync("missing", lockToken); else if (kind !== "empty") fs.writeFileSync(lockToken, token, { mode: 0o600 });
  assert.throws(() => store.getTurn(first.jobId, scope), /state_locked/); assert.ok(fs.existsSync(lock));
  fs.rmSync(lock, { recursive: true }); // Fixture-only cleanup, not store maintenance/takeover.
  for (const dir of [lease(store, first), path.join(root, "conversations", `${CONVERSATION}.lease`)]) {
    fs.mkdirSync(path.dirname(dir), { mode: 0o700, recursive: true }); fs.mkdirSync(dir, { mode: 0o700 });
    if (kind === "symlink") fs.symlinkSync("missing", path.join(dir, "owner.json")); else if (kind !== "empty") fs.writeFileSync(path.join(dir, "owner.json"), token, { mode: 0o600 });
    assert.throws(() => follow(store, scope, first), /conversation_leased/); assert.ok(fs.existsSync(dir));
    fs.rmSync(dir, { recursive: true });
  }
});

test("state.ts terminal proof cannot release a replaced foreign/nonregular local lease token", t => {
  const { store, scope } = fixture(t); const first = start(store, scope); store.markDispatching(first.jobId, scope);
  const token = path.join(lease(store, first), "owner.json"); fs.writeFileSync(token, JSON.stringify({ version: 1, ownerSessionId: OTHER, pid: process.pid, nonce: "other" }));
  assert.throws(() => terminal(store, scope, { ...first, phase: "dispatching" }), /lease_owner_mismatch/);
  assert.ok(fs.existsSync(token)); assert.equal(store.getTurn(first.jobId, scope).phase, "terminal");
});

test("state.ts strict unsafe identity, schema, symlink, directory, FIFO, permissions, oversized and missing referenced version refusal", t => {
  const { store, scope, scratch, root } = fixture(t);
  for (const owner of ["../escape", "bad"]) assert.throws(() => new AssignmentStore(root, owner, null));
  assert.throws(() => new AssignmentStore("relative", OWNER, null)); assert.throws(() => new AssignmentStore(root, OWNER, "relative"));
  assert.throws(() => store.getTurn("../../secret", scope));
  for (const c of [{ ...claim(), cwd: "/fixture/../escape" }, { ...claim(), runId: "bad\u0000" }, { ...claim(), stepIndex: -1 }, { ...claim(), extra: "env secret" }]) assert.throws(() => store.claimTurn(c, config, scope));
  const first = start(store, scope); const original = manifest(store); const mf = path.join(store.ownerDirectory, "manifest.json"); const ref = path.join(store.ownerDirectory, original.assignments[0].turns[0].file);
  const bytes = fs.readFileSync(ref);
  for (const alteration of [(m: any) => m.assignments[0].turns[0].file = "../secret", (m: any) => m.ownerSessionId = OTHER, (m: any) => m.extra = "env", (m: any) => m.assignments[0].receipts = [{ message: "secret" }]]) {
    const m = structuredClone(original); alteration(m); writeManifest(store, m); assert.throws(() => store.getTurn(first.jobId, scope));
  }
  writeManifest(store, original);
  for (const change of [(v: any) => v.source = { runId: "fabricated", stepIndex: 0 }, (v: any) => delete v.queueSnapshot, (v: any) => v.claim.promptDigest = "0".repeat(64), (v: any) => v.evidence = null]) {
    const v = JSON.parse(bytes.toString()); change(v); fs.writeFileSync(ref, JSON.stringify(v)); assert.throws(() => store.getTurn(first.jobId, scope));
  }
  fs.writeFileSync(ref, bytes); fs.chmodSync(ref, 0o644); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/); fs.chmodSync(ref, 0o600);
  fs.writeFileSync(ref, "{"); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/);
  fs.writeFileSync(ref, bytes); fs.truncateSync(ref, 2 * 1024 * 1024 + 1); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/);
  fs.unlinkSync(ref); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/);
  fs.symlinkSync(path.join(scratch, "missing"), ref); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/); fs.unlinkSync(ref);
  fs.mkdirSync(ref); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/); fs.rmdirSync(ref);
  execFileSync("mkfifo", [ref]); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/); fs.unlinkSync(ref);
  fs.writeFileSync(ref, bytes); fs.unlinkSync(mf); fs.symlinkSync("missing", mf); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/);
  fs.unlinkSync(mf); writeManifest(store, original); fs.chmodSync(store.ownerDirectory, 0o755); assert.throws(() => store.getTurn(first.jobId, scope), /state_unsafe_directory/); fs.chmodSync(store.ownerDirectory, 0o700);
  const linkedRoot = path.join(scratch, "linked"); fs.symlinkSync(root, linkedRoot); assert.throws(() => new AssignmentStore(linkedRoot, OWNER, null).listActiveTurns(scope), /state_unsafe_directory/);
});

test("state.ts assignment cap 32 and turn cap 64 reject without deleting evidence", t => {
  const { store, scope } = fixture(t);
  for (let i = 0; i < 32; i++) { const turn = start(store, scope, `assignment-${i}`); store.saveTurn(turn.jobId, { ...patch(turn, "terminal", "failed"), errorCode: "probe_failed" }, scope); }
  assert.throws(() => start(store, scope, "overflow"), /assignment_limit/); assert.equal(manifest(store).assignments.length, 32);
  const other = new AssignmentStore(store.root, OTHER, "/other/session.jsonl"); let latest = terminal(other, scope, start(other, scope, "turn-0", OTHER));
  for (let i = 1; i < 64; i++) latest = terminal(other, scope, follow(other, scope, latest, `turn-${i}`, OTHER));
  assert.throws(() => follow(other, scope, latest, "turn-overflow", OTHER), /turn_limit/);
  assert.equal(manifest(other).assignments[0].turns.length, 64);
});

test("state.ts 256 lifetime receipts remain bodyless/idempotent, reject the 257th without purge", t => {
  const { store, scope } = fixture(t); let latest = terminal(store, scope, start(store, scope));
  for (let batch = 0; batch < 16; batch++) {
    for (let i = 0; i < 16; i++) store.enqueueMessage(latest.jobId, `m-${batch * 16 + i}`, `private-${i}`, scope);
    latest = terminal(store, scope, follow(store, scope, latest, `batch-${batch}`));
  }
  assert.equal(store.getQueueReceipts(latest.jobId, scope).length, 256);
  assert.deepEqual(new Set(receipts(store, scope, latest.jobId)), new Set(["forwarded"]));
  assert.throws(() => store.enqueueMessage(latest.jobId, "m-257", "never persisted", scope), /receipt_limit/);
  assert.equal(store.enqueueMessage(latest.jobId, "m-0", "private-0", scope).state, "forwarded");
});

test("state.ts forced short-id collision compares full immutable claims and never allocates a replacement", t => {
  const { store, scope } = fixture(t); const createHash = crypto.createHash;
  t.mock.method(crypto, "createHash", (...args: Parameters<typeof createHash>) => {
    const hash = createHash(...args); const update = hash.update.bind(hash); const digest = hash.digest.bind(hash); let text = "";
    hash.update = ((data: any, encoding?: any) => { text += typeof data === "string" ? data : data.toString(); return update(data, encoding); }) as typeof hash.update;
    hash.digest = ((encoding?: any) => { const output = digest(encoding); if (encoding === "hex" && text.includes('"protocolVersion":1') && text.includes('"provider":"agy-mcp"')) return "a".repeat(32) + String(output).slice(32); return output; }) as typeof hash.digest;
    return hash;
  }); syncBuiltinESMExports();
  try {
    const first = start(store, scope, "collision-first");
    assert.throws(() => start(store, scope, "collision-second"), /operation_claim_collision/);
    assert.equal(manifest(store).assignments.length, 1); assert.equal(manifest(store).assignments[0].latestJobId, first.jobId);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

function child(scratch: string, store: AssignmentStore, mode: string, inputClaim: OperationInput, source?: { runId: string; stepIndex: number }): ChildProcess {
  const file = path.join(scratch, `child-${mode}.json`); fs.writeFileSync(file, JSON.stringify({ root: store.root, owner: store.ownerSessionId, sessionFile: store.ownerSessionFile, claim: inputClaim, config, source }), { mode: 0o600 });
  return fork(new URL("./support/state-child.ts", import.meta.url), [file, mode, path.join(scratch, "release")], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
}
for (const mode of ["crash-before", "crash-after"]) test(`state.ts actual child ${mode} manifest publication leaves fail-closed lock/lease and no dispatch authorization`, { timeout: 10000 }, async t => {
  const { store, scope, scratch } = fixture(t); const p = child(scratch, store, mode, claim()); const [code] = await once(p, "exit");
  assert.equal(code, mode === "crash-before" ? 73 : 74);
  const files = fs.readdirSync(store.ownerDirectory); assert.ok(files.some(f => f.startsWith("job_pi_") && f.endsWith(".json")));
  assert.ok(fs.existsSync(path.join(store.ownerDirectory, "mutation.lock", "owner.json")));
  if (mode === "crash-before") assert.equal(fs.existsSync(path.join(store.ownerDirectory, "manifest.json")), false);
  else { const m = manifest(store); assert.ok(fs.existsSync(path.join(store.ownerDirectory, m.assignments[0].turns[0].file))); assert.equal(JSON.parse(fs.readFileSync(path.join(store.ownerDirectory, m.assignments[0].turns[0].file), "utf8")).phase, "claimed"); }
  assert.throws(() => start(store, scope), /state_locked/);
});

test("state.ts deterministic filesystem child mutation race excludes queue and competing follow-up before publication", { timeout: 10000 }, async t => {
  const { store, scope, scratch } = fixture(t); const first = terminal(store, scope, start(store, scope)); store.enqueueMessage(first.jobId, "before", "before", scope);
  const p = child(scratch, store, "hold", claim("child-reply", first), { runId: "run-1", stepIndex: 0 });
  t.after(() => { if (p.exitCode === null) p.kill(); });
  const [message] = await once(p, "message"); assert.deepEqual(message, { ready: true });
  assert.throws(() => store.enqueueMessage(first.jobId, "during", "body", scope), /state_locked/);
  assert.throws(() => follow(store, scope, first, "competing"), /state_locked/);
  const done = once(p, "exit"); fs.writeFileSync(path.join(scratch, "release"), "release"); const [code] = await done; assert.equal(code, 0);
  assert.equal(manifest(store).assignments[0].turns.length, 2);
  assert.deepEqual(receipts(store, scope, first.jobId), ["queued"]);
  assert.throws(() => follow(store, scope, first, "competing"), /operation_claim_collision/);
});

test("state.ts actual rename failure before publication cannot expose unpublished version or dispatch permit", t => {
  const { store, scope } = fixture(t); const first = terminal(store, scope, start(store, scope));
  const old = fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")); const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { if (String(to).endsWith("/manifest.json")) throw new Error("injected private error"); return rename(from, to); });
  assert.throws(() => follow(store, scope, first), /state_write_failed/); t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")), old);
  const unpublished = deriveOperation(claim("run-2", first)).jobId;
  assert.throws(() => store.markDispatching(unpublished, scope), /dispatch_not_authorized/);
  assert.equal(store.getTurn(first.jobId, scope).jobId, first.jobId);
  assert.throws(() => follow(store, scope, first), /conversation_leased/);
});

test("state.ts expired injected ProviderDeadline has zero admission/writes and cannot dispatch", t => {
  const { store, root, scope } = fixture(t); let clock = 0; const expired = new ProviderDeadline(() => clock); t.after(() => expired.dispose()); clock = 85000;
  assert.throws(() => start(store, expired), /provider_deadline/); assert.equal(fs.existsSync(root), false);
  const first = start(store, scope); assert.throws(() => store.markDispatching(first.jobId, expired), /provider_deadline/);
  assert.equal(store.getTurn(first.jobId, scope).phase, "claimed");
});

for (const mode of ["intent-before", "intent-after"]) test(`state.ts actual child ${mode} publication never authorizes restart start`, { timeout: 10000 }, async t => {
  const { store, scope, scratch } = fixture(t); const p = child(scratch, store, mode, claim()); const [code] = await once(p, "exit");
  assert.equal(code, mode === "intent-before" ? 73 : 74);
  const m = manifest(store); const ref = m.assignments[0].turns[0];
  const persisted = JSON.parse(fs.readFileSync(path.join(store.ownerDirectory, ref.file), "utf8"));
  assert.equal(persisted.phase, mode === "intent-before" ? "claimed" : "dispatching");
  assert.ok(fs.existsSync(path.join(store.ownerDirectory, "mutation.lock", "owner.json")));
  assert.throws(() => store.markDispatching(ref.jobId, scope), /state_locked/);
});

test("state.ts actual filesystem finalization race serializes queued-before-final and rejects after-final with receipt preserved", { timeout: 10000 }, async t => {
  const { store, scope, scratch } = fixture(t); const first = start(store, scope); store.markDispatching(first.jobId, scope);
  store.enqueueMessage(first.jobId, "before", "sensitive late guidance", scope);
  const p = child(scratch, store, "hold-final", claim()); t.after(() => { if (p.exitCode === null) p.kill(); });
  const [message] = await once(p, "message"); assert.deepEqual(message, { ready: true });
  assert.throws(() => store.enqueueMessage(first.jobId, "during", "body", scope), /state_locked/);
  const done = once(p, "exit"); fs.writeFileSync(path.join(scratch, "release"), "release"); const [code] = await done; assert.equal(code, 0);
  assert.deepEqual(receipts(store, scope, first.jobId), ["not_delivered"]);
  assert.throws(() => store.enqueueMessage(first.jobId, "after", "body", scope), /queue_target_closed/);
  // Foreign terminal observation cannot release the original local lease. Exact local replay with proof can.
  assert.ok(fs.existsSync(lease(store, first)));
  const saved = store.getTurn(first.jobId, scope);
  store.saveTurn(first.jobId, { phase: saved.phase, semanticState: saved.semanticState, checkpoint: saved.checkpoint, output: saved.output, conversationId: saved.conversationId, errorCode: saved.errorCode, evidence: saved.evidence }, scope);
  assert.equal(fs.existsSync(lease(store, first)), false);
});

test("state.ts rejected >2MiB version cannot publish or enable dispatch; corrupt UTF8 and nonregular lease release fail fixed", t => {
  const { store, scope } = fixture(t);
  const huge = { ...config, model: "a".repeat(2 * 1024 * 1024) };
  const input = { ...claim(), executionConfigDigest: sha256Utf8(canonicalJson(huge)) };
  assert.throws(() => store.claimTurn(input, huge, scope), /state_oversize/);
  assert.equal(fs.existsSync(path.join(store.ownerDirectory, "manifest.json")), false);
  assert.throws(() => store.markDispatching(deriveOperation(input).jobId, scope), /dispatch_not_authorized/);
  const first = start(store, scope, "safe-turn"); store.markDispatching(first.jobId, scope);
  const m = manifest(store); const ref = path.join(store.ownerDirectory, m.assignments[0].turns[0].file); const bytes = fs.readFileSync(ref);
  fs.writeFileSync(ref, Buffer.concat([bytes.subarray(0, -1), Buffer.from([0xff, 0x7d])])); assert.throws(() => store.getTurn(first.jobId, scope), /state_unreadable/); fs.writeFileSync(ref, bytes);
  const token = path.join(lease(store, first), "owner.json"); fs.unlinkSync(token); fs.symlinkSync("missing", token);
  assert.throws(() => terminal(store, scope, { ...first, phase: "dispatching" }), /state_unreadable/);
  assert.ok(fs.lstatSync(token).isSymbolicLink());
});

test("state.ts foreign/restarted claimed observations project no admission authority, preserve exact bytes and reject queue without receipt", t => {
  const { store, scope, root } = fixture(t); const first = start(store, scope);
  store.enqueueMessage(first.jobId, "local", "locally admissible", scope);
  const mf = path.join(store.ownerDirectory, "manifest.json"); const before = fs.readFileSync(mf);
  const ref = manifest(store).assignments[0].turns[0].file; const turnBytes = fs.readFileSync(path.join(store.ownerDirectory, ref));
  const leaseBytes = fs.readFileSync(path.join(lease(store, first), "owner.json"));
  const restarted = new AssignmentStore(root, OWNER, "/fixture/session.jsonl");
  const observed = restarted.getTurn(first.jobId, scope);
  assert.equal(observed.phase, "claimed"); assert.equal(observed.semanticState, "execution_unknown"); assert.equal(observed.errorCode, "admission_abandoned");
  assert.equal(restarted.listActiveTurns(scope)[0].errorCode, "admission_abandoned");
  assert.equal(restarted.getAssignmentStatus(first.jobId, scope).semanticState, "execution_unknown");
  assert.throws(() => restarted.enqueueMessage(first.jobId, "foreign", "not accepted", scope), /queue_target_closed/);
  assert.throws(() => restarted.markDispatching(first.jobId, scope), /dispatch_not_authorized/);
  assert.throws(() => restarted.saveTurn(first.jobId, { phase: observed.phase, semanticState: observed.semanticState, checkpoint: null, output: null, conversationId: null, errorCode: observed.errorCode, evidence: observed.evidence }, scope), /state_turn_invalid/);
  assert.deepEqual(fs.readFileSync(mf), before); assert.deepEqual(fs.readFileSync(path.join(store.ownerDirectory, ref)), turnBytes); assert.deepEqual(fs.readFileSync(path.join(lease(store, first), "owner.json")), leaseBytes);
  assert.equal(store.getTurn(first.jobId, scope).semanticState, "running"); assert.equal(store.getTurn(first.jobId, scope).errorCode, null);
  store.enqueueMessage(first.jobId, "local-2", "still admissible", scope);
  assert.equal(store.markDispatching(first.jobId, scope).phase, "dispatching");
  assert.throws(() => store.markDispatching(first.jobId, scope), /dispatch_not_authorized/);
  assert.equal(store.getTurn(first.jobId, scope).phase, "dispatching");
  assert.equal(restarted.getTurn(first.jobId, scope).phase, "dispatch_unknown");
});

test("state.ts valid terminal formatted text uses the planned 2MiB file bound, not an extra smaller output ceiling", t => {
  const { store, scope } = fixture(t); const first = start(store, scope); store.markDispatching(first.jobId, scope);
  const output = "backend-redacted formatted result\n" + "x".repeat(150 * 1024);
  const checkpoint = { version: 1 as const, kind: "completed" as const, message: "valid", artifacts: [] };
  const saved = store.saveTurn(first.jobId, { phase: "terminal", semanticState: "completed", checkpoint, output, conversationId: CONVERSATION, errorCode: null, evidence: { backendStatus: "completed", exitCode: 0 } }, scope);
  assert.equal(saved.output, output); assert.equal(store.getTurn(first.jobId, scope).output, output);
  const m = manifest(store); assert.ok(fs.statSync(path.join(store.ownerDirectory, m.assignments[0].turns[0].file)).size < 2 * 1024 * 1024);
});

function savedPatch(turn: TurnRecord) {
  return { phase: turn.phase, semanticState: turn.semanticState, checkpoint: turn.checkpoint, output: turn.output, conversationId: turn.conversationId, errorCode: turn.errorCode, evidence: turn.evidence };
}
function retainedTurnBytes(store: AssignmentStore, id: string): Buffer {
  const ref = manifest(store).assignments.flatMap((a: any) => a.turns).find((r: any) => r.jobId === id);
  return fs.readFileSync(path.join(store.ownerDirectory, ref.file));
}
function leaseTokenBytes(store: AssignmentStore, turn: TurnRecord): Buffer[] {
  return [lease(store, turn), path.join(store.root, "conversations", `${turn.expectedConversation}.lease`)].map(dir => fs.readFileSync(path.join(dir, "owner.json")));
}

test("state.ts superseded terminal replay preserves newer active turn lease acquisition and immutable older result", t => {
  const { store, scope, root } = fixture(t);
  const a = terminal(store, scope, start(store, scope, "A"));
  const bClaimed = follow(store, scope, a, "B"); const bTokens = leaseTokenBytes(store, bClaimed);
  const b = terminal(store, scope, bClaimed);
  const c = store.markDispatching(follow(store, scope, b, "C").jobId, scope);
  const cTokens = leaseTokenBytes(store, c); const bBytes = retainedTurnBytes(store, b.jobId);
  const manifestBytes = fs.readFileSync(path.join(store.ownerDirectory, "manifest.json"));
  const other = new AssignmentStore(root, OTHER, "/other/session.jsonl");
  const parent = terminal(other, scope, start(other, scope, "foreign-parent", OTHER));
  assert.deepEqual(store.saveTurn(b.jobId, savedPatch(b), scope), b);
  assert.deepEqual(leaseTokenBytes(store, c), cTokens);
  assert.notDeepEqual(cTokens[0], bTokens[0]); assert.notDeepEqual(cTokens[1], bTokens[1]);
  assert.equal(store.withConversationLease(c.jobId, scope, current => current.jobId), c.jobId);
  assert.throws(() => follow(other, scope, parent, "foreign-follow-up", OTHER), /conversation_leased/);
  assert.deepEqual(leaseTokenBytes(store, c), cTokens);
  assert.deepEqual(retainedTurnBytes(store, b.jobId), bBytes);
  assert.deepEqual(fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")), manifestBytes);
  assert.equal(store.getTurn(b.jobId, scope).output, b.output);
  terminal(store, scope, c);
  assert.equal(fs.existsSync(lease(store, c)), false);
  assert.equal(fs.existsSync(path.join(root, "conversations", `${CONVERSATION}.lease`)), false);
});

test("state.ts latest terminal replay cannot release a newer unpublished uncertain acquisition", t => {
  const { store, scope, root } = fixture(t);
  const a = terminal(store, scope, start(store, scope, "A"));
  const b = terminal(store, scope, follow(store, scope, a, "B"));
  const mf = path.join(store.ownerDirectory, "manifest.json"); const manifestBytes = fs.readFileSync(mf); const bBytes = retainedTurnBytes(store, b.jobId);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { if (String(to) === mf) throw new Error("injected publication failure"); return rename(from, to); });
  assert.throws(() => follow(store, scope, b, "C-unpublished"), /state_write_failed/); t.mock.restoreAll();
  const tokens = leaseTokenBytes(store, b); // Same lease paths; different unpublished acquisition must remain private and retained.
  assert.equal(manifest(store).assignments[0].latestJobId, b.jobId);
  assert.deepEqual(store.saveTurn(b.jobId, savedPatch(b), scope), b);
  assert.deepEqual(leaseTokenBytes(store, b), tokens);
  assert.deepEqual(fs.readFileSync(mf), manifestBytes); assert.deepEqual(retainedTurnBytes(store, b.jobId), bBytes);
  const unpublishedId = deriveOperation(claim("C-unpublished", b)).jobId;
  assert.throws(() => store.markDispatching(unpublishedId, scope), /dispatch_not_authorized/);
  assert.throws(() => store.withConversationLease(b.jobId, scope, () => 0), /lease_not_owned/);
  assert.throws(() => follow(store, scope, b, "C-unpublished"), /conversation_leased/);
  const other = new AssignmentStore(root, OTHER, "/other/session.jsonl");
  const parent = terminal(other, scope, start(other, scope, "foreign-parent", OTHER));
  assert.throws(() => follow(other, scope, parent, "foreign-follow-up", OTHER), /conversation_leased/);
  assert.deepEqual(leaseTokenBytes(store, b), tokens);
});

test("state.ts recovered reopened not_delivered snapshot projects unknown without replay or mutation and preserves forwarded receipts", t => {
  const { store, scope, root } = fixture(t);
  const a = terminal(store, scope, start(store, scope, "A"));
  store.enqueueMessage(a.jobId, "forwarded", "forwarded private body", scope);
  let b = follow(store, scope, a, "B"); b = store.markDispatching(b.jobId, scope);
  b = store.saveTurn(b.jobId, patch(b, "acknowledged"), scope);
  store.enqueueMessage(b.jobId, "late", "late private body", scope);
  b = terminal(store, scope, b, "completed");
  assert.deepEqual(receipts(store, scope, b.jobId), ["forwarded", "not_delivered"]);
  const c = store.markDispatching(follow(store, scope, b, "C").jobId, scope);
  const mf = path.join(store.ownerDirectory, "manifest.json"); const manifestBytes = fs.readFileSync(mf); const cBytes = retainedTurnBytes(store, c.jobId); const tokens = leaseTokenBytes(store, c);
  const observer = new AssignmentStore(root, OWNER, "/fixture/session.jsonl");
  assert.equal(observer.getTurn(c.jobId, scope).phase, "dispatch_unknown");
  assert.deepEqual(receipts(observer, scope, c.jobId), ["forwarded", "dispatch_unknown"]);
  assert.deepEqual(observer.getAssignmentStatus(c.jobId, scope).receipts.map(r => r.state), ["forwarded", "dispatch_unknown"]);
  assert.equal(observer.enqueueMessage(c.jobId, "late", "late private body", scope).state, "dispatch_unknown");
  const repeated = observer.claimTurn(claim("C", b), config, scope, { runId: "B", stepIndex: 0 });
  assert.equal(repeated.fresh, false); assert.deepEqual(repeated.turn.queueSnapshot, c.queueSnapshot);
  assert.throws(() => observer.markDispatching(c.jobId, scope), /dispatch_not_authorized/);
  assert.throws(() => observer.enqueueMessage(c.jobId, "new", "new body", scope), /queue_target_closed/);
  assert.throws(() => observer.withConversationLease(c.jobId, scope, () => 0), /lease_not_owned/);
  assert.throws(() => follow(observer, scope, c, "no-replay"), /invalid_follow_up_parent/);
  assert.deepEqual(fs.readFileSync(mf), manifestBytes); assert.deepEqual(retainedTurnBytes(store, c.jobId), cBytes); assert.deepEqual(leaseTokenBytes(store, c), tokens);
  assert.equal(store.withConversationLease(c.jobId, scope, current => current.jobId), c.jobId);
});

test("state.ts genuinely uppercase UUID rejects before filesystem creation; canonical lowercase owner remains valid without escape", t => {
  const { scratch, root, scope } = fixture(t);
  const lowercase = "abcdef01-2345-4abc-8def-012345abcdef"; const uppercase = lowercase.toUpperCase();
  assert.notEqual(uppercase, lowercase);
  assert.throws(() => new AssignmentStore(root, uppercase, null), /invalid_owner_identity/);
  assert.throws(() => new AssignmentStore(root, "../escape", null), /invalid_owner_identity/);
  assert.equal(fs.existsSync(root), false); assert.equal(fs.existsSync(path.join(scratch, "escape")), false);
  const valid = new AssignmentStore(root, lowercase, null);
  const turn = start(valid, scope, "lowercase-control", lowercase);
  assert.equal(valid.ownerDirectory, path.join(root, lowercase)); assert.equal(valid.getTurn(turn.jobId, scope).claim.ownerSessionId, lowercase);
  assert.deepEqual(fs.readdirSync(root), [lowercase]); assert.equal(fs.existsSync(path.join(scratch, "escape")), false);
});

test("state.ts settlement work-expired/aborted uses original remaining total, shared first-entry <=5s across writes", t => {
  const { store, scope } = fixture(t); let turn = store.markDispatching(start(store, scope).jobId, scope);
  let now = 0; const abort = new AbortController(); const local = new ProviderDeadline(() => now, 90000, 5000, abort.signal); t.after(() => local.dispose());
  abort.abort();
  turn = store.settleTurn(turn.jobId, { ...patch(turn, "dispatch_unknown", "execution_unknown"), errorCode: "provider_deadline" }, local);
  now = 4999;
  store.settleTurn(turn.jobId, { ...patch(turn, "dispatch_unknown", "execution_unknown"), errorCode: "mcp_request_failed" }, local);
  const bytes = fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")); now = 5000;
  assert.throws(() => store.settleTurn(turn.jobId, { ...patch(turn, "dispatch_unknown", "execution_unknown"), errorCode: "provider_deadline" }, local), /settlement_deadline/);
  assert.deepEqual(fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")), bytes); assert.ok(fs.existsSync(lease(store, turn)));
  let late = 85001; const expiredWork = new ProviderDeadline(() => late - 85001, 100, 20); t.after(() => expiredWork.dispose()); late += 81;
  assert.throws(() => expiredWork.assertAdmission(), /provider_deadline/);
  store.settleTurn(turn.jobId, { ...patch(turn, "dispatch_unknown", "execution_unknown"), errorCode: "provider_deadline" }, expiredWork); late += 20;
  assert.throws(() => store.settleTurn(turn.jobId, patch(turn, "dispatch_unknown", "execution_unknown"), expiredWork), /settlement_deadline/);
});
test("state.ts settlement cannot create absent roots, acquire authority or dispatch; local no-dispatch proof releases", t => {
  const { store, scope, root } = fixture(t); const id = deriveOperation(claim()).jobId;
  const p = { phase: "terminal" as const, semanticState: "failed" as const, checkpoint: null, output: null, conversationId: null, errorCode: "provider_deadline", evidence: { backendStatus: null, exitCode: null } };
  assert.throws(() => store.settleTurn(id, p, scope)); assert.equal(fs.existsSync(root), false);
  const turn = start(store, scope); const fresh = new AssignmentStore(root, OWNER, "/fixture/session.jsonl");
  assert.throws(() => fresh.settleTurn(turn.jobId, p, scope), /invalid_turn_transition/); assert.ok(fs.existsSync(lease(store, turn)));
  const abort = new AbortController(); const local = new ProviderDeadline(undefined, 90000, 5000, abort.signal); t.after(() => local.dispose()); abort.abort();
  const failed = store.settleTurn(turn.jobId, p, local); assert.equal(failed.phase, "terminal"); assert.equal(fs.existsSync(lease(store, turn)), false);
  assert.throws(() => store.markDispatching(turn.jobId, scope), /dispatch_not_authorized/);
});
test("state.ts settlement signal evidence cannot upgrade an unresolved turn or forward its snapshot", t => {
  const { store, scope } = fixture(t); const parent = terminal(store, scope, start(store, scope));
  store.enqueueMessage(parent.jobId, "pending", "private guidance", scope);
  const turn = store.markDispatching(follow(store, scope, parent).jobId, scope);
  const bytes = fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")); const tokens = leaseTokenBytes(store, turn);
  const abort = new AbortController(); const local = new ProviderDeadline(undefined, 90000, 5000, abort.signal); t.after(() => local.dispose()); abort.abort();
  for (const signalled of [false, true]) {
    assert.throws(() => store.settleTurn(turn.jobId, { ...patch(turn, "acknowledged"), evidence: { ...turn.evidence, cancelSignalled: signalled } }, local), /invalid_settlement_transition/);
    assert.deepEqual(fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")), bytes);
    assert.deepEqual(leaseTokenBytes(store, turn), tokens); assert.deepEqual(receipts(store, scope, turn.jobId), ["queued"]);
  }
  const acknowledged = store.saveTurn(turn.jobId, patch(turn, "acknowledged"), scope);
  const saved = store.settleTurn(turn.jobId, { ...savedPatch(acknowledged), evidence: { ...acknowledged.evidence, cancelSignalled: true } }, local);
  assert.equal(saved.phase, "acknowledged"); assert.equal(saved.evidence.cancelSignalled, true); assert.deepEqual(leaseTokenBytes(store, turn), tokens);
});
function formattedPatch(turn: TurnRecord) {
  return { phase: "terminal" as const, semanticState: "completed" as const, checkpoint: { version: 1 as const, kind: "completed" as const, message: "complete", artifacts: [] }, output: "", conversationId: turn.expectedConversation ?? CONVERSATION, errorCode: null, evidence: { backendStatus: "completed", exitCode: 0 } };
}
test("state.ts atomic formatter sees post-final receipts; immutable older/duplicate replay never calls formatter", t => {
  const { store, scope } = fixture(t); const turn = store.markDispatching(start(store, scope).jobId, scope);
  store.enqueueMessage(turn.jobId, "late", "private body", scope);
  const saved = store.finalizeTurn(turn.jobId, formattedPatch(turn), scope, r => { assert.ok(Object.isFrozen(r)); assert.equal(r[0].state, "not_delivered"); assert.ok(!JSON.stringify(r).includes("private body")); return JSON.stringify(r); });
  assert.throws(() => store.enqueueMessage(turn.jobId, "after", "body", scope), /queue_target_closed/);
  assert.equal(store.finalizeTurn(turn.jobId, formattedPatch(turn), scope, () => { throw new Error("must never rerun"); }).output, saved.output);
  const next = follow(store, scope, saved); const token = fs.readFileSync(path.join(lease(store, next), "owner.json"));
  assert.equal(store.finalizeTurn(turn.jobId, formattedPatch(turn), scope, () => { throw new Error("must never rewrite older"); }).output, saved.output);
  assert.deepEqual(fs.readFileSync(path.join(lease(store, next), "owner.json")), token);
  assert.throws(() => store.finalizeTurn(turn.jobId, { ...formattedPatch(turn), conversationId: OTHER }, scope, () => "wrong"), /terminal_turn_immutable/);
});
for (const mode of ["throw", "async", "oversize", "expire"] as const) test(`state.ts ${mode} formatter rolls back manifest/receipt/output/leases`, t => {
  const { store, scope } = fixture(t); const turn = store.markDispatching(start(store, scope).jobId, scope); store.enqueueMessage(turn.jobId, "m", "private", scope);
  let now = 0; const local = new ProviderDeadline(() => now, 100, 20); t.after(() => local.dispose());
  const bytes = fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")); const token = fs.readFileSync(path.join(lease(store, turn), "owner.json"));
  const formatter = () => { if (mode === "throw") throw new Error("fixed"); if (mode === "async") return Promise.resolve("invalid") as unknown as string; if (mode === "expire") now = 100; return mode === "oversize" ? "x".repeat(2 * 1024 * 1024 + 1) : "late"; };
  assert.throws(() => store.finalizeTurn(turn.jobId, formattedPatch(turn), local, formatter, true));
  assert.deepEqual(fs.readFileSync(path.join(store.ownerDirectory, "manifest.json")), bytes); assert.deepEqual(fs.readFileSync(path.join(lease(store, turn), "owner.json")), token); assert.deepEqual(receipts(store, scope, turn.jobId), ["queued"]);
});
