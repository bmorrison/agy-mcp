import test from "node:test";
import assert from "node:assert/strict";
import { RpcUiHost, rpcHostTheme } from "./support/rpc-ui-host.js";

test("RpcUiHost correlated dialogs, cancellation, notifications and presentation state", async () => {
  const host = new RpcUiHost(rpcHostTheme()); const ui = host.uiContext;
  const selection = ui.select("Choose", ["Allow", "Block"]);
  const selectId = host.requests.at(-1)!.id;
  assert.equal(host.respond({ type: "extension_ui_response", id: "wrong", value: "Allow" }), false);
  assert.equal(host.respond({ type: "extension_ui_response", id: selectId, confirmed: true }), false);
  assert.equal(host.respond({ type: "extension_ui_response", id: selectId, value: "invalid" }), false);
  assert.equal(host.respond({ type: "extension_ui_response", id: selectId, value: "Allow" }), true);
  assert.equal(await selection, "Allow");
  assert.equal(host.respond({ type: "extension_ui_response", id: selectId, value: "Allow" }), false);
  const confirm = ui.confirm("Continue?", "Advisory only");
  host.respond({ type: "extension_ui_response", id: host.requests.at(-1)!.id, confirmed: false }); assert.equal(await confirm, false);
  const input = ui.input("Name", "placeholder");
  host.respond({ type: "extension_ui_response", id: host.requests.at(-1)!.id, value: "response" }); assert.equal(await input, "response");
  const editor = ui.editor("Edit", "prefill\ntext");
  host.respond({ type: "extension_ui_response", id: host.requests.at(-1)!.id, value: "edited\ntext" }); assert.equal(await editor, "edited\ntext");
  const cancelled = ui.confirm("Cancel?", "");
  host.respond({ type: "extension_ui_response", id: host.requests.at(-1)!.id, cancelled: true }); assert.equal(await cancelled, false);
  ui.notify("Visible", "warning"); assert.deepEqual(host.notifications, [{ message: "Visible", type: "warning" }]);
  ui.setStatus("owner", "running"); assert.equal(host.statuses.get("owner"), "running"); ui.setStatus("owner", undefined); assert.equal(host.statuses.size, 0);
  ui.setWidget("owner", ["line"], { placement: "belowEditor" }); assert.deepEqual(host.widgets.get("owner"), { lines: ["line"], placement: "belowEditor" });
  ui.setWidget("owner", undefined); assert.equal(host.widgets.size, 0);
  ui.setTitle("Advisory"); assert.equal(host.title, "Advisory"); ui.pasteToEditor("input"); assert.equal(host.editorText, "input");
  assert.equal(ui.getEditorText(), ""); assert.equal(await ui.custom(() => { throw Error("RPC must not run terminal components"); }), undefined);
  assert.deepEqual(ui.setTheme("dark"), { success: false, error: "Theme switching not supported in RPC mode" });
  assert.equal(ui.getToolsExpanded(), false); assert.deepEqual(ui.getAllThemes(), []);
  assert.match(ui.theme.fg("text", "rendered"), /rendered/);
  host.dispose();
});

test("RpcUiHost abort, timeout, disposal and automatic client response settle dialogs", async () => {
  const host = new RpcUiHost(rpcHostTheme()); const ui = host.uiContext;
  const controller = new AbortController(); const input = ui.input("Abort", undefined, { signal: controller.signal });
  controller.abort(); assert.equal(await input, undefined);
  const count = host.requests.length; assert.equal(await ui.select("Already aborted", ["x"], { signal: controller.signal }), undefined); assert.equal(host.requests.length, count);
  assert.equal(await ui.select("Timeout", ["x"], { timeout: 1 }), undefined);
  const pending = ui.editor("Dispose"); host.dispose(); assert.equal(await pending, undefined);
  const automatic = new RpcUiHost(rpcHostTheme(), (request, client) => {
    if (request.method === "confirm") client.respond({ type: "extension_ui_response", id: request.id, confirmed: true });
  });
  assert.equal(await automatic.uiContext.confirm("Authorized?", "Offline fixture"), true); automatic.dispose();
});

test("RpcUiHost public SDK binding executes functional extension dialogs and presentation", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { registerScriptedSupervisor } = await import("./support/scripted-supervisor.js");
  const root = await mkdtemp(path.join(tmpdir(), "agy-rpc-ui-helper-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const host = new RpcUiHost(rpcHostTheme(), (request, client) => {
    if (request.method === "select") client.respond({ type: "extension_ui_response", id: request.id, value: request.options[1] });
    if (request.method === "confirm") client.respond({ type: "extension_ui_response", id: request.id, confirmed: true });
    if (request.method === "input" || request.method === "editor") client.respond({ type: "extension_ui_response", id: request.id, value: "client answer" });
  });
  const errors: unknown[] = []; let exercised = false;
  try {
    const agentDir = path.join(root, "agent"); await mkdir(agentDir);
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const fake = registerScriptedSupervisor(runtime, () => { throw Error("UI binding must not call a model"); });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [pi => {
      pi.on("session_start", async (_event, ctx) => {
        assert.equal(ctx.mode, "rpc"); assert.equal(ctx.hasUI, true);
        assert.equal(await ctx.ui.select("Select", ["deny", "allow"]), "allow");
        assert.equal(await ctx.ui.confirm("Confirm", "Offline UI test only"), true);
        assert.equal(await ctx.ui.input("Input"), "client answer");
        assert.equal(await ctx.ui.editor("Editor"), "client answer");
        ctx.ui.notify("UI binding works", "info"); ctx.ui.setStatus("probe", "ready"); ctx.ui.setWidget("probe", ["visible"]); ctx.ui.setTitle("Bound RPC"); ctx.ui.setEditorText("draft");
        exercised = true;
      });
    }] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: fake.model, settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader: loader, noTools: "builtin" }));
    await session.bindExtensions({ mode: "rpc", uiContext: host.uiContext, onError: error => errors.push(error) });
    assert.deepEqual(errors, []); assert.equal(exercised, true); assert.equal(fake.requests.length, 0);
    assert.deepEqual(host.notifications, [{ message: "UI binding works", type: "info" }]); assert.equal(host.statuses.get("probe"), "ready"); assert.deepEqual(host.widgets.get("probe")?.lines, ["visible"]); assert.equal(host.title, "Bound RPC"); assert.equal(host.editorText, "draft");
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    host.dispose(); await rm(root, { recursive: true, force: true });
  }
});

test("scripted-supervisor exposes original assertion immediately, not as outer timeout", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { registerScriptedSupervisor } = await import("./support/scripted-supervisor.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "agy-scripted-errors-"));
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, modelsStorePath: path.join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const expected = new assert.AssertionError({ message: "source assertion evidence" });
    const observed: Error[] = [];
    const fake = registerScriptedSupervisor(runtime, () => { throw expected; }, error => observed.push(error));
    const stream = runtime.streamSimple(fake.model, { messages: [] });
    const result = await stream.result();
    assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, expected.message);
    assert.equal(observed[0], expected); assert.equal(fake.errors[0], expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});
