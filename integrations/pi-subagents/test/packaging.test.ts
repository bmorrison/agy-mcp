import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCorrectedOwner } from "./support/corrected-owner.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (name: string) => readFile(path.join(root, name), "utf8");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    assert.ok(entry.isFile() || entry.isDirectory(), `no package symlink/special file: ${name}`);
    found.push(...(entry.isDirectory() ? await files(name) : [name]));
  }
  return found.sort();
}

test("package exposes only the public provider seam and a discoverable advisory agent", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.engines.node, ">=22.19");
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.deepEqual(manifest["pi-subagents"].agents, ["./agents"]);
  assert.equal(manifest.dependencies["pi-subagents"], "0.77.0");
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@modelcontextprotocol/sdk", "pi-subagents"]);
  for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
    assert.equal(manifest.peerDependencies[peer], "*");
    assert.ok(!Object.hasOwn(manifest.dependencies, peer));
    assert.ok(import.meta.resolve(peer));
  }
  assert.ok(import.meta.resolve("pi-subagents/external-job-provider"));
  assert.ok(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const agent = await read("agents/agy-reviewer.md");
  for (const declaration of ["name: agy-reviewer", "advertise: true", "async: true", "timeoutMs: 600000", "acceptanceRole: read-only", "defaultContext: fresh", "type: external-job", "provider: agy-mcp", "options: {}"]) assert.ok(agent.includes(declaration), declaration);
  assert.match(agent, /not an OS write sandbox/);
  assert.ok((await files("src")).length > 0);
  for (const name of await files("src")) {
    const source = await read(name);
    const imports = [...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)].map(match => match[2]);
    for (const specifier of imports.filter(value => value.startsWith("pi-subagents"))) {
      assert.equal(specifier, "pi-subagents/external-job-provider", name);
    }
    assert.doesNotMatch(source, /node_modules\/pi-subagents|pi-subagents\/src\//, name);
  }
});

test("offline npm dry-run includes exact production sources, agent and README, never fixtures/state/dependencies", { timeout: 35000 }, async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agy-pi-pack-audit-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline", "--cache", path.join(scratch, "npm-cache")], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const reports = JSON.parse(output);
  assert.equal(reports.length, 1);
  const packed = reports[0].files.map((entry: { path: string }) => entry.path).sort();
  const expected = ["package.json", "README.md", ...await files("src"), ...await files("agents")].sort();
  assert.deepEqual(packed, expected);
  assert.deepEqual(JSON.parse(await read("package.json")).files, ["src/", "agents/", "README.md"]);
  for (const name of packed) {
    assert.doesNotMatch(name, /(?:^|\/)(?:node_modules|test|tests|dist|\.pi|\.env|\.git|agy-subagents|mcp-jobs)(?:\/|$)|owner-artifact|\.tgz$|auth\.json/);
    const content = await read(name);
    assert.doesNotMatch(content, /\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/);
    assert.doesNotMatch(content, /sk-[A-Za-z0-9_-]{20,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}/);
  }
});

test("portable corrected-owner bytes/provenance match local and CI public library; published owner is not silently substituted", async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agy-pi-provenance-audit-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const { ownerRoot, provenance } = await extractCorrectedOwner(path.join(scratch, "owner"));
  assert.equal(provenance.license, "MIT");
  assert.equal(provenance.source.revision, null);
  assert.equal(provenance.archiveFiles, 1331);
  assert.doesNotMatch(JSON.stringify(provenance), /\/Users\/|\/private\/tmp\/|node_modules\/pi-subagents/);
  const installedGuard = await readFile(path.join(root, "node_modules/pi-subagents/src/runs/background/runner-aliases.js"));
  const correctedGuard = await readFile(path.join(ownerRoot, "src/runs/background/runner-aliases.js"));
  assert.equal(digest(installedGuard), "3d97f6680e5741131fbf66eb4ab9516f7f54c669d387e8a3484c6d08fab2cea1");
  assert.equal(digest(correctedGuard), "5a5f0a3526a5374288fb1b76e50b4405c6adafdf49ed88cdcfda8a8280a3e198");
  assert.notEqual(digest(installedGuard), digest(correctedGuard));
});
