import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExternalJobProvider, registerExternalJobProvider } from "pi-subagents/external-job-provider";
import { fail } from "./contracts.js";
import { AgyMcpClient } from "./mcp-client.js";
import { createAgyProvider, type AgyProvider } from "./provider.js";
import { createControlTool } from "./control-tool.js";
import { AssignmentStore } from "./state.js";

export default function agySubagents(pi: ExtensionAPI): void {
  let lifetime: { provider: AgyProvider; dispose: () => void; shutdown?: Promise<void> } | undefined;
  let replacement = Promise.resolve();
  const shutdown = (): Promise<void> => {
    const owned = lifetime;
    if (!owned) return Promise.resolve();
    owned.provider.stopAdmission();
    return owned.shutdown ??= (async () => {
      try { await owned.provider.shutdown(); }
      finally { owned.dispose(); if (lifetime === owned) lifetime = undefined; }
    })();
  };
  pi.registerTool(createControlTool(() => lifetime?.provider));
  pi.on("session_start", (_event, ctx) => {
    const ownerId = ctx.sessionManager.getSessionId();
    const ownerFile = ctx.sessionManager.getSessionFile() ?? null;
    const flight = replacement.then(async () => {
      await shutdown();
      if (getExternalJobProvider("agy-mcp")) fail("provider_registration_collision");
      const root = process.env.AGY_PI_STATE_ROOT ?? path.join(getAgentDir(), "agy-subagents");
      const store = new AssignmentStore(root, ownerId, ownerFile);
      const client = new AgyMcpClient({ ownerDirectory: store.ownerDirectory });
      const provider = createAgyProvider({ store, client });
      lifetime = { provider, dispose: registerExternalJobProvider(provider) };
    });
    replacement = flight.catch(() => {});
    return flight;
  });
  pi.on("session_shutdown", async () => { await replacement; await shutdown(); });
}
