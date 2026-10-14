import { performance } from "node:perf_hooks";
import { ContractError, fail } from "./contracts.js";

export type MonotonicClock = () => number;
export class ProviderDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly start: number;
  private readonly timer: NodeJS.Timeout;
  private readonly onAbort: () => void;
  constructor(private readonly clock: MonotonicClock = () => performance.now(),
    readonly totalMs = 90_000, readonly settlementMs = 5_000, private readonly parentSignal?: AbortSignal) {
    if (!Number.isFinite(totalMs) || !Number.isFinite(settlementMs) || totalMs <= settlementMs || settlementMs < 0) fail("invalid_deadline");
    this.start = clock();
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(), totalMs - settlementMs);
    this.timer.unref();
    this.onAbort = () => this.controller.abort();
    parentSignal?.addEventListener("abort", this.onAbort, { once: true });
    if (parentSignal?.aborted) this.controller.abort();
  }
  remaining(phase: "work" | "settlement" = "work"): number {
    return Math.max(0, this.totalMs - (phase === "work" ? this.settlementMs : 0) - (this.clock() - this.start));
  }
  assertAdmission(): void {
    if (this.signal.aborted || this.remaining() <= 0) { this.controller.abort(); fail("provider_deadline"); }
  }
  assertSettlement(): void {
    if (this.remaining("settlement") <= 0) fail("settlement_deadline");
  }
  requestOptions(): { signal: AbortSignal; timeout: number; maxTotalTimeout: number; resetTimeoutOnProgress: false } {
    this.assertAdmission();
    const timeout = Math.floor(Math.min(60_000, this.remaining()));
    if (timeout < 1) { this.controller.abort(); fail("provider_deadline"); }
    return { signal: this.signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false };
  }
  /** Bounds an observer without abandoning the underlying, already tracked work. */
  wait<T>(work: Promise<T>, stopSignal?: AbortSignal): Promise<T> {
    this.assertAdmission();
    const signal = stopSignal ? AbortSignal.any([this.signal, stopSignal]) : this.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(new ContractError("provider_deadline")); };
      const timer = setTimeout(onAbort, this.remaining());
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(value => {
        cleanup();
        try { this.assertAdmission(); resolve(value); } catch (error) { reject(error); }
      }, error => { cleanup(); reject(error); });
      if (signal.aborted) onAbort();
    });
  }
  dispose(): void { clearTimeout(this.timer); this.parentSignal?.removeEventListener("abort", this.onAbort); }
}
export function remainingMs(scope: ProviderDeadline, phase: "work" | "settlement" = "work"): number {
  return scope.remaining(phase);
}
export async function withProviderDeadline<T>(operation: (scope: ProviderDeadline) => Promise<T>,
  options: { clock?: MonotonicClock; totalMs?: number; settlementMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const scope = new ProviderDeadline(options.clock, options.totalMs, options.settlementMs, options.signal);
  try { const result = await operation(scope); scope.assertSettlement(); return result; }
  finally { scope.dispose(); }
}
