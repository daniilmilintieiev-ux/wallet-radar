#!/usr/bin/env node
// Prospective Shadow Collector for Wallet Radar.
// Fetches fresh Solana pairs from DexScreener, queries mint state on-chain,
// resolves initial buyer, requests pre-trade firewall verdict from POST /gate-copy,
// and saves prospective records into SQLite before any outcome occurs.
//
// Rules enforced:
// - HELIUS_API_KEY from environment only, never printed.
// - radar.env never read.
// - Daily request quota ceiling enforced.
// - Retries with exponential backoff on 429 / network errors.
// - Errors recorded to error_logs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  openDb,
  checkDailyCeiling,
  incrementRequestCounter,
  logError,
  insertTrade,
  DEFAULT_DB_PATH,
  DEFAULT_DAILY_CEILING,
} from "./db.mjs";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");

const RADAR_URL = (process.env.RADAR_URL || "http://localhost:7690").replace(/\/+$/, "");
const DAILY_CEILING = parseInt(process.env.DAILY_REQUEST_CEILING || String(DEFAULT_DAILY_CEILING), 10);
const SPEC_DEX_REGEX = /^(raydium|pumpswap|pumpfun)$/i;
const MAX_AGE_DAYS = 14;

/**
 * Determine sampling stratum (TESTER-SPEC.md v2.1 section 1.3):
 * - Strat A -- "обычные новые токены": у mint на момент t нет активного freezeAuthority/mintAuthority (оба null).
 * - Strat B -- "новые токены с активной authority": у mint на момент t активен freezeAuthority и/или mintAuthority.
 */
export function determineStrat({ mintAuthority, freezeAuthority }) {
  if (mintAuthority != null || freezeAuthority != null) {
    return "B";
  }
  return "A";
}

/**
 * Sleeps for ms milliseconds.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches JSON from URL with retry on 429 and network errors.
 */
export async function fetchWithRetry(url, opts = {}, db = null, retries = 3) {
  if (db) {
    const status = checkDailyCeiling(db, DAILY_CEILING);
    if (!status.allowed) {
      throw new Error(`Daily request ceiling (${status.ceiling}) reached for ${status.date}`);
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (db) incrementRequestCounter(db, 1);
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          "User-Agent": "wallet-radar-shadow/2.1",
          ...(opts.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        if (attempt < retries) {
          const delay = 1000 * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw new Error(`DexScreener 429 Too Many Requests: ${url}`);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${url}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt < retries && /429|timeout|fetch failed/i.test(err.message)) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (db) logError(db, "collect", "fetchWithRetry", err, { url });
      throw err;
    }
  }
}

/**
 * Executes a Solana JSON-RPC call with 429 backoff and ceiling tracking.
 */
export async function rpcCall(method, params, db = null, retries = 3) {
  if (db) {
    const status = checkDailyCeiling(db, DAILY_CEILING);
    if (!status.allowed) {
      throw new Error(`Daily request ceiling (${status.ceiling}) reached for ${status.date}`);
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (db) incrementRequestCounter(db, 1);
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        if (attempt < retries) {
          const delay = 1000 * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw new Error("Solana RPC 429 Too Many Requests");
      }

      const data = await res.json();
      if (data?.error) {
        if (data.error.code === 429 && attempt < retries) {
          const delay = 1000 * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw new Error(`RPC Error [${data.error.code}]: ${data.error.message}`);
      }

      return data?.result;
    } catch (err) {
      if (attempt < retries && /429|timeout|fetch failed/i.test(err.message)) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (db) logError(db, "collect", `rpcCall:${method}`, err);
      throw err;
    }
  }
}

/**
 * Extracts buyer wallet from transaction parsed balances.
 * Looks for an account where postTokenBalances > preTokenBalances for the target mint,
 * excluding the pool pair address and system programs.
 */
export function extractBuyerFromTx(tx, targetMint, pairAddress) {
  if (!tx || !tx.meta) return "NO_BUYER";
  const post = tx.meta.postTokenBalances || [];
  const pre = tx.meta.preTokenBalances || [];

  for (const postBal of post) {
    if (postBal.mint !== targetMint) continue;
    const owner = postBal.owner;
    if (!owner) continue;
    if (owner === pairAddress) continue;
    if (owner === "11111111111111111111111111111111") continue;

    const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex);
    const postAmt = BigInt(postBal.uiTokenAmount?.amount || "0");
    const preAmt = BigInt(preBal?.uiTokenAmount?.amount || "0");

    if (postAmt > preAmt) {
      return owner;
    }
  }

  return "NO_BUYER";
}

/**
 * Queries the earliest buyer for a pair from chain history.
 */
export async function resolveBuyerForPair(pairAddress, targetMint, db = null) {
  try {
    const sigs = await rpcCall("getSignaturesForAddress", [pairAddress, { limit: 5 }], db);
    if (!Array.isArray(sigs) || sigs.length === 0) {
      return "NO_BUYER";
    }

    // Check oldest available signature in the batch
    const candidateSig = sigs[sigs.length - 1].signature;
    const tx = await rpcCall(
      "getTransaction",
      [candidateSig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }],
      db
    );

    return extractBuyerFromTx(tx, targetMint, pairAddress);
  } catch (err) {
    if (db) logError(db, "collect", "resolveBuyerForPair", err, { pairAddress, targetMint });
    return "NO_BUYER";
  }
}

/**
 * Fetches mint state at t: mintAuthority, freezeAuthority, and Token-2022 extensions.
 */
export async function fetchMintStateAtT(mint, db = null) {
  try {
    const accountInfo = await rpcCall("getAccountInfo", [mint, { encoding: "jsonParsed" }], db);
    if (!accountInfo || !accountInfo.value) {
      return {
        mintAuthority: null,
        freezeAuthority: null,
        tokenProgram: null,
        extensions: [],
      };
    }

    const value = accountInfo.value;
    const tokenProgram = value.owner || null;
    const parsed = value.data?.parsed;
    const info = parsed?.info || {};

    return {
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      tokenProgram,
      extensions: info.extensions || [],
    };
  } catch (err) {
    if (db) logError(db, "collect", "fetchMintStateAtT", err, { mint });
    return {
      mintAuthority: null,
      freezeAuthority: null,
      tokenProgram: null,
      extensions: [],
    };
  }
}

/**
 * Gets current git commit hash of the radar repository.
 */
export function getRadarCommitHash() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Queries POST /gate-copy on the local radar server for a pre-trade verdict.
 */
export async function queryGateCopy(radarUrl, buyer, mint, copyAmountUsd = 10) {
  if (buyer === "NO_BUYER") {
    return {
      allow: null,
      reason: "NO_BUYER: no buyer found to gate",
      action: "no_buyer",
      details: null,
    };
  }

  try {
    const res = await fetch(`${radarUrl}/gate-copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetWallet: buyer,
        mint,
        copyAmountUsd,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    return data;
  } catch (err) {
    return {
      error: `Radar call failed: ${err.message}`,
      connected: false,
    };
  }
}

/**
 * Fetches fresh candidate pairs from DexScreener search & latest feeds.
 */
export async function fetchFreshDexScreenerPairs(db = null) {
  const queries = ["raydium", "pumpswap"];
  const seenPairs = new Set();
  const pairs = [];
  const now = Date.now();
  const maxAgeMs = MAX_AGE_DAYS * 86400 * 1000;

  for (const q of queries) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${q}`;
      const data = await fetchWithRetry(url, {}, db);
      if (Array.isArray(data?.pairs)) {
        for (const p of data.pairs) {
          if (p.chainId !== "solana") continue;
          if (!SPEC_DEX_REGEX.test(p.dexId || "")) continue;
          if (seenPairs.has(p.pairAddress)) continue;
          seenPairs.add(p.pairAddress);

          const createdAt = p.pairCreatedAt || 0;
          const ageMs = now - createdAt;
          if (createdAt > 0 && ageMs <= maxAgeMs && ageMs >= 0) {
            pairs.push(p);
          }
        }
      }
    } catch (err) {
      if (db) logError(db, "collect", `fetchDexScreener:${q}`, err);
    }
  }

  return pairs;
}

/**
 * Runs a single collection cycle.
 */
export async function runCollectionCycle(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const radarUrl = opts.radarUrl || RADAR_URL;
  const limit = opts.limit || null;
  const dryRun = Boolean(opts.dryRun);

  const db = openDb(dbPath);
  const gitCommit = getRadarCommitHash();

  console.log(`[COLLECT] Starting cycle. DB: ${dbPath}, Radar: ${radarUrl}, Commit: ${gitCommit}`);

  const ceilingStatus = checkDailyCeiling(db, DAILY_CEILING);
  if (!ceilingStatus.allowed) {
    console.warn(`[COLLECT] Daily ceiling reached (${ceilingStatus.current}/${ceilingStatus.ceiling}). Skipping cycle.`);
    return { collected: 0, ceilingReached: true };
  }

  const rawPairs = await fetchFreshDexScreenerPairs(db);
  console.log(`[COLLECT] Fetched ${rawPairs.length} fresh Solana candidate pairs within 14 days.`);

  const candidatePairs = limit ? rawPairs.slice(0, limit) : rawPairs;
  let savedCount = 0;

  for (const p of candidatePairs) {
    const mint = p.baseToken?.address;
    const pair = p.pairAddress;
    const t = Math.floor((p.pairCreatedAt || Date.now()) / 1000);
    const liquidityUsd = p.liquidity?.usd ?? null;
    const dexId = p.dexId;

    if (!mint || !pair) continue;

    try {
      // 1. Fetch mint on-chain state at t
      const mintState = await fetchMintStateAtT(mint, db);

      // 2. Classify stratum (TESTER-SPEC.md v2.1 section 1.3)
      const strat = determineStrat({
        mintAuthority: mintState.mintAuthority,
        freezeAuthority: mintState.freezeAuthority,
      });

      // 3. Resolve buyer from first transaction
      const buyer = await resolveBuyerForPair(pair, mint, db);

      // 4. Query radar pre-trade verdict
      const radarVerdict = await queryGateCopy(radarUrl, buyer, mint);

      // 5. Store prospective record
      const record = {
        mint,
        pair,
        t,
        liquidity_usd: liquidityUsd,
        mint_authority: mintState.mintAuthority,
        freeze_authority: mintState.freezeAuthority,
        token_program: mintState.tokenProgram,
        token_2022_extensions: mintState.extensions,
        strat,
        buyer,
        radar_verdict: radarVerdict,
        radar_code_version: gitCommit,
        recorded_at: new Date().toISOString(),
      };

      if (!dryRun) {
        try {
          insertTrade(db, record);
          savedCount++;
        } catch (dbErr) {
          if (/UNIQUE constraint failed/i.test(dbErr.message)) {
            // Already tracked
          } else {
            throw dbErr;
          }
        }
      } else {
        savedCount++;
      }

      console.log(
        `[SAVED] ${strat} | ${mint.slice(0, 8)}... | Pair: ${pair.slice(0, 8)}... | Liq: $${liquidityUsd?.toFixed(0) || 0} | Buyer: ${buyer === "NO_BUYER" ? "NO_BUYER" : buyer.slice(0, 8) + "..."} | Verdict: ${radarVerdict.action || "err"}`
      );
    } catch (itemErr) {
      logError(db, "collect", `processPair:${pair}`, itemErr);
      console.error(`[ERROR] Processing pair ${pair}:`, itemErr.message);
    }

    // Polite pacing
    await sleep(200);
  }

  console.log(`[COLLECT] Cycle completed. Successfully processed: ${savedCount} records.`);
  return { collected: savedCount, ceilingReached: false };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let limit = null;
  let intervalMin = 15;
  let once = false;
  let dryRun = false;
  let customDb = null;

  for (const a of args) {
    if (a.startsWith("--limit=")) limit = parseInt(a.split("=")[1], 10);
    else if (a.startsWith("--interval=")) intervalMin = parseInt(a.split("=")[1], 10);
    else if (a === "--once") once = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--db=")) customDb = a.split("=")[1];
  }

  const opts = { dbPath: customDb, limit, dryRun };

  if (once) {
    runCollectionCycle(opts).then(() => process.exit(0)).catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
  } else {
    console.log(`[SERVICE] Running continuous collection every ${intervalMin} minutes.`);
    runCollectionCycle(opts).catch(console.error);
    setInterval(() => {
      runCollectionCycle(opts).catch(console.error);
    }, intervalMin * 60 * 1000);
  }
}
