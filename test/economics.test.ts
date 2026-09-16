import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { computeEconomics, recordHeliusCost, loadCostRates, DEFAULT_COST_RATES } from "../src/economics.js";

function tmpStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "radar-econ-"));
  return { store: new Store(join(dir, "econ.db")), dir };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const NOW = Math.floor(Date.now() / 1000);

test("economics: store revenue + cost aggregation", () => {
  const { store, dir } = tmpStore();
  // Revenue: 3 settled payments (USDC).
  store.recordSettledPayment({ signature: "sig1", payer: "P1", recipient: "R", amount: 0.005, endpoint: "/scan" }, NOW - 10);
  store.recordSettledPayment({ signature: "sig2", payer: "P2", recipient: "R", amount: 0.005, endpoint: "/scan" }, NOW - 20);
  store.recordSettledPayment({ signature: "sig3", payer: "P3", recipient: "R", amount: 0.001, endpoint: "/analyze" }, NOW - 30);

  const rev = store.getRevenueSummary();
  assert.equal(rev.payments, 3);
  assert.equal(rev.totalUsdc, 0.011);
  assert.deepEqual(rev.byEndpoint["/scan"], { count: 2, amountUsdc: 0.01 });
  assert.deepEqual(rev.byEndpoint["/analyze"], { count: 1, amountUsdc: 0.001 });

  // Cost: 2 helius events.
  store.recordCostEvent({ ts: NOW - 5, category: "helius", quantity: 1, unitPriceUsd: 0.0005, totalUsd: 0.0005 });
  store.recordCostEvent({ ts: NOW - 6, category: "helius", quantity: 1, unitPriceUsd: 0.0005, totalUsd: 0.0005 });
  const cost = store.getCostSummary();
  assert.equal(cost.events, 2);
  assert.equal(cost.totalUsd, 0.001);
  assert.equal(cost.byCategory.helius, 0.001);

  store.close();
  cleanup(dir);
});

test("economics: computeEconomics net-positive is self-sustaining", () => {
  const { store, dir } = tmpStore();
  store.recordSettledPayment({ signature: "s1", payer: "P", recipient: "R", amount: 1.0, endpoint: "/scan" }, NOW);
  store.recordCostEvent({ ts: NOW, category: "helius", quantity: 1, unitPriceUsd: 0.0005, totalUsd: 0.4 });
  const r = computeEconomics(store, { rates: DEFAULT_COST_RATES });
  assert.equal(r.revenue.totalUsdc, 1.0);
  assert.equal(r.revenue.totalUsd, 1.0);
  assert.equal(r.cost.totalUsd, 0.4);
  assert.equal(r.net.usd, 0.6);
  assert.equal(r.net.marginPct, 60);
  assert.equal(r.net.selfSustaining, true);
  assert.equal(r.unitEconomics.paidScans, 1);
  assert.equal(r.unitEconomics.avgRevenuePerPaidScanUsd, 1.0);
  assert.equal(r.unitEconomics.avgCostPerScanUsd, 0.4);
  assert.equal(r.unitEconomics.netPerScanUsd, 0.6);
  store.close();
  cleanup(dir);
});

test("economics: computeEconomics net-negative is NOT self-sustaining", () => {
  const { store, dir } = tmpStore();
  store.recordSettledPayment({ signature: "s1", payer: "P", recipient: "R", amount: 1.0, endpoint: "/scan" }, NOW);
  store.recordCostEvent({ ts: NOW, category: "helius", quantity: 1, unitPriceUsd: 0.0005, totalUsd: 1.2 });
  const r = computeEconomics(store, { rates: DEFAULT_COST_RATES });
  assert.equal(r.net.usd, -0.2);
  assert.equal(r.net.marginPct, -20);
  assert.equal(r.net.selfSustaining, false);
  store.close();
  cleanup(dir);
});

test("economics: zero revenue => margin null, not self-sustaining", () => {
  const { store, dir } = tmpStore();
  store.recordCostEvent({ ts: NOW, category: "helius", quantity: 1, unitPriceUsd: 0.0005, totalUsd: 0.5 });
  const r = computeEconomics(store, { rates: DEFAULT_COST_RATES });
  assert.equal(r.revenue.totalUsd, 0);
  assert.equal(r.net.usd, -0.5);
  assert.equal(r.net.marginPct, null);
  assert.equal(r.net.selfSustaining, false);
  store.close();
  cleanup(dir);
});

test("economics: perDay groups revenue + cost and sorts ascending", () => {
  const { store, dir } = tmpStore();
  store.recordSettledPayment({ signature: "a", payer: "P", recipient: "R", amount: 0.5, endpoint: "/scan" }, NOW - 2 * 86400);
  store.recordSettledPayment({ signature: "b", payer: "P", recipient: "R", amount: 0.5, endpoint: "/scan" }, NOW);
  store.recordCostEvent({ ts: NOW, category: "helius", quantity: 1, unitPriceUsd: 0.0005, totalUsd: 0.1 });
  const r = computeEconomics(store, { rates: DEFAULT_COST_RATES, days: 30 });
  assert.ok(r.perDay.length >= 1);
  // All revenue is within the 30-day window, so per-day revenue sums to total.
  const perDayRevSum = r.perDay.reduce((s, d) => s + d.revenueUsd, 0);
  assert.equal(perDayRevSum, r.revenue.totalUsd);
  const days = r.perDay.map((d) => d.day);
  assert.deepEqual(days, [...days].sort());
  // The most recent day carries the 0.5 revenue and the 0.1 cost.
  const today = r.perDay[r.perDay.length - 1];
  assert.equal(today.revenueUsd, 0.5);
  assert.equal(today.costUsd, 0.1);
  store.close();
  cleanup(dir);
});

test("economics: recordHeliusCost increments the cost ledger", () => {
  const { store, dir } = tmpStore();
  assert.equal(store.getCostSummary().events, 0);
  recordHeliusCost(store, "/scan", DEFAULT_COST_RATES);
  recordHeliusCost(store, "/trust", DEFAULT_COST_RATES);
  const cost = store.getCostSummary();
  assert.equal(cost.events, 2);
  assert.equal(cost.totalUsd, 2 * DEFAULT_COST_RATES.heliusPerCallUsd);
  store.close();
  cleanup(dir);
});

test("economics: loadCostRates falls back to defaults and honors env", () => {
  assert.deepEqual(loadCostRates({}), DEFAULT_COST_RATES);
  assert.equal(loadCostRates({ RADAR_HELIUS_COST_PER_CALL_USD: "0.002" }).heliusPerCallUsd, 0.002);
  assert.equal(loadCostRates({ RADAR_LLM_COST_PER_CALL_USD: "0.5" }).llmPerCallUsd, 0.5);
  assert.equal(loadCostRates({ RADAR_HELIUS_COST_PER_CALL_USD: "bad" }).heliusPerCallUsd, DEFAULT_COST_RATES.heliusPerCallUsd);
});
