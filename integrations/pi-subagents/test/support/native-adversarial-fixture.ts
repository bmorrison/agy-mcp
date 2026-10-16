import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { extractCorrectedOwner } from "./corrected-owner.js";
import { extractPublishedOwner } from "./published-owner.js";
import { RpcUiHost, rpcHostTheme } from "./rpc-ui-host.js";
import { findScriptedToolResult, registerScriptedSupervisor, type ScriptedReply } from "./scripted-supervisor.js";
import { AssignmentStore } from "../../src/state.js";
import { withProviderDeadline } from "../../src/deadline.js";
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export async function nativeAdversarialFixture(t: TestContext, backend: "node" | "python", name: string, missingAnchor = false, options: { owner?: "published"; hostMode?: "rpc" | "json"; modelEvidence?: boolean } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agy-pi-native-adversarial-")));
  const agentDir = path.join(root, "agent"); const cwd = path.join(root, "workspace");
  await fs.mkdir(path.join(agentDir, "npm/node_modules"), { recursive: true }); await fs.mkdir(cwd);
  await fs.symlink(packageRoot, path.join(agentDir, "npm/node_modules/agy-pi-subagents"), "dir");
  const oldEnv = process.env; const python = oldEnv.AGY_PI_TEST_PYTHON; assert.ok(python && path.isAbsolute(python));
  const evidence = path.join(root, "wire.jsonl");
  const owner = await (options.owner === "published" ? extractPublishedOwner : extractCorrectedOwner)(path.join(root, "owner"));
  process.env = { PATH: oldEnv.PATH, HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SUBAGENTS_TEMP_ROOT: path.join(root, "owner-temp"), AGY_PI_STATE_ROOT: path.join(root, "state"), AGY_PI_MODEL: options.modelEvidence ? undefined : "fixture-model", AGY_PI_TEST_CONFIGURED_MODEL: options.modelEvidence ? "Gemini 3.8 Flash (Medium)" : undefined, AGY_PI_TURN_TIMEOUT_SECONDS: "300", AGY_PI_TEST_EVIDENCE: evidence, AGY_PI_TEST_COMPLETION_ROOT: root, AGY_PI_TEST_MODE: missingAnchor ? "initOnly" : "normal", AGY_PI_TEST_INIT_ONLY: missingAnchor ? "1" : "0", AGY_PI_MCP_COMMAND: backend === "node" ? process.execPath : python, AGY_PI_MCP_ARGS: JSON.stringify(backend === "node" ? ["--import", "tsx", path.join(packageRoot, "test/support/fake-mcp-server.ts")] : [path.join(packageRoot, "test/support/python-mcp-server.py")]), PYTHONPATH: path.resolve(packageRoot, "../../src") + path.delimiter + path.join(packageRoot, "test/support"), PYTHONDONTWRITEBYTECODE: "1" };
  const settings = SettingsManager.inMemory({ packages: [packageRoot], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const errors: Error[] = []; const events: Record<string, unknown>[] = []; const sessions: AgentSession[] = []; const ui = options.hostMode === "json" ? undefined : new RpcUiHost(rpcHostTheme());
  let session: AgentSession; let manager: SessionManager;
  const rows = (): Record<string, unknown>[] => existsSync(evidence) ? readFileSync(evidence, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  async function until(check: () => boolean | Promise<boolean>, timeout = 15000) {
    const end = Date.now() + timeout;
    while (!await check()) { if (errors.length) throw errors[0]; if (Date.now() > end) throw new Error("native_adversarial_boundary_timeout"); await new Promise(r => setTimeout(r, 20)); }
    if (errors.length) throw errors[0];
  }
  const create = async (script: (request: number, last: unknown) => ScriptedReply | Promise<ScriptedReply>, reopen?: string) => {
    let previousCall: { id: string; name: string } | undefined;
    const fake = registerScriptedSupervisor(runtime, async (ctx, request) => {
      const last = previousCall ? findScriptedToolResult(ctx.messages, previousCall.id, previousCall.name) : ctx.messages.at(-1);
      events.push({ type: "script_boundary", request, previousCall, lastRole: last?.role, lastToolCallId: last?.role === "toolResult" ? last.toolCallId : undefined });
      const reply = await script(request, last);
      previousCall = "tool" in reply ? { id: `offline-call-${request}`, name: reply.tool } : undefined;
      return reply;
    }, e => errors.push(e));
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: [owner.entrypoint, path.join(packageRoot, "src/index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []); assert.equal(loader.getExtensions().extensions.length, 2);
    manager = reopen ? SessionManager.open(reopen) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
    session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: fake.model, thinkingLevel: "off", settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "builtin" })).session;
    sessions.push(session);
    session.subscribe(event => {
      if (event.type === "tool_execution_end") events.push({ type: event.type, tool: event.toolName, result: event.result, isError: event.isError });
      if (event.type === "message_end" && event.message.role === "custom") events.push({ type: "notice", customType: event.message.customType, content: event.message.content, details: event.message.details, idle: session.isIdle });
      if (event.type === "agent_settled") events.push({ type: event.type, idle: session.isIdle });
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") errors.push(new Error(event.message.errorMessage));
    });
    await session.bindExtensions({ mode: options.hostMode ?? "rpc", ...(ui ? { uiContext: ui.uiContext } : {}), onError: e => errors.push(new Error(JSON.stringify(e))) });
    assert.equal(session.extensionRunner.hasUI(), !!ui);
    return { session, fake, manager };
  };
  const retained = async (runId: string) => withProviderDeadline(async scope => new AssignmentStore(process.env.AGY_PI_STATE_ROOT!, manager.getSessionId(), manager.getSessionFile() ?? null).resolveRunTarget(runId, 0, scope).latest);
  const ready = async (runId: string) => until(async () => {
    try { const turn = await retained(runId); const s = JSON.parse(await fs.readFile(path.join(root, "owner-temp/async-subagent-runs", runId, "status.json"), "utf8")); return turn.phase === "acknowledged" && s.steps[0]?.externalJob?.providerJobId === turn.jobId && s.steps[0]?.runner?.type === "external-job"; } catch { return false; }
  });
  const report = path.join(oldEnv.AGY_PI_TEST_NATIVE_EVIDENCE_ROOT ?? "/private/tmp/agy-pi-c3-worker/native-adversarial-proofs", `${name}-${backend}-${path.basename(root)}`);
  t.after(async () => {
    await fs.mkdir(report, { recursive: true });
    const inventory: string[] = [];
    async function copy(dir: string) { if (!existsSync(dir)) return; for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await copy(p); else if (e.isFile() && (await fs.stat(p)).size <= 2097152) { const relative = path.relative(root, p); const out = path.join(report, "retained", relative); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.copyFile(p, out); inventory.push(relative); } } }
    await copy(path.join(root, "state")); await copy(path.join(root, "owner-temp"));
    await fs.writeFile(path.join(report, "proof.json"), JSON.stringify({ root, backend, name, provenance: owner.provenance, events, uiRequests: ui?.requests, wire: rows(), errors: errors.map(e => e.message), inventory }, null, 2));
    try {
      for (const s of sessions) { await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await s.abort(); s.dispose(); }
      const end = Date.now() + 5000;
      while (rows().filter(r => r.event === "fixture_process").some(r => { try { process.kill(Number(r.pid), 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } })) {
        if (Date.now() > end) throw new Error("owned_mcp_cleanup_timeout"); await new Promise(r => setTimeout(r, 20));
      }
      await fs.rm(root, { recursive: true, force: true });
      await fs.writeFile(path.join(report, "cleanup.json"), JSON.stringify({ root, allOwnedMcpPidsAbsent: true, removed: true }));
    } finally { ui?.dispose(); process.env = oldEnv; }
  });
  return { root, create, ready, retained, rows, until, events, errors, ui, release: async (index: number) => fs.writeFile(path.join(root, `completion-${index}`), "complete", { mode: 0o600 }) };
}
