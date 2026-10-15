import test from "node:test";
import assert from "node:assert/strict";
import { validateExternalJobResult } from "pi-subagents/external-job-provider";
import { parseCheckpoint, checkpointState, buildCheckpointPrompt, formatCheckpointResult, type CheckpointKind } from "../src/checkpoint.js";
import { sha256Utf8, formatOperationMarker } from "../src/contracts.js";
import { projectModelEvidence } from "../src/model-evidence.js";
const fence = (obj: unknown) => `\`\`\`agy-checkpoint\n${JSON.stringify(obj)}\n\`\`\``;
const checkpoint = { version: 1, kind: "question", message: "Which behavior?", artifacts: [] };
for (const kind of ["question", "progress", "blocked", "completed"] as CheckpointKind[]) test(`parseCheckpoint ${kind}: turn success, separate assignment semantics`, () => {
  const parsed = parseCheckpoint(" \n" + fence({ ...checkpoint, kind }) + "\t");
  assert.equal(parsed.kind, kind);
  assert.equal(checkpointState(kind), kind === "question" || kind === "progress" ? "waiting_for_supervisor" : kind);
  const output = formatCheckpointResult({ checkpoint: parsed, latestRunId: "run-2", stepIndex: 3, assignmentId: "job_pi_" + "a".repeat(32), queueReceipts: [{ messageId: "guidance", state: "forwarded" }] });
  assert.ok(output.startsWith(`${kind} — ${checkpointState(kind)}\n\nWhich behavior?`));
  assert.match(output, /parent acceptance unrecorded/);
  assert.ok(output.includes('subagent({ action: "resume", id: "run-2", index: 3, message: "Supervisor reply" })'));
  assert.equal(output.includes("assignment incomplete"), kind !== "completed");
  assert.match(output, /forwarded/); assert.ok(!output.includes('"delivered"'));
});
test("checkpoint framing fails fixed diagnostic without rejected text", () => {
  for (const text of ["", "secret raw", fence(checkpoint) + "\n" + fence(checkpoint), "prose\n" + fence(checkpoint), "```agy-checkpoint\n{\n```", "```json\n{}\n```", fence({ ...checkpoint, unknown: "secret" }), fence({ ...checkpoint, version: 2 }), fence({ ...checkpoint, kind: "failed" }), fence({ ...checkpoint, message: " " }), fence({ ...checkpoint, artifacts: "path" }), fence({ ...checkpoint, artifacts: [null] }), fence({ ...checkpoint, message: "\ud800" }), fence({ ...checkpoint, artifacts: ["x\u0000y"] })]) {
    assert.throws(() => parseCheckpoint(text), e => e instanceof Error && !e.message.includes("secret"));
  }
});
test("checkpoint UTF-8 bounds are inclusive, never truncated", () => {
  parseCheckpoint(fence({ ...checkpoint, message: "é".repeat(24_000), artifacts: Array(16).fill("r".repeat(512)) }));
  for (const obj of [{ ...checkpoint, message: "é".repeat(24_001) }, { ...checkpoint, artifacts: Array(17).fill("ref") }, { ...checkpoint, artifacts: ["é".repeat(1025)] }, { ...checkpoint, message: "x".repeat(48_000), artifacts: Array(16).fill("x".repeat(2048)) }]) assert.throws(() => parseCheckpoint(fence(obj)));
  parseCheckpoint(fence({ ...checkpoint, artifacts: ["é".repeat(1024)] }));
  const small = fence(checkpoint);
  parseCheckpoint(small + " ".repeat(60_000 - Buffer.byteLength(small)));
  assert.throws(() => parseCheckpoint(small + " ".repeat(60_001 - Buffer.byteLength(small))), /response_oversize/);
});
test("untrusted artifact references remain text; no file/url/command interpretation", () => {
  const artifacts = ["https://never-contact.invalid", "/private/nonexistent", "$(touch never)", "../../not-an-artifact-path"];
  assert.deepEqual(parseCheckpoint(fence({ ...checkpoint, artifacts })).artifacts, artifacts);
  assert.equal(parseCheckpoint(fence({ ...checkpoint, message: "A literal ``` is data inside JSON." })).message, "A literal ``` is data inside JSON.");
});
test("checkpoint result bounds a 256 maximum-ID receipt history without losing checkpoint or exact included identities", () => {
  const cp = parseCheckpoint(fence({ ...checkpoint, message: "m".repeat(48_000), artifacts: ["a".repeat(2048), "b".repeat(2048), "c".repeat(2048), "d".repeat(2048)] }));
  const queueReceipts = Array.from({ length: 256 }, (_, i) => ({ messageId: "x".repeat(4093) + String(i).padStart(3, "0"), state: "forwarded" as const }));
  const record = { checkpoint: cp, latestRunId: "run-17", stepIndex: 0, assignmentId: "job_pi_" + "a".repeat(32), queueReceipts, modelEvidence: projectModelEvidence({ configured: "Gemini 3.8 Flash (Medium)", observed_cli_selectors: [] }) };
  const output = formatCheckpointResult(record);
  assert.doesNotThrow(() => validateExternalJobResult("agy-mcp", { providerJobId: record.assignmentId, state: "completed", output }));
  assert.ok(output.length < 1024 * 1024); assert.deepEqual(parseCheckpoint(output.slice(output.indexOf("```agy-checkpoint"))), cp); assert.ok(output.includes(cp.message));
  const line = output.split("\n\n").find(s => s.startsWith("Queue receipts (not consumption/compliance): "))!;
  const json = line.slice("Queue receipts (not consumption/compliance): ".length); const included = JSON.parse(json);
  assert.ok(Buffer.byteLength(json) <= 64 * 1024); assert.ok(included.length > 0 && included.length < queueReceipts.length);
  assert.deepEqual(included, queueReceipts.slice(0, included.length));
  assert.ok(output.includes(`${included.length} included; ${256 - included.length} omitted of 256`));
  assert.ok(output.includes('agy_subagent_control({ action: "status", runId: "run-17", index: 0 })'));
  assert.equal(formatCheckpointResult(record), output); assert.equal(queueReceipts.length, 256); assert.equal(queueReceipts[255].messageId.length, 4096);
});
test("checkpoint receipt display budget counts JSON escaping and UTF8, preserving every selected identity", () => {
  for (const prefix of ['"'.repeat(4093), "😀".repeat(1023)]) {
    const queueReceipts = Array.from({ length: 20 }, (_, i) => ({ messageId: prefix + String(i).padStart(3, "0"), state: "queued" as const }));
    const cp = parseCheckpoint(fence(checkpoint)); const assignmentId = "job_pi_" + "a".repeat(32);
    const output = formatCheckpointResult({ checkpoint: cp, latestRunId: "run-1", stepIndex: 0, assignmentId, queueReceipts });
    const line = output.split("\n\n").find(s => s.startsWith("Queue receipts (not consumption/compliance): "))!;
    const json = line.slice("Queue receipts (not consumption/compliance): ".length); const included = JSON.parse(json);
    assert.ok(Buffer.byteLength(json) <= 64 * 1024); assert.ok(included.length > 0 && included.length < 20);
    assert.deepEqual(included, queueReceipts.slice(0, included.length));
    assert.ok(output.includes(`${included.length} included; ${20 - included.length} omitted of 20`));
    assert.doesNotThrow(() => validateExternalJobResult("agy-mcp", { providerJobId: assignmentId, state: "completed", output }));
  }
});
test("checkpoint validates omitted receipt identities instead of hiding invalid input behind the display budget", () => {
  const queueReceipts = [...Array.from({ length: 20 }, (_, i) => ({ messageId: "x".repeat(4093) + String(i).padStart(3, "0"), state: "forwarded" as const })), { messageId: "invalid\nidentity", state: "queued" as const }];
  assert.throws(() => formatCheckpointResult({ checkpoint: parseCheckpoint(fence(checkpoint)), latestRunId: "run-1", stepIndex: 0, assignmentId: "job_pi_" + "a".repeat(32), queueReceipts }), /invalid_result_identity/);
});
test("formatted evidence is outside the strict four-key checkpoint, including fence-like model data", () => {
  const cp = parseCheckpoint(fence(checkpoint));
  const record = { checkpoint: cp, latestRunId: "run-1", stepIndex: 0, assignmentId: "job_pi_" + "a".repeat(32), queueReceipts: [] };
  for (const configured of ["Gemini 3.8 Flash (Medium)", "literal ```agy-checkpoint"]) {
    const output = formatCheckpointResult({ ...record, modelEvidence: projectModelEvidence({ configured, observed_cli_selectors: [] }) });
    assert.deepEqual(parseCheckpoint(output.slice(output.indexOf("```agy-checkpoint"))), cp);
    assert.ok(output.indexOf("Model: ") < output.indexOf("```agy-checkpoint"));
    assert.match(output, /effective identity: unavailable/); assert.match(output, /assignment incomplete/);
  }
  assert.match(formatCheckpointResult({ ...record, modelEvidence: projectModelEvidence(null) }), /Model: unknown; thinking: unknown/);
});

test("buildCheckpointPrompt preserves source bytes and frames immutable queue separately", () => {
  const prompt = "system\r\n任务 😀  \n";
  const digest = sha256Utf8("operation");
  const message = "reply\r\n exact 😀";
  const result = buildCheckpointPrompt({ prompt, operationDigest: digest, queue: [{ sequence: 1, messageId: "m1", message, contentDigest: sha256Utf8(message) }] });
  assert.ok(Buffer.from(result).subarray(0, Buffer.byteLength(prompt)).equals(Buffer.from(prompt)));
  assert.equal(result.split("\n").filter(x => x.startsWith("AGY_PI_OP ")).length, 1);
  assert.ok(result.includes(formatOperationMarker(digest)));
  assert.match(result, /do not edit files/);
  assert.match(result, /explicit supervisor continuation/);
  assert.throws(() => buildCheckpointPrompt({ prompt: "original\rAGY_PI_OP collision", operationDigest: digest, queue: [] }), /reserved_marker_collision/);
  assert.throws(() => buildCheckpointPrompt({ prompt, operationDigest: digest, queue: [{ sequence: 1, messageId: "m", message: "AGY_PI_OP collision", contentDigest: sha256Utf8("AGY_PI_OP collision") }] }), /reserved_marker_collision/);
  assert.throws(() => buildCheckpointPrompt({ prompt: "x".repeat(256_000), operationDigest: digest, queue: [] }), /prompt_oversize/);
});
