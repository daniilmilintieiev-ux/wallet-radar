#!/usr/bin/env node
// Stage 6B.3 (ground-truth audit, see docs/TESTER-SPEC.md).
//
// For purchases whose mint passed the age + SetAuthority-clean filters
// (scripts/audit/pilot-check-mint-age-and-authority.mjs) and where t is at
// least 8 days in the past, computes outcome criterion (a) (frozen buyer
// token account) fully, and attempts (b) (pool liquidity drop, excluding
// migrations) best-effort using the buyer's own purchase transaction to
// identify the pool side. Where the pool cannot be unambiguously
// identified, the trade is marked "pool not identified" per
// docs/TESTER-SPEC.md's own pre-registered exclusion rule -- not treated
// as SAFE.
//
// Public RPC (or Helius if HELIUS_API_KEY is set in env -- never read from
// radar.env, never printed). No src/ changes.
//
// Usage: node scripts/audit/pilot-compute-outcomes.mjs <output.jsonl> <purchases.json>
// where purchases.json is an array of {wallet, mint, t, signature}.

import fs from "node:fs";
import { getPumpFunBondingCurvePda, KNOWN_AMM_OWNERS } from "../../dist/src/mint.js";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function rpc(method, params, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json();
    if (data?.error?.code === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    return data;
  }
}

async function checkOutcome(purchase) {
  const { wallet, mint, t, signature } = purchase;
  const txResp = await rpc("getTransaction", [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
  const tx = txResp?.result;
  if (!tx) return { ...purchase, error: "исходная транзакция не найдена (getTransaction)" };

  const postBalances = tx.meta?.postTokenBalances ?? [];
  const preBalances = tx.meta?.preTokenBalances ?? [];

  // Buyer's own token account for this mint, from the purchase tx itself.
  const buyerPost = postBalances.find((b) => b.mint === mint && b.owner === wallet);
  const accountKeys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const buyerTokenAccount = buyerPost ? accountKeys[buyerPost.accountIndex] : null;

  // --- (a) frozen buyer token account ---
  let outcomeA = "НЕ ПРОВЕРЕНО (buyer token account не идентифицирован в purchase tx)";
  if (buyerTokenAccount) {
    const acctResp = await rpc("getAccountInfo", [buyerTokenAccount, { encoding: "jsonParsed" }]);
    const value = acctResp?.result?.value;
    if (acctResp?.error) outcomeA = "НЕ ПРОВЕРЕНО (RPC error)";
    else if (value === null) outcomeA = "невосстановимо (ATA закрыт)";
    else {
      const state = value?.data?.parsed?.info?.state;
      outcomeA = state === "frozen" ? "DANGEROUS" : "не сработал";
    }
  }

  // --- (b) pool liquidity drop, best-effort pool identification ---
  // Candidate pool token accounts: any token account in the SAME purchase tx
  // holding this mint, NOT owned by the buyer wallet (i.e. the other side of
  // the swap -- typically an AMM vault or the pump.fun bonding curve ATA).
  const poolCandidates = postBalances.filter((b) => b.mint === mint && b.owner !== wallet && b.owner);
  let outcomeB = "пул не идентифицирован";
  let poolInfo = null;
  if (poolCandidates.length === 1) {
    const poolOwner = poolCandidates[0].owner;
    const poolTokenAccount = accountKeys[poolCandidates[0].accountIndex];
    const preEntry = preBalances.find((b) => b.accountIndex === poolCandidates[0].accountIndex);
    const liquidityAtT = poolCandidates[0].uiTokenAmount?.uiAmount ?? null;

    const nowResp = await rpc("getTokenAccountBalance", [poolTokenAccount]);
    const liquidityNow = nowResp?.result?.value?.uiAmount ?? null;

    if (typeof liquidityAtT === "number" && typeof liquidityNow === "number" && liquidityAtT > 0) {
      const dropRatio = (liquidityAtT - liquidityNow) / liquidityAtT;
      if (dropRatio >= 0.9) {
        // Check for migration: is this a pump.fun bonding curve, and does a successor pool exist?
        const bondingCurve = getPumpFunBondingCurvePda(mint);
        const isBondingCurve = poolTokenAccount === bondingCurve || poolOwner === bondingCurve;
        let migrationDetected = false;
        if (isBondingCurve) {
          try {
            const dexResp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(15000) });
            const dexData = await dexResp.json();
            migrationDetected = Array.isArray(dexData?.pairs) && dexData.pairs.some((p) => (p.liquidity?.usd ?? 0) > 0);
          } catch {
            migrationDetected = "НЕ ПРОВЕРЕНО (DexScreener недоступен)";
          }
        }
        outcomeB = migrationDetected === true ? "миграция, не исход" : migrationDetected === "НЕ ПРОВЕРЕНО (DexScreener недоступен)" ? "НЕ ОПРЕДЕЛЕНО (падение >=90%, миграция не проверена)" : "DANGEROUS";
      } else {
        outcomeB = "не сработал";
      }
      poolInfo = { poolTokenAccount, poolOwner, liquidityAtT, liquidityNow, dropRatio };
    } else {
      outcomeB = "НЕ ПРОВЕРЕНО (не удалось получить текущий баланс пула)";
    }
  } else if (poolCandidates.length > 1) {
    outcomeB = `пул не идентифицирован (${poolCandidates.length} кандидатов)`;
  }

  return {
    wallet,
    mint,
    t,
    signature,
    buyerTokenAccount,
    outcomeA,
    outcomeB,
    poolInfo,
    dangerous: outcomeA === "DANGEROUS" || outcomeB === "DANGEROUS",
  };
}

async function main() {
  const [, , outPath, purchasesPath] = process.argv;
  if (!outPath || !purchasesPath) {
    console.error("Usage: node scripts/audit/pilot-compute-outcomes.mjs <output.jsonl> <purchases.json>");
    process.exit(1);
  }
  const purchases = JSON.parse(fs.readFileSync(purchasesPath, "utf-8"));
  const out = fs.createWriteStream(outPath, { flags: "w" });
  let dangerousCount = 0;
  for (const p of purchases) {
    try {
      const r = await checkOutcome(p);
      out.write(JSON.stringify(r) + "\n");
      if (r.dangerous) dangerousCount++;
      console.log(`${p.wallet.slice(0, 8)}/${p.mint.slice(0, 8)}: (a)=${r.outcomeA} (b)=${r.outcomeB}`);
    } catch (err) {
      const errRow = { ...p, error: String(err && err.message ? err.message : err) };
      out.write(JSON.stringify(errRow) + "\n");
      console.log(`${p.wallet}/${p.mint}: ERROR ${errRow.error}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  out.end();
  console.log(`\n=== ${dangerousCount}/${purchases.length} DANGEROUS ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
