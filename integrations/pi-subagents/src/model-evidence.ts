/** Display-only projections of already-correlated, Python-redacted observations. */
export interface ModelEvidence {
  requested: string | null;
  configured: string | null;
  forwarded: string | null;
  forwardingSource: "constructed_argv" | null;
  observedCliSelectors: string[];
  observedCliSelectorsComplete: boolean;
  effective: null;
  effectiveSource: "unavailable";
}
export type EvidenceSource = "requested" | "configured" | "cli-observed";
export interface DisplayDatum {
  value: string;
  source: EvidenceSource;
  derivedFrom?: "model-label" | "selector";
}
export interface ExecutionMetadata { model?: DisplayDatum; thinking?: DisplayDatum }
export const MODEL_EVIDENCE_CACHE_LIMIT = 2048;
const unsafeDisplay = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const empty = (): ModelEvidence => ({ requested: null, configured: null, forwarded: null, forwardingSource: null, observedCliSelectors: [], observedCliSelectorsComplete: false, effective: null, effectiveSource: "unavailable" });
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function safe(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || unsafeDisplay.test(value) || value.includes("***")) return null;
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= 256 && bytes.toString("utf8") === value ? value : null;
}
export function projectModelEvidence(selection: unknown): ModelEvidence {
  if (!object(selection)) return empty();
  const requested = safe(own(selection, "requested"));
  const forwarded = safe(own(selection, "forwarded"));
  const canForward = requested !== null && forwarded === requested && own(selection, "forwarding_source") === "constructed_argv";
  const raw = own(selection, "observed_cli_selectors");
  const observedCliSelectors: string[] = [];
  let complete = Array.isArray(raw) && raw.length <= 8;
  if (Array.isArray(raw)) for (const item of raw.slice(0, 8)) {
    const value = safe(item);
    if (value === null) complete = false;
    else if (!observedCliSelectors.includes(value)) observedCliSelectors.push(value);
  }
  const evidence: ModelEvidence = {
    requested, configured: safe(own(selection, "configured")),
    forwarded: canForward ? forwarded : null, forwardingSource: canForward ? "constructed_argv" : null,
    observedCliSelectors, observedCliSelectorsComplete: complete,
    effective: null, effectiveSource: "unavailable",
  };
  return Buffer.byteLength(JSON.stringify(evidence), "utf8") <= 4096 ? evidence : empty();
}
export function selectExecutionMetadata(evidence: ModelEvidence): ExecutionMetadata | null {
  let value: string | null = null;
  let source: EvidenceSource;
  if (evidence.requested !== null) { value = evidence.requested; source = "requested"; }
  else if (evidence.configured !== null) { value = evidence.configured; source = "configured"; }
  else if (evidence.observedCliSelectorsComplete && evidence.observedCliSelectors.length === 1) { value = evidence.observedCliSelectors[0]; source = "cli-observed"; }
  else return null;
  const label = source === "configured" ? /^(.*\S) \((Low|Medium|High)\)$/.exec(value) : null;
  const selector = /^(gemini-[0-9]+(?:\.[0-9]+)?-(?:flash|pro))-(low|medium|high)$/.exec(value);
  const result: ExecutionMetadata = { model: { value: label ? label[1] : value, source } };
  if (label || selector) result.thinking = { value: (label ?? selector)![2].toLowerCase(), source, derivedFrom: label ? "model-label" : "selector" };
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= 2048 ? result : null;
}
export function rememberModelEvidence(cache: Map<string, ModelEvidence>, jobId: string, evidence: ModelEvidence): void {
  if (!cache.has(jobId) && cache.size >= MODEL_EVIDENCE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(jobId, { ...evidence, observedCliSelectors: [...evidence.observedCliSelectors] });
}
export function copyModelEvidence(evidence: ModelEvidence): ModelEvidence {
  return { ...evidence, observedCliSelectors: [...evidence.observedCliSelectors] };
}
export function formatModelEvidence(evidence: ModelEvidence): string {
  const metadata = selectExecutionMetadata(evidence);
  // Literal Markdown fences in data must not look like a checkpoint boundary.
  const escape = (value: string) => value.replace(/[\\`[\]()*_<>]/g, "\\$&");
  const datum = (value: DisplayDatum | undefined) => value ? `${escape(value.value)} [${value.source}${value.derivedFrom ? `, ${value.derivedFrom === "model-label" ? "label" : "selector"}-derived` : ""}]` : "unknown";
  const conflict = evidence.observedCliSelectors.length > 1 ? " CLI selector conflict; inspect control status." : "";
  const disagreement = evidence.requested !== null && evidence.configured !== null && evidence.requested !== evidence.configured ? " Requested/configured labels differ; inspect control status." : "";
  return `Model: ${datum(metadata?.model)}; thinking: ${datum(metadata?.thinking)}; effective identity: unavailable.${conflict}${disagreement}`;
}
