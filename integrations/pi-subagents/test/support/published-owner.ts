import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import * as providerApi from "pi-subagents/external-job-provider";
import { assertPublicProviderApi } from "../../src/index.js";
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const supportRoot = path.join(packageRoot, "test/support");
// Frozen test provenance only; production neither imports this nor checks versions.
const archiveHash = "9c4562f66c595d9878c04aae31d76727087db6e025b19eeba92d3bab1ac812cc";
export async function extractPublishedOwner(destination: string, archiveOverride?: Buffer) {
  const provenance = JSON.parse(await readFile(path.join(supportRoot, "published-owner.json"), "utf8"));
  assert.equal(provenance.schemaVersion, 1); assert.equal(provenance.packageName, "pi-subagents");
  assert.equal(provenance.source.kind, "npm-registry-published"); assert.equal(provenance.sha256, archiveHash);
  assert.equal(path.basename(provenance.archive), provenance.archive);
  assert.equal(provenance.archive, `pi-subagents-${provenance.packageVersion}.tgz`);
  assert.equal(provenance.source.tarball, `https://registry.npmjs.org/pi-subagents/-/${provenance.archive}`);
  const archive = archiveOverride ?? await readFile(path.join(supportRoot, provenance.archive));
  assert.equal(createHash("sha256").update(archive).digest("hex"), archiveHash, "verify immutable archive before parsing/loading");
  assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, provenance.source.integrity);
  assert.equal(createHash("sha1").update(archive).digest("hex"), provenance.source.shasum);
  const entries = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const listing = tar.t({ onReadEntry: entry => {
      try {
        assert.equal(entry.type, "File"); assert.match(entry.path, /^package\//);
        assert.ok(!entry.path.split("/").some(p => ["..", ".", "node_modules", ".git", ".pi", ".env", "auth.json"].includes(p)));
        assert.ok(!entries.has(entry.path)); entries.add(entry.path); entry.resume();
      } catch (error) { reject(error); }
    } });
    listing.on("error", reject); listing.on("end", resolve); listing.end(archive);
  });
  assert.equal(entries.size, provenance.archiveFiles); assert.deepEqual([...entries].sort(), provenance.members);
  await mkdir(destination, { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const extraction = tar.x({ cwd: destination, strict: true });
    extraction.on("error", reject); extraction.on("close", resolve); extraction.end(archive);
  });
  const ownerRoot = path.join(destination, "package");
  const manifest = JSON.parse(await readFile(path.join(ownerRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, provenance.packageName); assert.equal(manifest.version, provenance.packageVersion); assert.equal(manifest.license, "MIT");
  assert.equal(manifest.exports["."].default, "./index.js");
  assert.equal(manifest.exports["./external-job-provider"].default, "./src/api/external-job-provider.js");
  for (const [module, expected] of Object.entries(provenance.moduleHashes)) {
    assert.ok(entries.has(`package/${module}`));
    assert.equal(createHash("sha256").update(await readFile(path.join(ownerRoot, module))).digest("hex"), expected, module);
  }
  await symlink(path.join(packageRoot, "node_modules"), path.join(ownerRoot, "node_modules"), "dir");
  assertPublicProviderApi(providerApi);
  return { ownerRoot, entrypoint: path.join(ownerRoot, manifest.exports["."].default), provenance };
}
