import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertJobId, assertUtf8, canonicalJson, ContractError, fail, sha256Utf8, validateExecutionConfig, type ExecutionConfig } from "./contracts.js";
import { ProviderDeadline } from "./deadline.js";

export type BackendStatus = "running" | "completed" | "failed" | "cancelled" | "upstream_error" | "unknown";
export interface JobRecord {
  job_id: string; session_id: string | null; status: BackendStatus; backend: string | null;
  cwd: string; started_at: string; updated_at: string; finished_at: string | null;
  exit_code: number | null; request: Record<string, unknown>; extra: Record<string, unknown>;
  [key: string]: unknown;
}
export interface BridgeEnvelope { success: true; job_id: string | null; status: BackendStatus; SESSION_ID: string; adapter: Record<string, unknown>; command_preview: string[] | null; [key: string]: unknown }
export interface StatusEnvelope { success: true; record: JobRecord }
export interface ResultEnvelope extends StatusEnvelope { job_id: string; result_text: string; include_events: true; since: number; events: Record<string, unknown>[]; count: number }
export interface CancelEnvelope { success: true; job_id: string; signalled: boolean }
export type AgyTool = "agy" | "agy_start" | "agy_status" | "agy_result" | "agy_cancel";
const statuses = ["running", "completed", "failed", "cancelled", "upstream_error", "unknown"];
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function record(value: unknown, exactId: string): asserts value is JobRecord {
  if (!object(value) || value.job_id !== exactId || !statuses.includes(value.status as string) || !(value.session_id === null || typeof value.session_id === "string") || !(value.backend === null || ["agy", "gemini", "auto"].includes(value.backend as string)) || !object(value.request) || !object(value.extra)) fail("mcp_record_schema");
  const fields = ["job_id", "session_id", "status", "backend", "cwd", "pid", "started_at", "updated_at", "finished_at", "exit_code", "log_path", "stdout_path", "stderr_path", "events_path", "artifacts", "request", "last_event_at", "error", "extra"];
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail("mcp_record_schema");
  for (const field of ["cwd", "started_at", "updated_at"]) if (typeof value[field] !== "string") fail("mcp_record_schema");
  for (const field of ["finished_at", "log_path", "stdout_path", "stderr_path", "events_path", "last_event_at", "error"]) if (!(value[field] === null || typeof value[field] === "string")) fail("mcp_record_schema");
  for (const field of ["pid", "exit_code"]) if (!(value[field] === null || Number.isInteger(value[field]))) fail("mcp_record_schema");
  if (!Array.isArray(value.artifacts) || !value.artifacts.every(object)) fail("mcp_record_schema");
  if (typeof value.request.prompt !== "string" || !value.request.prompt || typeof value.request.cwd !== "string" || !["ask", "plan", "prototype", "review", "execute", "browser", "long"].includes(value.request.mode as string) || typeof value.request.sandbox !== "boolean" || typeof value.request.allow_write !== "boolean" || typeof value.request.worktree !== "boolean" || typeof value.request.timeout !== "number" || typeof value.request.output_protocol !== "string" || typeof value.request.backend !== "string" || !(value.request.model === null || typeof value.request.model === "string") || !(value.request.session_id === null || typeof value.request.session_id === "string")) fail("mcp_record_schema");
}
export function decodeEnvelope(tool: AgyTool, wire: unknown, exactId?: string): Record<string, unknown> {
  if (!object(wire)) fail("mcp_envelope_schema");
  let encoded: string;
  try { encoded = JSON.stringify(wire); } catch { return fail("mcp_envelope_schema"); }
  if (Buffer.byteLength(encoded) > 6 * 1024 * 1024) fail("mcp_envelope_oversize");
  if (wire.isError) fail("mcp_tool_error");
  let envelope: unknown = wire.structuredContent;
  if (envelope === undefined) {
    if (!Array.isArray(wire.content) || wire.content.length !== 1 || !object(wire.content[0]) || wire.content[0].type !== "text" || typeof wire.content[0].text !== "string") fail("mcp_envelope_schema");
    if (Buffer.byteLength(wire.content[0].text) > 2 * 1024 * 1024) fail("mcp_envelope_oversize");
    try { envelope = JSON.parse(wire.content[0].text); } catch { return fail("mcp_envelope_schema"); }
  }
  if (!object(envelope) || typeof envelope.success !== "boolean") fail("mcp_envelope_schema");
  if (Buffer.byteLength(JSON.stringify(envelope)) > 2 * 1024 * 1024) fail("mcp_envelope_oversize");
  // Reject ambiguous UTF-16/non-JSON without echoing validator/runtime errors.
  try { canonicalJson(envelope); } catch { return fail("mcp_envelope_schema"); }
  if (!envelope.success) fail("mcp_tool_rejected");
  if (envelope.error !== null && envelope.error !== undefined) fail("mcp_envelope_schema");
  const fields: Record<AgyTool, string[]> = {
    agy: ["success", "SESSION_ID", "job_id", "status", "agent_messages", "all_messages", "artifacts", "error", "warnings", "cwd", "adapter", "command_preview", "log_path", "created_at", "updated_at"],
    agy_start: ["success", "SESSION_ID", "job_id", "status", "agent_messages", "all_messages", "artifacts", "error", "warnings", "cwd", "adapter", "command_preview", "log_path", "created_at", "updated_at"],
    agy_status: ["success", "error", "record"],
    agy_result: ["success", "error", "job_id", "record", "result_text", "include_events", "since", "events", "count"],
    agy_cancel: ["success", "error", "job_id", "signalled"],
  };
  if (Object.keys(envelope).some(key => !fields[tool].includes(key))) fail("mcp_envelope_schema");
  if (tool === "agy" || tool === "agy_start") {
    if (fields[tool].some(key => !Object.hasOwn(envelope, key)) || !statuses.includes(envelope.status as string) || typeof envelope.SESSION_ID !== "string" || !object(envelope.adapter) || !(envelope.job_id === null || typeof envelope.job_id === "string") || !(envelope.command_preview === null || Array.isArray(envelope.command_preview) && envelope.command_preview.every(x => typeof x === "string"))) fail("mcp_envelope_schema");
    for (const field of ["cwd", "created_at", "updated_at"]) if (typeof envelope[field] !== "string") fail("mcp_envelope_schema");
    if (!(typeof envelope.agent_messages === "string" || Array.isArray(envelope.agent_messages) && envelope.agent_messages.every(object)) || !Array.isArray(envelope.all_messages) || !envelope.all_messages.every(object) || !Array.isArray(envelope.artifacts) || !envelope.artifacts.every(object) || !Array.isArray(envelope.warnings) || !envelope.warnings.every(x => typeof x === "string") || !(envelope.log_path === null || typeof envelope.log_path === "string")) fail("mcp_envelope_schema");
    if (tool === "agy_start" && (envelope.job_id !== exactId || envelope.status !== "running" || envelope.adapter.backend !== "agy")) fail("mcp_job_mismatch");
  } else {
    if (!exactId) fail("invalid_job_id");
    if (tool === "agy_status" || tool === "agy_result") record(envelope.record, exactId);
    if (tool !== "agy_status" && envelope.job_id !== exactId) fail("mcp_job_mismatch");
    if (tool === "agy_cancel" && typeof envelope.signalled !== "boolean") fail("mcp_envelope_schema");
    if (tool === "agy_result") {
      if (typeof envelope.result_text !== "string" || envelope.include_events !== true || envelope.since !== 0 || !Array.isArray(envelope.events) || envelope.events.length > 2000 || !envelope.events.every(object) || envelope.count !== envelope.events.length) fail("mcp_result_schema");
      if ((envelope.record as JobRecord).status === "running" || (envelope.record as JobRecord).status === "unknown") fail("mcp_result_schema");
    }
  }
  return envelope;
}
export function requireObservedConversation(result: ResultEnvelope, expected?: string): string {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const id = result.record.session_id;
  if (result.record.status !== "completed" || typeof id !== "string" || !uuid.test(id)) fail("conversation_missing");
  const anchors = result.events.filter(e => e.type === "system" && ["conversation_started", "conversation_resumed", "print_starting", "stream_start"].includes(e.subtype as string));
  if (anchors.some(e => e.session_id != null && (typeof e.session_id !== "string" || !uuid.test(e.session_id)))) fail("conversation_mismatch");
  const observed = anchors.filter(e => typeof e.session_id === "string" && uuid.test(e.session_id));
  if (!observed.length) fail("conversation_unobserved");
  if (observed.some(e => e.session_id !== id) || expected !== undefined && id !== expected) fail("conversation_mismatch");
  return id;
}
export interface McpClientOptions { ownerDirectory: string; command?: string; args?: string[]; env?: Record<string, string> }
/** Deterministic public-transport injection only; never populated from environment/model input. */
export interface McpClientTestDependencies {
  createStdioTransport?: (parameters: StdioServerParameters) => StdioClientTransport;
}
export interface TransportOwnership {
  jobId: string; generation: string; live: boolean; attempted: boolean; acknowledged: boolean;
  cancelAttempted: boolean; recordCorrelated: boolean; observedStatus: BackendStatus | null;
}
export interface OwnedCancelEvidence extends TransportOwnership {
  signalled: boolean | null; terminalObserved: boolean; errorCode: string | null;
}
interface OwnedJob {
  evidence: TransportOwnership;
  matches: (record: JobRecord) => boolean;
  cancellation?: Promise<OwnedCancelEvidence>;
}
/** Public Transport composition: admission is checked at the physical SDK send seam. */
class GuardedStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private closing?: Promise<void>;
  readonly pendingSends = new Set<Promise<void>>();
  closeSettled = false;
  closeObserved = false;
  constructor(readonly stdio: StdioClientTransport, private readonly admit: (message?: JSONRPCMessage) => void,
    private readonly started: () => void) {}
  start(): Promise<void> {
    this.admit();
    this.stdio.onclose = () => { this.closeObserved = true; this.onclose?.(); };
    this.stdio.onerror = error => this.onerror?.(error);
    this.stdio.onmessage = message => this.onmessage?.(message);
    return this.stdio.start().then(() => this.started());
  }
  async send(message: JSONRPCMessage): Promise<void> {
    // Cancellation notifications only end local RPC waiting, never AGY execution.
    if ("method" in message && message.method !== "notifications/cancelled") this.admit(message);
    const send = this.stdio.send(message);
    this.pendingSends.add(send);
    void send.then(() => this.pendingSends.delete(send), () => this.pendingSends.delete(send));
    await send;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      // Public SDK start initiates spawn synchronously. Never await an unresolved start/send loser.
      await this.stdio.close();
      this.closeSettled = true;
    })();
  }
}
export class AgyMcpClient {
  private client?: Client;
  private transport?: GuardedStdioTransport;
  private connecting?: Promise<void>;
  private closeFlight?: Promise<void>;
  private shutdownFlight?: Promise<{ jobs: readonly OwnedCancelEvidence[]; closed: true }>;
  private closed = false;
  private broken = false;
  private accepting = true;
  private readonly generation = randomUUID();
  private readonly ordinaryAbort = new AbortController();
  private readonly closeAbort = new AbortController();
  private readonly jobs = new Map<string, OwnedJob>();
  private readonly pending = new Set<Promise<unknown>>();
  private sendContext?: { scope: ProviderDeadline; settlement: boolean; tool: AgyTool; args: Record<string, unknown>; exactId?: string };
  constructor(private readonly options: McpClientOptions, private readonly testDependencies: McpClientTestDependencies = {}) {
    if (!path.isAbsolute(options.ownerDirectory)) fail("invalid_owner_directory");
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  lifecycle(): Readonly<{ generation: string; accepting: boolean; closed: boolean; broken: boolean; connected: boolean; pendingOperations: number; pendingSends: number; transportCloseSettled: boolean; transportCloseObserved: boolean }> {
    return Object.freeze({ generation: this.generation, accepting: this.accepting, closed: this.closed, broken: this.broken,
      connected: !!this.client && !this.closed && !this.broken,
      pendingOperations: this.pending.size, pendingSends: this.transport?.pendingSends.size ?? 0,
      transportCloseSettled: this.transport?.closeSettled ?? false, transportCloseObserved: this.transport?.closeObserved ?? false });
  }
  private assertAvailable(settlement = false): void {
    if (this.closed || this.broken || !settlement && !this.accepting) fail("mcp_connection_unavailable");
  }
  stopAdmission(): void {
    this.accepting = false;
    this.ordinaryAbort.abort();
  }
  ownership(jobId: string): TransportOwnership | null {
    assertJobId(jobId);
    const evidence = this.jobs.get(jobId)?.evidence;
    return evidence ? Object.freeze({ ...evidence, live: !this.closed && !this.broken && !!this.client }) : null;
  }
  ownedJobs(): readonly TransportOwnership[] {
    return Object.freeze([...this.jobs.keys()].map(id => this.ownership(id)!));
  }
  async connect(scope: ProviderDeadline): Promise<void> {
    scope.assertAdmission(); this.assertAvailable();
    if (this.client) return;
    if (!this.connecting) {
      const flight = this.track(this.open(scope));
      this.connecting = flight;
      void flight.then(() => { if (this.connecting === flight) this.connecting = undefined; }, () => { if (this.connecting === flight) this.connecting = undefined; });
    }
    try { await scope.wait(this.connecting, this.ordinaryAbort.signal); }
    catch (error) { if (this.closed || !this.accepting) fail("mcp_connection_unavailable"); throw error; }
    scope.assertAdmission(); this.assertAvailable();
  }
  private requestOptions(scope: ProviderDeadline, settlement = false) {
    const options = scope.requestOptions();
    options.signal = AbortSignal.any([options.signal, this.closeAbort.signal, ...(settlement ? [] : [this.ordinaryAbort.signal])]);
    return options;
  }
  private attempted(context: NonNullable<AgyMcpClient["sendContext"]>): void {
    const id = context.exactId!;
    if (this.jobs.has(id)) fail(this.jobs.get(id)!.evidence.acknowledged ? "mcp_tool_rejected" : "start_dispatch_unknown");
    const args = context.args;
    const prompt = String(args.PROMPT);
    const marker = prompt.split(/\r?\n/).find(line => /^AGY_PI_OP v1 [a-f0-9]{16}(?:\.[a-f0-9]{16}){3}$/.test(line));
    const digest = sha256Utf8(prompt);
    const config = Object.fromEntries(["backend", "mode", "sandbox", "timeout", "allow_write", "worktree", "output_protocol", "model"].map(key => [key, args[key] ?? null]));
    const conversation = args.SESSION_ID ?? null;
    this.jobs.set(id, {
      evidence: { jobId: id, generation: this.generation, live: true, attempted: true, acknowledged: false, cancelAttempted: false, recordCorrelated: false, observedStatus: null },
      matches: record => record.backend === "agy" && record.request.session_id === conversation && Object.entries(config).every(([key, value]) => record.request[key] === value) && (marker ? (record.request.prompt as string).split(/\r?\n/).filter(line => line === marker).length === 1 : sha256Utf8(record.request.prompt as string) === digest),
    });
  }
  private async open(scope: ProviderDeadline): Promise<void> {
    const env = this.options.env ?? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    const command = this.options.command ?? env.AGY_PI_MCP_COMMAND ?? "agymcp";
    let args: unknown = this.options.args ?? [];
    if (this.options.args === undefined && env.AGY_PI_MCP_ARGS !== undefined) {
      try { args = JSON.parse(env.AGY_PI_MCP_ARGS); } catch { return fail("invalid_mcp_command"); }
    }
    assertUtf8(command);
    if (!command.trim() || /[\x00\r\n]/.test(command) || !Array.isArray(args) || args.length > 16 || args.some(x => typeof x !== "string" || /[\x00\r\n]/.test(x))) fail("invalid_mcp_command");
    for (const arg of args) assertUtf8(arg);
    const client = new Client({ name: "agy-pi-subagents", version: "0.1.0" });
    const parameters: StdioServerParameters = { command, args, env: { ...env, AGY_MCP_SESSION_ROOT: path.join(this.options.ownerDirectory, "mcp-jobs") }, stderr: "ignore", maxBufferSize: 6 * 1024 * 1024 };
    const stdio = this.testDependencies.createStdioTransport?.(parameters) ?? new StdioClientTransport(parameters);
    const initializeOptions = this.requestOptions(scope);
    const transport = new GuardedStdioTransport(stdio, message => {
      const context = this.sendContext;
      const budget = context?.scope ?? scope;
      budget.assertAdmission(); this.assertAvailable(context?.settlement);
      if (message && "method" in message && message.method === "tools/call" && context) {
        if (context.tool === "agy_start") this.attempted(context);
        if (context.tool === "agy_cancel") this.jobs.get(context.exactId!)!.evidence.cancelAttempted = true;
      }
    }, () => {
      // Client.connect consumes this supplied object only after public Transport.start.
      scope.assertAdmission(); this.assertAvailable();
      const remaining = scope.requestOptions();
      initializeOptions.timeout = Math.min(initializeOptions.timeout, remaining.timeout);
      initializeOptions.maxTotalTimeout = Math.min(initializeOptions.maxTotalTimeout, remaining.maxTotalTimeout);
    });
    this.transport = transport;
    transport.onclose = () => { this.broken = true; this.closeAbort.abort(); };
    try {
      await client.connect(transport, initializeOptions); scope.assertAdmission(); this.assertAvailable();
      const listed = await client.listTools({}, this.requestOptions(scope)); scope.assertAdmission(); this.assertAvailable();
      if (listed.nextCursor) fail("mcp_capability_missing");
      for (const name of ["agy", "agy_start", "agy_status", "agy_result", "agy_cancel"]) if (listed.tools.filter(t => t.name === name).length !== 1) fail("mcp_capability_missing");
      const accepts = (schema: unknown, type: string): boolean => object(schema) && (schema.type === type || Array.isArray(schema.anyOf) && schema.anyOf.some(part => accepts(part, type)));
      for (const [name, required, type] of [["agy", ["dry_run", "debug"], "boolean"], ["agy_start", ["job_id", "SESSION_ID"], "string"]] as const) {
        const props = listed.tools.find(t => t.name === name)!.inputSchema.properties;
        if (!props || required.some(key => !accepts(props[key], type))) fail("mcp_capability_missing");
      }
      scope.assertAdmission(); this.assertAvailable();
      this.client = client;
    } catch (err) {
      this.broken = true;
      this.track(transport.close());
      if (err instanceof ContractError) throw err;
      fail("mcp_connect_failed");
    }
  }
  async callEnvelope(tool: AgyTool, args: Record<string, unknown>, scope: ProviderDeadline, exactId?: string): Promise<Record<string, unknown>> {
    // Raw generic cancellation must obey the same owning-generation/once-only contract.
    if (tool === "agy_cancel") {
      assertJobId(exactId); if (args.job_id !== exactId) fail("invalid_job_id");
      const evidence = await this.cancelOwned(exactId, scope);
      if (evidence.signalled === null) fail(evidence.errorCode ?? "mcp_request_failed");
      return { success: true, error: null, job_id: exactId, signalled: evidence.signalled };
    }
    return this.call(tool, args, scope, exactId);
  }
  private async call(tool: AgyTool, args: Record<string, unknown>, scope: ProviderDeadline, exactId?: string, settlement = false): Promise<Record<string, unknown>> {
    if (tool !== "agy") { assertJobId(exactId); if (args.job_id !== exactId) fail("invalid_job_id"); }
    scope.assertAdmission(); this.assertAvailable(settlement);
    if (!settlement) await this.connect(scope);
    else if (!this.client) fail("mcp_connection_unavailable"); // Settlement never spawns/reconnects.
    scope.assertAdmission(); this.assertAvailable(settlement);
    let wire: unknown;
    try {
      this.sendContext = { scope, settlement, tool, args, exactId };
      // request() permits the documented single-text fallback, unlike SDK callTool().
      const work = this.track(this.client!.request({ method: "tools/call", params: { name: tool, arguments: args } }, CallToolResultSchema, this.requestOptions(scope, settlement)));
      this.sendContext = undefined;
      wire = await work;
    } catch (error) {
      this.sendContext = undefined;
      if (error instanceof ContractError) throw error;
      fail(tool === "agy_start" ? "start_dispatch_unknown" : "mcp_request_failed");
    }
    const decoded = decodeEnvelope(tool, wire, exactId);
    const job = exactId ? this.jobs.get(exactId) : undefined;
    if (tool === "agy_start" && job) job.evidence.acknowledged = true;
    if ((tool === "agy_status" || tool === "agy_result") && job) {
      const observed = decoded.record as unknown as JobRecord;
      if (!job.matches(observed)) fail("mcp_record_uncorrelated");
      job.evidence.recordCorrelated = true; job.evidence.observedStatus = observed.status;
      // Correlation is not owning-server evidence, even for a same-generation attempt.
    }
    scope.assertAdmission(); this.assertAvailable(settlement);
    return decoded;
  }
  async probeCommand(config: ExecutionConfig, cwd: string, scope: ProviderDeadline, conversationId?: string): Promise<{ fresh: boolean; sandbox: true; conversation: true; modelForwarded: boolean; previewDigest: string; cwdDigest: string; requestedCwdDigest: string }> {
    validateExecutionConfig(config);
    const probe = async (sid?: string) => {
      const response = await this.callEnvelope("agy", { ...config, model: config.model, PROMPT: "AGY Pi non-sensitive command capability check.", cd: cwd, dry_run: true, debug: true, ...(sid ? { SESSION_ID: sid } : {}) }, scope);
      const argv = response.command_preview;
      if (!Array.isArray(argv) || !argv.every(x => typeof x === "string") || (response.adapter as Record<string, unknown>).backend !== "agy") fail("command_preview_invalid");
      if (argv.filter(x => x === "--sandbox").length !== 1 || argv.some(x => /^--(?:dangerously|yolo|skip-permissions|allow-write)/.test(x))) fail("command_capability_missing");
      const conversations = argv.filter(x => x.startsWith("--conversation"));
      if (argv.some(x => x === "--continue" || x.startsWith("--continue=") || x === "--resume")) fail("command_capability_missing");
      if (sid ? conversations.length !== 1 || conversations[0] !== `--conversation=${sid}` || argv.includes("--new-project") : argv.filter(x => x === "--new-project").length !== 1 || conversations.length !== 0) fail("command_capability_missing");
      const modeIndex = argv.indexOf("--mode");
      if (modeIndex >= 0 && (argv[modeIndex + 1] !== "plan" || argv.filter(x => x === "--mode").length !== 1)) fail("command_capability_missing");
      const models = argv.filter(x => x.startsWith("--model"));
      if (config.model === null ? models.length !== 0 : models.length !== 1 || models[0] !== `--model=${config.model}`) fail("command_capability_missing");
      return { previewDigest: sha256Utf8(canonicalJson(argv)), cwdDigest: sha256Utf8(response.cwd as string) };
    };
    if (conversationId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(conversationId)) fail("conversation_missing");
    const first = await probe(conversationId);
    if (conversationId === undefined && (await probe("11111111-1111-4111-8111-111111111111")).cwdDigest !== first.cwdDigest) fail("cwd_projection_mismatch");
    scope.assertAdmission();
    return { fresh: conversationId === undefined, sandbox: true, conversation: true, modelForwarded: config.model !== null, previewDigest: first.previewDigest, cwdDigest: first.cwdDigest, requestedCwdDigest: sha256Utf8(cwd) };
  }
  async startTurn(input: { jobId: string; prompt: string; cwd: string; config: ExecutionConfig; conversationId?: string }, scope: ProviderDeadline): Promise<BridgeEnvelope> {
    validateExecutionConfig(input.config); assertUtf8(input.prompt); scope.assertAdmission();
    if (input.conversationId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.conversationId)) fail("conversation_missing");
    const response = await this.callEnvelope("agy_start", { ...input.config, PROMPT: input.prompt, cd: input.cwd, job_id: input.jobId, ...(input.conversationId ? { SESSION_ID: input.conversationId } : {}) }, scope, input.jobId);
    return response as unknown as BridgeEnvelope;
  }
  async status(jobId: string, scope: ProviderDeadline): Promise<StatusEnvelope> {
    return await this.callEnvelope("agy_status", { job_id: jobId }, scope, jobId) as unknown as StatusEnvelope;
  }
  async result(jobId: string, scope: ProviderDeadline): Promise<ResultEnvelope> {
    return await this.callEnvelope("agy_result", { job_id: jobId, include_events: true, since: 0 }, scope, jobId) as unknown as ResultEnvelope;
  }
  /** Only a decoded start acknowledgment on this live generation grants cancellation authority. */
  async cancelOwned(jobId: string, scope: ProviderDeadline): Promise<OwnedCancelEvidence> {
    assertJobId(jobId);
    if (scope.totalMs > 10_000) fail("invalid_cancel_budget");
    scope.assertAdmission(); this.assertAvailable(true);
    const job = this.jobs.get(jobId);
    if (!job?.evidence.acknowledged || !this.client) fail("mcp_cancel_not_owned");
    if (!job.cancellation) {
      job.cancellation = this.track(this.cancelOnce(jobId, job, scope));
      return job.cancellation; // Bounded RPCs settle into evidence even at the budget boundary.
    }
    return scope.wait(job.cancellation, this.closeAbort.signal);
  }
  private async cancelOnce(jobId: string, job: OwnedJob, scope: ProviderDeadline): Promise<OwnedCancelEvidence> {
    let signalled: boolean | null = null;
    let errorCode: string | null = null;
    // The once-only flight reserves intent; cancelAttempted records physical send admission only.
    try {
      const response = await this.call("agy_cancel", { job_id: jobId }, scope, jobId, true) as unknown as CancelEnvelope;
      signalled = response.signalled;
    } catch (error) { errorCode = error instanceof ContractError ? error.code : "mcp_request_failed"; }
    try {
      await this.call("agy_status", { job_id: jobId }, scope, jobId, true);
    } catch (error) { errorCode ??= error instanceof ContractError ? error.code : "mcp_request_failed"; }
    const evidence = this.ownership(jobId)!;
    return Object.freeze({ ...evidence, signalled, terminalObserved: evidence.recordCorrelated && evidence.observedStatus !== null && ["completed", "failed", "cancelled", "upstream_error"].includes(evidence.observedStatus), errorCode });
  }
  /** Explicit owned read-only settlement; never creates or adopts a connection/job. */
  async observeOwned(jobId: string, scope: ProviderDeadline): Promise<StatusEnvelope> {
    assertJobId(jobId);
    if (!this.jobs.get(jobId)?.evidence.acknowledged) fail("mcp_cancel_not_owned");
    return await this.call("agy_status", { job_id: jobId }, scope, jobId, true) as unknown as StatusEnvelope;
  }
  /** Exact acknowledged-owned result under the original shutdown window; no reconnect/adoption. */
  async resultOwned(jobId: string, scope: ProviderDeadline): Promise<ResultEnvelope> {
    assertJobId(jobId);
    if (scope.totalMs > 10_000) fail("invalid_cancel_budget");
    if (!this.jobs.get(jobId)?.evidence.acknowledged) fail("mcp_cancel_not_owned");
    return await this.call("agy_result", { job_id: jobId, include_events: true, since: 0 }, scope, jobId, true) as unknown as ResultEnvelope;
  }
  async cancel(jobId: string, scope?: ProviderDeadline): Promise<{ signalled: boolean; observedStatus: BackendStatus | null }> {
    const budget = scope ?? new ProviderDeadline(undefined, 10_000, 0);
    try {
      // Return the legacy shape; richer local-vs-upstream evidence is opt-in via cancelOwned.
      const receipt = await this.cancelOwned(jobId, budget);
      if (receipt.signalled === null) fail(receipt.errorCode ?? "mcp_request_failed");
      return { signalled: receipt.signalled, observedStatus: receipt.observedStatus };
    } finally { if (!scope) budget.dispose(); }
  }
  shutdown(scope?: ProviderDeadline): Promise<{ jobs: readonly OwnedCancelEvidence[]; closed: true }> {
    if (scope && scope.totalMs > 10_000) fail("invalid_cancel_budget");
    if (this.shutdownFlight) return this.shutdownFlight;
    this.stopAdmission();
    const budget = scope ?? new ProviderDeadline(undefined, 10_000, 0);
    this.shutdownFlight = (async () => {
      try {
        const jobs = await Promise.all([...this.jobs].map(async ([id, job]): Promise<OwnedCancelEvidence> => {
          if (job.evidence.acknowledged && !this.closed && !this.broken && scope?.signal.aborted !== true) {
            try { return await this.cancelOwned(id, budget); } catch { /* report unresolved exact generation */ }
          }
          const evidence = this.ownership(id)!;
          return Object.freeze({ ...evidence, signalled: null, terminalObserved: false, errorCode: evidence.acknowledged ? "cancel_observation_unknown" : "mcp_cancel_not_owned" });
        }));
        await this.close();
        return { jobs: Object.freeze(jobs.map(job => Object.freeze({ ...job, live: false }))), closed: true };
      } finally { if (!scope) budget.dispose(); }
    })();
    return this.shutdownFlight;
  }
  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    this.closed = true; this.stopAdmission(); this.closeAbort.abort();
    this.closeFlight = (async () => {
      // SDK owns/signals only its stdio child (two 2s grace periods); not AGY terminal proof.
      const cleanup = this.track(this.transport?.close() ?? Promise.resolve());
      try { await cleanup; } catch { fail("mcp_close_failed"); }
      // Unresolved start/drain losers remain counted, with guarded continuations and handlers.
      this.client = undefined;
    })();
    return this.closeFlight;
  }
}
