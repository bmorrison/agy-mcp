import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { getExternalJobProvider, registerExternalJobProvider, type ExternalJobProvider } from "pi-subagents/external-job-provider";
import extension, { assertPublicProviderApi } from "../src/index.js";
import { createControlTool, ControlParameters, ControlOutput } from "../src/control-tool.js";
import { providerFixture, OWNER } from "./support/provider-fixture.js";
function context(owner = OWNER) { return { sessionManager: { getSessionId: () => owner, getSessionFile: () => undefined } } as unknown as ExtensionToolContext; }

test("control-tool.ts strict action-specific TypeBox/output schema, fixed failure, non-read-only annotation", async t => {
  const f = await providerFixture(t, "running"); const tool = createControlTool(() => f.provider);
  for (const invalid of [{ action: "launch", runId: "r" }, { action: "status", runId: "r", message: "private" }, { action: "cancel", runId: "r", model: "private" }, { action: "queue", runId: "r", message: "private" }, { action: "status", runId: "r", index: -1 }, { action: "queue", runId: "r", messageId: "m", message: "private", command: "x" }]) assert.equal(Check(ControlParameters, invalid), false);
  assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.outputSchema, ControlOutput);
  const absent = await createControlTool(() => undefined).execute("id", { action: "status", runId: "unknown" }, undefined, undefined, context()); assert.equal(absent.isError, true); assert.equal(Check(ControlOutput, absent.structuredContent), true);
  await f.provider.start(f.input());
  for (const input of [{ action: "status" as const, runId: "run-1" }, { action: "queue" as const, runId: "run-1", messageId: "m", message: "private body" }, { action: "cancel" as const, runId: "run-1" }]) {
    const result = await tool.execute("id", input, undefined, undefined, context()); assert.ok(!result.isError); assert.equal(Check(ControlOutput, result.structuredContent), true); assert.deepEqual(result.details, result.structuredContent); assert.ok(!JSON.stringify(result).includes("private body"));
  }
  const foreign = await tool.execute("id", { action: "status", runId: "run-1" }, undefined, undefined, context("foreign")); assert.equal(foreign.isError, true); assert.equal(JSON.stringify(foreign).includes("foreign"), false);
  const unknown = await tool.execute("id", { action: "status", runId: "native-other" }, undefined, undefined, context()); assert.equal(unknown.isError, true); assert.equal(Check(ControlOutput, unknown.structuredContent), true);
});

test("index.ts unsupported public provider API rejects explicitly without a version comparison", () => {
  for (const value of [null, {}, { getExternalJobProvider() {}, registerExternalJobProvider() {}, ExternalJobProviderError: Error, EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION: 2 }]) assert.throws(() => assertPublicProviderApi(value), /unsupported_provider_api/);
  assert.doesNotThrow(() => assertPublicProviderApi({ getExternalJobProvider() {}, registerExternalJobProvider() {}, ExternalJobProviderError: Error, EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION: 1 }));
});

test("control output permits absent/complete/null display observations, rejects unknown fields", async t => {
  const f = await providerFixture(t); const h = await f.provider.start(f.input());
  const status = (await f.provider.control({ action: "status", runId: "run-1" }, OWNER)).status;
  const base = { ok: true, requested: { runId: "run-1", index: 0 }, latest: { runId: "run-1", index: 0 }, status };
  const { modelEvidence, executionMetadata, ...legacy } = status;
  assert.equal(Check(ControlOutput, { ...base, status: legacy }), true);
  assert.equal(Check(ControlOutput, base), true); assert.equal(executionMetadata, null);
  const datum = { model: { value: "Gemini 3.8 Flash", source: "configured" } };
  assert.equal(Check(ControlOutput, { ...base, status: { ...status, executionMetadata: datum } }), true);
  assert.equal(Check(ControlOutput, { ...base, status: { ...status, executionMetadata: { ...datum, rawConfig: {} } } }), false);
  assert.equal(Check(ControlOutput, { ...base, status: { ...status, modelEvidence: { ...modelEvidence, effective: "verified" } } }), false);
  assert.equal(Check(ControlOutput, { ...base, status: { ...status, executionMetadata: { model: { value: "bad\nline", source: "configured" } } } }), false);
  assert.deepEqual(Object.keys(h).sort(), ["providerJobId", "state"]);
});

test("PR5 platform: unsupported extension host rejects before tool/event/provider registration", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!; let registrations = 0;
  const pi = { on: () => registrations++, registerTool: () => registrations++ } as unknown as ExtensionAPI;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    assert.throws(() => extension(pi), /unsupported_platform/);
    assert.equal(registrations, 0); assert.equal(getExternalJobProvider("agy-mcp"), undefined);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("index.ts lazy factory/session declaration; exact collision and owned idempotent replacement/shutdown", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-pi-extension-")); const oldRoot = process.env.AGY_PI_STATE_ROOT; process.env.AGY_PI_STATE_ROOT = path.join(root, "state");
  t.after(async () => { if (oldRoot === undefined) delete process.env.AGY_PI_STATE_ROOT; else process.env.AGY_PI_STATE_ROOT = oldRoot; await fs.rm(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>(); const tools: unknown[] = [];
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.set(name, handler); }, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI;
  extension(pi); assert.deepEqual([...handlers.keys()], ["session_start", "session_shutdown"]); assert.equal(tools.length, 1); assert.deepEqual(await fs.readdir(root), []);
  const foreign: ExternalJobProvider = { name: "agy-mcp", start: () => { throw new Error("never"); }, status: () => { throw new Error("never"); }, result: () => { throw new Error("never"); }, reattach: () => { throw new Error("never"); } };
  const disposeForeign = registerExternalJobProvider(foreign); await assert.rejects(handlers.get("session_start")!({}, context()), /provider_registration_collision/); assert.equal(getExternalJobProvider("agy-mcp"), foreign); await handlers.get("session_shutdown")!({}, context()); assert.equal(getExternalJobProvider("agy-mcp"), foreign); disposeForeign();
  await handlers.get("session_start")!({}, context()); const first = getExternalJobProvider("agy-mcp"); assert.ok(first); assert.deepEqual(await fs.readdir(root), []);
  await handlers.get("session_start")!({}, context()); const next = getExternalJobProvider("agy-mcp"); assert.ok(next); assert.notEqual(first, next);
  await Promise.all([handlers.get("session_shutdown")!({}, context()), handlers.get("session_shutdown")!({}, context())]); assert.equal(getExternalJobProvider("agy-mcp"), undefined); assert.deepEqual(await fs.readdir(root), []);
});

test("scripted-supervisor.ts exact previous-call selector ignores trailing native messages, never earlier/wrong/missing result", async () => {
  const { findScriptedToolResult } = await import("./support/scripted-supervisor.js");
  const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "agy_subagent_control", arguments: {} }] });
  const result = (id: string, name = "agy_subagent_control") => ({ role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false, timestamp: 0 });
  const messages = [call("first"), result("first"), call("second"), result("second"), { role: "custom", content: "native notice" }, { role: "user", content: [{ type: "text", text: "owner wake" }], timestamp: 0 }];
  const select = (values: unknown[]) => findScriptedToolResult(values as Parameters<typeof findScriptedToolResult>[0], "second", "agy_subagent_control");
  assert.equal(select(messages).toolCallId, "second");
  for (const invalid of [[call("first"), result("first"), call("second")], [call("second"), result("wrong")], [call("second"), result("second", "subagent")], [result("second"), call("second")], [result("second")]]) assert.throws(() => select(invalid), /scripted_matching/);
});
