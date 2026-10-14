import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, access, writeFile, copyFile, stat } from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { getExternalJobProvider } from "pi-subagents/external-job-provider";
import { RpcUiHost, rpcHostTheme } from "./support/rpc-ui-host.js";
import { registerScriptedSupervisor } from "./support/scripted-supervisor.js";
import { sha256Utf8 } from "../src/contracts.js";
import { extractCorrectedOwner } from "./support/corrected-owner.js";
import { AssignmentStore } from "../src/state.js";
import { withProviderDeadline } from "../src/deadline.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.AGY_PI_TEST_PYTHON;
assert.ok(python && path.isAbsolute(python), "explicit authorized Python required, no skip/fallback");
const rawReply = "Use the documented behavior; finish the advisory review.";
const wakeText = "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
async function waitFor(check: () => boolean, errors: Error[], milliseconds = 25000) {
  const end = Date.now() + milliseconds;
  while (!check()) { if (errors.length) throw errors[0]; if (Date.now() > end) assert.fail("native lifecycle did not settle within bounded fixture deadline"); await new Promise(r => setTimeout(r, 20)); }
  if (errors.length) throw errors[0];
}
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  if (!existsSync(root)) return result;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(target)); else if (entry.isFile()) result.push(target);
  }
  return result;
}
function nativeResults(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? nativeResults(file) : entry.isFile() && entry.name.endsWith(".result.md") ? [file] : [];
  });
}
function wireRows(file: string): Record<string, unknown>[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
for (const hostMode of ["ui-capable-rpc", "json-headless"] as const) for (const backend of ["node", "python"] as const) test(`Gate C REAL corrected owner ${hostMode}: ordinary two-run retained resume (${backend} MCP)`, { timeout: 60000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agy-pi-native-")));
  const agentDir = path.join(root, "agent"); const cwd = path.join(root, "workspace");
  const oldEnv = process.env;
  const uiCapable = hostMode === "ui-capable-rpc";
  const ui = uiCapable ? new RpcUiHost(rpcHostTheme()) : undefined;
  const evidenceDirectory = oldEnv.AGY_PI_TEST_NATIVE_EVIDENCE_ROOT ?? await mkdtemp(path.join(os.tmpdir(), "agy-pi-native-evidence-"));
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(evidenceDirectory, `${hostMode}-${backend}-${path.basename(root)}`);
  await mkdir(reportPath, { mode: 0o700 });
  const evidence = path.join(root, "wire-evidence.jsonl");
  const order: Record<string, unknown>[] = [];
  const record = (type: string, metadata: Record<string, unknown> = {}) => order.push({ sequence: order.length + 1, type, ...metadata });
  const release = (index: number) => { record("fixture_release", { index, idle: session?.isIdle }); writeFileSync(path.join(root, `completion-${index}`), "complete", { mode: 0o600 }); };
  let settled = 0; let passed = false; let proof: unknown; let provenance: unknown;
  let oldNativeResult: { file: string; bytes: string } | undefined;
  let session: AgentSession | undefined;
  const errors: Error[] = [];
  const notifications: { content: string; details: { runs: { runId: string; status: string }[] }; idle: boolean }[] = [];
  let firstRun = ""; let secondRun = ""; let idleBeforeQuestion = false; let finalWake = false;
  try {
    await mkdir(path.join(agentDir, "npm", "node_modules"), { recursive: true, mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    // Pinned owner discovers installed packages from disk, not SDK in-memory settings.
    await symlink(packageRoot, path.join(agentDir, "npm", "node_modules", manifest.name), "dir");
    await access(python!);
    const owner = await extractCorrectedOwner(path.join(root, "corrected-owner"));
    provenance = owner.provenance;
    process.env = { PATH: oldEnv.PATH, HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SUBAGENTS_TEMP_ROOT: path.join(root, "owner-temp"), AGY_PI_STATE_ROOT: path.join(root, "adapter-state"), AGY_PI_MODEL: "fixture-model", AGY_PI_TURN_TIMEOUT_SECONDS: "300", AGY_PI_TEST_EVIDENCE: evidence, AGY_PI_TEST_COMPLETION_ROOT: root, AGY_PI_MCP_COMMAND: backend === "node" ? process.execPath : python!, AGY_PI_MCP_ARGS: JSON.stringify(backend === "node" ? ["--import", "tsx", path.join(packageRoot, "test/support/fake-mcp-server.ts")] : [path.join(packageRoot, "test/support/python-mcp-server.py")]), PYTHONPATH: path.resolve(packageRoot, "../../src") + path.delimiter + path.join(packageRoot, "test/support"), PYTHONDONTWRITEBYTECODE: "1" };
    const settings = SettingsManager.inMemory({ packages: [packageRoot], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    const ready = async (runId: string, starts: number) => {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (errors.length) throw errors[0];
        const physical = wireRows(evidence).filter(row => backend === "node" ? row.name === "agy_start" : row.event === "execution");
        try {
          const status = JSON.parse(await readFile(path.join(root, "owner-temp/async-subagent-runs", runId, "status.json"), "utf8"));
          const step = status.steps[0];
          if (physical.length === starts && step.runner?.type === "external-job" && step.runner.provider === "agy-mcp" && step.externalJob?.providerJobId && step.externalJob.state === "running") {
            const observer = new AssignmentStore(process.env.AGY_PI_STATE_ROOT!, manager.getSessionId(), manager.getSessionFile() ?? null);
            await withProviderDeadline(async scope => { const target = observer.resolveRunTarget(runId, 0, scope); assert.equal(target.latest.phase, "acknowledged"); assert.equal(target.latest.jobId, step.externalJob.providerJobId); });
            record("verified_exact_mapping_ready", { runId, starts, providerJobId: step.externalJob.providerJobId }); return;
          }
        } catch { /* only bounded read-only readiness, no inference/adoption */ }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("fixture_exact_mapping_readiness_timeout");
    };
    const fake = registerScriptedSupervisor(runtime, async (context, request) => {
      const text = JSON.stringify(context.messages);
      const last = context.messages.at(-1);
      record("script_request", { request, idle: session?.isIdle, lastRole: last?.role, question: text.includes("Which behavior"), incomplete: text.includes("assignment incomplete"), final: text.includes("Review complete"), ownerWake: text.includes(wakeText) });
      if (request === 1) return { tool: "subagent", arguments: { action: "list", options: { capabilities: true } } };
      if (request === 2) return { tool: "subagent", arguments: { action: "get", agent: "agy-reviewer" } };
      if (request === 3) return { tool: "subagent", arguments: { agent: "agy-reviewer", task: "Review the documented behavior; yield a question first.", async: true } };
      if (request === 4) { assert.ok(firstRun); await ready(firstRun, 1); return { tool: "subagent", arguments: { action: "resume", id: firstRun, message: "Refuse running parent" } }; }
      if (request === 5) { assert.equal(last?.role, "toolResult"); return { tool: "subagent", arguments: { action: "steer", id: firstRun, message: "No live steer" } }; }
      if (request === 6) return { tool: "agy_subagent_control", arguments: { action: "queue", runId: firstRun, messageId: "native-guidance", message: "Queued only for explicit followup" } };
      if (request === 7) { assert.ok(firstRun && text.includes(firstRun)); if (!uiCapable) { assert.equal(session!.isIdle, false); release(1); } return { text: "Handing control back; awaiting checkpoint." }; }
      if (request === 8) {
        assert.ok(text.includes("Which behavior"), "native question reaches supervisor"); assert.ok(text.includes("assignment incomplete"), "native incomplete marker reaches supervisor");
        assert.equal(text.includes(wakeText), uiCapable, "only UI idle branch sends a separate owner wake");
        assert.equal(idleBeforeQuestion, uiCapable);
        if (uiCapable) {
          assert.ok(settled >= 1); assert.equal(notifications.length, 1);
        } else assert.equal(settled, 0, "headless completion delivered before first settled boundary");
        const resultFile = nativeResults(path.join(root, "owner-temp")).find(file => readFileSync(file, "utf8").includes(firstRun));
        assert.ok(resultFile, "older native result saved before resume");
        oldNativeResult = { file: resultFile, bytes: readFileSync(resultFile, "utf8") };
        return { tool: "subagent", arguments: { action: "resume", id: firstRun, message: rawReply } };
      }
      if (request === 9) { assert.ok(secondRun && secondRun !== firstRun && text.includes(secondRun)); await ready(secondRun, 2); return { tool: "agy_subagent_control", arguments: { action: "cancel", runId: firstRun } }; }
      if (request === 10) return { tool: "agy_subagent_control", arguments: { action: "status", runId: firstRun } };
      if (request === 11) { const result = last as { details?: { requested?: { runId: string }; latest?: { runId: string } } }; assert.equal(result.details?.requested?.runId, firstRun); assert.equal(result.details?.latest?.runId, secondRun); if (!uiCapable) release(2); return { text: "Awaiting the retained conversation's final checkpoint." }; }
      if (request === 12) { assert.equal(text.includes(wakeText), uiCapable); assert.ok(text.includes("Review complete"), "native final checkpoint reaches supervisor"); assert.ok(text.includes("assignment completed"), "native completed marker reaches supervisor"); finalWake = true; return { text: "Final checkpoint received; parent acceptance remains unrecorded." }; }
      assert.fail(`unexpected fake model request ${request}`);
    }, error => { errors.push(error); record("script_error", { message: error.message }); });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: [owner.entrypoint, path.join(packageRoot, "src/index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 2, "only real owner and real adapter extensions");
    const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
    const created = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: fake.model, thinkingLevel: "off", settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "builtin" });
    session = created.session;
    session.subscribe(event => {
      if (event.type === "tool_execution_end") {
        const result = event.result as { isError?: boolean; content?: { type: string; text?: string }[]; details?: Record<string, unknown> };
        const expectedRefusal = [4, 5, 9].includes(fake.requests.length);
        if (expectedRefusal) {
          try { assert.equal(event.isError || result.isError, true, "actual native/control refusal must be an error"); assert.match(JSON.stringify(result.content), fake.requests.length === 4 ? /running|completed|still active/i : fake.requests.length === 5 ? /external|steer|support/i : /stale_cancel_target/); record("expected_refusal", { request: fake.requests.length, tool: event.toolName }); }
          catch (error) { errors.push(error as Error); }
        } else if (event.isError || result.isError) errors.push(new Error(`native tool failed: ${JSON.stringify(result.content)}`));
        const d = result.details;
        record("tool_receipt", { tool: event.toolName, isError: event.isError, refusal: expectedRefusal ? { content: result.content, details: result.details } : undefined, asyncId: d?.asyncId, timeoutMs: d?.timeoutMs, context: d?.context, launchContractDigest: d?.launchContractDigest });
        if (typeof d?.asyncId === "string") { if (!firstRun) firstRun = d.asyncId; else secondRun = d.asyncId; }
      }
      if (event.type === "agent_end" || event.type === "agent_start" || event.type === "agent_settled" || event.type === "queue_update") {
        if (event.type === "agent_settled") settled++;
        record(event.type, { idle: session!.isIdle, settled });
      }
      if (event.type === "message_end" && event.message.role === "user") record("user_message", { ownerWake: JSON.stringify(event.message.content).includes(wakeText), idle: session!.isIdle });
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") errors.push(new Error(event.message.errorMessage ?? "scripted_assistant_error"));
      if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "subagent-notify") {
        const msg = event.message;
        const idle = session!.isIdle;
        if (notifications.length === 0) idleBeforeQuestion = idle;
        record("native_notification", { idle, runIds: (msg.details as { runs: { runId: string }[] }).runs.map(run => run.runId) });
        notifications.push({ content: String(msg.content), details: msg.details as { runs: { runId: string; status: string }[] }, idle });
      }
    });
    await session.bindExtensions({ mode: uiCapable ? "rpc" : "json", ...(ui ? { uiContext: ui.uiContext } : {}), onError: e => errors.push(new Error(JSON.stringify(e))) });
    assert.equal(session.extensionRunner.hasUI(), uiCapable, "SDK derives capability from the functioning bound UI");
    assert.ok(getExternalJobProvider("agy-mcp"));
    assert.ok(session.getActiveToolNames().includes("subagent"), "RPC/JSON owner directly registers the ordinary tool for this fresh scripted model");
    assert.ok(!session.getActiveToolNames().includes("subagents_enable"));
    assert.equal((await readdir(root)).includes("adapter-state"), false, "session binding/discovery is lazy");
    await session.prompt("Launch the authorized AGY advisory reviewer and wait for its checkpoint.");
    if (errors.length) throw errors[0];
    if (uiCapable) {
      await session.waitForIdle(); assert.equal(session.isIdle, true); assert.equal(settled, 1);
      assert.equal(fake.requests.length, 7); assert.equal(notifications.length, 0);
      assert.equal(wireRows(evidence).filter(row => row.event === "fixture_completed").length, 0);
      record("verified_settled_idle_before_question", { idle: true }); release(1);
      await waitFor(() => settled >= 2 && session!.isIdle, errors);
      assert.equal(fake.requests.length, 11); assert.equal(notifications.length, 1);
      record("verified_settled_idle_before_final", { idle: true }); release(2);
    }
    assert.deepEqual(errors, []);
    assert.ok(fake.requests.length >= 4, "initial launch returned control to the supervisor");
    await waitFor(() => finalWake, errors);
    await session.waitForIdle(); assert.deepEqual(errors, []);
    assert.deepEqual(fake.errors, []);
    assert.equal(fake.requests.length, 12); assert.equal(notifications.length, 2); assert.ok(firstRun && secondRun && firstRun !== secondRun);
    assert.deepEqual(notifications.map(n => n.details.runs[0].runId), [firstRun, secondRun]);
    assert.deepEqual(notifications.map(n => n.details.runs[0].status), ["completed", "completed"]);
    assert.deepEqual(notifications.map(n => n.idle), [uiCapable, uiCapable]);
    const ownerWakes = order.filter(event => event.type === "user_message" && event.ownerWake === true);
    assert.equal(ownerWakes.length, uiCapable ? 2 : 0, "two real owner wake messages in RPC; none in queued headless path");
    const receipts = order.filter(event => event.type === "tool_receipt" && event.asyncId);
    assert.equal(receipts.length, 2); assert.equal(receipts[0].timeoutMs, 600000, "initial launch actually uses supported native default");
    if (uiCapable) {
      const idleBoundaries = order.filter(event => typeof event.type === "string" && event.type.startsWith("verified_settled_idle_before_"));
      const notices = order.filter(event => event.type === "native_notification");
      for (let index = 0; index < 2; index++) {
        assert.ok(Number(idleBoundaries[index].sequence) < Number(notices[index].sequence));
        assert.ok(Number(notices[index].sequence) < Number(ownerWakes[index].sequence));
      }
    } else assert.equal(settled, 1, "headless queued turns finish before the only final settled boundary");
    assert.match(notifications[0].content, /question.*waiting_for_supervisor/s); assert.match(notifications[0].content, /assignment incomplete/);
    assert.match(notifications[1].content, /completed.*assignment completed/s);
    assert.ok(fake.requests.some(c => getCurrentSystemPrompt(c.messages)?.includes("agy-reviewer")), "file agent is advertised in the real supervisor prompt");
    const listResult = session.messages.filter(m => m.role === "toolResult" && m.toolName === "subagent")[0];
    assert.ok(listResult?.role === "toolResult");
    const capabilities = (listResult.details as { agentCapabilities: { agents: Record<string, unknown>[] } }).agentCapabilities.agents;
    const discovered = capabilities.find(a => a.name === "agy-reviewer"); assert.ok(discovered); assert.equal(discovered.source, "package");
    assert.match(JSON.stringify(discovered), /600000/);
    assert.ok(oldNativeResult); assert.equal(await readFile(oldNativeResult.file, "utf8"), oldNativeResult.bytes, "older native saved result is byte-immutable after resume");
    await copyFile(oldNativeResult.file, path.join(reportPath, "older-native-result.md"));
    const store = new AssignmentStore(process.env.AGY_PI_STATE_ROOT!, manager.getSessionId(), manager.getSessionFile() ?? null);
    await withProviderDeadline(async scope => {
      const a = store.resolveRunTarget(firstRun, 0, scope); const b = store.resolveRunTarget(secondRun, 0, scope);
      assert.equal(a.requested.semanticState, "waiting_for_supervisor"); assert.equal(a.latest.jobId, b.latest.jobId); assert.equal(b.latest.semanticState, "completed");
      assert.equal(a.requested.conversationId, "12345678-1234-4234-8234-123456789abc");
      assert.equal(a.requested.conversationId, b.latest.conversationId); assert.equal(b.latest.expectedConversation, a.requested.conversationId);
      assert.equal(a.requested.claim.cwd, cwd); assert.equal(b.latest.claim.cwd, cwd); assert.deepEqual(a.requested.config, b.latest.config);
      assert.equal(b.latest.claim.parentProviderJobId, a.requested.jobId);
      assert.equal(b.latest.queueSnapshot.length, 1); assert.equal(b.latest.queueSnapshot[0].messageId, "native-guidance"); assert.match(b.latest.output!, /forwarded/);
      assert.equal(order.filter(e => e.type === "expected_refusal").length, 3);
      assert.notEqual(b.latest.claim.promptDigest, sha256Utf8(rawReply)); assert.notEqual(b.latest.claim.requestDigest, b.latest.claim.promptDigest);
      assert.equal(b.latest.claim.requestId, `follow-up-${b.latest.claim.requestDigest!.slice(0, 48)}`);
      assert.match(a.requested.output!, new RegExp(firstRun)); assert.ok(!a.requested.output!.includes(secondRun));
      assert.match(b.latest.output!, new RegExp(secondRun));
      assert.equal((await getExternalJobProvider("agy-mcp")!.result(a.requested.jobId)).output, a.requested.output);
      proof = { first: a.requested, second: b.latest };
    });
    const wire = (await readFile(evidence, "utf8")).trim().split("\n").map(l => JSON.parse(l));
    const starts = wire.filter(e => backend === "node" ? e.name === "agy_start" : e.event === "execution");
    assert.equal(starts.length, 2, "exactly two fake AGY starts; dry-run probes are not inference");
    assert.equal(starts[0].SESSION_ID ?? starts[0].session_id ?? null, null); assert.equal(starts[1].SESSION_ID ?? starts[1].session_id, "12345678-1234-4234-8234-123456789abc");
    for (const s of starts) { assert.equal(s.cd ?? s.cwd, cwd); assert.equal(s.model, "fixture-model"); assert.equal(s.mode, "review"); assert.equal(s.sandbox, true); assert.equal(s.allow_write, false); assert.equal(s.worktree, false); assert.equal(s.timeout, 300); assert.equal(s.output_protocol, "raw"); }
    assert.equal((await readdir(cwd)).length, 0, "advisory fixture workspace unchanged");
    passed = true;
    record("assertions_passed", { firstRun, secondRun, starts: starts.length, nativeResultsImmutable: true });
    console.log(JSON.stringify({ backend, hostMode, reportPath, firstRun, secondRun, starts: starts.length, passed }));
  } catch (error) {
    record("test_failure", { message: error instanceof Error ? error.message : String(error) }); throw error;
  } finally {
    // Preserve bounded state/wire/native proof BEFORE disposal and fixture cleanup, even on failure.
    try {
      const retainedFiles: { file: string; bytes: number; metadata?: unknown }[] = [];
      for (const base of ["adapter-state", "owner-temp"]) for (const file of await files(path.join(root, base))) {
        const item: { file: string; bytes: number; metadata?: unknown } = { file: path.relative(root, file), bytes: (await stat(file)).size };
        if (file.endsWith(".json") && item.bytes <= 128000) {
          try {
            const data = JSON.parse(await readFile(file, "utf8"));
            const { version, jobId, assignmentId, operationDigest, claim, config, expectedConversation, conversationId, phase, semanticState, checkpoint, output, errorCode, evidence: stateEvidence, runId, status, steps } = data;
            item.metadata = { version, jobId, assignmentId, operationDigest, claim, config, expectedConversation, conversationId, phase, semanticState, checkpoint, output, errorCode, evidence: stateEvidence, runId, status, steps: steps?.map((step: Record<string, unknown>) => ({ status: step.status, externalJob: step.externalJob })) };
          } catch { item.metadata = { unreadable: true }; }
        }
        retainedFiles.push(item);
        if (file.endsWith(".result.md") && item.bytes <= 12000) await copyFile(file, path.join(reportPath, `${retainedFiles.length}-native-result.md`));
      }
      await writeFile(path.join(reportPath, "proof.json"), JSON.stringify({ backend, hostMode, root, passed, provenance, firstRun, secondRun, order, notifications, proof, retainedFiles, wire: wireRows(evidence), uiRequests: ui?.requests }, null, 2), { mode: 0o600 });
    } finally {
      try {
        if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose(); }
        for (const row of wireRows(evidence).filter(row => row.event === "fixture_process")) await waitFor(() => {
          try { process.kill(row.pid as number, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
        }, [], 5000);
        ui?.dispose();
        await writeFile(path.join(reportPath, "cleanup.json"), JSON.stringify({ root, fixturePids: wireRows(evidence).filter(row => row.event === "fixture_process"), shutdown: true, disposed: true }), { mode: 0o600 });
      } finally { process.env = oldEnv; await rm(root, { recursive: true, force: true }); }
    }
  }
});

// Actual owner/tool regressions; direct provider tests are not native proof.
for (const backend of ["node", "python"] as const) test(`Gate C REAL owner native local-stop/deadline versus explicit owning cancel (${backend})`, { timeout: 60000 }, async t => {
  const { nativeAdversarialFixture } = await import("./support/native-adversarial-fixture.js");
  const f = await nativeAdversarialFixture(t, backend, "stop-cancel-deadline"); let first = ""; let second = ""; let controlsComplete = false;
  const host = await f.create(async (request, last) => {
    const result = last as { toolCallId?: string; toolName?: string; details?: { asyncId?: string; requested?: { runId: string; index: number }; latest?: { runId: string; index: number }; cancellation?: { signalled: boolean; terminalCorrelated: boolean }; status?: { semanticState: string } }; isError?: boolean };
    if (request === 1) return { tool: "subagent", arguments: { agent: "agy-reviewer", task: "Hold this advisory turn", async: true } };
    if (request === 2) { first = result.details!.asyncId!; await f.ready(first); return { tool: "subagent", arguments: { action: "stop", id: first } }; }
    if (request === 3) { assert.ok(!result.isError); assert.equal(f.rows().filter(r => r.name === "agy_cancel").length, 0); assert.notEqual((await f.retained(first)).phase, "terminal"); return { tool: "agy_subagent_control", arguments: { action: "cancel", runId: first } }; }
    if (request === 4) { assert.equal(result.toolCallId, "offline-call-3"); assert.equal(result.toolName, "agy_subagent_control"); assert.deepEqual(result.details?.requested, { runId: first, index: 0 }); assert.deepEqual(result.details?.latest, { runId: first, index: 0 }); assert.equal(result.isError, false); assert.equal(result.details?.cancellation?.signalled, true); assert.equal(result.details?.cancellation?.terminalCorrelated, true); assert.equal(result.details?.status?.semanticState, "cancelled"); return { tool: "subagent", arguments: { agent: "agy-reviewer", task: "Short native observer deadline", async: true, options: { timeoutMs: 5000 } } }; }
    if (request === 5) { second = result.details!.asyncId!; await f.ready(second); return { text: "Observer deadline is not upstream cancellation." }; }
    if (request === 6) {
      await f.until(async () => { try { const native = JSON.parse(await readFile(path.join(f.root, "owner-temp/async-subagent-runs", second, "status.json"), "utf8")); return native.runId === second && native.state === "failed" && native.timedOut === true && native.timeoutMs === 5000 && /timed out after 5000ms/.test(native.error); } catch { return false; } });
      const native = JSON.parse(await readFile(path.join(f.root, "owner-temp/async-subagent-runs", second, "status.json"), "utf8"));
      const turn = await f.retained(second); f.events.push({ type: "pre_second_cancel_native_timeout", runId: second, jobId: turn.jobId, phase: turn.phase, nativeState: native.state, timedOut: native.timedOut, timeoutMs: native.timeoutMs, error: native.error, upstreamCancels: f.rows().filter(r => r.name === "agy_cancel").length });
      assert.equal(f.rows().filter(r => r.name === "agy_cancel").length, 1); assert.notEqual((await f.retained(second)).phase, "terminal"); return { tool: "agy_subagent_control", arguments: { action: "cancel", runId: second } }; }
    if (request === 7) { assert.equal(result.toolCallId, "offline-call-6"); assert.equal(result.toolName, "agy_subagent_control"); assert.deepEqual(result.details?.requested, { runId: second, index: 0 }); assert.deepEqual(result.details?.latest, { runId: second, index: 0 }); assert.equal(result.details?.cancellation?.terminalCorrelated, true); assert.equal(result.details?.cancellation?.signalled, true); assert.equal(result.details?.status?.semanticState, "cancelled"); controlsComplete = true; return { text: "Only explicit owning cancellation observed." }; }
    if (controlsComplete) return { text: "Acknowledged the already-observed native notices; no new work or controls." };
    assert.fail(`unexpected adversarial request ${request}`);
  });
  await host.session.prompt("Exercise native observation controls only."); await f.until(() => controlsComplete && host.session.isIdle);
  assert.deepEqual(f.errors, []); assert.equal(f.rows().filter(r => backend === "node" ? r.name === "agy_start" : r.event === "execution").length, 2);
  const noticeFor = (runId: string, status: string) => f.events.find(e => e.type === "notice" && e.customType === "subagent-notify" && (e.details as { runs: { runId: string; status: string }[] }).runs.some(r => r.runId === runId && r.status === status));
  await f.until(() => !!noticeFor(first, "stopped") && !!noticeFor(second, "failed") && host.session.isIdle);
  assert.match(String(noticeFor(first, "stopped")!.content), /stopped by user/); assert.match(String(noticeFor(second, "failed")!.content), /timed out after 5000ms/);
  const cancels = f.rows().filter(r => r.name === "agy_cancel"); assert.equal(cancels.length, 2); assert.notEqual(cancels[0].job_id, cancels[1].job_id); assert.deepEqual(cancels.map(r => r.job_id), [(await f.retained(first)).jobId, (await f.retained(second)).jobId]);
  const nativeDeadlineReceipt = f.events.find(e => e.type === "tool_execution_end" && (e.result as { details?: { asyncId?: string } }).details?.asyncId === second)!;
  assert.equal((nativeDeadlineReceipt.result as { details: { timeoutMs: number } }).details.timeoutMs, 5000);
});
for (const backend of ["node", "python"] as const) test(`Gate C REAL owner completed checkpoint restart and missing CLI anchor refuse (${backend})`, { timeout: 60000 }, async t => {
  const { nativeAdversarialFixture } = await import("./support/native-adversarial-fixture.js");
  const f = await nativeAdversarialFixture(t, backend, "restart"); let first = ""; let second = "";
  const host = await f.create(async (request, last) => {
    const result = last as { details?: { asyncId?: string } };
    if (request === 1) return { tool: "subagent", arguments: { agent: "agy-reviewer", task: "Question checkpoint", async: true } };
    if (request === 2) { first = result.details!.asyncId!; await f.ready(first); return { text: "Wait idle for question." }; }
    if (request === 3) return { text: "Question saved for explicit restart." };
    assert.fail(`unexpected prere start request ${request}`);
  });
  await host.session.prompt("Launch and wait."); await host.session.waitForIdle(); await f.release(1); await f.until(() => host.fake.requests.length === 3 && host.session.isIdle);
  const before = await f.retained(first); const sessionFile = host.manager.getSessionFile()!;
  await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" }); host.session.dispose();
  const restarted = await f.create(async (request, last) => {
    const result = last as { details?: { asyncId?: string; status?: { semanticState: string } } };
    if (request === 1) return { tool: "agy_subagent_control", arguments: { action: "status", runId: first } };
    if (request === 2) { assert.equal(result.details?.status?.semanticState, "waiting_for_supervisor"); assert.equal(f.rows().filter(r => backend === "node" ? r.name === "agy_start" : r.event === "execution").length, 1); return { tool: "subagent", arguments: { action: "resume", id: first, message: rawReply } }; }
    if (request === 3) { second = result.details!.asyncId!; await f.ready(second); return { text: "Wait idle for retained final." }; }
    if (request === 4) return { text: "Completed after clean public session restart." };
    assert.fail(`unexpected restart request ${request}`);
  }, sessionFile);
  await restarted.session.prompt("Explicitly resume saved checkpoint."); await restarted.session.waitForIdle(); await f.release(2); await f.until(() => restarted.fake.requests.length === 4 && restarted.session.isIdle);
  const after = await f.retained(second); assert.equal(after.conversationId, before.conversationId); assert.equal(after.claim.cwd, before.claim.cwd); assert.deepEqual(after.config, before.config); assert.equal((await f.retained(first)).output, after.output); // target resolution is latest; older bytes below
  const observer = new AssignmentStore(process.env.AGY_PI_STATE_ROOT!, restarted.manager.getSessionId(), restarted.manager.getSessionFile() ?? null);
  await withProviderDeadline(async scope => assert.equal(observer.resolveRunTarget(first, 0, scope).requested.output, before.output));
  assert.equal(f.rows().filter(r => backend === "node" ? r.name === "agy_start" : r.event === "execution").length, 2);
});
for (const backend of ["node", "python"] as const) test(`Gate C REAL owner init-only conversation evidence fails checkpoint and resume (${backend})`, { timeout: 60000 }, async t => {
  const { nativeAdversarialFixture } = await import("./support/native-adversarial-fixture.js");
  const f = await nativeAdversarialFixture(t, backend, "missing-anchor", true); let first = "";
  const host = await f.create(async (request, last) => {
    const result = last as { details?: { asyncId?: string }; isError?: boolean };
    if (request === 1) return { tool: "subagent", arguments: { agent: "agy-reviewer", task: "Unobserved fixture", async: true } };
    if (request === 2) { first = result.details!.asyncId!; await f.ready(first); return { text: "Wait for fail-closed notification." }; }
    if (request === 3) { assert.equal((await f.retained(first)).errorCode, "conversation_unobserved"); return { tool: "subagent", arguments: { action: "resume", id: first, message: "Must refuse this failed checkpoint" } }; }
    if (request === 4) { assert.equal(result.isError, true); return { text: "Missing CLI identity refused, no fallback." }; }
    assert.fail(`unexpected init-only request ${request}`);
  });
  await host.session.prompt("Launch offline negative."); await host.session.waitForIdle(); await f.release(1); await f.until(() => host.fake.requests.length === 4 && host.session.isIdle);
  assert.equal(f.rows().filter(r => backend === "node" ? r.name === "agy_start" : r.event === "execution").length, 1); assert.equal((await f.retained(first)).semanticState, "failed");
});
