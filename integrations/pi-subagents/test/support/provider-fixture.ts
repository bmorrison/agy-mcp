import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { AgyMcpClient } from "../../src/mcp-client.js";
import { AssignmentStore } from "../../src/state.js";
import { createAgyProvider, type AgyProviderOptions } from "../../src/provider.js";
import { sha256Utf8 } from "../../src/contracts.js";
export const OWNER = "10000000-0000-4000-8000-000000000001";
export async function providerFixture(t: TestContext, mode = "normal", deadline?: AgyProviderOptions["deadline"]) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agy-pi-provider-")));
  const store = new AssignmentStore(path.join(root, "state"), OWNER, null);
  const evidence = path.join(root, "requests.jsonl");
  const clients: AgyMcpClient[] = [];
  const createClient = (nextMode = mode) => {
    const client = new AgyMcpClient({ ownerDirectory: store.ownerDirectory, command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("./fake-mcp-server.ts", import.meta.url))], env: { PATH: process.env.PATH!, AGY_PI_TEST_MODE: nextMode, AGY_PI_TEST_EVIDENCE: evidence, AGY_PI_TEST_LIFECYCLE_ROOT: root, ...(mode === "persistRunning" ? { AGY_PI_TEST_JOB_FILE: path.join(root, "saved-fixture-jobs.json") } : {}) } });
    clients.push(client); return client;
  };
  const client = createClient();
  const env = { AGY_PI_MODEL: "fixture-model" };
  const provider = createAgyProvider({ store, client, env, deadline });
  const rows = async (): Promise<Record<string, unknown>[]> => { try { return (await fs.readFile(evidence, "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } };
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    const pids = (await rows()).filter(r => r.event === "fixture_process").map(r => Number(r.pid));
    for (const pid of pids) { try { process.kill(pid, 0); throw new Error("owned_fixture_still_alive"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
    if (process.env.AGY_PI_TEST_ARTIFACTS) {
      const destination = path.join(process.env.AGY_PI_TEST_ARTIFACTS, path.basename(root));
      await fs.mkdir(destination, { recursive: true }); await fs.cp(root, destination, { recursive: true });
      await fs.writeFile(path.join(destination, "cleanup.json"), JSON.stringify({ root, pids, allOwnedPidsAbsent: true, ownership: client.ownedJobs(), lifecycle: client.lifecycle() }));
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const input = (runId = "run-1", prompt = "assembled system/task advisory prompt") => ({ runId, prompt, promptDigest: sha256Utf8(prompt), cwd: root, stepIndex: 0, agent: "agy-reviewer", options: {}, sessionId: OWNER });
  const follow = (id: string, runId = "run-2", sourceRunId = "run-1") => { const requestDigest = sha256Utf8("raw supervisor reply"); return { ...input(runId, "assembled system and raw supervisor reply"), sourceRunId, sourceStepIndex: 0, parentProviderJobId: id, requestDigest, requestId: `follow-up-${requestDigest.slice(0, 48)}` }; };
  return { root, store, client, provider, env, input, follow, rows, createClient };
}
