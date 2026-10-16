import test from "node:test";
import assert from "node:assert/strict";
import { validateExternalJobResult } from "pi-subagents/external-job-provider";
import fs from "node:fs/promises";
import path from "node:path";
import { providerFixture, OWNER } from "./support/provider-fixture.js";
import { createAgyProvider, resolveExecutionConfig } from "../src/provider.js";
import { AssignmentStore } from "../src/state.js";
import { AgyMcpClient } from "../src/mcp-client.js";
import { withProviderDeadline } from "../src/deadline.js";
import { requireOperationMarker, sha256Utf8 } from "../src/contracts.js";


test("wrapper evidence is exact-job display data; native handles and caller mutations cannot carry it", async t => {
  const f = await providerFixture(t, "running"); const file = path.join(f.root, "model-evidence.json");
  await fs.writeFile(file, JSON.stringify({ configured: "Gemini 3.8 Flash (Medium)", observed_cli_selectors: [] }));
  const first = await f.provider.start(f.input());
  assert.deepEqual(Object.keys(first).sort(), ["providerJobId", "state"]);
  const a = (await f.provider.control({ action: "status", runId: "run-1" }, OWNER)).status;
  assert.equal(a.executionMetadata?.thinking?.value, "medium"); assert.equal(a.executionMetadata?.model?.source, "configured");
  a.modelEvidence!.observedCliSelectors.push("caller mutation"); a.executionMetadata!.thinking!.value = "caller mutation";
  await fs.writeFile(file, JSON.stringify({ configured: "Other label", observed_cli_selectors: [] }));
  const second = await f.provider.start(f.input("other"));
  assert.notEqual(second.providerJobId, first.providerJobId);
  const before = (await f.rows()).filter(row => row.name).length;
  const queue = await f.provider.control({ action: "queue", runId: "run-1", messageId: "safe-id", message: "private guidance never exposed" }, OWNER);
  assert.equal(queue.status.executionMetadata?.thinking?.value, "medium"); assert.deepEqual(queue.status.modelEvidence?.observedCliSelectors, []);
  assert.ok(!JSON.stringify(queue).includes("private guidance")); assert.equal((await f.rows()).filter(row => row.name).length, before);
  const b = (await f.provider.control({ action: "status", runId: "other" }, OWNER)).status;
  assert.equal(b.executionMetadata?.model?.value, "Other label"); assert.equal(b.executionMetadata?.thinking, undefined);
  assert.deepEqual(Object.keys(await f.provider.result(second.providerJobId)).sort(), ["providerJobId", "state"]);
});

test("new complete/conflicting/unavailable evidence replaces the entire same-job display snapshot", async t => {
  const f = await providerFixture(t, "running"); const file = path.join(f.root, "model-evidence.json");
  const write = (value: unknown) => fs.writeFile(file, JSON.stringify(value));
  await write({ observed_cli_selectors: ["gemini-3.1-pro-low"] }); await f.provider.start(f.input());
  const status = async () => (await f.provider.control({ action: "status", runId: "run-1" }, OWNER)).status;
  assert.equal((await status()).executionMetadata?.thinking?.value, "low");
  await write({ observed_cli_selectors: ["gemini-3.1-pro-low", "gemini-3.8-flash-high"] });
  const conflict = await status(); assert.equal(conflict.executionMetadata, null); assert.equal(conflict.modelEvidence?.observedCliSelectors.length, 2);
  await write({ configured: "Unknown effort", observed_cli_selectors: [] });
  const modelOnly = await status(); assert.equal(modelOnly.executionMetadata?.model?.value, "Unknown effort"); assert.equal(modelOnly.executionMetadata?.thinking, undefined);
  await write(null);
  const missing = await status(); assert.equal(missing.executionMetadata, null); assert.equal(missing.modelEvidence?.configured, null);
});

test("evidence is never admitted before mandatory record correlation succeeds", async t => {
  const f = await providerFixture(t, "badMarker");
  await fs.writeFile(path.join(f.root, "model-evidence.json"), JSON.stringify({ configured: "Foreign label", observed_cli_selectors: [] }));
  const set = Map.prototype.set; let admissions = 0;
  Map.prototype.set = function (key, value) {
    if (typeof key === "string" && key.startsWith("job_pi_") && value?.effectiveSource === "unavailable") admissions++;
    return set.call(this, key, value);
  };
  try { await assert.rejects(f.provider.start(f.input()), /operation_marker_mismatch/); assert.equal(admissions, 0); }
  finally { Map.prototype.set = set; }
  assert.equal((await f.rows()).filter(row => row.name === "agy_start").length, 1);
});

test("saved evidence text is immutable while a cold terminal control lookup omits unobserved fields", async t => {
  const f = await providerFixture(t);
  await fs.writeFile(path.join(f.root, "model-evidence.json"), JSON.stringify({ configured: "Gemini 3.8 Flash (Medium)", observed_cli_selectors: [] }));
  const h = await f.provider.start(f.input()); const result = await f.provider.result(h.providerJobId);
  assert.ok(result.output!.includes("thinking: medium [configured, label-derived]"));
  assert.ok(!("executionMetadata" in result)); assert.ok(!("modelEvidence" in result));
  const cold = createAgyProvider({ store: new AssignmentStore(f.store.root, OWNER, null), client: f.createClient(), env: f.env });
  const count = (await f.rows()).filter(row => row.name).length;
  const status = (await cold.control({ action: "status", runId: "run-1" }, OWNER)).status;
  assert.ok(!("executionMetadata" in status)); assert.ok(!("modelEvidence" in status));
  assert.equal((await cold.result(h.providerJobId)).output, result.output); assert.equal((await f.rows()).filter(row => row.name).length, count);
  await f.client.close();
});

test("metadata performs zero extra MCP operations: paired two-turn sequences have identical complete wire arguments", async t => {
  const plain = await providerFixture(t); const enriched = await providerFixture(t);
  await fs.writeFile(path.join(enriched.root, "model-evidence.json"), JSON.stringify({ configured: "Gemini 3.8 Flash (Medium)", observed_cli_selectors: [] }));
  for (const f of [plain, enriched]) {
    const first = await f.provider.start({ ...f.input(), cwd: plain.root }); await f.provider.result(first.providerJobId);
    await f.provider.control({ action: "queue", runId: "run-1", messageId: "same-guidance", message: "same private guidance" }, OWNER);
    const second = await f.provider.followUp({ ...f.follow(first.providerJobId), cwd: plain.root }); await f.provider.result(second.providerJobId);
    await f.provider.control({ action: "status", runId: "run-1" }, OWNER);
    assert.equal((await f.rows()).filter(row => row.name === "agy_start").length, 2);
  }
  const operations = async (f: typeof plain) => (await f.rows()).filter(row => typeof row.name === "string");
  assert.deepEqual(await operations(plain), await operations(enriched));
});

test("display cache clears during shutdown even when the owning client close rejects", async t => {
  const f = await providerFixture(t); const h = await f.provider.start(f.input()); await f.provider.result(h.providerJobId);
  const clear = Map.prototype.clear; const close = f.client.close; let cleared = 0;
  Map.prototype.clear = function () { if (this.get(h.providerJobId)?.effectiveSource === "unavailable") cleared++; return clear.call(this); };
  f.client.close = async () => { await close.call(f.client); throw new Error("fixture_close_failure"); };
  try { await assert.rejects(f.provider.shutdown(), /fixture_close_failure/); assert.equal(cleared, 1); }
  finally { Map.prototype.clear = clear; f.client.close = close; }
});

test("provider.ts actual committed queued snapshot frames explicit resume; immutable cache and completed restart", async t => {
  const f = await providerFixture(t); const first = await f.provider.start(f.input());
  const question = await f.provider.result(first.providerJobId); assert.equal(question.state, "completed"); assert.match(question.output!, /assignment incomplete/);
  const receipt = await f.provider.control({ action: "queue", runId: "run-1", messageId: "m1", message: "sensitive queued guidance" }, OWNER);
  assert.equal(receipt.receipt?.state, "queued"); assert.ok(!JSON.stringify(receipt).includes("sensitive queued"));
  const calls = (await f.rows()).filter(r => r.name === "agy_start"); assert.equal(calls.length, 1);
  const input = f.follow(first.providerJobId); const second = await f.provider.followUp!(input);
  await withProviderDeadline(async scope => {
    const turn = f.store.getTurn(second.providerJobId, scope); const result = await f.client.result(second.providerJobId, scope);
    requireOperationMarker(result.record.request.prompt as string, turn.operationDigest);
    assert.ok((result.record.request.prompt as string).includes("sensitive queued guidance"));
    assert.equal(turn.queueSnapshot.length, 1); assert.equal(turn.claim.requestDigest, sha256Utf8("raw supervisor reply")); assert.notEqual(turn.claim.requestDigest, turn.claim.promptDigest);
    assert.equal(turn.expectedConversation, "12345678-1234-4234-8234-123456789abc");
  });
  const final = await f.provider.result(second.providerJobId); assert.match(final.output!, /forwarded/); assert.ok(!final.output!.includes("sensitive queued"));
  assert.equal((await f.provider.result(first.providerJobId)).output, question.output);
  assert.equal((await f.provider.followUp!(input)).providerJobId, second.providerJobId);
  const old = await f.provider.control({ action: "status", runId: "run-1" }, OWNER); assert.deepEqual(old.requested, { runId: "run-1", index: 0 }); assert.deepEqual(old.latest, { runId: "run-2", index: 0 });
  await assert.rejects(f.provider.control({ action: "cancel", runId: "run-1" }, OWNER), /stale_cancel_target/);
  await assert.rejects(f.provider.control({ action: "queue", runId: "run-2", messageId: "late", message: "late" }, OWNER), /queue_target_closed/);
  await f.client.close();
  const reopened = new AssignmentStore(f.store.root, OWNER, null); const client = new AgyMcpClient({ ownerDirectory: reopened.ownerDirectory });
  const restarted = createAgyProvider({ store: reopened, client, env: f.env });
  assert.equal((await restarted.reattach!(second.providerJobId)).state, "completed"); assert.equal((await restarted.result(first.providerJobId)).output, question.output); assert.equal(client.lifecycle().connected, false);
  assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 2);
});
for (const phase of ["acknowledged", "dispatch_unknown"] as const) for (const action of ["reattach", "status", "control"] as const) test(`PR5 cold recovery: ${phase} ${action} rebuilds cwd evidence without redispatch or adopting ownership`, async t => {
  const f = await providerFixture(t, "persistRunning"); const first = await f.provider.start(f.input());
  if (phase === "dispatch_unknown") await withProviderDeadline(async scope => {
    const turn = f.store.getTurn(first.providerJobId, scope);
    f.store.settleTurn(turn.jobId, { phase, semanticState: "execution_unknown", checkpoint: null, output: null, conversationId: turn.conversationId, errorCode: "test_lost_response", evidence: turn.evidence }, scope);
  });
  await f.client.close();
  const store = new AssignmentStore(f.store.root, OWNER, null); const client = f.createClient();
  const recovered = createAgyProvider({ store, client, env: f.env });
  if (action === "control") assert.equal((await recovered.control({ action: "status", runId: "run-1" }, OWNER)).status.phase, "acknowledged");
  else assert.equal((await recovered[action](first.providerJobId)).state, "running");
  assert.notEqual(client.lifecycle().generation, f.client.lifecycle().generation);
  assert.equal(client.ownership(first.providerJobId), null);
  await assert.rejects(recovered.control({ action: "cancel", runId: "run-1" }, OWNER), /lease_not_owned|mcp_cancel_not_owned/);
  await withProviderDeadline(async scope => { await fs.access(path.join(store.ownerDirectory, `${first.providerJobId}.lease`)); });
  const rows = await f.rows(); assert.equal(rows.filter(r => r.name === "agy_start").length, 1);
  assert.equal(rows.filter(r => r.name === "agy_cancel").length, 0);
  assert.equal(rows.filter(r => r.event === "fixture_process").length, 2);
  assert.ok(rows.filter(r => r.name === "agy").every(r => r.dry_run === true));
});
for (const mode of ["badCwd", "writeMode"] as const) test(`PR5 cold recovery: ${mode} fails closed with the exact unresolved lease retained`, async t => {
  const f = await providerFixture(t, "persistRunning"); const first = await f.provider.start(f.input()); await f.client.close();
  const store = new AssignmentStore(f.store.root, OWNER, null); const client = f.createClient(mode);
  const recovered = createAgyProvider({ store, client, env: f.env });
  await assert.rejects(recovered.reattach(first.providerJobId), new RegExp(mode === "badCwd" ? "cwd_mismatch" : "command_capability_missing"));
  await withProviderDeadline(async scope => { assert.equal(store.getTurn(first.providerJobId, scope).phase, "dispatch_unknown"); await fs.access(path.join(store.ownerDirectory, `${first.providerJobId}.lease`)); });
  assert.equal(client.ownership(first.providerJobId), null);
  assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 1);
  assert.equal((await f.rows()).filter(r => r.name === "agy_cancel").length, 0);
});
test("PR5 cold recovery: changed canonical cwd cannot rebuild projection or send a probe", async t => {
  const f = await providerFixture(t, "persistRunning"); const cwd = path.join(f.root, "workspace"); await fs.mkdir(cwd);
  const first = await f.provider.start({ ...f.input(), cwd }); await f.client.close();
  const other = path.join(f.root, "other"); await fs.mkdir(other); await fs.rmdir(cwd); await fs.symlink(other, cwd);
  const before = (await f.rows()).length; const store = new AssignmentStore(f.store.root, OWNER, null); const client = f.createClient();
  const recovered = createAgyProvider({ store, client, env: f.env });
  await assert.rejects(recovered.reattach(first.providerJobId), /cwd_mismatch/);
  assert.equal((await f.rows()).length, before); assert.equal(client.lifecycle().connected, false);
  await fs.access(path.join(store.ownerDirectory, `${first.providerJobId}.lease`));
});

test("provider.ts 256 maximum-length lifetime IDs deliver bounded immutable output and complete bodyless control history", async t => {
  const f = await providerFixture(t, "questionOnly"); let runId = "run-1"; let h = await f.provider.start(f.input(runId));
  const originalId = h.providerJobId; const originalOutput = (await f.provider.result(originalId)).output;
  const ids: string[] = []; let output = "";
  for (let batch = 0; batch < 16; batch++) {
    for (let index = 0; index < 16; index++) {
      const messageId = "x".repeat(4093) + String(batch * 16 + index).padStart(3, "0"); ids.push(messageId);
      await f.provider.control({ action: "queue", runId, messageId, message: "private bounded guidance" }, OWNER);
    }
    const sourceRunId = runId; runId = `run-${batch + 2}`;
    h = await f.provider.followUp(f.follow(h.providerJobId, runId, sourceRunId));
    const result = await f.provider.result(h.providerJobId); assert.equal(result.state, "completed");
    assert.doesNotThrow(() => validateExternalJobResult("agy-mcp", result)); output = result.output!;
  }
  const status = await f.provider.control({ action: "status", runId: "run-1" }, OWNER);
  assert.deepEqual(status.latest, { runId: "run-17", index: 0 }); assert.equal(status.status!.receipts.length, 256);
  assert.deepEqual(status.status!.receipts.map(r => r.messageId), ids); assert.ok(status.status!.receipts.every(r => r.state === "forwarded" && !Object.hasOwn(r, "message")));
  assert.ok(!JSON.stringify(status).includes("private bounded guidance")); assert.ok(output.length < 1024 * 1024);
  assert.match(output, /included; \d+ omitted of 256/); assert.match(output, /assignment incomplete/);
  assert.equal((await f.provider.result(h.providerJobId)).output, output); assert.equal((await f.provider.result(originalId)).output, originalOutput);
  assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 17);
});
for (const [mode, code] of [["invalidCheckpoint", "checkpoint_framing"], ["initOnly", "conversation_unobserved"], ["conversationMismatch", "conversation_mismatch"], ["failed", "backend_failed"], ["upstream_error", "backend_upstream_error"], ["cancelled", "backend_cancelled"]]) test(`provider.ts terminal ${mode} releases only proved exact local lease`, async t => {
  const f = await providerFixture(t, mode); const h = await f.provider.start(f.input()); const result = await f.provider.result(h.providerJobId);
  assert.equal(result.failureCode, code); assert.equal(result.state, mode === "cancelled" ? "stopped" : "failed");
  await withProviderDeadline(async scope => { const turn = f.store.getTurn(h.providerJobId, scope); assert.equal(turn.phase, "terminal"); await assert.rejects(fs.access(path.join(f.store.ownerDirectory, `${turn.assignmentId}.lease`))); });
  await assert.rejects(f.provider.followUp!(f.follow(h.providerJobId))); assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 1);
});
for (const [mode, code] of [["badMarker", "operation_marker_mismatch"], ["badConfig", "mcp_record_uncorrelated"], ["badCwd", "cwd_mismatch"], ["missingStatus", "mcp_tool_rejected"], ["malformedStatus", "mcp_record_schema"]]) test(`provider.ts ${mode} preserves unresolved exact lease and cannot replay inference`, async t => {
  const f = await providerFixture(t, mode); await assert.rejects(f.provider.start(f.input()), new RegExp(code));
  await withProviderDeadline(async scope => { const turn = f.store.resolveRunTarget("run-1", 0, scope).latest; assert.equal(turn.phase, "dispatch_unknown"); await fs.access(path.join(f.store.ownerDirectory, `${turn.assignmentId}.lease`)); });
  await assert.rejects(f.provider.start(f.input())); assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 1);
});
for (const [mode, code] of [["badFollowUpCwd", "cwd_mismatch"], ["badFollowUpConversation", "conversation_lineage_mismatch"]]) test(`provider.ts ${mode} cannot acknowledge or forward an uncorrelated follow-up`, async t => {
  const f = await providerFixture(t, mode); const first = await f.provider.start(f.input()); await f.provider.result(first.providerJobId);
  await f.provider.control({ action: "queue", runId: "run-1", messageId: "reserved", message: "private queued guidance" }, OWNER);
  await assert.rejects(f.provider.followUp(f.follow(first.providerJobId)), new RegExp(code));
  await withProviderDeadline(async scope => {
    const turn = f.store.resolveRunTarget("run-2", 0, scope).latest;
    assert.equal(turn.phase, "dispatch_unknown");
    assert.equal(f.store.getQueueReceipts(turn.jobId, scope)[0].state, "dispatch_unknown");
    await fs.access(path.join(f.store.ownerDirectory, `${turn.assignmentId}.lease`));
  });
  await assert.rejects(f.provider.followUp(f.follow(first.providerJobId)));
  assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 2);
});
test("provider.ts preadmission invalid task/options/owner/digest/config/cwd never creates state or dispatches", async t => {
  const f = await providerFixture(t);
  for (const change of [{ prompt: "AGY_PI_OP collision", promptDigest: sha256Utf8("AGY_PI_OP collision") }, { prompt: "\ud800" }, { options: { model: "private" } }, { sessionId: "foreign" }, { promptDigest: "a".repeat(64) }, { cwd: "relative" }]) await assert.rejects(f.provider.start({ ...f.input(), ...change }));
  await assert.rejects(fs.access(f.store.ownerDirectory)); assert.equal((await f.rows()).length, 0);
  for (const timeout of ["301", "900", "0", "1.5"]) assert.throws(() => resolveExecutionConfig({}, { AGY_PI_TURN_TIMEOUT_SECONDS: timeout }));
  assert.equal(resolveExecutionConfig({}, { AGY_PI_TURN_TIMEOUT_SECONDS: "300" }).timeout, 300);
});
test("provider.ts duplicate/competing/stale source/config/cwd/owner refuse without start", async t => {
  const f = await providerFixture(t); const h = await f.provider.start(f.input()); await f.provider.result(h.providerJobId);
  for (const change of [{ sourceRunId: "wrong" }, { sourceStepIndex: 1 }, { sessionId: "foreign" }, { cwd: path.dirname(f.root) }]) await assert.rejects(f.provider.followUp!({ ...f.follow(h.providerJobId), ...change }));
  f.env.AGY_PI_MODEL = "changed"; await assert.rejects(f.provider.followUp!(f.follow(h.providerJobId)), /frozen_context_changed/); f.env.AGY_PI_MODEL = "fixture-model";
  const results = await Promise.allSettled([f.provider.followUp!(f.follow(h.providerJobId)), f.provider.followUp!(f.follow(h.providerJobId, "competing"))]); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 2);
});
test("provider.ts independently expiring finalization waiters share original full result flight", async t => {
  let now = 0; const budgets = { clock: () => now, totalMs: 90_000, settlementMs: 5000 };
  const f = await providerFixture(t, "holdResult", budgets); const h = await f.provider.start(f.input());
  let statusResponses = 0; let resultCalls = 0;
  const status = f.client.status.bind(f.client); const result = f.client.result.bind(f.client);
  f.client.status = async (...args) => { const response = await status(...args); statusResponses++; return response; };
  f.client.result = (...args) => { resultCalls++; return result(...args); };
  const until = async (check: () => Promise<boolean>) => {
    const end = performance.now() + 1000;
    while (!await check()) { assert.ok(performance.now() < end, "real result boundary must be reached"); await new Promise(r => setTimeout(r, 5)); }
  };
  const first = f.provider.result(h.providerJobId);
  await until(async () => (await f.rows()).some(r => r.event === "boundary" && r.name === "result"));
  budgets.totalMs = 10_000; budgets.settlementMs = 1000;
  const second = f.provider.result(h.providerJobId);
  const outcomes = Promise.allSettled([first, second]); // Track rejection even if a readiness boundary fails.
  await until(async () => statusResponses === 2);
  // The resolved status wrappers' microtasks resume both real provider observers.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(resultCalls, 1, "both admitted observers join one held finalization");
  now = 9500; // Monotonic: only the later, shorter observer has expired.
  await fs.writeFile(path.join(f.root, "release-result"), "release");
  const results = await outcomes; assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") assert.match(String(results[1].reason), /provider_deadline/);
  assert.equal((await f.rows()).filter(r => r.name === "agy_result").length, 1);
  assert.equal((await f.provider.result(h.providerJobId)).state, "completed");
});
test("provider.ts expired delayed ACK preserves unknown and lease; exact recovery never adopts cancel", async t => {
  let now = 0; const f = await providerFixture(t, "delayStart", { clock: () => now });
  await withProviderDeadline(scope => f.client.connect(scope));
  const start = f.client.startTurn.bind(f.client);
  f.client.startTurn = async (input, scope) => {
    const attempt = start(input, scope); void attempt.catch(() => {}); // Track the pending physical call immediately.
    const end = performance.now() + 1000;
    while (!(await f.rows()).some(r => r.name === "agy_start")) { assert.ok(performance.now() < end); await new Promise(r => setTimeout(r, 5)); }
    now = 85001; // Expire the ORIGINAL work scope only after real physical dispatch.
    assert.throws(() => scope.assertAdmission(), /provider_deadline/);
    return attempt;
  };
  await assert.rejects(f.provider.start(f.input()), /start_dispatch_unknown|provider_deadline/);
  // Observe the actual late backend record without granting cancellation ownership.
  await withProviderDeadline(async scope => {
    const id = f.store.resolveRunTarget("run-1", 0, scope).latest.jobId; const end = performance.now() + 2000;
    for (;;) {
      try { await f.client.status(id, scope); break; } catch { assert.ok(performance.now() < end); await scope.wait(new Promise(r => setTimeout(r, 5))); }
    }
  });
  await withProviderDeadline(async scope => { const target = f.store.resolveRunTarget("run-1", 0, scope); assert.equal(target.latest.phase, "dispatch_unknown"); await fs.access(path.join(f.store.ownerDirectory, `${target.latest.assignmentId}.lease`)); });
  await assert.rejects(f.provider.control({ action: "cancel", runId: "run-1" }, OWNER), /mcp_cancel_not_owned/);
  assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 1); assert.equal((await f.rows()).filter(r => r.name === "agy_cancel").length, 0);
});
test("provider.ts cancel requires local acquisition and live decoded owning ACK; records signal separately", async t => {
  const f = await providerFixture(t, "cancelDelayed"); const h = await f.provider.start(f.input());
  const ack = await f.provider.control({ action: "cancel", runId: "run-1" }, OWNER); assert.equal(ack.cancellation?.signalled, true); assert.equal(ack.cancellation?.terminalCorrelated, false); assert.equal(ack.status.evidence.cancelSignalled, true); assert.equal(ack.status.phase, "acknowledged");
  const foreignStore = new AssignmentStore(f.store.root, OWNER, null); const foreign = createAgyProvider({ store: foreignStore, client: f.client, env: f.env });
  await assert.rejects(foreign.control({ action: "cancel", runId: "run-1" }, OWNER), /lease_not_owned/);
  await assert.rejects(f.provider.control({ action: "status", runId: "unknown" }, OWNER), /run_target_missing/);
  await assert.rejects(f.provider.control({ action: "status", runId: "run-1" }, "foreign"), /owner_mismatch/);
  assert.equal((await f.rows()).filter(r => r.name === "agy_cancel").length, 1); assert.equal((await f.provider.status(h.providerJobId)).state, "running");
});
test("provider.ts shutdown work and total windows share the exact first-entry clock epoch", async t => {
  let first = true; const clock = () => first ? (first = false, 0) : 15_001;
  const f = await providerFixture(t, "normal", { clock });
  await assert.rejects(f.provider.shutdown(), /provider_deadline/); assert.deepEqual(await f.rows(), []);
});
test("provider.ts shutdown is one lifetime, lazy, full correlated cancellation with optional signal preserved", async t => {
  const f = await providerFixture(t, "running"); await f.provider.start(f.input()); await f.provider.start(f.input("run-other"));
  const a = f.provider.shutdown(); const b = f.provider.shutdown(); assert.equal(a, b); await a;
  await withProviderDeadline(async scope => { const active = f.store.listActiveTurns(scope); assert.equal(active.length, 0); const turn = f.store.resolveRunTarget("run-1", 0, scope).latest; assert.equal(turn.evidence.cancelSignalled, true); assert.equal(turn.semanticState, "cancelled"); });
  assert.equal((await f.rows()).filter(r => r.name === "agy_cancel").length, 2); await assert.rejects(f.provider.start(f.input("late")), /provider_shutting_down/);
  const lazy = await providerFixture(t); await lazy.provider.shutdown(); await assert.rejects(fs.access(lazy.store.ownerDirectory)); assert.equal((await lazy.rows()).length, 0);
});

test("provider.ts exhausted predispatch probe settles local no-dispatch failure and no late inference", async t => {
  const f = await providerFixture(t, "hold-probe", { totalMs: 180, settlementMs: 40 });
  await withProviderDeadline(scope => f.client.connect(scope)); const attempt = f.provider.start(f.input());
  await assert.rejects(attempt, /provider_deadline|mcp_request_failed/);
  await fs.writeFile(path.join(f.root, "release-probe"), "release"); await new Promise(r => setTimeout(r, 50));
  assert.equal((await f.rows()).filter(r => r.name === "agy_start").length, 0);
  await withProviderDeadline(async scope => { const turn = f.store.resolveRunTarget("run-1", 0, scope).latest; assert.equal(turn.phase, "terminal"); assert.equal(turn.evidence.backendStatus, null); await assert.rejects(fs.access(path.join(f.store.ownerDirectory, `${turn.assignmentId}.lease`))); });
});
test("provider.ts global shutdown budget several signal-only jobs preserves unknown leases/ACK, not close-as-kill", async t => {
  const f = await providerFixture(t, "cancelDelayed"); await f.provider.start(f.input()); await f.provider.start(f.input("other"));
  const start = performance.now(); await f.provider.shutdown(); assert.ok(performance.now() - start < 15000);
  await withProviderDeadline(async scope => {
    const active = f.store.listActiveTurns(scope); assert.equal(active.length, 2);
    for (const item of active) { assert.equal(item.semanticState, "execution_unknown"); assert.equal(item.evidence.cancelSignalled, true); await fs.access(path.join(f.store.ownerDirectory, `${item.assignmentId}.lease`)); }
  });
  assert.equal((await f.rows()).filter(r => r.name === "agy_cancel").length, 2); assert.equal(f.client.lifecycle().closed, true);
});
