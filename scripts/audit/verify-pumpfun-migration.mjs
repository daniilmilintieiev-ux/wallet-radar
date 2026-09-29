#!/usr/bin/env node
// Stage 6A.5 (ground-truth audit, see CLAUDE.md / docs/TESTER-SPEC.md).
//
// Verifies, on real examples, that a pump.fun bonding-curve PDA is genuinely
// drained (down to ~rent-exempt minimum) once a token migrates to a real AMM
// pool -- the premise behind excluding liquidity migrations from outcome
// criterion (b) in docs/TESTER-SPEC.md (a migration looks identical to a
// "pool drained 90%+" rug if you only look at the bonding curve balance).
//
// Method: for each mint, (1) derive its pump.fun bonding curve PDA (same
// derivation as src/mint.ts's getPumpFunBondingCurvePda, imported from
// dist/, not reimplemented), (2) read its CURRENT SOL balance via public
// RPC, (3) independently cross-check via DexScreener's public search API
// that a PumpSwap (or other AMM) pair exists for the same mint with real
// liquidity. Two independent sources agreeing (curve ~empty AND a
// successor pool holds real liquidity) is the evidence, not either alone.
//
// Public RPC + public DexScreener API, no API key, no radar.env read.
//
// Usage: node scripts/audit/verify-pumpfun-migration.mjs [mint1 mint2 mint3 ...]

import { getPumpFunBondingCurvePda } from "../../dist/src/mint.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

const RENT_EXEMPT_THRESHOLD_LAMPORTS = 2_000_000; // bonding curve rent-exempt minimum is ~1.42M lamports; allow headroom

async function checkMint(mint) {
  const pda = getPumpFunBondingCurvePda(mint);
  const balResp = await rpc("getBalance", [pda]);
  const lamports = balResp?.result?.value ?? null;

  let dexPairs = null;
  try {
    const dexResp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(15000) });
    const dexData = await dexResp.json();
    dexPairs = dexData?.pairs ?? null;
  } catch {
    dexPairs = "НЕ ПРОВЕРЕНО (DexScreener fetch failed)";
  }

  const curveDrained = typeof lamports === "number" && lamports <= RENT_EXEMPT_THRESHOLD_LAMPORTS;
  const hasSuccessorPool = Array.isArray(dexPairs) && dexPairs.length > 0 && dexPairs.some((p) => (p.liquidity?.usd ?? 0) > 0);

  return {
    mint,
    bondingCurvePda: pda,
    curveLamportsNow: lamports,
    curveDrained,
    dexPairs: Array.isArray(dexPairs) ? dexPairs.map((p) => ({ dexId: p.dexId, pairAddress: p.pairAddress, liquidityUsd: p.liquidity?.usd ?? null, pairCreatedAt: p.pairCreatedAt ?? null })) : dexPairs,
    hasSuccessorPool,
    migrationEvidenceConsistent: curveDrained && hasSuccessorPool,
  };
}

async function main() {
  const mints = process.argv.slice(2);
  if (mints.length === 0) {
    console.error("Usage: node scripts/audit/verify-pumpfun-migration.mjs <mint1> [mint2 ...]");
    process.exit(1);
  }
  const results = [];
  for (const mint of mints) {
    const r = await checkMint(mint);
    results.push(r);
    console.log(`${mint}: curve=${r.curveLamportsNow} lamports (drained=${r.curveDrained}) | successor pool liquidity found=${r.hasSuccessorPool} | consistent=${r.migrationEvidenceConsistent}`);
    if (Array.isArray(r.dexPairs)) {
      for (const p of r.dexPairs) console.log(`    ${p.dexId} ${p.pairAddress} liq=$${p.liquidityUsd}`);
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  console.log("\n=== SUMMARY ===");
  console.log(`${results.filter((r) => r.migrationEvidenceConsistent).length}/${results.length} mints show BOTH a drained bonding curve AND a successor AMM pool with real liquidity.`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
