import fs from "node:fs/promises";
import path from "node:path";
import { ExternalJobProviderError, type ExternalJobProvider, type ExternalJobStartInput, type ExternalJobFollowUpInput, type ExternalJobHandle, type ExternalJobResult } from "pi-subagents/external-job-provider";
import { canonicalJson, ContractError, fail, requireOperationMarker, sha256Utf8, validateExecutionConfig, validateOwnerInputDigests, type ExecutionConfig, type OperationInput } from "./contracts.js";
import { buildCheckpointPrompt, checkpointState, formatCheckpointResult, parseCheckpoint } from "./checkpoint.js";
import { AgyMcpClient, requireObservedConversation, type JobRecord, type ResultEnvelope } from "./mcp-client.js";
import { ProviderDeadline, withProviderDeadline } from "./deadline.js";
import { AssignmentStore, type AssignmentStatus, type QueueReceipt, type TurnRecord } from "./state.js";

export function resolveExecutionConfig(options: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): ExecutionConfig {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length) fail("unsupported_provider_options");
  const value = env.AGY_PI_TURN_TIMEOUT_SECONDS ?? "300";
  if (!/^[1-9][0-9]*$/.test(value)) fail("invalid_turn_timeout");
  const timeout = Number(value);
  if (timeout < 1 || timeout > 300) fail("invalid_turn_timeout");
  const config: ExecutionConfig = { backend: "agy", mode: "review", sandbox: true, allow_write: false, worktree: false, output_protocol: "raw", timeout, model: env.AGY_PI_MODEL ?? null };
  validateExecutionConfig(config); return config;
}
export function providerDiagnostic(error: unknown): string { return error instanceof ContractError || error instanceof ExternalJobProviderError ? error.code : "provider_operation_failed"; }
function handle(t: TurnRecord): ExternalJobHandle {
  const state = t.phase !== "terminal" ? t.semanticState === "execution_unknown" ? "failed" : "running" : t.checkpoint ? "completed" : t.semanticState === "cancelled" ? "stopped" : "failed";
  return { providerJobId: t.jobId, state, ...(t.errorCode ? { failureCode: t.errorCode, failureMessage: t.errorCode } : {}) };
}
function patch(t: TurnRecord) { return { phase: t.phase, semanticState: t.semanticState, checkpoint: t.checkpoint, output: t.output, conversationId: t.conversationId, errorCode: t.errorCode, evidence: t.evidence }; }
export interface ControlInput { action: "status" | "queue" | "cancel"; runId: string; index?: number; message?: string; messageId?: string }
export interface ControlResult { requested: { runId: string; index: number }; latest: { runId: string; index: number }; status: AssignmentStatus; receipt?: QueueReceipt; cancellation?: { signalled: boolean | null; terminalCorrelated: boolean; errorCode: string | null } }
export interface AgyProviderOptions {
  store: AssignmentStore; client: AgyMcpClient; env?: NodeJS.ProcessEnv;
  /** Hermetic clock/budget injection only; never populated from model/environment options. */
  deadline?: { clock?: () => number; totalMs?: number; settlementMs?: number };
}
export interface AgyProvider extends ExternalJobProvider {
  start(input: ExternalJobStartInput): Promise<ExternalJobHandle>;
  followUp(input: ExternalJobFollowUpInput): Promise<ExternalJobHandle>;
  status(id: string): Promise<ExternalJobHandle>;
  result(id: string): Promise<ExternalJobResult>;
  reattach(id: string): Promise<ExternalJobHandle>;
  stopAdmission(): void;
  shutdown(): Promise<void>;
  control(input: ControlInput, ownerSessionId: string, signal?: AbortSignal): Promise<ControlResult>;
}
export function createAgyProvider({ store, client, env = process.env, deadline }: AgyProviderOptions): AgyProvider {
  let accepting = true; let shutdownFlight: Promise<void> | undefined;
  const admissionAbort = new AbortController();
  const finalizations = new Map<string, Promise<TurnRecord>>();
  // Public-server redacted-cwd projection, bound to the exact outgoing canonical cwd.
  // Consistency evidence, not reconstruction or OS cwd attestation. Never persisted/exposed.
  const projections = new Map<string, { cwdDigest: string; requestedCwdDigest: string }>();
  async function operation<T>(fn: (scope: ProviderDeadline) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      if (!accepting) fail("provider_shutting_down");
      return await withProviderDeadline(fn, { ...deadline, signal: signal ? AbortSignal.any([admissionAbort.signal, signal]) : admissionAbort.signal });
    } catch (error) { const code = providerDiagnostic(error); throw new ExternalJobProviderError(code, { code }); }
  }
  async function restoreProjection(t: TurnRecord, scope: ProviderDeadline): Promise<void> {
    if (projections.has(t.jobId)) return;
    // Cold recovery is observation only: rebuild public-server consistency
    // evidence from the frozen canonical cwd/config, never from backend paths.
    const cwd = await scope.wait(fs.realpath(t.claim.cwd));
    if (cwd !== t.claim.cwd) fail("cwd_mismatch");
    if (!(await scope.wait(fs.stat(cwd))).isDirectory()) fail("invalid_cwd");
    const projection = await client.probeCommand(t.config, cwd, scope, t.expectedConversation ?? undefined);
    scope.assertAdmission();
    projections.set(t.jobId, { cwdDigest: projection.cwdDigest, requestedCwdDigest: projection.requestedCwdDigest });
  }
  function correlate(t: TurnRecord, record: JobRecord): void {
    if (record.job_id !== t.jobId) fail("mcp_job_mismatch");
    requireOperationMarker(record.request.prompt as string, t.operationDigest);
    for (const [key, value] of Object.entries(t.config)) if (record.request[key] !== value) fail("execution_config_mismatch");
    if (record.backend !== "agy" || record.request.session_id !== t.expectedConversation) fail("conversation_lineage_mismatch");
    const projection = projections.get(t.jobId);
    if (!projection) fail("cwd_unverifiable");
    if (projection.requestedCwdDigest !== sha256Utf8(t.claim.cwd) || record.cwd !== record.request.cwd || sha256Utf8(record.cwd) !== projection.cwdDigest) fail("cwd_mismatch");
    if (t.expectedConversation && record.session_id !== t.expectedConversation) fail("conversation_lineage_mismatch");
  }
  function unknown(t: TurnRecord, error: unknown, scope: ProviderDeadline): void {
    if (t.phase === "terminal" || t.phase === "claimed") return;
    try { store.settleTurn(t.jobId, { ...patch(t), phase: "dispatch_unknown", semanticState: "execution_unknown", errorCode: providerDiagnostic(error) }, scope); } catch { /* Durable intent/lease remains authoritative if local settlement fails. */ }
  }
  function owner(input: ExternalJobStartInput): void {
    if (!accepting) fail("provider_shutting_down");
    if (input.agent !== "agy-reviewer" || input.sessionId !== undefined && input.sessionId !== store.ownerSessionId && input.sessionId !== store.ownerSessionFile) fail("owner_mismatch");
  }
  async function dispatch(input: ExternalJobStartInput | ExternalJobFollowUpInput, scope: ProviderDeadline, follow: boolean): Promise<ExternalJobHandle> {
    owner(input); const digests = validateOwnerInputDigests(input, follow);
    const config = resolveExecutionConfig(input.options, env);
    // Prevalidate raw task before reservation; discard this validation-only frame.
    buildCheckpointPrompt({ prompt: input.prompt, operationDigest: "0".repeat(64), queue: [] });
    if (!path.isAbsolute(input.cwd)) fail("invalid_cwd");
    const cwd = await scope.wait(fs.realpath(input.cwd));
    if (!(await scope.wait(fs.stat(cwd))).isDirectory()) fail("invalid_cwd"); scope.assertAdmission();
    const f = follow ? input as ExternalJobFollowUpInput : null;
    const claim: OperationInput = { ownerSessionId: store.ownerSessionId, runId: input.runId, stepIndex: input.stepIndex, parentProviderJobId: f?.parentProviderJobId ?? null, ...digests, cwd, executionConfigDigest: sha256Utf8(canonicalJson(config)), queue: [] };
    const claimed = store.claimTurn(claim, config, scope, f ? { runId: f.sourceRunId, stepIndex: f.sourceStepIndex } : undefined);
    let t = claimed.turn;
    if (!claimed.fresh) {
      if (t.phase === "claimed") fail("admission_abandoned");
      return observe(t.jobId, scope);
    }
    try {
      // Only the committed actual snapshot determines the marker and outgoing prompt.
      const prompt = buildCheckpointPrompt({ prompt: input.prompt, operationDigest: t.operationDigest, queue: t.queueSnapshot });
      const projection = await client.probeCommand(t.config, t.claim.cwd, scope, t.expectedConversation ?? undefined); scope.assertAdmission();
      projections.set(t.jobId, { cwdDigest: projection.cwdDigest, requestedCwdDigest: projection.requestedCwdDigest });
      if (!accepting) fail("provider_shutting_down");
      t = store.markDispatching(t.jobId, scope); scope.assertAdmission();
      await client.startTurn({ jobId: t.jobId, prompt, cwd: t.claim.cwd, config: t.config, ...(t.expectedConversation ? { conversationId: t.expectedConversation } : {}) }, scope);
      scope.assertAdmission();
      // A start receipt establishes owning-server authority, not full retained
      // identity. Correlate the exact record before forwarding queued guidance.
      const started = await client.status(t.jobId, scope); scope.assertAdmission();
      correlate(t, started.record);
      t = store.saveTurn(t.jobId, { ...patch(t), phase: "acknowledged" }, scope);
      return handle(t);
    } catch (error) {
      try { store.settleTurn(t.jobId, { ...patch(t), phase: t.phase === "claimed" ? "terminal" : "dispatch_unknown", semanticState: t.phase === "claimed" ? "failed" : "execution_unknown", errorCode: providerDiagnostic(error) }, scope); } catch { /* No new scope, retry or implied non-dispatch proof. */ }
      throw error;
    }
  }
  function completed(t: TurnRecord, result: ResultEnvelope, scope: ProviderDeadline, settlement = false): TurnRecord {
    correlate(t, result.record);
    const current = store.getTurn(t.jobId, scope); if (current.phase === "terminal") return current;
    const evidence = { ...current.evidence, backendStatus: result.record.status, exitCode: result.record.exit_code };
    if (result.record.status !== "completed") fail("backend_terminal_changed");
    let conversationId: string; let checkpoint;
    try { conversationId = requireObservedConversation(result, t.expectedConversation ?? undefined); checkpoint = parseCheckpoint(result.result_text); }
    catch (error) { return store.saveTurn(t.jobId, { ...patch(current), phase: "terminal", semanticState: "failed", errorCode: providerDiagnostic(error), evidence }, scope); }
    return store.finalizeTurn(t.jobId, { phase: "terminal", semanticState: checkpointState(checkpoint.kind), checkpoint, output: "", conversationId, errorCode: null, evidence }, scope,
      receipts => formatCheckpointResult({ checkpoint, latestRunId: t.claim.runId, stepIndex: t.claim.stepIndex, assignmentId: t.assignmentId, queueReceipts: receipts }), settlement);
  }
  async function finalizeTurn(t: TurnRecord, scope: ProviderDeadline): Promise<TurnRecord> {
    let flight = finalizations.get(t.jobId);
    if (!flight) {
      flight = (async () => { const result = await client.result(t.jobId, scope); scope.assertAdmission(); return completed(t, result, scope); })();
      finalizations.set(t.jobId, flight);
      void flight.then(() => { if (finalizations.get(t.jobId) === flight) finalizations.delete(t.jobId); }, () => { if (finalizations.get(t.jobId) === flight) finalizations.delete(t.jobId); });
    }
    return scope.wait(flight);
  }
  function terminalRecord(t: TurnRecord, record: JobRecord, scope: ProviderDeadline): TurnRecord {
    correlate(t, record);
    return store.saveTurn(t.jobId, { ...patch(t), phase: "terminal", semanticState: record.status === "cancelled" ? "cancelled" : "failed", errorCode: `backend_${record.status}`, evidence: { ...t.evidence, backendStatus: record.status, exitCode: record.exit_code } }, scope);
  }
  async function observe(id: string, scope: ProviderDeadline): Promise<ExternalJobHandle> {
    let t = store.getTurn(id, scope);
    if (t.phase === "terminal") return handle(t);
    if (t.phase === "claimed") fail("admission_abandoned");
    try {
      await restoreProjection(t, scope);
      const status = await client.status(id, scope); scope.assertAdmission(); correlate(t, status.record);
      t = store.getTurn(id, scope); if (t.phase === "terminal") return handle(t);
      if (status.record.status === "completed") t = await finalizeTurn(t, scope);
      else if (["failed", "upstream_error", "cancelled"].includes(status.record.status)) t = terminalRecord(t, status.record, scope);
      else t = store.saveTurn(id, { ...patch(t), phase: status.record.status === "unknown" ? "dispatch_unknown" : "acknowledged", semanticState: status.record.status === "unknown" ? "execution_unknown" : "running", errorCode: status.record.status === "unknown" ? "backend_unknown" : null, evidence: { ...t.evidence, backendStatus: status.record.status, exitCode: status.record.exit_code } }, scope);
      return handle(t);
    } catch (error) { unknown(t, error, scope); throw error; }
  }
  function requireOwned(t: TurnRecord, scope: ProviderDeadline): void {
    store.withConversationLease(t.jobId, scope, held => { if (held.phase === "claimed") fail("cancel_target_inactive"); });
    const ownership = client.ownership(t.jobId);
    if (!ownership?.live || !ownership.acknowledged || ownership.generation !== client.lifecycle().generation) fail("mcp_cancel_not_owned");
  }
  async function cancelTurn(t: TurnRecord, scope: ProviderDeadline, settlementScope = scope): Promise<NonNullable<ControlResult["cancellation"]>> {
    requireOwned(t, scope);
    const ack = await client.cancelOwned(t.jobId, scope);
    let terminalCorrelated = false; let errorCode = ack.errorCode;
    try {
      scope.assertAdmission();
      let current = store.getTurn(t.jobId, scope);
      if (current.phase === "terminal") return { signalled: ack.signalled, terminalCorrelated: true, errorCode };
      if (ack.signalled !== null) current = store.saveTurn(t.jobId, { ...patch(current), evidence: { ...current.evidence, cancelSignalled: current.evidence.cancelSignalled === true || ack.signalled } }, scope);
      let { record } = await client.observeOwned(t.jobId, scope); scope.assertAdmission(); correlate(current, record);
      while (ack.signalled === true && record.status === "running" && scope.remaining() > 25) {
        await scope.wait(new Promise(resolve => setTimeout(resolve, Math.min(25, scope.remaining()))));
        ({ record } = await client.observeOwned(t.jobId, scope)); scope.assertAdmission(); correlate(current, record);
      }
      current = store.getTurn(t.jobId, scope);
      if (current.phase !== "terminal") {
        if (record.status === "completed") completed(current, await client.resultOwned(t.jobId, scope), scope);
        else if (["failed", "upstream_error", "cancelled"].includes(record.status)) terminalRecord(current, record, scope);
      }
      terminalCorrelated = ["completed", "failed", "upstream_error", "cancelled"].includes(record.status);
    } catch (error) {
      errorCode = providerDiagnostic(error);
      const evidence = { ...t.evidence, ...(ack.signalled === null ? {} : { cancelSignalled: t.evidence.cancelSignalled === true || ack.signalled }) };
      try { store.settleTurn(t.jobId, { ...patch(t), phase: "dispatch_unknown", semanticState: "execution_unknown", errorCode, evidence }, settlementScope); } catch { /* No release from ACK/bodyless evidence. */ }
    }
    return { signalled: ack.signalled, terminalCorrelated, errorCode };
  }
  const provider: AgyProvider = {
    name: "agy-mcp",
    stopAdmission: () => { accepting = false; admissionAbort.abort(); client.stopAdmission(); },
    start: input => operation(scope => dispatch(input, scope, false)),
    followUp: input => operation(scope => dispatch(input, scope, true)),
    status: id => operation(scope => observe(id, scope)),
    result: id => operation(async scope => { const h = await observe(id, scope); const t = store.getTurn(id, scope); return { ...h, ...(t.output !== null ? { output: t.output } : {}) } satisfies ExternalJobResult; }),
    reattach: id => operation(scope => observe(id, scope)),
    control: (input, ownerSessionId, signal) => operation(async scope => {
      if (ownerSessionId !== store.ownerSessionId) fail("owner_mismatch");
      const index = input.index ?? 0;
      const target = store.resolveRunTarget(input.runId, index, scope);
      const identities = { requested: { runId: target.requested.claim.runId, index: target.requested.claim.stepIndex }, latest: { runId: target.latest.claim.runId, index: target.latest.claim.stepIndex } };
      if (input.action === "queue") {
        const receipt = store.enqueueMessage(target.latest.jobId, input.messageId!, input.message!, scope);
        return { ...identities, receipt, status: store.getAssignmentStatus(target.latest.jobId, scope) };
      }
      if (input.action === "cancel") {
        if (target.requested.jobId !== target.latest.jobId) fail("stale_cancel_target");
        if (target.latest.phase === "terminal") fail("cancel_target_inactive");
        requireOwned(target.latest, scope);
        const budget = new ProviderDeadline(deadline?.clock, Math.min(10_000, scope.remaining()), 0, scope.signal);
        try { const cancellation = await cancelTurn(target.latest, budget); return { ...identities, cancellation, status: store.getAssignmentStatus(target.latest.jobId, scope) }; }
        finally { budget.dispose(); }
      }
      if (input.action !== "status") fail("invalid_control_action");
      await observe(target.latest.jobId, scope);
      return { ...identities, status: store.getAssignmentStatus(target.latest.jobId, scope) };
    }, signal),
    shutdown: () => shutdownFlight ??= (async () => {
      provider.stopAdmission();
      const now = deadline?.clock ?? (() => performance.now()); const entry = now();
      let initializing = true;
      const clock = () => initializing ? entry : now();
      const work = new ProviderDeadline(clock, 10_000, 0);
      const local = new ProviderDeadline(clock, 15_000, 0);
      initializing = false; // Both scopes retain the same first-entry epoch.
      try {
        let active: readonly ReturnType<AssignmentStore["listActiveTurns"]>[number][] = [];
        // Never create lazy state merely to shut down an unused extension.
        if (client.ownedJobs().length) active = store.listActiveTurns(work);
        await Promise.all(active.map(async item => {
          let t: TurnRecord | undefined;
          try { t = store.getTurn(item.jobId, work); requireOwned(t, work); const cancellation = await cancelTurn(t, work, local);
            if (!cancellation.terminalCorrelated) {
              const current = store.getTurn(t.jobId, local);
              unknown(current, new ContractError("shutdown_execution_unknown"), local);
            } }
          catch (error) { if (t) unknown(t, error, local); }
        }));
      } finally {
        try { await local.wait(client.close()); } finally { work.dispose(); local.dispose(); }
      }
    })(),
  };
  return provider;
}
