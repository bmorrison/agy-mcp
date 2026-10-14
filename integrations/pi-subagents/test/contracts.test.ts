import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Utf8, validateOwnerInputDigests, deriveOperation, formatOperationMarker, requireOperationMarker, verifyOperationClaim, validateExecutionConfig, type OperationInput, type ExecutionConfig } from "../src/contracts.js";

export const config: ExecutionConfig = { backend: "agy", mode: "review", sandbox: true, allow_write: false, worktree: false, output_protocol: "raw", timeout: 300, model: null };
const input: OperationInput = { ownerSessionId: "owner", runId: "run", stepIndex: 0, parentProviderJobId: null, requestId: null, requestDigest: null, promptDigest: sha256Utf8("task\r\n😀"), cwd: "/fixture", executionConfigDigest: sha256Utf8(canonicalJson(config)), queue: [] };
test("canonicalJson pinned JSON/UTF-8 vectors, scalars and ordering", () => {
  assert.equal(canonicalJson({ z: [3, "é", null], a: { b: true, a: "\n" } }), '{"a":{"a":"\\n","b":true},"z":[3,"é",null]}');
  assert.equal(sha256Utf8("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Utf8("😀"), "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9");
  assert.notEqual(sha256Utf8("é"), sha256Utf8("e\u0301"));
  assert.notEqual(sha256Utf8("a\r\n"), sha256Utf8("a\n"));
});
test("canonicalJson rejects non-JSON, sparse arrays, cycles, getters, unpaired surrogates", () => {
  const cycle: unknown[] = []; cycle.push(cycle);
  const getterArray = [1]; Object.defineProperty(getterArray, "0", { get: () => 1 });
  const symbolArray = [1]; Object.defineProperty(symbolArray, Symbol("non-JSON"), { value: 2 });
  for (const bad of [undefined, NaN, Infinity, BigInt(1), () => 0, new Date(), new Map(), [undefined], Array(2), cycle, getterArray, symbolArray, { x: undefined }, { get x() { return 1; } }, { x: "\ud800" }, "\udfff"]) assert.throws(() => canonicalJson(bad));
  assert.throws(() => sha256Utf8("\ud800"), /invalid_utf8/);
});
test("validateOwnerInputDigests retains independent opaque raw-reply digest", () => {
  const prompt = "combined system\nSupervisor raw reply";
  const requestDigest = sha256Utf8("Supervisor raw reply");
  const owner = { prompt, promptDigest: sha256Utf8(prompt), requestDigest, requestId: `follow-up-${requestDigest.slice(0, 48)}` };
  assert.notEqual(requestDigest, owner.promptDigest);
  assert.deepEqual(validateOwnerInputDigests(owner, true), { promptDigest: owner.promptDigest, requestDigest, requestId: owner.requestId });
  assert.throws(() => validateOwnerInputDigests({ ...owner, promptDigest: requestDigest }, true), /prompt_digest_mismatch/);
  assert.throws(() => validateOwnerInputDigests({ ...owner, requestId: "follow-up-wrong" }, true), /request_identity_mismatch/);
  assert.throws(() => validateOwnerInputDigests({ ...owner, requestDigest: requestDigest.toUpperCase() }, true));
  assert.deepEqual(validateOwnerInputDigests({ prompt, promptDigest: sha256Utf8(prompt) }), { promptDigest: sha256Utf8(prompt), requestId: null, requestDigest: null });
  assert.throws(() => validateOwnerInputDigests(owner));
});
test("deriveOperation has exact mandatory preimage, 39-char id, queue-only operation domain", () => {
  const actual = deriveOperation(input);
  assert.equal(actual.operationDigest, "581d40e35aea9521bb8baf4b1563ca07b11ad88047b9685f4049ab6853dd452c"); // Independent Python sorted-JSON/UTF-8 vector.
  assert.equal(actual.operationDigest, sha256Utf8(canonicalJson({ protocolVersion: 1, provider: "agy-mcp", ...input })));
  assert.equal(actual.jobId, `job_pi_${actual.operationDigest.slice(0, 32)}`);
  assert.equal(actual.jobId.length, 39);
  const queued = { ...input, queue: [{ sequence: 1, messageId: "m1", contentDigest: sha256Utf8("guidance") }] };
  assert.notEqual(deriveOperation(queued).operationDigest, actual.operationDigest);
  assert.equal(queued.promptDigest, input.promptDigest);
  assert.throws(() => deriveOperation({ ...queued, queue: [...queued.queue, { sequence: 0, messageId: "m2", contentDigest: sha256Utf8("two") }] }));
  assert.throws(() => deriveOperation({ ...input, parentProviderJobId: undefined } as unknown as OperationInput));
});
test("marker excludes itself, full continuous owner hashes, and matches standalone exactly once", () => {
  const { operationDigest } = deriveOperation(input);
  const marker = formatOperationMarker(operationDigest);
  assert.match(marker, /^AGY_PI_OP v1 [a-f0-9]{16}(\.[a-f0-9]{16}){3}$/);
  assert.ok(!marker.includes(operationDigest));
  requireOperationMarker(`original\n${marker}\n`, operationDigest);
  for (const text of [marker + "x", marker + "\n" + marker, "prefix " + marker, "missing"]) assert.throws(() => requireOperationMarker(text, operationDigest));
});
test("simulated 128-bit short-id collision refuses full immutable claim; no replacement", () => {
  const existing = { ...input };
  const shortId = deriveOperation(input).jobId;
  // Force the incoming claim onto an occupied short-id slot, simulating a
  // truncated hash collision independently of the full SHA-256 preimage.
  const claims = new Map([[shortId, existing]]);
  verifyOperationClaim(claims.get(shortId)!, input);
  assert.throws(() => verifyOperationClaim(claims.get(shortId)!, { ...input, cwd: "/different" }), /operation_claim_collision/);
  assert.equal(claims.size, 1); assert.deepEqual(claims.get(shortId), existing);
});
test("frozen authority and timeout 1..300 only", () => {
  validateExecutionConfig(config); validateExecutionConfig({ ...config, timeout: 1 });
  for (const timeout of [0, 301, 900, 1.5]) assert.throws(() => validateExecutionConfig({ ...config, timeout }));
  assert.throws(() => validateExecutionConfig({ ...config, allow_write: true } as unknown as ExecutionConfig));
  assert.throws(() => validateExecutionConfig({ ...config, extra: 1 } as ExecutionConfig));
});
