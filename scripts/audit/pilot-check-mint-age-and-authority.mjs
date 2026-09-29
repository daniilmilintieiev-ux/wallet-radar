#!/usr/bin/env node
// Stage 6B.1/6B.2 (ground-truth audit, see docs/TESTER-SPEC.md section 3).
//
// For a list of (mint, referenceT) pairs, determines via public RPC (or
// Helius RPC if HELIUS_API_KEY is set -- never read from radar.env, never
// printed):
//   - whether the mint was created within 14 days before referenceT
//     (paginates getSignaturesForAddress backward with an early-exit: as
//     soon as a signature older than referenceT-14d is found, the mint is
//     confirmed too old and pagination stops -- avoids walking a whole
//     multi-thousand-tx history just to reject it). Capped at 5 pages
//     (5000 signatures); if the cap is hit without finding true genesis
//     OR a disqualifying old signature, age is "НЕ ОПРЕДЕЛЕНО" (excluded
//     conservatively, not counted as passing).
//   - whether any of up to `maxAuthorityChecks` sampled signatures (spread
//     across the full range actually fetched) is a SetAuthority
//     instruction -- only run for mints that already pass the age filter,
//     to bound RPC volume.
//
// Usage: node scripts/audit/pilot-check-mint-age-and-authority.mjs <output.jsonl> <mint:referenceT> [mint:referenceT ...]

import fs from "node:fs";

const HELIUS_KEY = process.env.HELIUS_API_KEY; // never printed, never read from radar.env
const RPC_URL = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const FOURTEEN_DAYS = 14 * 86400;
const MAX_PAGES = 5;
const PAGE_SIZE = 1000;

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

async function checkAge(mint, referenceT) {
  const cutoff = referenceT - FOURTEEN_DAYS;
  let before;
  let page = 0;
  let allFetched = [];
  let oldestSeen = null;
  let disqualified = false;
  let hitGenesis = false;

  for (page = 0; page < MAX_PAGES; page++) {
    const params = [mint, { limit: PAGE_SIZE, ...(before ? { before } : {}) }];
    const resp = await rpc("getSignaturesForAddress", params);
    const batch = resp?.result;
    if (!Array.isArray(batch) || batch.length === 0) {
      hitGenesis = page > 0 || batch?.length === 0;
      break;
    }
    allFetched.push(...batch);
    oldestSeen = batch[batch.length - 1];
    if (oldestSeen.blockTime !== null && oldestSeen.blockTime !== undefined && oldestSeen.blockTime < cutoff) {
      disqualified = true;
      break;
    }
    if (batch.length < PAGE_SIZE) {
      hitGenesis = true;
      break;
    }
    before = batch[batch.length - 1].signature;
    await new Promise((r) => setTimeout(r, 250));
  }

  const withinAgeLimit = hitGenesis && !disqualified;
  const status = disqualified ? "too_old" : hitGenesis ? "young_enough" : "НЕ ОПРЕДЕЛЕНО (потолок страниц достигнут, не дошли до создания)";

  return {
    mint,
    referenceT,
    cutoffIso: new Date(cutoff * 1000).toISOString(),
    pagesFetched: page + (allFetched.length > 0 ? 0 : 0),
    totalSignaturesFetched: allFetched.length,
    oldestSeenBlockTime: oldestSeen?.blockTime ?? null,
    oldestSeenIso: oldestSeen?.blockTime ? new Date(oldestSeen.blockTime * 1000).toISOString() : null,
    status,
    withinAgeLimit,
    allSignatures: allFetched,
  };
}

async function findSetAuthority(signatures, maxChecks = 25) {
  const step = Math.max(1, Math.floor(signatures.length / maxChecks));
  const sampled = [];
  for (let i = 0; i < signatures.length; i += step) sampled.push(signatures[i]);

  let checked = 0;
  for (const sigInfo of sampled) {
    if (checked >= maxChecks) break;
    const resp = await rpc("getTransaction", [sigInfo.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    checked++;
    const tx = resp?.result;
    const instructions = tx?.transaction?.message?.instructions ?? [];
    for (const ix of instructions) {
      if (ix?.parsed?.type === "setAuthority") {
        return { found: true, signature: sigInfo.signature, checked, sampledOf: signatures.length };
      }
    }
    const inner = tx?.meta?.innerInstructions ?? [];
    for (const group of inner) {
      for (const ix of group.instructions ?? []) {
        if (ix?.parsed?.type === "setAuthority") {
          return { found: true, signature: sigInfo.signature, checked, sampledOf: signatures.length };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { found: false, checked, sampledOf: signatures.length };
}

async function main() {
  const [, , outPath, ...pairs] = process.argv;
  if (!outPath || pairs.length === 0) {
    console.error("Usage: node scripts/audit/pilot-check-mint-age-and-authority.mjs <output.jsonl> <mint:referenceT> [...]");
    process.exit(1);
  }
  const out = fs.createWriteStream(outPath, { flags: "w" });
  for (const pair of pairs) {
    const [mint, refTStr] = pair.split(":");
    const referenceT = parseInt(refTStr, 10);
    try {
      const ageResult = await checkAge(mint, referenceT);
      let setAuthorityCheck = null;
      if (ageResult.withinAgeLimit) {
        setAuthorityCheck = await findSetAuthority(ageResult.allSignatures, 25);
      }
      const { allSignatures, ...ageResultSlim } = ageResult;
      const row = { ...ageResultSlim, setAuthorityCheck };
      out.write(JSON.stringify(row) + "\n");
      console.log(`${mint}: age=${ageResult.status} (oldest seen ${ageResult.oldestSeenIso}) | setAuthority=${setAuthorityCheck ? `found=${setAuthorityCheck.found} (${setAuthorityCheck.checked}/${setAuthorityCheck.sampledOf})` : "skipped (failed age filter)"}`);
    } catch (err) {
      const errRow = { mint, referenceT, error: String(err && err.message ? err.message : err) };
      out.write(JSON.stringify(errRow) + "\n");
      console.log(`${mint}: ERROR ${errRow.error}`);
    }
  }
  out.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
