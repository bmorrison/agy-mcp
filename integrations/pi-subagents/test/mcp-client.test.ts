import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access, writeFile, cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgyMcpClient, decodeEnvelope, requireObservedConversation, type McpClientTestDependencies } from "../src/mcp-client.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { withProviderDeadline, ProviderDeadline } from "../src/deadline.js";
import type { ExecutionConfig } from "../src/contracts.js";
const config: ExecutionConfig = { backend: "agy", mode: "review", sandbox: true, allow_write: false, worktree: false, output_protocol: "raw", timeout: 300, model: "fixture-model" };
const id = "job_pi_" + "a".repeat(32);
async function fixture(mode: string, run: (client: AgyMcpClient, root: string, requests: () => Promise<Record<string, unknown>[]>) => Promise<void>, lifecycle = false, dependencies: McpClientTestDependencies = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-pi-node-"));
  const evidence = path.join(root, "requests.jsonl");
  const client = new AgyMcpClient({ ownerDirectory: root, command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("./support/fake-mcp-server.ts", import.meta.url))], env: { PATH: process.env.PATH!, AGY_PI_TEST_MODE: mode, AGY_PI_TEST_EVIDENCE: evidence, ...(lifecycle ? { AGY_PI_TEST_LIFECYCLE_ROOT: root } : {}) } }, dependencies);
  try { await run(client, root, async () => (await readFile(evidence, "utf8")).trim().split("\n").map(line => JSON.parse(line))); }
  finally {
    await client.close(); await client.close();
    const artifacts = process.env.AGY_PI_TEST_ARTIFACTS;
    if (artifacts) {
      const destination = path.join(artifacts, path.basename(root));
      await mkdir(artifacts, { recursive: true }); await cp(root, destination, { recursive: true });
      let events: Record<string, unknown>[] = [];
      try { events = (await readFile(evidence, "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch { /* never spawned */ }
      const pids = events.filter(event => event.event === "fixture_process").map(event => Number(event.pid));
      for (const pid of pids) await eventually(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
      await writeFile(path.join(destination, "cleanup.json"), JSON.stringify({ root, pids, allOwnedPidsAbsent: true, ownership: client.ownedJobs(), lifecycle: client.lifecycle() }));
    }
    await rm(root, { recursive: true, force: true });
  }
}
for (const mode of ["normal", "text"]) test(`MCP ${mode}: lazy owned lifetime, dry-run-only probes, exact wire start/status/result`, { timeout: 15_000 }, async () => {
  await fixture(mode, async (client, root, requests) => {
    await assert.rejects(access(path.join(root, "requests.jsonl")));
    await withProviderDeadline(async scope => {
      const evidence = await client.probeCommand(config, root, scope);
      assert.equal(evidence.conversation, true); assert.ok(!("command_preview" in evidence));
      const probes = await requests(); assert.equal(probes.length, 2);
      assert.ok(probes.every(r => r.name === "agy" && r.dry_run === true && r.debug === true));
      assert.equal(probes[1].SESSION_ID, "11111111-1111-4111-8111-111111111111");
      assert.equal((await client.startTurn({ jobId: id, prompt: "source task", cwd: root, config }, scope)).status, "running");
      assert.equal((await client.status(id, scope)).record.job_id, id);
      const result = await client.result(id, scope);
      assert.equal(requireObservedConversation(result), "12345678-1234-4234-8234-123456789abc");
      const calls = await requests(); assert.equal(calls.filter(r => r.name === "agy_start").length, 1);
      const start = calls.find(r => r.name === "agy_start")!;
      assert.equal(start.SESSION_ID, undefined); assert.equal(start.cd, root);
      assert.equal(start.allow_write, false); assert.equal(start.worktree, false);
      assert.equal(calls.find(r => r.name === "agy_result")!.include_events, true);
      assert.ok(calls.filter(r => r.name !== "agy").every(r => r.job_id === id));
      await assert.rejects(client.status("job_pi_a", scope), /invalid_job_id/);
    });
  });
});
for (const [mode, code] of [["isError", "mcp_tool_error"], ["rejected", "mcp_tool_rejected"], ["wrongSchema", "mcp_envelope_schema"], ["oversize", "mcp_envelope_oversize"]]) test(`MCP refuses ${mode} with fixed diagnostic`, { timeout: 15_000 }, async () => {
  await fixture(mode, async (client, root) => {
    await assert.rejects(withProviderDeadline(scope => client.probeCommand(config, root, scope)), e => e instanceof Error && e.message === code);
  });
});
test("MCP inconsistent exact id and missing required record fields rejected", { timeout: 15_000 }, async () => {
  await fixture("wrongId", async (client, root) => {
    await withProviderDeadline(async scope => {
      await client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope);
      await assert.rejects(client.status(id, scope), /mcp_record_schema/);
    });
  });
  assert.throws(() => decodeEnvelope("agy_status", { structuredContent: { success: true, record: { job_id: id } } }, id), /mcp_record_schema/);
  assert.throws(() => decodeEnvelope("agy", { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }));
  assert.throws(() => decodeEnvelope("agy", { structuredContent: { success: true }, content: [{ type: "text", text: JSON.stringify({ success: true, status: "completed", SESSION_ID: "", adapter: {}, command_preview: null }) }] }), /mcp_envelope_schema/);
});
for (const mode of ["delayStart", "disconnect"]) test(`MCP ambiguous ${mode}: never retries start or implicit-latest reconciliation`, { timeout: 15_000 }, async () => {
  await fixture(mode, async (client, root, requests) => {
    await withProviderDeadline(scope => client.connect(scope));
    await assert.rejects(withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope), { totalMs: 150, settlementMs: 20 }), /start_dispatch_unknown/);
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await requests()).filter(r => r.name === "agy_start").length, 1);
    if (mode === "delayStart") {
      await withProviderDeadline(async scope => assert.equal((await client.status(id, scope)).record.job_id, id));
      assert.equal((await requests()).filter(r => r.name === "agy_start").length, 1);
    }
  });
});
test("MCP cancel signal acknowledgment is separate from terminal observation on same owning connection", { timeout: 15_000 }, async () => {
  await fixture("cancelDelayed", async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope));
    assert.deepEqual(await client.cancel(id), { signalled: true, observedStatus: "running" });
    const calls = await requests(); assert.deepEqual(calls.slice(-2).map(r => r.name), ["agy_cancel", "agy_status"]);
  });
});
test("MCP cancelled terminal observation and bounded lazy/idempotent close", { timeout: 15_000 }, async () => {
  await fixture("running", async (client, root) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope));
    assert.deepEqual(await client.cancel(id), { signalled: true, observedStatus: "cancelled" });
    const start = performance.now(); await client.close(); assert.ok(performance.now() - start < 5000);
    await assert.rejects(withProviderDeadline(scope => client.status(id, scope)), /mcp_connection_unavailable/);
  });
});
test("MCP no start after shared scope expires following connection", { timeout: 15_000 }, async () => {
  await fixture("normal", async (client, root, requests) => {
    let now = 0; const scope = new ProviderDeadline(() => now);
    try {
      await client.probeCommand(config, root, scope); now = 85_000;
      await assert.rejects(client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope), /provider_deadline/);
      assert.equal((await requests()).filter(r => r.name === "agy_start").length, 0);
    } finally { scope.dispose(); }
  });
});
test("MCP malformed operator command refuses before spawning", async () => {
  const client = new AgyMcpClient({ ownerDirectory: os.tmpdir(), env: { AGY_PI_MCP_ARGS: '["x", 1]' } });
  try { await assert.rejects(withProviderDeadline(scope => client.connect(scope)), /invalid_mcp_command/); }
  finally { await client.close(); }
});
for (const mode of ["extraConversation", "continue", "writeMode"]) test(`MCP preview rejects unsafe/conflicting ${mode}`, { timeout: 15_000 }, async () => {
  await fixture(mode, async (client, root, requests) => {
    await assert.rejects(withProviderDeadline(scope => client.probeCommand(config, root, scope)), /command_capability_missing/);
    assert.equal((await requests()).filter(r => r.name === "agy_start").length, 0);
  });
});
for (const mode of ["missingTool", "missingSchema"]) test(`MCP discovery requires ${mode} without running any tool`, { timeout: 15_000 }, async () => {
  await fixture(mode, async (client, root) => {
    await assert.rejects(withProviderDeadline(scope => client.connect(scope)), /mcp_capability_missing/);
    await assert.rejects(access(path.join(root, "requests.jsonl")));
    await assert.rejects(withProviderDeadline(scope => client.connect(scope)), /mcp_connection_unavailable/);
  });
});
test("MCP cancel acknowledgment retained when observation exhausts the one shared budget", { timeout: 15_000 }, async () => {
  await fixture("delayStatus", async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope));
    const scope = new ProviderDeadline(undefined, 150, 0);
    try {
      const receipt = await client.cancel(id, scope);
      assert.equal(receipt.signalled, true); assert.equal(receipt.observedStatus, null);
      assert.ok(scope.signal.aborted || scope.remaining() <= 1);
      assert.deepEqual((await requests()).slice(-2).map(r => r.name), ["agy_cancel", "agy_status"]);
    } finally { scope.dispose(); }
  });
});
test("MCP init-only, unobserved, conflicting and invalid UUID anchors fail fixed diagnostics", () => {
  const base = { success: true as const, job_id: id, record: { job_id: id, session_id: "12345678-1234-4234-8234-123456789abc", status: "completed" as const, backend: "agy", cwd: "/fixture", started_at: "t", updated_at: "t", finished_at: "t", exit_code: 0, request: {}, extra: {} }, result_text: "", include_events: true as const, since: 0, events: [], count: 0 };
  assert.throws(() => requireObservedConversation(base), /conversation_unobserved/);
  assert.throws(() => requireObservedConversation({ ...base, events: [{ type: "system", subtype: "init", session_id: base.record.session_id }] }), /conversation_unobserved/);
  assert.throws(() => requireObservedConversation({ ...base, events: [{ type: "system", subtype: "conversation_started", session_id: base.record.session_id }, { type: "system", subtype: "stream_start", session_id: "invalid" }] }), /conversation_mismatch/);
});
test("MCP independently expiring concurrent connection waiter cannot later dispatch", { timeout: 15_000 }, async () => {
  await fixture("delayInitialize", async (client, root, requests) => {
    const first = withProviderDeadline(scope => client.connect(scope));
    await assert.rejects(withProviderDeadline(async scope => {
      await client.connect(scope); scope.assertAdmission();
      await client.startTurn({ jobId: id, prompt: "late", cwd: root, config }, scope);
    }, { totalMs: 50, settlementMs: 0 }), /provider_deadline/);
    await first;
    await withProviderDeadline(scope => client.probeCommand(config, root, scope));
    assert.equal((await requests()).filter(r => r.name === "agy_start").length, 0);
  });
});
test("MCP event bounds and schema rejection occur before interpretation", { timeout: 15_000 }, async () => {
  await fixture("normal", async (client, root) => {
    await withProviderDeadline(async scope => {
      await client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope);
      const result = await client.result(id, scope);
      const large = { ...result, record: { ...result.record, extra: { evidence: "x".repeat(1_500_000) } } };
      assert.equal(decodeEnvelope("agy_result", { structuredContent: large, content: [{ type: "text", text: JSON.stringify(large) }] }, id).job_id, id);
      assert.throws(() => decodeEnvelope("agy_result", { structuredContent: { ...large, record: { ...large.record, extra: { evidence: "x".repeat(2 * 1024 * 1024) } } } }, id), /mcp_envelope_oversize/);
      for (const bad of [
        { ...result, events: Array(2001).fill({ type: "system" }), count: 2001 },
        { ...result, events: [null], count: 1 }, { ...result, count: 2 },
        { ...result, record: { ...result.record, exit_code: "0" } },
        { ...result, record: { ...result.record, request: { prompt: "task" } } },
        { ...result, job_id: "job_pi_" + "b".repeat(32) },
      ]) assert.throws(() => decodeEnvelope("agy_result", { structuredContent: bad }, id));
    });
  });
});

async function eventually(check: () => Promise<boolean>, timeout = 3000): Promise<void> {
  const until = performance.now() + timeout;
  while (!await check()) {
    if (performance.now() >= until) assert.fail("fixture boundary/cleanup not observed");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function boundary(root: string, name: string) {
  await eventually(async () => {
    try { return (await readFile(path.join(root, "requests.jsonl"), "utf8")).includes(`"name":"${name}"`); } catch { return false; }
  });
}
async function release(root: string, name: string) { await writeFile(path.join(root, `release-${name}`), "release"); }
const starts = (events: Record<string, unknown>[]) => events.filter(event => event.name === "agy_start").length;
for (const held of ["initialize", "list", "probe"]) {
  for (const reason of ["expiry", "parentAbort", "stop", "close"]) test(`MCP ${held} physical boundary then ${reason}: zero losing-continuation start`, { timeout: 15_000 }, async () => {
    await fixture(`hold-${held}`, async (client, root, requests) => {
      let now = 0;
      const parent = new AbortController();
      const scope = new ProviderDeadline(() => now, 90_000, 5000, parent.signal);
      let dispatched = false;
      const operation = (async () => {
        await client.probeCommand(config, root, scope);
        await client.startTurn({ jobId: id, prompt: "must not dispatch", cwd: root, config }, scope);
        dispatched = true;
      })();
      const rejection = assert.rejects(operation, /provider_deadline|mcp_connection_unavailable|mcp_request_failed|mcp_connect_failed/);
      try {
        await boundary(root, held);
        if (reason === "expiry") { now = 85_000; assert.throws(() => scope.assertAdmission(), /provider_deadline/); }
        if (reason === "parentAbort") parent.abort();
        if (reason === "stop") client.stopAdmission();
        if (reason === "close") await client.close();
        await release(root, held);
        await rejection;
        await client.close();
        assert.equal(dispatched, false); assert.equal(starts(await requests()), 0);
        assert.equal(client.ownership(id), null);
        if (held !== "probe") assert.equal((await requests()).filter(e => e.name === "agy").length, 0);
      } finally { scope.dispose(); }
    }, true);
  });
}
test("MCP list and two probes retain original monotonic budget, physical dispatch never renews", { timeout: 15_000 }, async () => {
  await fixture("hold-list", async (client, root, requests) => {
    let now = 0; const scope = new ProviderDeadline(() => now);
    try {
      const connected = client.connect(scope);
      await boundary(root, "list"); now = 80_000; await release(root, "list"); await connected;
      assert.equal(scope.requestOptions().timeout, 5000);
      await client.probeCommand(config, root, scope); now = 85_000;
      await assert.rejects(client.startTurn({ jobId: id, prompt: "late", cwd: root, config }, scope), /provider_deadline/);
      assert.equal(starts(await requests()), 0);
    } finally { scope.dispose(); }
  }, true);
});
test("MCP shorter concurrent metadata observer cannot abort longer flight; longer dispatch remains authorized", { timeout: 15_000 }, async () => {
  await fixture("hold-list", async (client, root, requests) => {
    const longer = new ProviderDeadline();
    try {
      const longWork = client.connect(longer); await boundary(root, "list");
      const shortParent = new AbortController(); const shorter = new ProviderDeadline(undefined, 2000, 0, shortParent.signal);
      try {
        const shortWork = client.connect(shorter);
        const refused = assert.rejects(shortWork, /provider_deadline/); shortParent.abort(); await refused;
        await release(root, "list"); await longWork;
        await client.startTurn({ jobId: id, prompt: "authorized longer", cwd: root, config }, longer);
        assert.equal(starts(await requests()), 1);
        const wire = (await requests()).filter(event => event.event === "wire");
        assert.equal(wire.filter(event => event.method === "initialize").length, 1);
        assert.equal(wire.filter(event => event.method === "tools/list").length, 1);
      } finally { shorter.dispose(); }
    } finally { longer.dispose(); }
  }, true);
});
test("MCP short-first metadata flight fails closed rather than renewing dispatched physical request for longer joiner", { timeout: 15_000 }, async () => {
  await fixture("hold-list", async (client, root, requests) => {
    const parent = new AbortController(); const short = new ProviderDeadline(undefined, 2000, 0, parent.signal); const long = new ProviderDeadline();
    try {
      const first = client.connect(short); const firstRejected = assert.rejects(first, /provider_deadline|mcp_connect_failed/);
      await boundary(root, "list");
      const secondRejected = assert.rejects(client.connect(long), /provider_deadline|mcp_connect_failed/);
      parent.abort(); await firstRejected; await secondRejected;
      await release(root, "list");
      await assert.rejects(client.startTurn({ jobId: id, prompt: "not renewed", cwd: root, config }, long), /mcp_connection_unavailable/);
      assert.equal(starts(await requests()), 0);
      assert.equal((await requests()).filter(event => event.method === "tools/list").length, 1);
    } finally { short.dispose(); long.dispose(); }
  }, true);
});
test("MCP close during shared connection is one tracked close, no late client publication/reconnect", { timeout: 15_000 }, async () => {
  await fixture("hold-initialize", async (client, root, requests) => {
    const scope = new ProviderDeadline();
    try {
      const work = client.connect(scope); const rejected = assert.rejects(work, /mcp_connect_failed|mcp_connection_unavailable/);
      await boundary(root, "initialize");
      const closing = client.close(); assert.equal(client.close(), closing);
      await closing; await rejected; await release(root, "initialize");
      await assert.rejects(client.connect(scope), /mcp_connection_unavailable/);
      assert.equal((await requests()).filter(event => event.method === "initialize").length, 1);
      assert.equal(starts(await requests()), 0);
    } finally { scope.dispose(); }
  }, true);
});
for (const mode of ["delayStart", "lostDuplicate"]) test(`MCP ${mode}: correlated ambiguous record never grants ownership, cancellation, or second start`, { timeout: 15_000 }, async () => {
  await fixture(mode, async (client, root, requests) => {
    await withProviderDeadline(scope => client.connect(scope));
    await assert.rejects(withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "identical saved request", cwd: root, config }, scope), { totalMs: 100, settlementMs: 0 }), /start_dispatch_unknown/);
    await new Promise(resolve => setTimeout(resolve, 400));
    await withProviderDeadline(scope => client.status(id, scope));
    const evidence = client.ownership(id)!;
    assert.equal(evidence.attempted, true); assert.equal(evidence.acknowledged, false); assert.equal(evidence.recordCorrelated, true);
    await assert.rejects(client.cancel(id), /mcp_cancel_not_owned/);
    await assert.rejects(withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "identical saved request", cwd: root, config }, scope)), /start_dispatch_unknown/);
    assert.equal(starts(await requests()), 1); assert.equal((await requests()).filter(event => event.name === "agy_cancel").length, 0);
  }, true);
});
for (const [mode, signal, observed, terminal] of [
  ["cancelDelayed", true, "running", false], ["running", true, "cancelled", true],
  ["cancelFalse", false, "running", false], ["cancelFalseTerminal", false, "cancelled", true], ["cancelUnknown", true, "unknown", false],
  ["missingStatus", true, null, false], ["malformedStatus", true, null, false], ["uncorrelatedStatus", true, null, false],
] as const) test(`MCP owned cancel ${mode}: once-only signal with separate correlated observation`, { timeout: 15_000 }, async () => {
  await fixture(mode, async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "correlated", cwd: root, config }, scope));
    const scope = new ProviderDeadline(undefined, 10_000, 0);
    try {
      const [first, concurrent] = await Promise.all([client.cancelOwned(id, scope), client.cancelOwned(id, scope)]);
      assert.equal(first.signalled, signal); assert.equal(first.observedStatus, observed); assert.equal(first.terminalObserved, terminal);
      assert.deepEqual(concurrent, first); assert.deepEqual(await client.cancelOwned(id, scope), first);
      assert.ok(first.acknowledged && first.live && first.cancelAttempted);
      assert.equal((await requests()).filter(event => event.name === "agy_cancel").length, 1);
      assert.equal((await requests()).filter(event => event.name === "agy_status").length, 1);
      await assert.rejects(client.cancel("job_pi_" + "b".repeat(32)), /mcp_cancel_not_owned/);
      assert.equal(client.ownership("job_pi_" + "b".repeat(32)), null);
      assert.ok(!JSON.stringify(first).includes('"correlated"')); // no request bodies
    } finally { scope.dispose(); }
  }, true);
});
test("MCP stopped admission permits only owned explicit settlement without spawn/new ordinary work", { timeout: 15_000 }, async () => {
  await fixture("running", async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "running", cwd: root, config }, scope));
    client.stopAdmission();
    await assert.rejects(withProviderDeadline(scope => client.status(id, scope)), /mcp_connection_unavailable/);
    await assert.rejects(withProviderDeadline(scope => client.startTurn({ jobId: "job_pi_" + "b".repeat(32), prompt: "late", cwd: root, config }, scope)), /mcp_connection_unavailable/);
    const settlement = new ProviderDeadline(undefined, 10_000, 0);
    try {
      assert.equal((await client.observeOwned(id, settlement)).record.status, "running");
      assert.equal((await client.cancelOwned(id, settlement)).observedStatus, "cancelled");
      assert.equal(starts(await requests()), 1);
    } finally { settlement.dispose(); }
  }, true);
});
test("MCP global shutdown several hung jobs shares one original budget, tracks close, cancels each at most once", { timeout: 15_000 }, async () => {
  await fixture("hungCancel", async (client, root, requests) => {
    await withProviderDeadline(async scope => {
      for (const suffix of ["a", "b", "c"]) await client.startTurn({ jobId: "job_pi_" + suffix.repeat(32), prompt: "owned", cwd: root, config }, scope);
    });
    const scope = new ProviderDeadline(undefined, 150, 0);
    try {
      const begin = performance.now(); const shutdown = client.shutdown(scope); assert.equal(client.shutdown(scope), shutdown);
      const evidence = await shutdown;
      assert.ok(performance.now() - begin < 5300); assert.equal(evidence.closed, true); assert.equal(evidence.jobs.length, 3);
      assert.ok(evidence.jobs.every(job => job.signalled === null && !job.terminalObserved));
      const cancels = (await requests()).filter(event => event.name === "agy_cancel");
      assert.equal(cancels.length, 3); assert.equal(new Set(cancels.map(event => event.job_id)).size, 3);
      assert.equal((await requests()).filter(event => event.name === "agy_status").length, 0);
      assert.ok(client.ownedJobs().every(job => !job.live));
    } finally { scope.dispose(); }
  }, true);
});
test("MCP shutdown hung predispatch metadata creates no jobs or new cancellation/observation work", { timeout: 15_000 }, async () => {
  await fixture("hold-list", async (client, root, requests) => {
    const scope = new ProviderDeadline();
    try {
      const connecting = client.connect(scope); const refused = assert.rejects(connecting, /mcp_connect_failed|mcp_connection_unavailable/);
      await boundary(root, "list"); const evidence = await client.shutdown(); await refused;
      assert.deepEqual(evidence.jobs, []); assert.equal(starts(await requests()), 0);
      assert.equal((await requests()).filter(event => event.name === "agy_cancel").length, 0);
    } finally { scope.dispose(); }
  }, true);
});

function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
test("MCP delayed public stdio spawn completion shrinks initialize options before consumption, no original cap extension", { timeout: 15_000 }, async () => {
  const gate = deferred(); const spawned = deferred(); let now = 0;
  const recorded: ReturnType<ProviderDeadline["requestOptions"]>[] = [];
  class RecordingDeadline extends ProviderDeadline {
    override requestOptions() { const value = super.requestOptions(); recorded.push(value); return value; }
  }
  const scope = new RecordingDeadline(() => now);
  try {
    await fixture("normal", async (client, root, requests) => {
      const connecting = client.connect(scope); await spawned.promise;
      assert.equal(recorded[0].timeout, 60_000); now = 80_000; gate.resolve(); await connecting;
      assert.equal(recorded[0].timeout, 5000); assert.equal(recorded[0].maxTotalTimeout, 5000);
      assert.equal(recorded[0].resetTimeoutOnProgress, false);
      assert.equal((await requests()).filter(event => event.method === "initialize").length, 1);
      await client.startTurn({ jobId: id, prompt: "remaining admitted", cwd: root, config }, scope);
      assert.equal(starts(await requests()), 1);
    }, true, { createStdioTransport: parameters => new class extends StdioClientTransport {
      override async start() { await super.start(); spawned.resolve(); await gate.promise; }
    }(parameters) });
  } finally { gate.resolve(); scope.dispose(); }
});
for (const reason of ["expiry", "parentAbort", "close"]) test(`MCP delayed spawn ${reason}: no initialize/start, bounded close retains pending setup until late settlement`, { timeout: 15_000 }, async () => {
  const gate = deferred(); const spawned = deferred(); let now = 0;
  const parent = new AbortController(); const scope = new ProviderDeadline(() => now, 90_000, 5000, parent.signal);
  try {
    await fixture("normal", async (client, root, requests) => {
      const connecting = client.connect(scope); const rejected = assert.rejects(connecting, /provider_deadline|mcp_connection_unavailable/);
      await spawned.promise;
      if (reason === "expiry") { now = 85_000; assert.throws(() => scope.assertAdmission(), /provider_deadline/); }
      if (reason === "parentAbort") parent.abort();
      const begin = performance.now(); await client.close();
      assert.ok(performance.now() - begin < 5000); await rejected;
      assert.ok(client.lifecycle().pendingOperations >= 1); // Not silently discarded on close.
      assert.equal(client.lifecycle().closed, true); assert.equal(client.lifecycle().connected, false);
      gate.resolve(); await eventually(async () => client.lifecycle().pendingOperations === 0);
      assert.equal((await requests()).filter(event => event.method === "initialize").length, 0);
      assert.equal(starts(await requests()), 0);
      assert.equal(client.lifecycle().transportCloseSettled, true);
    }, true, { createStdioTransport: parameters => new class extends StdioClientTransport {
      override async start() { await super.start(); spawned.resolve(); await gate.promise; }
    }(parameters) });
  } finally { gate.resolve(); scope.dispose(); }
});
for (const settle of ["resolve", "reject"]) test(`MCP synchronous physical send then unresolved drain: bounded close truthful counts and late ${settle} never dispatches`, { timeout: 15_000 }, async () => {
  const drain = deferred();
  await fixture("running", async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "physical ack despite drain", cwd: root, config }, scope));
    assert.equal(starts(await requests()), 1); assert.equal(client.ownership(id)!.acknowledged, true);
    assert.equal(client.lifecycle().pendingSends, 1); assert.equal(client.lifecycle().pendingOperations, 0);
    const begin = performance.now(); await client.close(); assert.ok(performance.now() - begin < 5000);
    assert.equal(client.lifecycle().pendingSends, 1); // SDK close is not drain/job termination proof.
    assert.equal(client.lifecycle().closed, true); assert.equal(client.ownership(id)!.live, false);
    const before = (await requests()).length;
    if (settle === "resolve") drain.resolve(); else drain.reject(new Error("offline late drain failure"));
    await eventually(async () => client.lifecycle().pendingSends === 0);
    assert.equal((await requests()).length, before); assert.equal(starts(await requests()), 1);
    await assert.rejects(client.cancel(id), /mcp_connection_unavailable/);
    assert.equal(client.lifecycle().connected, false);
  }, true, { createStdioTransport: parameters => new class extends StdioClientTransport {
    override async send(message: JSONRPCMessage) {
      await super.send(message);
      if ("method" in message && message.method === "tools/call" && (message.params as { name?: string })?.name === "agy_start") await drain.promise;
    }
  }(parameters) });
});
test("MCP standalone close uses bounded SDK-only child cleanup even when fixture ignores stdin/TERM", { timeout: 15_000 }, async () => {
  await fixture("ignoreClose", async (client, root, requests) => {
    await withProviderDeadline(scope => client.connect(scope));
    const pid = Number((await requests()).find(event => event.event === "fixture_process")!.pid);
    const begin = performance.now(); await client.close(); const elapsed = performance.now() - begin;
    assert.ok(elapsed >= 3900 && elapsed < 5000);
    assert.equal(client.lifecycle().closed, true); assert.equal(client.lifecycle().transportCloseSettled, true);
    await eventually(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.equal(client.lifecycle().transportCloseObserved, true);
    assert.deepEqual(client.ownedJobs(), []); assert.equal(starts(await requests()), 0);
  }, true);
});

test("PR5 close callback: SDK composition preserves adapter ownership invalidation and pending RPC rejection", { timeout: 15_000 }, async () => {
  let stdio!: StdioClientTransport;
  await fixture("holdResult", async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "owned", cwd: root, config }, scope));
    assert.equal(client.ownership(id)!.live, true);
    const scope = new ProviderDeadline();
    try {
      const pending = client.result(id, scope);
      const rejected = assert.rejects(pending, /mcp_request_failed|mcp_connection_unavailable/);
      await boundary(root, "result");
      // Close only the public stdio transport, NOT AgyMcpClient.close().
      await stdio.close(); await rejected;
      await eventually(async () => client.lifecycle().pendingOperations === 0);
      assert.equal(client.lifecycle().closed, false);
      assert.equal(client.lifecycle().broken, true);
      assert.equal(client.lifecycle().connected, false);
      assert.equal(client.lifecycle().transportCloseObserved, true);
      assert.equal(client.ownership(id)!.live, false);
      const before = (await requests()).length;
      await assert.rejects(client.connect(scope), /mcp_connection_unavailable/);
      await assert.rejects(client.status(id, scope), /mcp_connection_unavailable/);
      await assert.rejects(client.cancel(id), /mcp_connection_unavailable/);
      assert.equal((await requests()).length, before);
      assert.equal(starts(await requests()), 1);
    } finally { scope.dispose(); }
  }, true, { createStdioTransport: parameters => (stdio = new StdioClientTransport(parameters)) });
});

test("MCP resultOwned works after stop only on decoded live ownership under <=10s original window", async () => {
  await fixture("normal", async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope)); client.stopAdmission();
    const scope = new ProviderDeadline(undefined, 1000, 0);
    try { assert.equal((await client.resultOwned(id, scope)).record.status, "completed"); await assert.rejects(client.resultOwned("job_pi_" + "b".repeat(32), scope), /mcp_cancel_not_owned/); }
    finally { scope.dispose(); }
    await assert.rejects(withProviderDeadline(scope => client.resultOwned(id, scope)), /invalid_cancel_budget/);
    await client.close(); const closed = new ProviderDeadline(undefined, 1000, 0); try { await assert.rejects(client.resultOwned(id, closed), /mcp_connection_unavailable/); } finally { closed.dispose(); }
    assert.equal((await requests()).filter(r => r.name === "agy_start").length, 1); assert.equal((await requests()).filter(r => r.name === "agy_cancel").length, 0);
  });
});
test("MCP resultOwned never adopts correlated ambiguous start and expired shared shutdown scope cannot request", async () => {
  await fixture("delayStart", async (client, root, requests) => {
    await withProviderDeadline(scope => client.connect(scope)); await assert.rejects(withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope), { totalMs: 100, settlementMs: 0 }));
    await new Promise(r => setTimeout(r, 400)); await withProviderDeadline(scope => client.status(id, scope)); client.stopAdmission();
    const scope = new ProviderDeadline(undefined, 1000, 0); try { await assert.rejects(client.resultOwned(id, scope), /mcp_cancel_not_owned/); } finally { scope.dispose(); }
    assert.equal((await requests()).filter(r => r.name === "agy_result").length, 0);
  });
  await fixture("normal", async (client, root, requests) => {
    await withProviderDeadline(scope => client.startTurn({ jobId: id, prompt: "task", cwd: root, config }, scope)); client.stopAdmission();
    let now = 0; const scope = new ProviderDeadline(() => now, 1000, 0); now = 1000;
    try { await assert.rejects(client.resultOwned(id, scope), /provider_deadline/); } finally { scope.dispose(); }
    assert.equal((await requests()).filter(r => r.name === "agy_result").length, 0);
  });
});
