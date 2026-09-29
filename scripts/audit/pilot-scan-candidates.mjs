#!/usr/bin/env node
// Stage 6B.1 (ground-truth audit, see docs/TESTER-SPEC.md).
//
// Scans the ALREADY-CACHED benchmarks/history-cache/*.json (1001 wallets,
// real Helius-fetched transaction histories from earlier stages of this
// session) for candidate purchases matching the pilot sampling frame
// (docs/TESTER-SPEC.md section 1): a wallet acquiring a non-major-mint
// token via a Jupiter/Raydium/PumpSwap-tagged transaction.
//
// This step does NOT yet check mint age or hit any network -- it is a
// pure offline filter over local files, producing a candidate list for
// pilot-collect-purchases.mjs to then verify (mint creation date, buyer
// prior-tx count, SetAuthority history) against live RPC. Splitting the
// steps keeps RPC volume bounded to only the candidates that already pass
// the cheap, offline checks.
//
// "Buyer had >= 20 prior transactions" is approximated here as: count of
// transactions in that wallet's OWN cached file with an earlier timestamp
// than the candidate buy (a lower bound -- the cache is a last-50-tx
// snapshot, not the full lifetime history, so the true count can only be
// equal or higher). Documented explicitly as a pilot-scale simplification
// in the stage-6 report, not silently treated as exact.
//
// No src/ changes, no radar.env read, no network calls in this script.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSwap } from "../../dist/src/analyzer.js";
import { MAJOR_MINTS } from "../../dist/src/types.js";
import { KNOWN_SAFE_MINTS } from "../../dist/src/mint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const historyCacheDir = path.join(ROOT, "benchmarks/history-cache");

const VENUE_SOURCES = new Set(["JUPITER", "PUMP_AMM", "PUMP_FUN", "RAYDIUM", "RAYDIUM_AMM", "RAYDIUM_CLMM", "RAYDIUM_CPMM"]);
const MIN_PRIOR_TX = 20;

function isMajor(mint) {
  return MAJOR_MINTS.includes(mint) || KNOWN_SAFE_MINTS.has(mint);
}

const files = fs.readdirSync(historyCacheDir).filter((f) => f.endsWith(".json"));
console.error(`Scanning ${files.length} cached wallet files...`);

const candidates = [];
const sourceTally = {};

for (const file of files) {
  const wallet = file.replace(/\.json$/, "");
  let txs;
  try {
    txs = JSON.parse(fs.readFileSync(path.join(historyCacheDir, file), "utf-8"));
  } catch {
    continue;
  }
  if (!Array.isArray(txs) || txs.length === 0) continue;
  const sorted = [...txs].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  for (let i = 0; i < sorted.length; i++) {
    const tx = sorted[i];
    const src = tx.source || "UNKNOWN";
    sourceTally[src] = (sourceTally[src] || 0) + 1;
    if (!VENUE_SOURCES.has(src)) continue;

    const swap = extractSwap(tx, wallet);
    if (!swap) continue;
    const acquiredMint = swap.tokenOut?.mint;
    if (!acquiredMint || isMajor(acquiredMint)) continue; // must be acquiring a non-major token (a "buy")

    const priorTxCount = i; // txs strictly before this one in the cached (ascending) list
    if (priorTxCount < MIN_PRIOR_TX) continue;

    candidates.push({
      wallet,
      mint: acquiredMint,
      t: tx.timestamp,
      signature: tx.signature,
      source: src,
      priorTxCountLowerBound: priorTxCount,
      cacheFileTxCount: sorted.length,
    });
  }
}

console.error(`\nSource tally across all scanned tx:`, JSON.stringify(sourceTally, null, 2));
console.error(`\nCandidate buys (venue matched, non-major mint, priorTxCountLowerBound >= ${MIN_PRIOR_TX}): ${candidates.length}`);
console.error(`Distinct wallets contributing: ${new Set(candidates.map((c) => c.wallet)).size}`);
console.error(`Distinct mints among candidates: ${new Set(candidates.map((c) => c.mint)).size}`);

console.log(JSON.stringify(candidates));
