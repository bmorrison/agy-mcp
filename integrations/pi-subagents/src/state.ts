import fs, { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError, canonicalJson, deriveOperation, sha256Utf8, assertJobId, assertDigest, assertUtf8, validateExecutionConfig, verifyOperationClaim, fail, type ExecutionConfig, type OperationInput } from "./contracts.js";
import { type Checkpoint, type PromptQueueMessage, parseCheckpoint, checkpointState } from "./checkpoint.js";
import type { ProviderDeadline } from "./deadline.js";

export type AssignmentState = "running" | "waiting_for_supervisor" | "blocked" | "completed" | "failed" | "cancelled" | "execution_unknown";
export type DispatchPhase = "claimed" | "dispatching" | "acknowledged" | "dispatch_unknown" | "terminal";
export type ReceiptState = "queued" | "forwarded" | "dispatch_unknown" | "not_delivered";
export interface QueueReceipt { sequence: number; messageId: string; contentDigest: string; state: ReceiptState }
interface RetainedReceipt extends QueueReceipt { message: string | null; snapshotJobId: string | null }
export interface TurnRecord {
  version: 1; jobId: string; assignmentId: string; operationDigest: string; claim: OperationInput;
  ownerSessionFile: string | null; config: ExecutionConfig; expectedConversation: string | null;
  source: { runId: string; stepIndex: number } | null;
  /** Sensitive private framing data, never include in control status or diagnostics. */
  queueSnapshot: readonly PromptQueueMessage[];
  conversationId: string | null; phase: DispatchPhase; semanticState: AssignmentState;
  checkpoint: Checkpoint | null; output: string | null; errorCode: string | null;
  evidence: { backendStatus: string | null; exitCode: number | null; cancelSignalled?: boolean };
}
type TurnPatch = Pick<TurnRecord, "phase" | "semanticState" | "checkpoint" | "output" | "conversationId" | "errorCode" | "evidence">;
interface LeaseAcquisition { directory: string; jobId: string; generation: string; token: string }
interface TurnReference { jobId: string; file: string; runId: string; stepIndex: number }
interface AssignmentIndex { assignmentId: string; latestJobId: string; turns: TurnReference[]; receipts: RetainedReceipt[] }
interface Manifest { version: 1; ownerSessionId: string; ownerSessionFile: string | null; assignments: AssignmentIndex[] }
/** Observation only: no queue bodies, checkpoints, output, cwd, config, or lease authority. */
export interface AssignmentStatus {
  assignmentId: string; latestJobId: string; runId: string; stepIndex: number;
  phase: DispatchPhase; semanticState: AssignmentState; conversationAvailable: boolean; errorCode: string | null;
  evidence: TurnRecord["evidence"]; receipts: readonly QueueReceipt[];
}
export interface ActiveTurnObservation {
  jobId: string; assignmentId: string; phase: DispatchPhase; semanticState: AssignmentState; errorCode: string | null;
  evidence: TurnRecord["evidence"];
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const settlementEntries = new WeakMap<ProviderDeadline, number>();
const MAX_BYTES = 2 * 1024 * 1024;
const PHASES = ["claimed", "dispatching", "acknowledged", "dispatch_unknown", "terminal"];
const STATES = ["running", "waiting_for_supervisor", "blocked", "completed", "failed", "cancelled", "execution_unknown"];
const BACKENDS = ["running", "completed", "failed", "cancelled", "upstream_error", "unknown"];
function keys(value: unknown, required: string[], optional: string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail("state_schema_invalid");
}
function identity(value: unknown): asserts value is string {
  assertUtf8(value);
  if (!value.trim() || /\p{Cc}/u.test(value) || Buffer.byteLength(value) > 4096) fail("state_identity_invalid");
}
function target(runId: unknown, index: unknown): void {
  identity(runId);
  if (!Number.isSafeInteger(index) || (index as number) < 0) fail("state_identity_invalid");
}
function messageBody(message: unknown): asserts message is string {
  assertUtf8(message);
  if (!message.trim() || Buffer.byteLength(message) > 4096 || /(?:^|[\r\n])AGY_PI_OP /.test(message)) fail("queue_message_invalid");
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const v of Object.values(value)) frozen(v); Object.freeze(value); }
  return value;
}
function clone<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; return fail("state_io"); }
}
function inspectDirectory(dir: string): void {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("state_unsafe_directory");
  } catch { fail("state_unsafe_directory"); }
}
function directory(dir: string): void {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") fail("state_unsafe_directory"); }
  inspectDirectory(dir);
}
function readJson(file: string): unknown {
  let fd: number | undefined;
  try {
    // Inspect before opening as well: a FIFO must never block the caller.
    const leaf = fs.lstatSync(file);
    if (!leaf.isFile() || leaf.isSymbolicLink()) fail("state_unsafe_file");
    fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0) fail("state_unsafe_file");
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_BYTES) fail("state_oversize");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return fail("state_unreadable"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeExclusive(file: string, value: unknown): void {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text) > MAX_BYTES) fail("state_oversize");
  let fd: number | undefined;
  try { fd = fs.openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  catch { fail("state_write_failed"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function syncDirectory(dir: string): void {
  try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { fail("state_write_failed"); }
}
function patchOf(t: TurnRecord): TurnPatch {
  return { phase: t.phase, semanticState: t.semanticState, checkpoint: t.checkpoint, output: t.output, conversationId: t.conversationId, errorCode: t.errorCode, evidence: t.evidence };
}
function bodyless(r: RetainedReceipt): QueueReceipt { return { sequence: r.sequence, messageId: r.messageId, contentDigest: r.contentDigest, state: r.state }; }

export class AssignmentStore {
  readonly ownerDirectory: string;
  private readonly nonce = randomUUID();
  private mutationCheck: (() => void) | undefined;
  private readonly dispatchPermits = new Set<string>();
  private readonly localIntents = new Set<string>();
  private readonly ownedLeases = new Map<string, LeaseAcquisition>();
  constructor(readonly root: string, readonly ownerSessionId: string, readonly ownerSessionFile: string | null) {
    if (!path.isAbsolute(root) || !UUID.test(ownerSessionId)) fail("invalid_owner_identity");
    if (ownerSessionFile !== null) { identity(ownerSessionFile); if (!path.isAbsolute(ownerSessionFile)) fail("invalid_owner_identity"); }
    this.ownerDirectory = path.join(root, ownerSessionId);
  }
  private initialize(): void { directory(this.root); directory(this.ownerDirectory); }
  private ownerToken(): string { return canonicalJson({ version: 1, ownerSessionId: this.ownerSessionId, pid: process.pid, nonce: this.nonce }); }
  private locked<T>(scope: ProviderDeadline, fn: () => T, settlement = false): T {
    if (settlement && !settlementEntries.has(scope)) settlementEntries.set(scope, scope.remaining("settlement"));
    const enteredRemaining = settlementEntries.get(scope) ?? scope.remaining("settlement");
    const check = settlement ? () => {
      scope.assertSettlement();
      if (enteredRemaining - scope.remaining("settlement") >= Math.min(5000, enteredRemaining)) fail("settlement_deadline");
    } : () => scope.assertAdmission();
    check();
    if (settlement) { inspectDirectory(this.root); inspectDirectory(this.ownerDirectory); }
    else this.initialize();
    const lock = path.join(this.ownerDirectory, "mutation.lock");
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { return fail("state_locked"); }
    const token = path.join(lock, "owner.json"); let owned = false;
    try { writeExclusive(token, JSON.parse(this.ownerToken())); owned = true; syncDirectory(lock); check(); this.mutationCheck = check; return fn(); }
    catch (error) { if (error instanceof ContractError) throw error; return fail("state_io"); }
    finally {
      this.mutationCheck = undefined;
      if (owned) {
        if (canonicalJson(readJson(token)) !== this.ownerToken()) fail("lock_owner_mismatch");
        fs.unlinkSync(token); fs.rmdirSync(lock);
      }
    }
  }
  private manifest(): Manifest {
    const file = path.join(this.ownerDirectory, "manifest.json");
    if (!exists(file)) return { version: 1, ownerSessionId: this.ownerSessionId, ownerSessionFile: this.ownerSessionFile, assignments: [] };
    const m = readJson(file) as Manifest;
    keys(m, ["version", "ownerSessionId", "ownerSessionFile", "assignments"]);
    if (m.version !== 1 || m.ownerSessionId !== this.ownerSessionId || m.ownerSessionFile !== this.ownerSessionFile || !Array.isArray(m.assignments) || m.assignments.length > 32) fail("state_manifest_invalid");
    const jobs = new Set<string>(); const targets = new Set<string>(); const assignments = new Set<string>();
    for (const a of m.assignments) {
      keys(a, ["assignmentId", "latestJobId", "turns", "receipts"]); assertJobId(a.assignmentId); assertJobId(a.latestJobId);
      if (assignments.has(a.assignmentId) || !Array.isArray(a.turns) || a.turns.length < 1 || a.turns.length > 64 || a.turns[0].jobId !== a.assignmentId || a.turns.at(-1)!.jobId !== a.latestJobId || !Array.isArray(a.receipts) || a.receipts.length > 256) fail("state_manifest_invalid");
      assignments.add(a.assignmentId);
      for (const t of a.turns) {
        keys(t, ["jobId", "file", "runId", "stepIndex"]); assertJobId(t.jobId); target(t.runId, t.stepIndex);
        if (typeof t.file !== "string" || !new RegExp(`^${t.jobId}\\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`).test(t.file)) fail("state_manifest_invalid");
        const key = canonicalJson([t.runId, t.stepIndex]);
        if (jobs.has(t.jobId) || targets.has(key)) fail("state_manifest_invalid"); jobs.add(t.jobId); targets.add(key);
      }
      const ids = new Set<string>(); let pending = 0; let bytes = 0;
      for (const [i, r] of a.receipts.entries()) {
        keys(r, ["sequence", "messageId", "contentDigest", "state", "message", "snapshotJobId"]); identity(r.messageId); assertDigest(r.contentDigest);
        if (r.sequence !== i + 1 || ids.has(r.messageId) || !["queued", "forwarded", "dispatch_unknown", "not_delivered"].includes(r.state)) fail("state_receipt_invalid"); ids.add(r.messageId);
        if (r.snapshotJobId !== null && !a.turns.some(t => t.jobId === r.snapshotJobId)) fail("state_receipt_invalid");
        if (r.state === "forwarded") { if (r.message !== null || r.snapshotJobId === null) fail("state_receipt_invalid"); }
        else { messageBody(r.message); if (sha256Utf8(r.message) !== r.contentDigest) fail("state_receipt_invalid"); pending++; bytes += Buffer.byteLength(r.message); }
        if (r.state === "dispatch_unknown" && r.snapshotJobId === null) fail("state_receipt_invalid");
      }
      if (pending > 20 || bytes > 64 * 1024) fail("state_receipt_invalid");
    }
    // Missing/corrupt referenced versions are not reconstructed from backend history.
    for (const a of m.assignments) {
      for (const ref of a.turns) this.load(m, ref.jobId);
      for (const r of a.receipts) if (r.snapshotJobId !== null) {
        const t = this.load(m, r.snapshotJobId);
        if (!t.queueSnapshot.some(q => q.messageId === r.messageId && q.sequence === r.sequence && q.contentDigest === r.contentDigest) || r.state === "not_delivered" && !["claimed", "dispatching"].includes(t.phase) || r.state === "forwarded" && t.phase === "claimed") fail("state_receipt_invalid");
      }
    }
    return m;
  }
  private load(m: Manifest, id: string): TurnRecord {
    assertJobId(id);
    const a = m.assignments.find(a => a.turns.some(t => t.jobId === id));
    const ref = a?.turns.find(t => t.jobId === id);
    if (!a || !ref) fail("turn_missing");
    const t = readJson(path.join(this.ownerDirectory, ref.file)) as TurnRecord;
    keys(t, ["version", "jobId", "assignmentId", "operationDigest", "claim", "ownerSessionFile", "config", "expectedConversation", "source", "queueSnapshot", "conversationId", "phase", "semanticState", "checkpoint", "output", "errorCode", "evidence"]);
    keys(t.claim, ["ownerSessionId", "runId", "stepIndex", "parentProviderJobId", "requestId", "requestDigest", "promptDigest", "cwd", "executionConfigDigest", "queue"]);
    if (t.version !== 1 || t.jobId !== id || t.assignmentId !== a.assignmentId || t.ownerSessionFile !== this.ownerSessionFile || t.claim.ownerSessionId !== this.ownerSessionId || t.claim.runId !== ref.runId || t.claim.stepIndex !== ref.stepIndex || !Array.isArray(t.claim.queue) || !Array.isArray(t.queueSnapshot) || t.queueSnapshot.length > 20) fail("state_turn_invalid");
    validateExecutionConfig(t.config); assertDigest(t.operationDigest);
    const op = deriveOperation(t.claim);
    if (op.jobId !== id || op.operationDigest !== t.operationDigest || t.claim.executionConfigDigest !== sha256Utf8(canonicalJson(t.config)) || !path.isAbsolute(t.claim.cwd) || path.normalize(t.claim.cwd) !== t.claim.cwd) fail("state_turn_invalid");
    const queue = t.queueSnapshot.map(q => {
      keys(q, ["sequence", "messageId", "message", "contentDigest"]); messageBody(q.message);
      if (sha256Utf8(q.message) !== q.contentDigest) fail("state_turn_invalid");
      const receipt = a.receipts.find(r => r.messageId === q.messageId);
      if (!receipt || receipt.sequence !== q.sequence || receipt.contentDigest !== q.contentDigest) fail("state_turn_invalid");
      return { sequence: q.sequence, messageId: q.messageId, contentDigest: q.contentDigest };
    });
    if (canonicalJson(queue) !== canonicalJson(t.claim.queue)) fail("state_turn_invalid");
    const n = a.turns.findIndex(r => r.jobId === id);
    if (n === 0) { if (t.source !== null || t.claim.parentProviderJobId !== null || t.expectedConversation !== null || queue.length) fail("state_lineage_invalid"); }
    else {
      keys(t.source, ["runId", "stepIndex"]); const prior = a.turns[n - 1];
      const parent = readJson(path.join(this.ownerDirectory, prior.file)) as TurnRecord;
      if (t.claim.parentProviderJobId !== prior.jobId || t.source!.runId !== prior.runId || t.source!.stepIndex !== prior.stepIndex || parent.phase !== "terminal" || !parent.checkpoint || parent.conversationId !== t.expectedConversation || !t.expectedConversation || parent.claim.cwd !== t.claim.cwd || canonicalJson(parent.config) !== canonicalJson(t.config)) fail("state_lineage_invalid");
    }
    this.validatePatch(patchOf(t));
    return t;
  }
  private validatePatch(p: TurnPatch): void {
    keys(p, ["phase", "semanticState", "checkpoint", "output", "conversationId", "errorCode", "evidence"]);
    keys(p.evidence, ["backendStatus", "exitCode"], ["cancelSignalled"]);
    if (!PHASES.includes(p.phase) || !STATES.includes(p.semanticState) || !(p.conversationId === null || typeof p.conversationId === "string" && UUID.test(p.conversationId)) || !(p.output === null || typeof p.output === "string") || !(p.errorCode === null || typeof p.errorCode === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(p.errorCode)) || !(p.evidence.backendStatus === null || BACKENDS.includes(p.evidence.backendStatus)) || !(p.evidence.exitCode === null || Number.isSafeInteger(p.evidence.exitCode)) || !(p.evidence.cancelSignalled === undefined || typeof p.evidence.cancelSignalled === "boolean")) fail("state_turn_invalid");
    if (p.output !== null) { assertUtf8(p.output); if (Buffer.byteLength(p.output) > MAX_BYTES) fail("state_output_oversize"); }
    if (p.checkpoint !== null) {
      parseCheckpoint(`\`\`\`agy-checkpoint\n${canonicalJson(p.checkpoint)}\n\`\`\``);
      if (p.phase !== "terminal" || p.semanticState !== checkpointState(p.checkpoint.kind) || p.evidence.backendStatus !== "completed" || !p.conversationId || p.output === null || p.errorCode !== null) fail("state_turn_invalid");
    } else {
      if (p.output !== null || ["waiting_for_supervisor", "blocked", "completed"].includes(p.semanticState)) fail("state_turn_invalid");
      if (p.phase === "terminal" && !["failed", "cancelled"].includes(p.semanticState)) fail("state_turn_invalid");
    }
    if (p.phase !== "terminal" && !["running", "execution_unknown"].includes(p.semanticState)) fail("state_turn_invalid");
    if (p.phase === "claimed" && (p.semanticState !== "running" || p.evidence.backendStatus !== null) || p.phase === "dispatch_unknown" && p.semanticState !== "execution_unknown") fail("state_turn_invalid");
    if (p.phase !== "terminal" && ![null, "running", "unknown"].includes(p.evidence.backendStatus)) fail("state_turn_invalid");
    if (p.semanticState === "cancelled" && p.evidence.backendStatus !== "cancelled") fail("state_turn_invalid");
  }
  private publishManifest(m: Manifest): void {
    const temp = path.join(this.ownerDirectory, `manifest.${randomUUID()}.tmp`);
    writeExclusive(temp, m);
    const dest = path.join(this.ownerDirectory, "manifest.json");
    if (exists(dest)) readJson(dest);
    this.mutationCheck?.();
    try { fs.renameSync(temp, dest); } catch { fail("state_write_failed"); }
    syncDirectory(this.ownerDirectory);
  }
  private publish(m: Manifest, t: TurnRecord): void {
    this.mutationCheck?.(); this.validatePatch(patchOf(t));
    const file = `${t.jobId}.${randomUUID()}.json`;
    writeExclusive(path.join(this.ownerDirectory, file), t); syncDirectory(this.ownerDirectory);
    const a = m.assignments.find(a => a.assignmentId === t.assignmentId)!;
    a.turns.find(r => r.jobId === t.jobId)!.file = file;
    this.publishManifest(m);
  }
  private leasePaths(t: Pick<TurnRecord, "assignmentId" | "expectedConversation">): string[] {
    const dirs = [path.join(this.ownerDirectory, `${t.assignmentId}.lease`)];
    if (t.expectedConversation) dirs.push(path.join(this.root, "conversations", `${t.expectedConversation}.lease`));
    return dirs;
  }
  private acquireLease(dir: string, jobId: string, generation: string): LeaseAcquisition {
    if (path.dirname(dir) === path.join(this.root, "conversations")) directory(path.dirname(dir));
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch { fail("conversation_leased"); }
    const token = canonicalJson({ ...JSON.parse(this.ownerToken()), jobId, generation });
    writeExclusive(path.join(dir, "owner.json"), JSON.parse(token)); syncDirectory(dir); syncDirectory(path.dirname(dir));
    const acquisition = frozen({ directory: dir, jobId, generation, token });
    this.ownedLeases.set(dir, acquisition); return acquisition;
  }
  private releaseLease(acquisition: LeaseAcquisition): void {
    const dir = acquisition.directory;
    // A reusable lease path is not release authority for a different turn/acquisition.
    if (this.ownedLeases.get(dir) !== acquisition) return;
    inspectDirectory(dir);
    if (canonicalJson(readJson(path.join(dir, "owner.json"))) !== acquisition.token) fail("lease_owner_mismatch");
    fs.unlinkSync(path.join(dir, "owner.json")); fs.rmdirSync(dir); syncDirectory(path.dirname(dir)); this.ownedLeases.delete(dir);
  }
  private releaseTurnLeases(t: TurnRecord): void {
    for (const dir of this.leasePaths(t)) {
      const acquisition = this.ownedLeases.get(dir);
      if (acquisition?.jobId === t.jobId) this.releaseLease(acquisition);
    }
  }
  private view(t: TurnRecord): TurnRecord {
    // Observation cannot manufacture a dispatch permit, even for this process's PID.
    if (t.phase === "claimed" && !this.dispatchPermits.has(t.jobId)) {
      // This observer lacks admission authority; this is not proof of a dead owner or no dispatch.
      t.semanticState = "execution_unknown"; t.errorCode = "admission_abandoned";
    }
    if (t.phase === "dispatching" && !this.localIntents.has(t.jobId)) {
      t.phase = "dispatch_unknown"; t.semanticState = "execution_unknown";
    }
    return frozen(t);
  }
  claimTurn(claim: OperationInput, config: ExecutionConfig, scope: ProviderDeadline, source?: { runId: string; stepIndex: number }): { turn: TurnRecord; fresh: boolean } {
    return this.locked(scope, () => {
      claim = clone(claim); config = clone(config); source = source ? clone(source) : undefined;
      keys(claim, ["ownerSessionId", "runId", "stepIndex", "parentProviderJobId", "requestId", "requestDigest", "promptDigest", "cwd", "executionConfigDigest", "queue"]);
      validateExecutionConfig(config); assertDigest(claim.promptDigest); assertDigest(claim.executionConfigDigest);
      target(claim.runId, claim.stepIndex); identity(claim.cwd);
      if (!Array.isArray(claim.queue)) fail("invalid_queue_snapshot");
      if (claim.ownerSessionId !== this.ownerSessionId || claim.executionConfigDigest !== sha256Utf8(canonicalJson(config)) || !path.isAbsolute(claim.cwd) || path.normalize(claim.cwd) !== claim.cwd) fail("state_identity_invalid");
      if (source) { keys(source, ["runId", "stepIndex"]); target(source.runId, source.stepIndex); }
      if (claim.parentProviderJobId === null && source || claim.parentProviderJobId !== null && !source) fail("state_lineage_invalid");
      const m = this.manifest();
      const refs = m.assignments.flatMap(a => a.turns);
      const existing = refs.find(r => r.runId === claim.runId && r.stepIndex === claim.stepIndex || claim.requestId !== null && (() => { const t = this.load(m, r.jobId); return t.claim.parentProviderJobId === claim.parentProviderJobId && t.claim.requestId === claim.requestId; })());
      if (existing) {
        const t = this.load(m, existing.jobId);
        // The previously committed snapshot is authoritative before operation derivation.
        if (claim.queue.length && canonicalJson(claim.queue) !== canonicalJson(t.claim.queue)) fail("operation_claim_collision");
        verifyOperationClaim(t.claim, { ...claim, queue: t.claim.queue });
        if (canonicalJson(t.config) !== canonicalJson(config) || canonicalJson(t.source) !== canonicalJson(source ?? null)) fail("frozen_context_changed");
        return { turn: this.view(t), fresh: false };
      }
      let a: AssignmentIndex; let conversation: string | null = null;
      if (claim.parentProviderJobId !== null) {
        const parent = this.load(m, claim.parentProviderJobId); a = m.assignments.find(a => a.assignmentId === parent.assignmentId)!;
        if (a.latestJobId !== parent.jobId || parent.phase !== "terminal" || !parent.checkpoint || !parent.conversationId || parent.claim.runId !== source!.runId || parent.claim.stepIndex !== source!.stepIndex) fail("invalid_follow_up_parent");
        if (parent.claim.cwd !== claim.cwd || canonicalJson(parent.config) !== canonicalJson(config)) fail("frozen_context_changed");
        if (a.turns.length >= 64) fail("turn_limit"); conversation = parent.conversationId;
      } else {
        if (m.assignments.length >= 32) fail("assignment_limit");
        a = { assignmentId: "", latestJobId: "", turns: [], receipts: [] };
      }
      const snapshot: PromptQueueMessage[] = conversation ? a.receipts.filter(r => ["queued", "not_delivered"].includes(r.state) && r.snapshotJobId === null).map(r => ({ sequence: r.sequence, messageId: r.messageId, contentDigest: r.contentDigest, message: r.message! })) : [];
      const queue = snapshot.map(({ sequence, messageId, contentDigest }) => ({ sequence, messageId, contentDigest }));
      if (claim.queue.length && canonicalJson(claim.queue) !== canonicalJson(queue)) fail("operation_claim_collision");
      claim = { ...claim, queue }; const op = deriveOperation(claim);
      const collision = refs.find(r => r.jobId === op.jobId);
      if (collision) { verifyOperationClaim(this.load(m, collision.jobId).claim, claim); fail("operation_claim_collision"); }
      if (!conversation) { a.assignmentId = op.jobId; m.assignments.push(a); }
      const turn: TurnRecord = { version: 1, jobId: op.jobId, assignmentId: a.assignmentId, operationDigest: op.operationDigest, claim, ownerSessionFile: this.ownerSessionFile, config, source: source ?? null, queueSnapshot: snapshot, expectedConversation: conversation, conversationId: null, phase: "claimed", semanticState: "running", checkpoint: null, output: null, errorCode: null, evidence: { backendStatus: null, exitCode: null } };
      const generation = randomUUID(); const acquired: LeaseAcquisition[] = [];
      try { for (const dir of this.leasePaths(turn)) acquired.push(this.acquireLease(dir, turn.jobId, generation)); }
      catch (e) { for (const acquisition of acquired.reverse()) this.releaseLease(acquisition); throw e; }
      a.latestJobId = op.jobId; a.turns.push({ jobId: op.jobId, file: "", runId: claim.runId, stepIndex: claim.stepIndex });
      for (const r of a.receipts) if (snapshot.some(q => q.messageId === r.messageId)) r.snapshotJobId = op.jobId;
      // On any uncertain publication failure, retain leases and omit the local permit.
      this.publish(m, turn); scope.assertAdmission(); this.dispatchPermits.add(op.jobId);
      return { turn: frozen(turn), fresh: true };
    });
  }
  getTurn(id: string, scope: ProviderDeadline): TurnRecord { return this.locked(scope, () => this.view(this.load(this.manifest(), id))); }
  resolveRunTarget(runId: string, stepIndex: number, scope: ProviderDeadline): { requested: TurnRecord; latest: TurnRecord } {
    target(runId, stepIndex);
    return this.locked(scope, () => {
      const m = this.manifest(); const a = m.assignments.find(a => a.turns.some(t => t.runId === runId && t.stepIndex === stepIndex));
      const ref = a?.turns.find(t => t.runId === runId && t.stepIndex === stepIndex);
      if (!a || !ref) fail("run_target_missing");
      return { requested: this.view(this.load(m, ref.jobId)), latest: this.view(this.load(m, a.latestJobId)) };
    });
  }
  markDispatching(id: string, scope: ProviderDeadline): TurnRecord {
    return this.locked(scope, () => {
      if (!this.dispatchPermits.delete(id)) fail("dispatch_not_authorized");
      const m = this.manifest(); const t = this.load(m, id);
      if (t.phase !== "claimed") fail("dispatch_not_authorized");
      for (const dir of this.leasePaths(t)) this.assertLease(dir, t.jobId);
      scope.assertAdmission(); t.phase = "dispatching"; this.publish(m, t); this.localIntents.add(id); return frozen(t);
    });
  }
  private assertLease(dir: string, jobId: string): void {
    const acquisition = this.ownedLeases.get(dir);
    if (!acquisition || acquisition.jobId !== jobId) fail("lease_not_owned");
    inspectDirectory(dir);
    if (canonicalJson(readJson(path.join(dir, "owner.json"))) !== acquisition.token) fail("lease_owner_mismatch");
  }
  /** Synchronous local ownership guard only; it never acquires/releases a lease or authorizes MCP cancellation. */
  withConversationLease<T>(id: string, scope: ProviderDeadline, operation: (turn: TurnRecord) => T): T {
    return this.locked(scope, () => {
      const t = this.load(this.manifest(), id);
      if (t.phase === "terminal") fail("lease_not_owned");
      for (const dir of this.leasePaths(t)) this.assertLease(dir, t.jobId);
      return operation(this.view(t));
    });
  }
  saveTurn(id: string, patch: TurnPatch, scope: ProviderDeadline): TurnRecord {
    return this.save(id, patch, scope);
  }
  /** Local-only settlement under the original total window, capped at 5s from entry. */
  settleTurn(id: string, patch: TurnPatch, scope: ProviderDeadline): TurnRecord {
    return this.save(id, patch, scope, undefined, true);
  }
  /** Trusted synchronous formatter; post-transition receipts and output commit atomically. */
  finalizeTurn(id: string, patch: TurnPatch, scope: ProviderDeadline,
    formatter: (receipts: readonly QueueReceipt[]) => string, settlement = false): TurnRecord {
    if (patch.phase !== "terminal" || !patch.checkpoint) fail("invalid_terminal_formatter");
    return this.save(id, patch, scope, formatter, settlement);
  }
  private save(id: string, patch: TurnPatch, scope: ProviderDeadline,
    formatter?: (receipts: readonly QueueReceipt[]) => string, settlement = false): TurnRecord {
    return this.locked(scope, () => {
      patch = clone(patch); this.validatePatch(patch);
      const m = this.manifest(); const t = this.load(m, id); const previous = patchOf(t);
      if (settlement && !["terminal", "dispatch_unknown"].includes(patch.phase)) {
        const { cancelSignalled: _oldSignal, ...oldEvidence } = previous.evidence;
        const { cancelSignalled: signal, ...newEvidence } = patch.evidence;
        // Signal-only settlement preserves every other field; an ACK boolean
        // cannot upgrade unresolved execution or newly forward queue receipts.
        if (signal === undefined || canonicalJson({ ...patch, evidence: newEvidence }) !== canonicalJson({ ...previous, evidence: oldEvidence })) fail("invalid_settlement_transition");
      }
      if (canonicalJson(formatter ? { ...patch, output: previous.output } : patch) === canonicalJson(previous)) {
        if (t.phase === "terminal" && m.assignments.find(a => a.assignmentId === t.assignmentId)!.latestJobId === id) this.releaseTurnLeases(t);
        return this.view(t);
      }
      if (t.phase === "terminal") fail("terminal_turn_immutable");
      if (patch.phase === "claimed" || patch.phase === "dispatching" && t.phase !== "dispatching") fail("invalid_turn_transition");
      if (t.evidence.cancelSignalled !== undefined && patch.evidence.cancelSignalled === undefined || t.evidence.cancelSignalled === true && patch.evidence.cancelSignalled !== true) fail("evidence_regression");
      if (t.evidence.backendStatus !== null && patch.evidence.backendStatus === null || t.evidence.exitCode !== null && patch.evidence.exitCode !== t.evidence.exitCode) fail("evidence_regression");
      if (t.conversationId !== null && t.conversationId !== patch.conversationId || patch.checkpoint && t.expectedConversation !== null && patch.conversationId !== t.expectedConversation) fail("conversation_lineage_mismatch");
      const noDispatch = t.phase === "claimed" && patch.phase === "terminal" && patch.semanticState === "failed" && patch.evidence.backendStatus === null && this.dispatchPermits.has(id);
      if (t.phase === "claimed" && !noDispatch) fail("invalid_turn_transition");
      if (patch.phase === "terminal" && !noDispatch) {
        const backend = patch.evidence.backendStatus;
        if (!["completed", "failed", "upstream_error", "cancelled"].includes(backend ?? "") || backend === "cancelled" && patch.semanticState !== "cancelled" || backend !== "cancelled" && !patch.checkpoint && patch.semanticState !== "failed") fail("terminal_evidence_required");
      }
      if (patch.phase === "acknowledged" && !["dispatching", "dispatch_unknown", "acknowledged"].includes(t.phase)) fail("invalid_turn_transition");
      Object.assign(t, patch);
      const a = m.assignments.find(a => a.assignmentId === t.assignmentId)!;
      for (const r of a.receipts) {
        if (r.snapshotJobId === id) {
          // acknowledged is a caller assertion of exact correlation; the transport/provider must verify it.
          if (patch.phase === "acknowledged" || patch.phase === "terminal" && !noDispatch) { r.state = "forwarded"; r.message = null; }
          else if (r.state !== "forwarded" && (noDispatch || patch.phase === "dispatch_unknown")) { r.state = noDispatch ? "not_delivered" : "dispatch_unknown"; if (noDispatch) r.snapshotJobId = null; }
        } else if (patch.phase === "terminal" && ["completed", "failed", "cancelled"].includes(patch.semanticState) && r.state === "queued") r.state = "not_delivered";
      }
      if (formatter) {
        const output = formatter(frozen(a.receipts.map(bodyless)));
        if (typeof output !== "string") fail("invalid_terminal_formatter");
        t.output = output;
      }
      this.mutationCheck?.(); this.publish(m, t);
      if (patch.phase === "terminal") {
        this.dispatchPermits.delete(id); this.localIntents.delete(id);
        this.releaseTurnLeases(t);
      }
      return frozen(t);
    }, settlement);
  }
  /** Exact current-owner retained job/assignment id. No wake, inference, continuation, or body echo. */
  enqueueMessage(id: string, messageId: string, message: string, scope: ProviderDeadline): QueueReceipt {
    identity(messageId); messageBody(message); const contentDigest = sha256Utf8(message);
    return this.locked(scope, () => {
      const m = this.manifest(); const t = this.load(m, id); const a = m.assignments.find(a => a.assignmentId === t.assignmentId)!;
      const existing = a.receipts.find(r => r.messageId === messageId);
      if (existing) { if (existing.contentDigest !== contentDigest) fail("message_id_collision"); return frozen(this.receiptViews(m, a).find(r => r.messageId === messageId)!); }
      const latest = this.view(this.load(m, a.latestJobId));
      if (["completed", "failed", "cancelled", "execution_unknown"].includes(latest.semanticState) || latest.phase === "dispatch_unknown" || latest.phase === "dispatching" && !this.localIntents.has(latest.jobId)) fail("queue_target_closed");
      const pending = a.receipts.filter(r => r.state !== "forwarded");
      if (a.receipts.length >= 256) fail("receipt_limit");
      if (pending.length >= 20 || pending.reduce((n, r) => n + Buffer.byteLength(r.message!), 0) + Buffer.byteLength(message) > 64 * 1024) fail("queue_limit");
      const receipt: RetainedReceipt = { sequence: a.receipts.length + 1, messageId, contentDigest, state: "queued", message, snapshotJobId: null };
      a.receipts.push(receipt); this.publishManifest(m); return frozen(bodyless(receipt));
    });
  }
  private receiptViews(m: Manifest, a: AssignmentIndex): QueueReceipt[] {
    return a.receipts.map(r => {
      const receipt = bodyless(r);
      if (["queued", "not_delivered"].includes(r.state) && r.snapshotJobId !== null && this.view(this.load(m, r.snapshotJobId)).phase === "dispatch_unknown") receipt.state = "dispatch_unknown";
      return receipt;
    });
  }
  getQueueReceipts(id: string, scope: ProviderDeadline): readonly QueueReceipt[] {
    return this.locked(scope, () => { const m = this.manifest(); const t = this.load(m, id); return frozen(this.receiptViews(m, m.assignments.find(a => a.assignmentId === t.assignmentId)!)); });
  }
  getAssignmentStatus(id: string, scope: ProviderDeadline): AssignmentStatus {
    return this.locked(scope, () => {
      const m = this.manifest(); const requested = this.load(m, id); const a = m.assignments.find(a => a.assignmentId === requested.assignmentId)!; const t = this.view(this.load(m, a.latestJobId));
      return frozen({ assignmentId: a.assignmentId, latestJobId: t.jobId, runId: t.claim.runId, stepIndex: t.claim.stepIndex, phase: t.phase, semanticState: t.semanticState, conversationAvailable: t.conversationId !== null || t.expectedConversation !== null, errorCode: t.errorCode, evidence: t.evidence, receipts: this.receiptViews(m, a) });
    });
  }
  listActiveTurns(scope: ProviderDeadline): readonly ActiveTurnObservation[] {
    return this.locked(scope, () => {
      const m = this.manifest();
      return frozen(m.assignments.map(a => this.view(this.load(m, a.latestJobId))).filter(t => t.phase !== "terminal").map(t => ({ jobId: t.jobId, assignmentId: t.assignmentId, phase: t.phase, semanticState: t.semanticState, errorCode: t.errorCode, evidence: t.evidence })));
    });
  }
}
