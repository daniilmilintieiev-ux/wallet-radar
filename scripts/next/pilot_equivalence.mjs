#!/usr/bin/env node
/**
 * Expanded Equivalence test suite between scoreAt and runTrustCheck.
 * Verifies that the composed scoring pipeline in pilot_score.mjs produces
 * results identical to runTrustCheck under stubbed network and fixed time T across:
 *   1. Baseline test (windowed mode with gap and burst)
 *   2. Snapshot-mode test (< 3 prior txs older than 7 days, >= 20 recent txs)
 *   3. T_b test (evaluating strictly before compromise: T_b = T - 300s)
 *   4. 5 randomized check times T (seed 20261017)
 */

import assert from "node:assert/strict";
import { scoreAt, runTrustCheck, SYSTEM_PROGRAM } from "./pilot_score.mjs";

const DAY = 86_400;
const WALLET = "4J7uT2PQnrfWazv3DJcM82i49WmTugyfpdmDvEjKLDks";

// PRNG with seed 20261017 (Mulberry32)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runTrustCheckMocked(wallet, txs, checkTime) {
  const origNow = Date.now;
  const origFetch = globalThis.fetch;

  Date.now = () => checkTime * 1000;
  globalThis.fetch = async (input, init) => {
    const urlStr = String(input);
    if (urlStr.includes("/v0/addresses") && urlStr.includes("/transactions")) {
      const sortedNewestFirst = [...txs].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      return new Response(JSON.stringify(sortedNewestFirst), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (init && init.body) {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed.method === "getBalance") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 1_000_000_000 } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (parsed.method === "getTokenAccountsByOwner") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (parsed.method === "getAccountInfo") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { owner: SYSTEM_PROGRAM } } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch {}
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  try {
    return await runTrustCheck("stub_key", wallet, { noPrices: true, windowDays: 7 });
  } finally {
    Date.now = origNow;
    globalThis.fetch = origFetch;
  }
}

function compareResults(testName, scoreRes, trustRes) {
  const scoreTypes = scoreRes.anomalies.map((a) => `${a.type}:${a.severity}`);
  const trustTypes = trustRes.anomalies.map((a) => `${a.type}:${a.severity}`);

  const riskMatch = scoreRes.riskScore === trustRes.riskScore;
  const anomaliesMatch = JSON.stringify(scoreTypes) === JSON.stringify(trustTypes);

  console.log(`\n[${testName}]`);
  console.log(`  scoreAt:       riskScore=${scoreRes.riskScore}, anomalies=[${scoreTypes.join(", ")}]`);
  console.log(`  runTrustCheck: riskScore=${trustRes.riskScore}, anomalies=[${trustTypes.join(", ")}]`);
  console.log(`  Match:         riskScore: ${riskMatch}, anomalies: ${anomaliesMatch}`);

  if (!riskMatch || !anomaliesMatch) {
    throw new Error(`Equivalence failure in ${testName}!`);
  }
  return true;
}

export async function runEquivalenceTest() {
  console.log("================================================================================");
  console.log("EXPANDED PILOT EQUIVALENCE TEST SUITE");
  console.log("================================================================================");

  const T_BASE = 1659500000;

  // 1. BASELINE TEST (Original windowed test with 40 txs)
  const baseTxs = [];
  for (let i = 0; i < 37; i++) {
    const ts = T_BASE - 35 * DAY + Math.floor(i * ((14 * DAY) / 37));
    baseTxs.push({
      signature: `base_tx_${i}`,
      timestamp: ts,
      source: "JUPITER",
      type: "SWAP",
      feePayer: WALLET,
      nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: "Normal11111111111111111111111111111", amount: 100_000_000 }],
    });
  }
  for (let i = 0; i < 3; i++) {
    const ts = T_BASE - 1800 + i * 600;
    baseTxs.push({
      signature: `burst_tx_${i}`,
      timestamp: ts,
      source: "SYSTEM_PROGRAM",
      type: "TRANSFER",
      feePayer: WALLET,
      nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: `Attacker${i}111111111111111111111111111`, amount: 50_000_000_000 }],
    });
  }
  const scoreBase = scoreAt(WALLET, baseTxs, T_BASE);
  const trustBase = await runTrustCheckMocked(WALLET, baseTxs, T_BASE);
  compareResults("Test 1: Baseline Windowed Mode", scoreBase, trustBase);

  // 2. SNAPSHOT-MODE TEST (< 3 prior txs older than 7d, >= 20 recent txs)
  // Only 1 transaction older than 7 days, 22 transactions in the last 7 days
  const snapTxs = [];
  snapTxs.push({
    signature: "old_tx_1",
    timestamp: T_BASE - 10 * DAY,
    source: "JUPITER",
    type: "SWAP",
    feePayer: WALLET,
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: "Normal11111111111111111111111111111", amount: 50_000_000 }],
  });
  for (let i = 0; i < 22; i++) {
    const ts = T_BASE - 5 * DAY + Math.floor(i * ((4 * DAY) / 22));
    snapTxs.push({
      signature: `recent_tx_${i}`,
      timestamp: ts,
      source: "JUPITER",
      type: "SWAP",
      feePayer: WALLET,
      nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: "Normal11111111111111111111111111111", amount: 100_000_000 }],
    });
  }
  const scoreSnap = scoreAt(WALLET, snapTxs, T_BASE);
  const trustSnap = await runTrustCheckMocked(WALLET, snapTxs, T_BASE);
  compareResults("Test 2 (i): Snapshot Mode (< 3 prior txs)", scoreSnap, trustSnap);

  // 3. T_b TEST (T_b = T_BASE - 300s, transactions with timestamp < T_b)
  const T_B = T_BASE - 300;
  const tbTxs = baseTxs.filter((t) => (t.timestamp ?? 0) < T_B);
  const scoreTb = scoreAt(WALLET, tbTxs, T_B);
  const trustTb = await runTrustCheckMocked(WALLET, tbTxs, T_B);
  compareResults("Test 3 (ii): Checkpoint T_b (strictly before t0)", scoreTb, trustTb);

  // 4. RANDOMIZED TIME TEST (5 random values of T, seed 20261017)
  const rng = mulberry32(20261017);
  console.log("\n[Test 4 (iii): 5 Randomized Checkpoint Times (seed 20261017)]");
  for (let r = 0; r < 5; r++) {
    // Offset between -10 days and +5 days
    const offsetSec = Math.floor((rng() - 0.5) * 20 * DAY);
    const T_rand = T_BASE + offsetSec;
    const randTxs = baseTxs.filter((t) => (t.timestamp ?? 0) <= T_rand);
    const scoreRand = scoreAt(WALLET, randTxs, T_rand);
    const trustRand = await runTrustCheckMocked(WALLET, randTxs, T_rand);
    compareResults(`Random T #${r + 1} (T=${T_rand}, ${randTxs.length} txs)`, scoreRand, trustRand);
  }

  console.log("\n================================================================================");
  console.log("ALL EQUIVALENCE TESTS PASSED STRICTLY (100% IDENTICAL)");
  console.log("================================================================================\n");
  return true;
}

if (process.argv[1] && process.argv[1].endsWith("pilot_equivalence.mjs")) {
  runEquivalenceTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
