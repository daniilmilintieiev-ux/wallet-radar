#!/usr/bin/env node
/**
 * Equivalence test between scoreAt and runTrustCheck.
 * Verifies that the composed scoring pipeline in pilot_score.mjs produces
 * results identical to runTrustCheck under stubbed network and fixed time T.
 */

import assert from "node:assert/strict";
import { scoreAt, runTrustCheck, SYSTEM_PROGRAM } from "./pilot_score.mjs";

export async function runEquivalenceTest() {
  console.log("=== PILOT PIPELINE EQUIVALENCE TEST ===");

  const DAY = 86_400;
  const T = 1659500000; // Fixed evaluation timestamp
  const wallet = "4J7uT2PQnrfWazv3DJcM82i49WmTugyfpdmDvEjKLDks";

  // Build synthetic history (40 transactions):
  // 1. Normal activity (37 transactions between T - 35 days and T - 21 days)
  const syntheticTxs = [];
  for (let i = 0; i < 37; i++) {
    const ts = T - 35 * DAY + Math.floor(i * ((14 * DAY) / 37));
    syntheticTxs.push({
      signature: `normal_tx_${i}`,
      timestamp: ts,
      source: "JUPITER",
      type: "SWAP",
      feePayer: wallet,
      nativeTransfers: [
        {
          fromUserAccount: wallet,
          toUserAccount: "NormalCounterparty111111111111111111111111",
          amount: 100_000_000,
        },
      ],
    });
  }

  // 2. 20-day break (T - 21 days to T - 1 day, no transactions)

  // 3. Burst of 3 large transfers to new addresses within the last hour before T
  for (let i = 0; i < 3; i++) {
    const ts = T - 1800 + i * 600;
    syntheticTxs.push({
      signature: `burst_tx_${i}`,
      timestamp: ts,
      source: "SYSTEM_PROGRAM",
      type: "TRANSFER",
      feePayer: wallet,
      nativeTransfers: [
        {
          fromUserAccount: wallet,
          toUserAccount: `NewAttackerTarget${i}11111111111111111111111`,
          amount: 50_000_000_000,
        },
      ],
    });
  }

  console.log(`Synthetic history generated: ${syntheticTxs.length} transactions.`);

  // 1. Run scoreAt
  const scoreAtRes = scoreAt(wallet, syntheticTxs, T);
  console.log("\n1. scoreAt output:");
  console.log(`   riskScore: ${scoreAtRes.riskScore}`);
  console.log(`   baselineMode: ${scoreAtRes.baselineMode}`);
  console.log(`   anomalies count: ${scoreAtRes.anomalies.length}`);
  for (const a of scoreAtRes.anomalies) {
    console.log(`   - [${a.severity.toUpperCase()}] ${a.type}: ${a.text}`);
  }

  // 2. Run runTrustCheck with stubbed network and fixed Date.now
  const origNow = Date.now;
  const origFetch = globalThis.fetch;

  Date.now = () => T * 1000;
  globalThis.fetch = async (input, init) => {
    const urlStr = String(input);
    // Helius history endpoint
    if (urlStr.includes("/v0/addresses") && urlStr.includes("/transactions")) {
      const sortedNewestFirst = [...syntheticTxs].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      return new Response(JSON.stringify(sortedNewestFirst), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Solana RPC mock for balances and account authority
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

  let trustRes;
  try {
    trustRes = await runTrustCheck("stub_key", wallet, { noPrices: true, windowDays: 7 });
  } finally {
    Date.now = origNow;
    globalThis.fetch = origFetch;
  }

  console.log("\n2. runTrustCheck output:");
  console.log(`   riskScore: ${trustRes.riskScore}`);
  console.log(`   anomalies count: ${trustRes.anomalies.length}`);
  for (const a of trustRes.anomalies) {
    console.log(`   - [${a.severity.toUpperCase()}] ${a.type}: ${a.text}`);
  }

  // 3. Comparison
  const scoreAtTypes = scoreAtRes.anomalies.map((a) => a.type);
  const trustTypes = trustRes.anomalies.map((a) => a.type);

  const riskScoreMatches = scoreAtRes.riskScore === trustRes.riskScore;
  const anomalyTypesMatch = JSON.stringify(scoreAtTypes) === JSON.stringify(trustTypes);

  console.log("\n3. Equivalence comparison:");
  console.log(`   riskScore match: ${riskScoreMatches} (${scoreAtRes.riskScore} vs ${trustRes.riskScore})`);
  console.log(`   anomaly types match: ${anomalyTypesMatch} (${JSON.stringify(scoreAtTypes)} vs ${JSON.stringify(trustTypes)})`);

  if (!riskScoreMatches || !anomalyTypesMatch) {
    console.error("FAIL: Equivalence test did not match!");
    return false;
  }

  console.log("\nSUCCESS: scoreAt and runTrustCheck are strictly equivalent.\n");
  return true;
}

// Direct execution
if (process.argv[1] && process.argv[1].endsWith("pilot_equivalence.mjs")) {
  const ok = await runEquivalenceTest();
  process.exit(ok ? 0 : 1);
}
