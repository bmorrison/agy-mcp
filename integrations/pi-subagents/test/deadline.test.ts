import test from "node:test";
import assert from "node:assert/strict";
import { ProviderDeadline, remainingMs, withProviderDeadline } from "../src/deadline.js";

test("one monotonic 90s scope: 85s work plus 5s bounded settlement, 60s request caps", async () => {
  let now = 1000;
  await withProviderDeadline(async scope => {
    assert.equal(remainingMs(scope), 85_000);
    assert.equal(scope.requestOptions().timeout, 60_000);
    now += 60_000;
    assert.equal(scope.requestOptions().timeout, 25_000);
    now += 24_999;
    assert.equal(scope.requestOptions().timeout, 1);
    now++;
    assert.throws(() => scope.assertAdmission(), /provider_deadline/);
    assert.equal(remainingMs(scope, "settlement"), 5000);
    scope.assertSettlement();
    now += 4999; scope.assertSettlement();
    now++; assert.throws(() => scope.assertSettlement(), /settlement_deadline/);
    return 1;
  }, { clock: () => now }).then(() => assert.fail("expired settlement accepted"), e => assert.match(e.message, /settlement_deadline/));
});
test("rechecks after await refuse late continuation and dispatch without racing losing promises", async () => {
  let now = 0, starts = 0;
  await assert.rejects(withProviderDeadline(async scope => {
    scope.assertAdmission();
    await Promise.resolve(); now = 85_000;
    scope.assertAdmission(); starts++;
  }, { clock: () => now }), /provider_deadline/);
  assert.equal(starts, 0);
});
test("status and finalization use same diminishing scope, not per-await renewal", async () => {
  let now = 0;
  await withProviderDeadline(async scope => {
    now += 30_000; assert.equal(scope.requestOptions().timeout, 55_000);
    await Promise.resolve(); now += 50_000;
    assert.equal(scope.requestOptions().timeout, 5000);
  }, { clock: () => now });
});
test("cancel/shutdown share one 10s scope across jobs and observation", () => {
  let now = 0;
  const scope = new ProviderDeadline(() => now, 10_000, 0);
  try {
    assert.equal(scope.requestOptions().timeout, 10_000);
    now += 6000; assert.equal(scope.requestOptions().timeout, 4000);
    now += 4000; assert.throws(() => scope.requestOptions(), /provider_deadline/);
  } finally { scope.dispose(); }
});
test("AbortSignal stops local admission/waiting, not upstream execution", async () => {
  const controller = new AbortController(); let upstreamRunning = true;
  await withProviderDeadline(async scope => {
    controller.abort();
    assert.equal(scope.signal.aborted, true);
    assert.throws(() => scope.assertAdmission());
    assert.equal(upstreamRunning, true);
  }, { signal: controller.signal });
  upstreamRunning = false;
});

test("deadline rejects sub-millisecond physical allowance instead of rounding it beyond remaining work", () => {
  let now = 0; const scope = new ProviderDeadline(() => now);
  try { now = 84_999.5; assert.equal(scope.remaining(), 0.5); assert.throws(() => scope.requestOptions(), /provider_deadline/); }
  finally { scope.dispose(); }
});
test("deadline observer losers are attached/consumed and cannot resume after parent abort or monotonic expiry", async () => {
  let resolve!: (value: number) => void;
  const work = new Promise<number>(done => { resolve = done; });
  const parent = new AbortController(); const scope = new ProviderDeadline(undefined, 1000, 0, parent.signal);
  try {
    const refused = assert.rejects(scope.wait(work), /provider_deadline/);
    parent.abort(); await refused; resolve(1); await work;
    assert.throws(() => scope.assertAdmission(), /provider_deadline/);
  } finally { scope.dispose(); }
  let now = 0; const clockScope = new ProviderDeadline(() => now);
  try {
    const waiting = clockScope.wait(Promise.resolve(1)); now = 85_000;
    await assert.rejects(waiting, /provider_deadline/);
  } finally { clockScope.dispose(); }
});
test("deadline invalid non-finite budgets reject without timers", () => {
  for (const total of [NaN, Infinity, -1, 0]) assert.throws(() => new ProviderDeadline(undefined, total, 0), /invalid_deadline/);
  assert.throws(() => new ProviderDeadline(undefined, 1000, NaN), /invalid_deadline/);
});
