import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access, stat, cp, mkdir, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgyMcpClient, requireObservedConversation } from "../src/mcp-client.js";
import { ProviderDeadline, withProviderDeadline } from "../src/deadline.js";
import { canonicalJson, deriveOperation, sha256Utf8, formatOperationMarker, requireOperationMarker, type ExecutionConfig } from "../src/contracts.js";
import { buildCheckpointPrompt, parseCheckpoint } from "../src/checkpoint.js";

const python = process.env.AGY_PI_TEST_PYTHON;
assert.ok(python && path.isAbsolute(python), "AGY_PI_TEST_PYTHON must name the authorized existing interpreter; no skip/install fallback");
const fixturePath = fileURLToPath(new URL("./support/python-mcp-server.py", import.meta.url));
const source = fileURLToPath(new URL("../../../src", import.meta.url));
const config: ExecutionConfig = { backend: "agy", mode: "review", sandbox: true, allow_write: false, worktree: false, output_protocol: "raw", timeout: 300, model: "fixture-model" };
const uuid = "12345678-1234-4234-8234-123456789abc";
function operation(root: string, prompt = "source\r\n review 😀", runId = "run-1") {
  return deriveOperation({ ownerSessionId: "12345678-1234-4234-8234-abcdefabcdef", runId, stepIndex: 0,
    parentProviderJobId: null, requestId: null, requestDigest: null, promptDigest: sha256Utf8(prompt), cwd: root,
    executionConfigDigest: sha256Utf8(canonicalJson(config)), queue: [] });
}
async function fixture(extra: Record<string, string>, run: (client: AgyMcpClient, root: string, env: Record<string, string>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-pi-python-"));
  const env = { PATH: process.env.PATH!, PYTHONPATH: source + path.delimiter + path.dirname(fixturePath), PYTHONDONTWRITEBYTECODE: "1", TMPDIR: root, AGY_PI_TEST_EVIDENCE: path.join(root, "evidence.jsonl"), ...(process.env.AGY_PI_TEST_ARTIFACTS ? { AGY_PI_TEST_PROCESS_EVIDENCE: path.join(root, "processes.jsonl") } : {}), ...extra };
  const client = new AgyMcpClient({ ownerDirectory: root, command: python, args: [fixturePath], env });
  try { await access(python!); await run(client, root, env); }
  finally {
    await client.close();
    const artifacts = process.env.AGY_PI_TEST_ARTIFACTS;
    if (artifacts) {
      const destination = path.join(artifacts, path.basename(root));
      await mkdir(artifacts, { recursive: true }); await cp(root, destination, { recursive: true });
      const pids = (await readFile(path.join(root, "processes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).pid as number);
      for (const pid of pids) {
        const until = performance.now() + 3000;
        while (true) {
          try { process.kill(pid, 0); } catch { break; }
          assert.ok(performance.now() < until, "owned Python fixture child remains after close");
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      await writeFile(path.join(destination, "cleanup.json"), JSON.stringify({ root, pids, allOwnedPidsAbsent: true, clientClosed: true, ownership: client.ownedJobs(), lifecycle: client.lifecycle() }));
    }
    await rm(root, { recursive: true, force: true });
  }
}
async function completed(client: AgyMcpClient, jobId: string, scope: Parameters<AgyMcpClient["status"]>[1]) {
  for (let i = 0; i < 100; i++) {
    const current = await client.status(jobId, scope);
    if (current.record.status !== "running") return current;
    await new Promise(r => setTimeout(r, 10)); scope.assertAdmission();
  }
  assert.fail("fixture did not finish in bounded polling window");
}

for (const [label, message, expected] of [
  ["neutral marker", "Retention marker: sample-memento", "Retention marker: sample-memento"],
  ["token-labelled control", "Retention token: sample-memento", "Retention token: ***"],
] as const) test(`Gate A actual Python stdio: retention ${label} uses production redaction`, { timeout: 20_000 }, async () => {
  await fixture({ AGY_PI_TEST_CHECKPOINT_MESSAGE: message }, async (client, root) => {
    const prompt = "Check the synthetic response framing only.";
    const op = operation(root, prompt);
    await withProviderDeadline(async scope => {
      await client.probeCommand(config, root, scope);
      await client.startTurn({ jobId: op.jobId, prompt: buildCheckpointPrompt({ prompt, operationDigest: op.operationDigest, queue: [] }), cwd: root, config }, scope);
      const status = await completed(client, op.jobId, scope);
      assert.equal(status.record.status, "completed");
      const result = await client.result(op.jobId, scope);
      assert.deepEqual(parseCheckpoint(result.result_text), { version: 1, kind: "question", message: expected, artifacts: [] });
      assert.equal(requireObservedConversation(result), uuid);
      const rows = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(rows.filter(row => row.event === "execution").length, 1);
    });
  });
});

test("Gate A actual Python stdio: generated 39-char id/grouped marker, typed storage/envelopes and production previews", { timeout: 20_000 }, async () => {
  await fixture({}, async (client, root) => {
    const prompt = "source\r\n review 😀";
    const op = operation(root, prompt);
    const framed = buildCheckpointPrompt({ prompt, operationDigest: op.operationDigest, queue: [] });
    await withProviderDeadline(async scope => {
      const probe = await client.probeCommand(config, root, scope);
      assert.deepEqual([probe.fresh, probe.sandbox, probe.conversation, probe.modelForwarded], [true, true, true, true]);
      let evidence = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(evidence.filter(e => e.event === "execution").length, 0);
      assert.ok(evidence.every(e => e.dry_run === true && e.debug === true && e.sandbox && e.model === "--model=fixture-model"));
      assert.equal(evidence[0].fresh, true);
      assert.equal(evidence[1].conversation, "--conversation=11111111-1111-4111-8111-111111111111");
      const defaultPolicy = await client.probeCommand({ ...config, model: null }, root, scope);
      assert.equal(defaultPolicy.modelForwarded, false);
      const defaultCommands = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).slice(-2);
      assert.ok(defaultCommands.every(e => e.model === null && e.dry_run === true));
      const start = await client.startTurn({ jobId: op.jobId, prompt: framed, cwd: root, config }, scope);
      assert.equal(op.jobId.length, 39); assert.equal(start.job_id, op.jobId); assert.equal(start.SESSION_ID, "");
      const status = await completed(client, op.jobId, scope);
      assert.equal(status.record.status, "completed"); assert.equal(status.record.exit_code, 0);
      requireOperationMarker(status.record.request.prompt as string, op.operationDigest);
      assert.equal(requireObservedConversation(await client.result(op.jobId, scope)), uuid);
      const result = await client.result(op.jobId, scope);
      assert.equal(result.success, true); assert.equal(parseCheckpoint(result.result_text).kind, "question");
      assert.equal(result.record.extra.lifecycle && (result.record.extra.lifecycle as Record<string, unknown>).parent_acceptance, "not_recorded");
      await assert.rejects(client.startTurn({ jobId: op.jobId, prompt: framed, cwd: root, config }, scope), /mcp_tool_rejected/);
      // Recovery is exact-id observation only, not a start retry.
      requireOperationMarker((await client.status(op.jobId, scope)).record.request.prompt as string, op.operationDigest);
      await client.result(op.jobId, scope);
      evidence = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(evidence.filter(e => e.event === "execution").length, 1);
      const metaPath = path.join(root, "mcp-jobs", op.jobId, "meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8"));
      assert.equal(meta.job_id, op.jobId); requireOperationMarker(meta.request.prompt, op.operationDigest);
      assert.equal((await stat(metaPath)).mode & 0o777, 0o600);
      await client.probeCommand(config, root, scope, uuid);
      const second = operation(root, "explicit reply", "run-2");
      await client.startTurn({ jobId: second.jobId, prompt: buildCheckpointPrompt({ prompt: "explicit reply", operationDigest: second.operationDigest, queue: [] }), cwd: root, config, conversationId: uuid }, scope);
      await completed(client, second.jobId, scope);
      const followup = await client.result(second.jobId, scope);
      assert.equal(requireObservedConversation(followup, uuid), uuid); assert.equal(parseCheckpoint(followup.result_text).kind, "completed");
      assert.equal(followup.record.request.session_id, uuid); assert.equal(followup.record.request.sandbox, true);
    });
  });
});
test("Gate A Python validator rejects old full hash; real SafetyPolicy redacts continuous hashes and secrets, not grouped marker", { timeout: 20_000 }, async () => {
  await fixture({}, async (_owned, root, env) => {
    const raw = new Client({ name: "negative-wire-fixture", version: "1" });
    const transport = new StdioClientTransport({ command: python!, args: [fixturePath], env: { ...env, AGY_MCP_SESSION_ROOT: path.join(root, "mcp-jobs") }, stderr: "ignore" });
    try {
      await raw.connect(transport, { timeout: 5000 }); await raw.listTools({}, { timeout: 5000 });
      const digest = sha256Utf8("negative"); const op = operation(root);
      const args = { ...config, cd: root, PROMPT: `review\nAGY_PI_OP v1 ${digest}\n${formatOperationMarker(op.operationDigest)}\nBearer abcdefghijklmnop\n/Users/fixture/private`, job_id: "job_pi_" + digest };
      const old = await raw.callTool({ name: "agy_start", arguments: args }, undefined, { timeout: 5000 });
      assert.equal((old.structuredContent as Record<string, unknown>).success, false);
      assert.ok(!JSON.stringify(old).includes(args.job_id));
      const valid = await raw.callTool({ name: "agy_start", arguments: { ...args, job_id: op.jobId } }, undefined, { timeout: 5000 });
      assert.equal((valid.structuredContent as Record<string, unknown>).success, true);
      let status;
      for (let i = 0; i < 100; i++) {
        status = await raw.callTool({ name: "agy_status", arguments: { job_id: op.jobId } }, undefined, { timeout: 5000 });
        if (((status.structuredContent as Record<string, unknown>).record as Record<string, unknown>).status !== "running") break;
        await new Promise(r => setTimeout(r, 10));
      }
      const record = (status!.structuredContent as Record<string, unknown>).record as Record<string, unknown>;
      const persisted = (record.request as Record<string, unknown>).prompt as string;
      assert.ok(persisted.includes("AGY_PI_OP v1 ***")); assert.ok(persisted.includes(formatOperationMarker(op.operationDigest)));
      assert.ok(!persisted.includes(digest)); assert.ok(!persisted.includes("abcdefghijklmnop")); assert.ok(!persisted.includes("/Users/fixture"));
      const invalid = await raw.callTool({ name: "agy_start", arguments: { ...args, job_id: "job_pi_" + "b".repeat(32), SESSION_ID: "bad\nidentity" } }, undefined, { timeout: 5000 });
      assert.equal((invalid.structuredContent as Record<string, unknown>).success, false);
      assert.ok(!JSON.stringify(invalid).includes("bad\\nidentity"));
    } finally { await raw.close(); }
  });
});
for (const flag of ["new-project", "sandbox", "conversation", "model"]) test(`Gate A real build_command: unsupported ${flag} fails before execution`, { timeout: 20_000 }, async () => {
  await fixture({ AGY_PI_TEST_MISSING_FLAG: flag }, async (client, root) => {
    await assert.rejects(withProviderDeadline(scope => client.probeCommand(config, root, scope)), /command_capability_missing|mcp_tool_rejected/);
    let evidence = ""; try { evidence = await readFile(path.join(root, "evidence.jsonl"), "utf8"); } catch { /* model unsupported throws before recording command */ }
    assert.ok(!evidence.includes('"event": "execution"'));
  });
});
test("Gate A seeded init/JobRecord id is not observed CLI conversation evidence", { timeout: 20_000 }, async () => {
  await fixture({ AGY_PI_TEST_INIT_ONLY: "1" }, async (client, root) => {
    const op = operation(root);
    await withProviderDeadline(async scope => {
      await client.startTurn({ jobId: op.jobId, prompt: "review", cwd: root, config }, scope);
      await completed(client, op.jobId, scope);
      const result = await client.result(op.jobId, scope);
      assert.equal(result.record.status, "completed"); assert.equal(result.record.session_id, uuid);
      assert.throws(() => requireObservedConversation(result), /conversation_unobserved/);
      assert.throws(() => requireObservedConversation({ ...result, events: [{ type: "system", subtype: "conversation_started", session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] }), /conversation_mismatch/);
    });
  });
});
test("Gate A actual Supervisor cancellation through same stdio owner", { timeout: 20_000 }, async () => {
  await fixture({ AGY_PI_TEST_DELAY: "2" }, async (client, root) => {
    const op = operation(root);
    await withProviderDeadline(async scope => {
      await client.startTurn({ jobId: op.jobId, prompt: "review", cwd: root, config }, scope);
      const receipt = await client.cancel(op.jobId);
      assert.equal(receipt.signalled, true);
      const terminal = await completed(client, op.jobId, scope);
      assert.equal(terminal.record.status, "cancelled");
      const result = await client.result(op.jobId, scope);
      assert.equal(result.success, true); // Retrieval success, NOT execution success.
      assert.throws(() => requireObservedConversation(result), /conversation_missing/);
    });
  });
});

test("C2 actual Python retained root: second live client cannot cancel/adopt/restart acknowledged foreign job", { timeout: 20_000 }, async () => {
  await fixture({}, async (owner, root, env) => {
    const foreign = new AgyMcpClient({ ownerDirectory: root, command: python, args: [fixturePath], env });
    const op = operation(root); const prompt = buildCheckpointPrompt({ prompt: "review", operationDigest: op.operationDigest, queue: [] });
    try {
      await withProviderDeadline(async scope => {
        await owner.startTurn({ jobId: op.jobId, prompt, cwd: root, config }, scope);
        await completed(owner, op.jobId, scope);
        const retained = await foreign.status(op.jobId, scope);
        requireOperationMarker(retained.record.request.prompt as string, op.operationDigest);
        assert.equal(requireObservedConversation(await foreign.result(op.jobId, scope)), uuid);
        assert.equal(foreign.ownership(op.jobId), null);
        await assert.rejects(foreign.cancel(op.jobId), /mcp_cancel_not_owned/);
        await assert.rejects(foreign.startTurn({ jobId: op.jobId, prompt, cwd: root, config }, scope), /mcp_tool_rejected/);
        assert.equal(foreign.ownership(op.jobId)!.acknowledged, false);
        await assert.rejects(foreign.cancel(op.jobId), /mcp_cancel_not_owned/);
        assert.notEqual(foreign.ownership(op.jobId)!.generation, owner.ownership(op.jobId)!.generation);
        const budget = new ProviderDeadline(undefined, 10_000, 0);
        try {
          const receipt = await owner.cancelOwned(op.jobId, budget);
          assert.equal(receipt.signalled, false); assert.equal(receipt.observedStatus, "completed"); assert.equal(receipt.terminalObserved, true);
          assert.equal(owner.ownership(op.jobId)!.acknowledged, true);
        } finally { budget.dispose(); }
        const events = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(events.filter(event => event.event === "execution").length, 1);
        await access(path.join(root, "mcp-jobs", op.jobId, "meta.json")); // stable, no random generation root
      });
    } finally { await foreign.close(); }
  });
});
test("C2 actual Python active owner: foreign cancel is refused without touching live worker; owning generation cancels once", { timeout: 20_000 }, async () => {
  await fixture({ AGY_PI_TEST_DELAY: "2" }, async (owner, root, env) => {
    const foreign = new AgyMcpClient({ ownerDirectory: root, command: python, args: [fixturePath], env });
    const op = operation(root);
    try {
      await withProviderDeadline(async scope => {
        await owner.startTurn({ jobId: op.jobId, prompt: "review", cwd: root, config }, scope);
        await foreign.connect(scope); // metadata only; same saved root grants no ownership
        await assert.rejects(foreign.cancel(op.jobId), /mcp_cancel_not_owned/);
        assert.equal((await owner.status(op.jobId, scope)).record.status, "running");
        assert.equal(foreign.ownedJobs().length, 0);
        const cancelBudget = new ProviderDeadline(undefined, 10_000, 0);
        try {
          const first = await owner.cancelOwned(op.jobId, cancelBudget);
          assert.equal(first.signalled, true);
          assert.deepEqual(await owner.cancelOwned(op.jobId, cancelBudget), first);
        } finally { cancelBudget.dispose(); }
        assert.equal((await completed(owner, op.jobId, scope)).record.status, "cancelled");
        assert.equal((await owner.result(op.jobId, scope)).record.status, "cancelled");
        const events = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(events.filter(event => event.event === "execution").length, 1);
      });
    } finally { await foreign.close(); }
  });
});


test("C3 actual Python public cwd projection binds home/token paths to frozen raw intent, not reconstructed cwd", { timeout: 20000 }, async () => {
  const { AssignmentStore } = await import("../src/state.js"); const { createAgyProvider } = await import("../src/provider.js");
  await fixture({}, async (client, root) => {
    const store = new AssignmentStore(path.join(root, "adapter"), "12345678-1234-4234-8234-abcdefabcdef", null);
    const provider = createAgyProvider({ store, client, env: { AGY_PI_MODEL: "fixture-model" } });
    for (const [index, leaf] of ["Users/fixture-user/projects", "home/fixture-user/projects", "projects/" + "a".repeat(64)].entries()) {
      const cwd = path.join(root, leaf); await mkdir(cwd, { recursive: true }); const canonical = await realpath(cwd);
      await withProviderDeadline(async scope => {
        const projection = await client.probeCommand(config, canonical, scope); assert.equal(projection.requestedCwdDigest, sha256Utf8(canonical));
        const h = await provider.start({ prompt: "advisory", promptDigest: sha256Utf8("advisory"), cwd: canonical, runId: `projection-${index}`, stepIndex: 0, agent: "agy-reviewer", options: {} });
        const status = await completed(client, h.providerJobId, scope); assert.notEqual(status.record.cwd, canonical); assert.equal(status.record.cwd, status.record.request.cwd); assert.equal(sha256Utf8(status.record.cwd), projection.cwdDigest);
        const turn = store.getTurn(h.providerJobId, scope); assert.equal(turn.claim.cwd, canonical); requireOperationMarker(status.record.request.prompt as string, turn.operationDigest);
        assert.equal((await provider.result(h.providerJobId)).state, "completed");
        const output = await provider.control({ action: "status", runId: `projection-${index}` }, store.ownerSessionId); assert.ok(!JSON.stringify(output).includes(canonical)); assert.ok(!JSON.stringify(output).includes("fixture-user"));
        const wire = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.ok(wire.some(row => row.event === "execution" && row.cwd === canonical));
      });
    }
  });
});
for (const vector of ["cwd", "config", "marker"] as const) test(`C3 actual Python changed ${vector} record fails closed, preserves lease and never retries`, { timeout: 20000 }, async () => {
  const { AssignmentStore } = await import("../src/state.js"); const { createAgyProvider } = await import("../src/provider.js");
  await fixture({}, async (client, root) => {
    const store = new AssignmentStore(path.join(root, "adapter"), "12345678-1234-4234-8234-abcdefabcdef", null);
    const provider = createAgyProvider({ store, client, env: { AGY_PI_MODEL: "fixture-model" } }); const canonical = await realpath(root);
    const input = { prompt: "advisory", promptDigest: sha256Utf8("advisory"), cwd: canonical, runId: "changed-record", stepIndex: 0, agent: "agy-reviewer", options: {} };
    const h = await provider.start(input);
    await withProviderDeadline(scope => completed(client, h.providerJobId, scope));
    const file = path.join(root, "mcp-jobs", h.providerJobId, "meta.json"); const record = JSON.parse(await readFile(file, "utf8"));
    if (vector === "cwd") { record.cwd = "/wrong/home/suffix"; record.request.cwd = record.cwd; }
    else if (vector === "config") record.request.sandbox = false;
    else record.request.prompt = "foreign operation marker";
    await writeFile(file, JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(provider.status(h.providerJobId), vector === "cwd" ? /cwd_mismatch/ : /mcp_record_uncorrelated/);
    await withProviderDeadline(async scope => { const turn = store.getTurn(h.providerJobId, scope); assert.equal(turn.phase, "dispatch_unknown"); await access(path.join(store.ownerDirectory, `${turn.assignmentId}.lease`)); });
    await assert.rejects(provider.start({ ...input, cwd: path.dirname(canonical) }), /operation_claim_collision/);
    const wire = (await readFile(path.join(root, "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.equal(wire.filter(row => row.event === "execution").length, 1);
  });
});
