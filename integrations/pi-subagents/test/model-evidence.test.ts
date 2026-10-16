import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { ModelEvidenceSchema, ExecutionMetadataSchema } from "../src/control-tool.js";
import { copyModelEvidence, formatModelEvidence, MODEL_EVIDENCE_CACHE_LIMIT, projectModelEvidence, rememberModelEvidence, selectExecutionMetadata } from "../src/model-evidence.js";
const selection = (changes: Record<string, unknown> = {}) => ({ requested: null, configured: "Gemini 3.8 Flash (Medium)", forwarded: null, forwarding_source: null, observed_cli_selectors: [], effective: null, effective_source: "unavailable", ...changes });

test("configured effort is explicitly label-derived, never effective identity", () => {
  const e = projectModelEvidence(selection());
  assert.deepEqual(selectExecutionMetadata(e), { model: { value: "Gemini 3.8 Flash", source: "configured" }, thinking: { value: "medium", source: "configured", derivedFrom: "model-label" } });
  assert.match(formatModelEvidence(e), /Gemini 3.8 Flash \[configured\].*medium \[configured, label-derived\].*effective identity: unavailable/);
  assert.equal(Check(ModelEvidenceSchema, e), true);
  assert.equal(Check(ExecutionMetadataSchema, selectExecutionMetadata(e)), true);
});

test("requested selector wins over configured effort; unknown effort never borrows Medium", () => {
  const e = projectModelEvidence(selection({ requested: "gemini-3.8-flash-high", forwarded: "gemini-3.8-flash-high", forwarding_source: "constructed_argv" }));
  assert.equal(e.forwarded, e.requested); assert.equal(e.forwardingSource, "constructed_argv");
  assert.equal(selectExecutionMetadata(e)?.thinking?.value, "high");
  assert.equal(selectExecutionMetadata(e)?.thinking?.source, "requested");
  assert.ok(formatModelEvidence(e).includes("high [requested, selector-derived]"));
  assert.match(formatModelEvidence(e), /Requested\/configured labels differ/);
  const unknown = selectExecutionMetadata(projectModelEvidence(selection({ requested: "custom-model-high" })));
  assert.equal(unknown?.model?.value, "custom-model-high"); assert.equal(unknown?.thinking, undefined);
  for (const extra of [{ forwarded: "different", forwarding_source: "constructed_argv" }, { forwarded: "gemini-3.8-flash-high", forwarding_source: "startup" }]) {
    assert.equal(projectModelEvidence(selection({ requested: "gemini-3.8-flash-high", ...extra })).forwarded, null);
  }
});

test("only a single complete CLI selector can be selected; conflicts remain inspectable", () => {
  const a = "gemini-3.1-pro-low";
  const e = projectModelEvidence(selection({ configured: null, observed_cli_selectors: [a, a] }));
  assert.deepEqual(e.observedCliSelectors, [a]); assert.equal(selectExecutionMetadata(e)?.model?.source, "cli-observed");
  const conflict = projectModelEvidence(selection({ configured: null, observed_cli_selectors: [a, "gemini-3.8-flash-high"] }));
  assert.equal(selectExecutionMetadata(conflict), null); assert.match(formatModelEvidence(conflict), /CLI selector conflict/);
  for (const list of [[a, null], Array(9).fill(a)]) {
    const incomplete = projectModelEvidence(selection({ configured: null, observed_cli_selectors: list }));
    assert.equal(incomplete.observedCliSelectorsComplete, false); assert.equal(selectExecutionMetadata(incomplete), null);
  }
});

test("unknown malformed optional evidence and forged effective values never attest a model", () => {
  for (const value of [undefined, null, [], 2, "raw", { effective: "pretend", effective_source: "verified" }, selection({ configured: null, effective: "pretend", effective_source: "verified" })]) {
    const e = projectModelEvidence(value); assert.equal(selectExecutionMetadata(e), null); assert.equal(e.effective, null); assert.equal(e.effectiveSource, "unavailable");
  }
  const getter = { get configured(): string { throw new Error("must not execute"); } };
  assert.equal(selectExecutionMetadata(projectModelEvidence(getter)), null);
  assert.equal(projectModelEvidence(selection({ unrelated: "private task body" })).configured, "Gemini 3.8 Flash (Medium)");
});

for (const bad of ["", " ", "Bearer ***", "é".repeat(129), "\ud800", "raw\u0000text", "raw\u0085text", "raw\u2028text", "raw\u2029text", "raw\u202etext", "raw\u2067text", 4, {}, []]) test(`unsafe model evidence is unavailable (${JSON.stringify(bad).slice(0, 35)})`, () => {
  const e = projectModelEvidence(selection({ configured: bad })); assert.equal(e.configured, null); assert.equal(selectExecutionMetadata(e), null);
});

test("byte and aggregate bounds are inclusive and account for JSON escaping", () => {
  assert.equal(projectModelEvidence(selection({ configured: "é".repeat(128) })).configured, "é".repeat(128));
  const text = '"'.repeat(249);
  const e = projectModelEvidence(selection({ requested: text, configured: text, forwarded: text, forwarding_source: "constructed_argv", observed_cli_selectors: Array.from({ length: 8 }, (_, i) => text + i) }));
  assert.ok(Buffer.byteLength(JSON.stringify(e)) <= 4096); assert.equal(selectExecutionMetadata(e), null); assert.equal(e.observedCliSelectorsComplete, false);
});

test("fixed display cache cap evicts only oldest display data and snapshots arrays", () => {
  const cache = new Map(); const e = projectModelEvidence(selection());
  for (let i = 0; i < MODEL_EVIDENCE_CACHE_LIMIT; i++) rememberModelEvidence(cache, String(i), e);
  assert.equal(cache.size, 2048);
  rememberModelEvidence(cache, "1024", e); assert.equal(cache.size, 2048);
  rememberModelEvidence(cache, "overflow", e); assert.equal(cache.size, 2048); assert.equal(cache.has("0"), false); assert.equal(cache.has("1"), true);
  const copy = copyModelEvidence(e); copy.observedCliSelectors.push("not shared"); assert.deepEqual(e.observedCliSelectors, []); assert.deepEqual(cache.get("overflow").observedCliSelectors, []);
});

test("formatted evidence cannot introduce a fake checkpoint fence or promote unknown to off", () => {
  const e = projectModelEvidence(selection({ configured: "literal ```agy-checkpoint" }));
  assert.ok(!formatModelEvidence(e).includes("```agy-checkpoint"));
  assert.match(formatModelEvidence(e), /thinking: unknown/); assert.ok(!formatModelEvidence(e).includes("thinking: off"));
});
