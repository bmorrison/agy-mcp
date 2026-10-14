import fs from "node:fs";
import { AssignmentStore } from "../../src/state.js";
import { ProviderDeadline } from "../../src/deadline.js";
import type { ExecutionConfig, OperationInput } from "../../src/contracts.js";
const [inputFile, mode, releaseFile] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputFile, "utf8")) as { root: string; owner: string; sessionFile: string; claim: OperationInput; config: ExecutionConfig; source?: { runId: string; stepIndex: number } };
const rename = fs.renameSync;
let armed = !mode.startsWith("intent-");
fs.renameSync = ((from, to) => {
  if (String(to).endsWith("/manifest.json")) {
    if (armed && mode.endsWith("before")) process.exit(73);
    if (mode === "hold" || mode === "hold-final") {
      process.send?.({ ready: true });
      const until = Date.now() + 5000;
      while (!fs.existsSync(releaseFile)) {
        if (Date.now() > until) process.exit(75);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    rename(from, to);
    if (armed && mode.endsWith("after")) process.exit(74);
  } else rename(from, to);
}) as typeof fs.renameSync;
const scope = new ProviderDeadline();
try {
  const store = new AssignmentStore(input.root, input.owner, input.sessionFile);
  const result = store.claimTurn(input.claim, input.config, scope, input.source);
  if (mode.startsWith("intent-")) { armed = true; store.markDispatching(result.turn.jobId, scope); }
  if (mode === "hold-final") store.saveTurn(result.turn.jobId, { phase: "terminal", semanticState: "completed", checkpoint: { version: 1, kind: "completed", message: "Validated child checkpoint", artifacts: [] }, output: "immutable child final", conversationId: "30000000-0000-4000-8000-000000000003", errorCode: null, evidence: { backendStatus: "completed", exitCode: 0 } }, scope);
  process.send?.({ jobId: result.turn.jobId, fresh: result.fresh });
} finally { scope.dispose(); }
