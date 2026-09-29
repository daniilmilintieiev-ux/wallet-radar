#!/usr/bin/env node
// Stage 5A (ground-truth audit, see CLAUDE.md). Extends stage-4C's exp2.
//
// 1. Fidelity check: reimplement history-machine.ts's walk-forward WITH
//    mintRisk (from benchmarks/mint-cache.json) and confirm it reproduces
//    benchmarks/simulation-results.json's finalVerdict/finalRiskScore
//    exactly, before trusting any counterfactual built on the same code.
// 2. Path B_noMintRisk: the SAME walk-forward loop, SAME window (all cached
//    txs, step by step, not trust.ts's 7-day window), mintRisk forced to
//    null. This isolates "does mintRisk change the outcome" while holding
//    the windowing/methodology constant -- unlike stage-4C's path A, which
//    changes BOTH windowing and mintRisk at once.
// 3. Path A: trust.ts's own methodology (7-day window anchored to the
//    wallet's last cached activity, ONE detectAnomalies call, no mintRisk)
//    -- re-run here (not reading stage-4C's CSV) so the same address/category
//    sample and prices are used consistently across all three paths.
// 4. Direction tables (A vs B_withMintRisk) for both groups: stricter /
//    softer / same.
// 5. Decomposition: (A vs B_noMintRisk) isolates the window-methodology
//    effect alone (mintRisk absent on both sides). (B_noMintRisk vs
//    B_withMintRisk) isolates the mintRisk effect alone (same walk-forward
//    window on both sides).
//
// This does NOT modify src/ or scripts/history-machine.ts. It is a
// separate, additional reimplementation living only in scripts/audit/.
// No network calls.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectScoring, TRUST_DEFAULTS } from "../../dist/src/trust.js";
import { updateBaseline } from "../../dist/src/baseline.js";
import { detectAnomalies, computeRiskScore } from "../../dist/src/analyzer.js";
import { BLUECHIP_FALLBACK_PRICES } from "../../dist/src/pricing.js";
import { replayWalkForward, loadCachedTxs } from "./lib/walk-forward-replay.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260929;
const SAMPLE_SIZE = 100;

const historyCacheDir = path.join(ROOT, "benchmarks/history-cache");
const sim = readJson(path.join(ROOT, "benchmarks/simulation-results.json"));
const mintCache = readJson(path.join(ROOT, "benchmarks/mint-cache.json"));
const priceCachePath = path.join(ROOT, "benchmarks/price-cache.json");
const prices = { ...BLUECHIP_FALLBACK_PRICES, ...(fs.existsSync(priceCachePath) ? readJson(priceCachePath) : {}) };

const blocked = sim.results.filter((r) => r.finalVerdict === "BLOCKED");
const nonBlocked = sim.results.filter((r) => r.finalVerdict !== "BLOCKED");
const rand = mulberry32(SEED);
const shuffled = [...nonBlocked];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const sampledNonBlocked = shuffled.slice(0, SAMPLE_SIZE);

function pathA(address) {
  const sortedTxs = loadCachedTxs(historyCacheDir, address);
  if (!sortedTxs) return { available: false };
  if (sortedTxs.length === 0) return { available: true, riskScore: 0 };
  const stamps = sortedTxs.map((t) => t.timestamp).filter((n) => typeof n === "number");
  const generatedAt = (stamps.length > 0 ? Math.max(...stamps) : 0) + 1;
  const windowStart = generatedAt - TRUST_DEFAULTS.windowDays * 86_400;
  const { baselineTxs, evalTxs } = selectScoring(sortedTxs, windowStart);
  const baseline = updateBaseline(address, null, baselineTxs, generatedAt, prices);
  const anomalies = detectAnomalies(address, evalTxs, baseline, undefined, prices);
  return { available: true, riskScore: computeRiskScore(anomalies) };
}

function bucket(record) {
  const address = record.address;
  const category = record.category;
  const sortedTxs = loadCachedTxs(historyCacheDir, address);
  const a = pathA(address);

  if (!sortedTxs) {
    return { address, category, available: false };
  }

  const bWith = replayWalkForward(address, category, sortedTxs, prices, mintCache);
  const bWithout = replayWalkForward(address, category, sortedTxs, prices, null);

  const fidelityMatch = bWith.finalVerdict === record.finalVerdict && bWith.finalRiskScore === record.finalRiskScore;

  const pathA_flag = a.available ? a.riskScore > TRUST_DEFAULTS.maxRisk : null;
  const pathBWith_blocked = record.finalVerdict === "BLOCKED";
  const pathBWithout_blocked = bWithout.finalVerdict === "BLOCKED";

  // Direction, A vs recorded B (WITH mintRisk):
  //   "A stricter" = A flags, B does not block
  //   "A softer"   = B blocks, A does not flag
  //   "same"       = both flag or both don't
  let direction_A_vs_BWith = "same";
  if (a.available) {
    if (pathA_flag && !pathBWith_blocked) direction_A_vs_BWith = "A stricter";
    else if (!pathA_flag && pathBWith_blocked) direction_A_vs_BWith = "A softer";
  } else {
    direction_A_vs_BWith = "НЕ ПРОВЕРЕНО";
  }

  // Window-only effect: A (no mintRisk, 7d window) vs B_noMintRisk (no mintRisk, walk-forward window)
  let direction_A_vs_BWithout = "same";
  if (a.available) {
    if (pathA_flag && !pathBWithout_blocked) direction_A_vs_BWithout = "A stricter";
    else if (!pathA_flag && pathBWithout_blocked) direction_A_vs_BWithout = "A softer";
  } else {
    direction_A_vs_BWithout = "НЕ ПРОВЕРЕНО";
  }

  // mintRisk-only effect: B_noMintRisk vs B_withMintRisk (same walk-forward window both sides)
  let direction_BWithout_vs_BWith = "same";
  if (!pathBWithout_blocked && pathBWith_blocked) direction_BWithout_vs_BWith = "mintRisk adds block";
  else if (pathBWithout_blocked && !pathBWith_blocked) direction_BWithout_vs_BWith = "mintRisk removes block (unexpected)";

  return {
    address,
    category,
    available: true,
    fidelityMatch,
    recordedVerdict: record.finalVerdict,
    recordedRisk: record.finalRiskScore,
    pathA_available: a.available,
    pathA_risk: a.available ? a.riskScore : null,
    pathA_flag,
    bWithout_verdict: bWithout.finalVerdict,
    bWithout_risk: bWithout.finalRiskScore,
    direction_A_vs_BWith,
    direction_A_vs_BWithout,
    direction_BWithout_vs_BWith,
  };
}

function summarize(label, records) {
  const rows = records.map(bucket);
  const available = rows.filter((r) => r.available);
  const fidelityMismatches = available.filter((r) => !r.fidelityMatch);
  const dirCounts_A_vs_BWith = {};
  const dirCounts_A_vs_BWithout = {};
  const dirCounts_BWithout_vs_BWith = {};
  for (const r of available) {
    dirCounts_A_vs_BWith[r.direction_A_vs_BWith] = (dirCounts_A_vs_BWith[r.direction_A_vs_BWith] || 0) + 1;
    dirCounts_A_vs_BWithout[r.direction_A_vs_BWithout] = (dirCounts_A_vs_BWithout[r.direction_A_vs_BWithout] || 0) + 1;
    dirCounts_BWithout_vs_BWith[r.direction_BWithout_vs_BWith] = (dirCounts_BWithout_vs_BWith[r.direction_BWithout_vs_BWith] || 0) + 1;
  }
  return { label, rows, available, fidelityMismatches, dirCounts_A_vs_BWith, dirCounts_A_vs_BWithout, dirCounts_BWithout_vs_BWith };
}

const resBlocked = summarize("58 BLOCKED", blocked);
const resSample = summarize(`${SAMPLE_SIZE} sampled non-BLOCKED (seed=${SEED})`, sampledNonBlocked);

console.log("=== 0. FIDELITY CHECK (reimplemented walk-forward WITH mintRisk vs benchmarks/simulation-results.json) ===");
for (const res of [resBlocked, resSample]) {
  console.log(`${res.label}: ${res.available.length - res.fidelityMismatches.length}/${res.available.length} exact match`);
  for (const m of res.fidelityMismatches) {
    console.log(`  MISMATCH ${m.address}: recorded=${m.recordedVerdict}/${m.recordedRisk} vs reimplemented(withMintRisk) unavailable-in-log`);
  }
}

console.log("\n=== 1. DIRECTION TABLE: path A (trust.ts, no mintRisk, 7d window) vs recorded B (history-machine, WITH mintRisk) ===");
for (const res of [resBlocked, resSample]) {
  console.log(`${res.label}:`, JSON.stringify(res.dirCounts_A_vs_BWith));
}

console.log("\n=== 2. WINDOW-ONLY EFFECT: path A (no mintRisk, 7d) vs B_noMintRisk (no mintRisk, walk-forward window) ===");
for (const res of [resBlocked, resSample]) {
  console.log(`${res.label}:`, JSON.stringify(res.dirCounts_A_vs_BWithout));
}

console.log("\n=== 3. MINTRISK-ONLY EFFECT: B_noMintRisk vs B_withMintRisk (SAME walk-forward window both sides) ===");
for (const res of [resBlocked, resSample]) {
  console.log(`${res.label}:`, JSON.stringify(res.dirCounts_BWithout_vs_BWith));
}

console.log("\naddress,group,category,recordedVerdict,recordedRisk,pathA_risk,pathA_flag,bWithout_verdict,bWithout_risk,dir_A_vs_BWith,dir_A_vs_BWithout,dir_BWithout_vs_BWith");
for (const [group, res] of [["blocked58", resBlocked], ["sample100", resSample]]) {
  for (const r of res.rows) {
    if (!r.available) {
      console.log([r.address, group, r.category, "НЕ ПРОВЕРЕНО (нет кэша)", "", "", "", "", "", "", "", ""].join(","));
      continue;
    }
    console.log(
      [r.address, group, r.category, r.recordedVerdict, r.recordedRisk, r.pathA_risk, r.pathA_flag, r.bWithout_verdict, r.bWithout_risk, r.direction_A_vs_BWith, r.direction_A_vs_BWithout, r.direction_BWithout_vs_BWith].join(","),
    );
  }
}
