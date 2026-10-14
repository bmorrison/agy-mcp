import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const supportRoot = path.join(packageRoot, "test/support");
const archiveHash = "034cb85bdaeb1dc9753cd8679f0cf0cfe8b8dedc0fa2e13c9ccb62663b37bcf0";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function extractCorrectedOwner(destination: string, archiveOverride?: Buffer) {
  const provenance = JSON.parse(await readFile(path.join(supportRoot, "owner-artifact.json"), "utf8"));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.packageName, "pi-subagents");
  assert.equal(provenance.packageVersion, "0.77.0");
  assert.equal(provenance.source.kind, "operator-approved-corrected-installed-package");
  assert.equal(provenance.archive, "pi-subagents-owner-0.77.0-chord-compatible.tgz");
  assert.equal(provenance.sha256, archiveHash, "manifest must describe the approved immutable artifact");
  const archive = archiveOverride ?? await readFile(path.join(supportRoot, provenance.archive));
  assert.equal(digest(archive), archiveHash, "verify archive integrity before parsing/extraction/loading");
  const entries = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const listing = tar.t({ onReadEntry: entry => {
      try {
        assert.equal(entry.type, "File");
        assert.match(entry.path, /^package\//);
        assert.ok(!entry.path.split("/").some(p => ["..", ".", "node_modules", ".git", ".pi", ".env", "auth.json"].includes(p)));
        assert.ok(!entries.has(entry.path)); entries.add(entry.path);
        entry.resume();
      } catch (error) { reject(error); }
    } });
    listing.on("error", reject); listing.on("end", resolve); listing.end(archive);
  });
  assert.equal(entries.size, provenance.archiveFiles);
  await mkdir(destination, { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const extraction = tar.x({ cwd: destination, strict: true });
    extraction.on("error", reject); extraction.on("close", resolve); extraction.end(archive);
  });
  const ownerRoot = path.join(destination, "package");
  const manifest = JSON.parse(await readFile(path.join(ownerRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, provenance.packageName); assert.equal(manifest.version, provenance.packageVersion);
  assert.equal(manifest.exports["."].default, "./index.js");
  assert.equal(manifest.exports["./external-job-provider"].default, "./src/api/external-job-provider.js");
  for (const [module, expected] of Object.entries(provenance.moduleHashes)) {
    assert.equal(digest(await readFile(path.join(ownerRoot, module))), expected, module);
  }
  // Ordinary declared dependencies/SDK peers resolve from the authorized package-local tree.
  // No source in that tree or in the approved archive is patched.
  await symlink(path.join(packageRoot, "node_modules"), path.join(ownerRoot, "node_modules"), "dir");
  const library = await readFile(path.join(packageRoot, "node_modules/pi-subagents/src/api/external-job-provider.js"));
  assert.equal(digest(library), provenance.moduleHashes["src/api/external-job-provider.js"], "public 0.77 library is byte-compatible with corrected owner");
  return { ownerRoot, entrypoint: path.join(ownerRoot, manifest.exports["."].default), provenance };
}
