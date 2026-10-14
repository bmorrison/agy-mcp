import { createHash } from "node:crypto";

export class ContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ContractError"; }
}
export function fail(code: string): never { throw new ContractError(code); }
export function assertUtf8(text: unknown): asserts text is string {
  if (typeof text !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) fail("invalid_utf8");
}
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "string") { assertUtf8(v); return JSON.stringify(v); }
    if (typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || !v || seen.has(v)) return fail("invalid_json");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length || Reflect.ownKeys(v).length !== v.length + 1) fail("invalid_json");
        return `[${Array.from({ length: v.length }, (_, i) => {
          const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
          if (!descriptor || !("value" in descriptor)) fail("invalid_json");
          return encode(descriptor.value);
        }).join(",")}]`;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail("invalid_json");
      if (Reflect.ownKeys(v).length !== Object.keys(v).length) fail("invalid_json");
      return `{${Object.keys(v).sort().map(k => {
        assertUtf8(k);
        const descriptor = Object.getOwnPropertyDescriptor(v, k)!;
        if (!("value" in descriptor)) fail("invalid_json");
        return `${JSON.stringify(k)}:${encode(descriptor.value)}`;
      }).join(",")}}`;
    } finally { seen.delete(v); }
  }
  return encode(value);
}
export function sha256Utf8(text: string): string {
  assertUtf8(text);
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid_digest");
}
export function validateOwnerInputDigests(input: {
  prompt: string; promptDigest: string; requestId?: string | null; requestDigest?: string | null;
}, followUp = false): { promptDigest: string; requestId: string | null; requestDigest: string | null } {
  assertDigest(input.promptDigest);
  if (sha256Utf8(input.prompt) !== input.promptDigest) fail("prompt_digest_mismatch");
  if (!followUp) {
    if (input.requestId != null || input.requestDigest != null) fail("unexpected_request_identity");
    return { promptDigest: input.promptDigest, requestId: null, requestDigest: null };
  }
  assertDigest(input.requestDigest);
  if (input.requestId !== `follow-up-${input.requestDigest.slice(0, 48)}`) fail("request_identity_mismatch");
  return { promptDigest: input.promptDigest, requestId: input.requestId, requestDigest: input.requestDigest };
}
export interface ExecutionConfig {
  backend: "agy"; mode: "review"; sandbox: true; allow_write: false; worktree: false;
  output_protocol: "raw"; timeout: number; model: string | null;
}
export function validateExecutionConfig(config: ExecutionConfig): void {
  if (canonicalJson(Object.keys(config).sort()) !== canonicalJson(["allow_write", "backend", "mode", "model", "output_protocol", "sandbox", "timeout", "worktree"])) fail("invalid_execution_config");
  if (config.backend !== "agy" || config.mode !== "review" || config.sandbox !== true || config.allow_write !== false || config.worktree !== false || config.output_protocol !== "raw" || !Number.isInteger(config.timeout) || config.timeout < 1 || config.timeout > 300) fail("invalid_execution_config");
  if (config.model !== null) { assertUtf8(config.model); if (!config.model.trim() || /\p{Cc}/u.test(config.model)) fail("invalid_execution_config"); }
}
export interface QueueDigest { sequence: number; messageId: string; contentDigest: string }
export interface OperationInput {
  ownerSessionId: string; runId: string; stepIndex: number; parentProviderJobId: string | null;
  requestId: string | null; requestDigest: string | null; promptDigest: string; cwd: string;
  executionConfigDigest: string; queue: readonly QueueDigest[];
}
export function deriveOperation(input: OperationInput): { operationDigest: string; jobId: string } {
  for (const text of [input.ownerSessionId, input.runId, input.cwd]) {
    assertUtf8(text); if (!text || /\p{Cc}/u.test(text)) fail("invalid_operation");
  }
  if (!Number.isSafeInteger(input.stepIndex) || input.stepIndex < 0) fail("invalid_operation");
  assertDigest(input.promptDigest); assertDigest(input.executionConfigDigest);
  if (input.parentProviderJobId === null) {
    if (input.requestId !== null || input.requestDigest !== null) fail("invalid_operation");
  } else {
    assertJobId(input.parentProviderJobId); assertDigest(input.requestDigest);
    if (input.requestId !== `follow-up-${input.requestDigest.slice(0, 48)}`) fail("request_identity_mismatch");
  }
  let prior = -1; const ids = new Set<string>();
  for (const item of input.queue) {
    assertUtf8(item.messageId); assertDigest(item.contentDigest);
    if (!item.messageId || /\p{Cc}/u.test(item.messageId) || !Number.isSafeInteger(item.sequence) || item.sequence <= prior || ids.has(item.messageId)) fail("invalid_queue_snapshot");
    prior = item.sequence; ids.add(item.messageId);
    if (Object.keys(item).sort().join(",") !== "contentDigest,messageId,sequence") fail("invalid_queue_snapshot");
  }
  // Explicit preimage excludes raw text, marker and all mutable receipt fields.
  const preimage = { protocolVersion: 1, provider: "agy-mcp", ownerSessionId: input.ownerSessionId,
    runId: input.runId, stepIndex: input.stepIndex, parentProviderJobId: input.parentProviderJobId,
    requestId: input.requestId, requestDigest: input.requestDigest, promptDigest: input.promptDigest,
    cwd: input.cwd, executionConfigDigest: input.executionConfigDigest, queue: input.queue };
  const operationDigest = sha256Utf8(canonicalJson(preimage));
  return { operationDigest, jobId: `job_pi_${operationDigest.slice(0, 32)}` };
}
export function assertJobId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^job_pi_[a-f0-9]{32}$/.test(id)) fail("invalid_job_id");
}
export function formatOperationMarker(digest: string): string {
  assertDigest(digest);
  return `AGY_PI_OP v1 ${digest.match(/.{16}/g)!.join(".")}`;
}
export function verifyOperationClaim(existing: OperationInput, incoming: OperationInput): void {
  if (canonicalJson(existing) !== canonicalJson(incoming)) fail("operation_claim_collision");
}
export function requireOperationMarker(prompt: string, digest: string): void {
  assertUtf8(prompt);
  const lines = prompt.split(/\r?\n/).filter(line => line.startsWith("AGY_PI_OP "));
  if (lines.length !== 1 || lines[0] !== formatOperationMarker(digest)) fail("operation_marker_mismatch");
}
