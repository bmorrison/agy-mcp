import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const server = new McpServer({ name: "offline-agy-fixture", version: "1" });
// Test-only persisted records permit a real second MCP process, not fake ownership.
const jobFile = process.env.AGY_PI_TEST_JOB_FILE;
const jobs = new Map<string, Record<string, unknown>>(jobFile && existsSync(jobFile) ? JSON.parse(readFileSync(jobFile, "utf8")) : []);
const evidence = process.env.AGY_PI_TEST_EVIDENCE!;
const mode = process.env.AGY_PI_TEST_MODE ?? "normal";
const uuid = "12345678-1234-4234-8234-123456789abc";
const completionRoot = process.env.AGY_PI_TEST_COMPLETION_ROOT;
const lifecycleRoot = process.env.AGY_PI_TEST_LIFECYCLE_ROOT;
function observeRecord(record: Record<string, unknown> | undefined) {
  const file = process.env.AGY_PI_TEST_MODEL_EVIDENCE_FILE;
  if (record && file && existsSync(file)) record.extra = { model_selection: JSON.parse(readFileSync(file, "utf8")) };
  else if (record && process.env.AGY_PI_TEST_CONFIGURED_MODEL) record.extra = { model_selection: { requested: (record.request as Record<string, unknown>).model, configured: process.env.AGY_PI_TEST_CONFIGURED_MODEL, observed_cli_selectors: [] } };
  return record;
}
async function hold(name: string) {
  if (!lifecycleRoot) return;
  appendFileSync(evidence, JSON.stringify({ event: "boundary", name }) + "\n");
  const until = Date.now() + 10_000;
  while (!existsSync(`${lifecycleRoot}/release-${name}`)) {
    if (Date.now() > until) throw new Error("fixture_barrier_timeout");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
if (completionRoot) appendFileSync(evidence, JSON.stringify({ event: "fixture_process", pid: process.pid }) + "\n");
function log(name: string, args: Record<string, unknown>) {
  const { PROMPT, ...safe } = args;
  appendFileSync(evidence, JSON.stringify({ name, ...safe, ...(typeof PROMPT === "string" ? { promptDigest: createHash("sha256").update(PROMPT).digest("hex") } : {}) }) + "\n", { mode: 0o600 });
}
function response(envelope: Record<string, unknown>) {
  envelope = { error: null, ...("SESSION_ID" in envelope ? { agent_messages: "", all_messages: [], artifacts: [], warnings: [], cwd: "", log_path: null, created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z" } : {}), ...envelope };
  if (mode === "isError") return { isError: true, content: [{ type: "text" as const, text: "fixed" }] };
  if (mode === "rejected") envelope = { success: false, error: "sensitive-rejection-never-exposed" };
  if (mode === "wrongSchema") envelope = { success: true };
  if (mode === "oversize") envelope.padding = "x".repeat(2 * 1024 * 1024);
  const content = [{ type: "text" as const, text: JSON.stringify(envelope) }];
  return mode === "text" ? { content } : { content, structuredContent: envelope };
}
const configSchema = {
  PROMPT: z.string(), cd: z.string(), model: z.string().nullable().optional(),
  sandbox: z.boolean(), mode: z.string(), timeout: z.number(), allow_write: z.boolean(),
  worktree: z.boolean(), backend: z.string(), output_protocol: z.string(), SESSION_ID: z.string().optional(),
};
server.registerTool("agy", { inputSchema: { ...configSchema, dry_run: z.boolean(), debug: z.boolean() } }, async args => {
  log("agy", args);
  const argv = ["/offline/agy", "--print=fixed", "--sandbox", ...(args.SESSION_ID ? [`--conversation=${args.SESSION_ID}`] : ["--new-project"]), ...(args.model ? [`--model=${args.model}`] : [])];
  if (mode === "extraConversation") argv.push("--conversation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  if (mode === "continue") argv.push("--continue");
  if (mode === "writeMode") argv.push("--mode", "accept-edits");
  return response({ success: true, status: "completed", job_id: null, SESSION_ID: args.SESSION_ID ?? "", cwd: args.cd, adapter: { backend: "agy" }, command_preview: argv });
});
server.registerTool("agy_start", { inputSchema: { ...configSchema, job_id: mode === "missingSchema" ? z.number() : z.string() } }, async args => {
  log("agy_start", args);
  if (mode === "disconnect") process.exit(0);
  if (mode === "delayStart") await new Promise(r => setTimeout(r, 350));
  if (mode === "lostDuplicate") {
    // Identical saved request could belong to another server; rejection reply is lost.
    const { PROMPT, cd, SESSION_ID, job_id, ...config } = args;
    jobs.set(String(job_id), { job_id, session_id: SESSION_ID ?? uuid, status: "running", backend: "agy", cwd: cd, started_at: "t", updated_at: "t", finished_at: null, exit_code: null, pid: 1, log_path: null, stdout_path: null, stderr_path: null, events_path: null, artifacts: [], last_event_at: null, error: null, request: { ...config, prompt: PROMPT, cwd: cd, session_id: SESSION_ID ?? null, model: args.model ?? null }, extra: {} });
    await new Promise(r => setTimeout(r, 350));
    return response({ success: false });
  }
  if (jobs.has(String(args.job_id))) return response({ success: false });
  const { PROMPT, cd, SESSION_ID, job_id, ...config } = args;
  jobs.set(String(job_id), { job_id, session_id: SESSION_ID ?? uuid,
    status: completionRoot || ["running", "persistRunning", "cancelDelayed", "cancelFalse", "hungCancel"].includes(mode) ? "running" : "completed",
    backend: "agy", cwd: cd, started_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z",
    finished_at: "2026-10-13T00:00:00Z", exit_code: 0, pid: null, log_path: null,
    stdout_path: null, stderr_path: null, events_path: null, artifacts: [], last_event_at: null, error: null,
    request: { ...config, prompt: PROMPT, cwd: cd, session_id: SESSION_ID ?? null, model: args.model ?? null }, extra: {} });
  if (jobFile) writeFileSync(jobFile, JSON.stringify([...jobs]), { mode: 0o600 });
  return response({ success: true, status: "running", job_id, SESSION_ID: SESSION_ID ?? "", adapter: { backend: "agy" }, command_preview: null });
});
server.registerTool("agy_status", { inputSchema: { job_id: z.string() } }, async args => {
  log("agy_status", args);
  if (mode === "delayStatus") await new Promise(r => setTimeout(r, 200));
  const record = observeRecord(jobs.get(args.job_id));
  if (record && ["failed", "upstream_error", "cancelled"].includes(mode)) record.status = mode;
  if (record && mode === "badMarker") (record.request as Record<string, unknown>).prompt += "\nAGY_PI_OP v1 " + "f".repeat(16) + "." + "f".repeat(16) + "." + "f".repeat(16) + "." + "f".repeat(16);
  if (record && mode === "badConfig") (record.request as Record<string, unknown>).sandbox = false;
  if (record && (mode === "badCwd" || mode === "badFollowUpCwd" && (record.request as Record<string, unknown>).session_id)) { record.cwd = "/wrong"; (record.request as Record<string, unknown>).cwd = "/wrong"; }
  if (record && mode === "badFollowUpConversation" && (record.request as Record<string, unknown>).session_id) record.session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  if (record && completionRoot && record.status === "running") {
    const index = [...jobs.keys()].indexOf(args.job_id) + 1;
    if (existsSync(`${completionRoot}/completion-${index}`)) {
      record.status = "completed";
      appendFileSync(evidence, JSON.stringify({ event: "fixture_completed", job_id: args.job_id, index }) + "\n");
    }
  }
  if (mode === "wrongId" && record) record.job_id = "job_pi_" + "f".repeat(32);
  if (record && mode === "cancelUnknown") record.status = "unknown";
  if (record && mode === "uncorrelatedStatus") (record.request as Record<string, unknown>).prompt = "foreign";
  if (mode === "missingStatus") return response({ success: false });
  if (mode === "malformedStatus") return response({ success: true, record: { job_id: args.job_id } });
  return response({ success: !!record, record });
});
server.registerTool("agy_result", { inputSchema: { job_id: z.string(), include_events: z.boolean(), since: z.number() } }, async args => {
  log("agy_result", args);
  if (mode === "delayResult") await new Promise(r => setTimeout(r, 150));
  if (mode === "holdResult") await hold("result");
  const record = observeRecord(jobs.get(args.job_id));
  const resumed = !!(record?.request as Record<string, unknown> | undefined)?.session_id;
  const observedId = mode === "conversationMismatch" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : uuid;
  const events = [{ type: "system", subtype: mode === "initOnly" ? "init" : resumed ? "conversation_resumed" : "conversation_started", session_id: observedId }];
  const kind = process.env.AGY_PI_TEST_CHECKPOINT_KIND ?? (mode === "questionOnly" ? "question" : resumed ? "completed" : "question");
  return response({ success: !!record, job_id: args.job_id, record, result_text: mode === "invalidCheckpoint" ? "not a checkpoint" : "```agy-checkpoint\n" + JSON.stringify({ version: 1, kind, message: resumed ? "Review complete." : "Which behavior?", artifacts: [] }) + "\n```", include_events: args.include_events, since: args.since, events, count: events.length });
});
if (mode !== "missingTool") server.registerTool("agy_cancel", { inputSchema: { job_id: z.string() } }, async args => {
  log("agy_cancel", args);
  const record = jobs.get(args.job_id);
  if (mode === "hungCancel") await new Promise(r => setTimeout(r, 10_000));
  if (record && !["cancelDelayed", "cancelFalse", "cancelUnknown", "uncorrelatedStatus", "missingStatus", "malformedStatus"].includes(mode)) record.status = "cancelled";
  return response({ success: true, job_id: args.job_id, signalled: !["cancelFalse", "cancelFalseTerminal"].includes(mode) && !!record });
});
if (mode === "ignoreClose") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000); // Exercise only SDK-owned child cleanup, never an AGY job kill proof.
}
if (mode === "delayInitialize") await new Promise(r => setTimeout(r, 350));
if (!lifecycleRoot) await server.connect(new StdioServerTransport());
else {
  appendFileSync(evidence, JSON.stringify({ event: "fixture_process", pid: process.pid }) + "\n");
  class BoundaryTransport implements Transport {
    onclose?: Transport["onclose"]; onerror?: Transport["onerror"]; onmessage?: Transport["onmessage"];
    private readonly stdio = new StdioServerTransport();
    async start() {
      this.stdio.onclose = () => this.onclose?.();
      this.stdio.onerror = error => this.onerror?.(error);
      this.stdio.onmessage = message => {
        appendFileSync(evidence, JSON.stringify({ event: "wire", method: "method" in message ? message.method : "response", id: "id" in message ? message.id : null }) + "\n");
        const boundary = "method" in message && (message.method === "initialize" ? "initialize" : message.method === "tools/list" ? "list" : message.method === "tools/call" && (message.params as { name?: string })?.name === "agy" ? "probe" : null);
        void (async () => {
          if (boundary && mode === `hold-${boundary}`) await hold(boundary);
          this.onmessage?.(message);
        })().catch(error => this.onerror?.(error));
      };
      await this.stdio.start();
    }
    send(message: JSONRPCMessage) { return this.stdio.send(message); }
    close() { return this.stdio.close(); }
  }
  await server.connect(new BoundaryTransport());
}
