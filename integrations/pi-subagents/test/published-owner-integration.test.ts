import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeAdversarialFixture } from "./support/native-adversarial-fixture.js";
import { AssignmentStore } from "../src/state.js";
import { withProviderDeadline } from "../src/deadline.js";
import type { ControlResult } from "../src/provider.js";

for (const hostMode of ["rpc", "json"] as const) for (const backend of ["node", "python"] as const) test(`published owner unmodified ${hostMode}/${backend}: wrapper evidence and ordinary retained lifecycle`, { timeout: 60_000 }, async t => {
  const f = await nativeAdversarialFixture(t, backend, `published-${hostMode}`, false, { owner: "published", hostMode, modelEvidence: true });
  let first = ""; let second = ""; let oldJob = ""; let oldOutput: string | null = null; let complete = false;
  const notices = () => f.events.filter(e => e.type === "notice" && e.customType === "subagent-notify");
  const checkStatus = (result: ControlResult) => {
    assert.equal(result.status.modelEvidence?.configured, "Gemini 3.8 Flash (Medium)");
    assert.equal(result.status.modelEvidence?.requested, null);
    assert.equal(result.status.modelEvidence?.effective, null);
    assert.deepEqual(result.status.executionMetadata, { model: { value: "Gemini 3.8 Flash", source: "configured" }, thinking: { value: "medium", source: "configured", derivedFrom: "model-label" } });
  };
  const host = await f.create(async (request, last) => {
    const result = last as { details?: ControlResult & { asyncId?: string }; isError?: boolean };
    assert.ok(!result?.isError);
    if (request === 1) return { tool: "subagent", arguments: { agent: "agy-reviewer", task: "Read-only fixture; question first, then complete after explicit continuation.", async: true } };
    if (request === 2) { first = result.details!.asyncId!; assert.ok(first); await f.ready(first); return { tool: "agy_subagent_control", arguments: { action: "status", runId: first } }; }
    if (request === 3) { checkStatus(result.details!); return { tool: "agy_subagent_control", arguments: { action: "queue", runId: first, messageId: "published-guidance", message: "Private guidance for the explicit followup only" } }; }
    if (request === 4) {
      checkStatus(result.details!); assert.equal(result.details!.receipt?.state, "queued");
      assert.ok(!JSON.stringify(result).includes("Private guidance"));
      if (hostMode === "json") await f.release(1);
      return { text: "Awaiting the question checkpoint." };
    }
    if (request === 5) {
      assert.equal(notices().length, 1); assert.ok(String(notices()[0].content).includes("assignment incomplete"));
      const turn = await f.retained(first); oldJob = turn.jobId; oldOutput = turn.output;
      assert.ok(oldOutput?.includes("Model: Gemini 3.8 Flash [configured]"));
      assert.ok(oldOutput?.includes("thinking: medium [configured, label-derived]"));
      return { tool: "subagent", arguments: { action: "resume", id: first, message: "Use the documented behavior and finish." } };
    }
    if (request === 6) { second = result.details!.asyncId!; assert.ok(second && second !== first); await f.ready(second); return { tool: "agy_subagent_control", arguments: { action: "status", runId: first } }; }
    if (request === 7) {
      checkStatus(result.details!); assert.equal(result.details!.latest.runId, second); assert.equal(result.details!.requested.runId, first);
      if (hostMode === "json") await f.release(2);
      return { text: "Awaiting the completed checkpoint." };
    }
    if (request === 8) { assert.equal(notices().length, 2); assert.ok(String(notices()[1].content).includes("assignment completed")); complete = true; return { text: "Completed; configured evidence is not serving attestation." }; }
    assert.fail(`unexpected published-owner scripted request ${request}`);
  });
  await host.session.prompt("Exercise the unmodified published owner's external-job public API.");
  if (hostMode === "rpc") {
    await host.session.waitForIdle(); assert.equal(host.fake.requests.length, 4); assert.equal(notices().length, 0);
    await f.release(1); await f.until(() => host.fake.requests.length === 7 && host.session.isIdle);
    assert.equal(notices().length, 1); await f.release(2);
  }
  await f.until(() => complete && host.session.isIdle); await host.session.waitForIdle();
  assert.deepEqual(f.errors, []); assert.equal(host.fake.requests.length, 8); assert.equal(notices().length, 2);
  assert.deepEqual(notices().map(e => e.idle), [hostMode === "rpc", hostMode === "rpc"]);
  const final = await f.retained(second);
  assert.equal(final.semanticState, "completed"); assert.ok(final.output?.includes("Model: Gemini 3.8 Flash [configured]"));
  assert.ok(final.output?.includes("effective identity: unavailable")); assert.ok(final.output?.includes("forwarded"));
  const store = new AssignmentStore(process.env.AGY_PI_STATE_ROOT!, host.manager.getSessionId(), host.manager.getSessionFile() ?? null);
  await withProviderDeadline(async scope => {
    const old = store.getTurn(oldJob, scope); assert.equal(old.output, oldOutput);
    assert.equal(old.conversationId, final.conversationId); assert.equal(final.expectedConversation, old.conversationId);
    assert.equal(old.claim.cwd, final.claim.cwd); assert.deepEqual(old.config, final.config);
    assert.equal(final.queueSnapshot[0].messageId, "published-guidance");
    assert.ok(!("executionMetadata" in old)); assert.ok(!("modelEvidence" in final));
  });
  for (const runId of [first, second]) {
    const status = JSON.parse(await fs.readFile(path.join(f.root, "owner-temp/async-subagent-runs", runId, "status.json"), "utf8"));
    assert.equal(status.steps[0].runner.type, "external-job");
    for (const key of ["model", "thinking", "executionMetadata", "modelEvidence"]) assert.ok(!(key in status.steps[0].externalJob));
  }
  const starts = f.rows().filter(row => backend === "node" ? row.name === "agy_start" : row.event === "execution");
  assert.equal(starts.length, 2); assert.equal(starts[0].SESSION_ID ?? starts[0].session_id ?? null, null);
  assert.equal(starts[1].SESSION_ID ?? starts[1].session_id, final.conversationId);
  assert.equal(starts[0].model ?? null, null); assert.equal(starts[1].model ?? null, null);
  assert.equal(f.rows().filter(row => row.name === "agy_cancel").length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, "workspace")), []);
  if (f.ui) {
    // The owner also clears its own Fleet/inspect widgets during initialization.
    // Count actual async snapshots, not those unrelated native cleanup requests.
    const snapshots = f.ui.requests.filter(r => r.method === "setWidget" && r.widgetLines?.some(line => line.startsWith("PI_SUBAGENT_ASYNC_JSON:")));
    const widgetKeys = new Set(snapshots.map(r => r.method === "setWidget" ? r.widgetKey : undefined));
    assert.equal(widgetKeys.size, 1, "one native async snapshot widget, no wrapper widget or duplicate registry");
  }
});
