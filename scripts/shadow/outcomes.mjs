#!/usr/bin/env node
// Independent Outcomes Calculator for Wallet Radar.
// Evaluates prospective trades at t + N days (default >= 3 days) using objective on-chain
// and market facts:
// - ISSUER_CONTROLLED: pre-registered mint in ground-truth/issuer-controlled-mints.jsonl
// - Criterion (a): buyer token account frozen on chain
// - Criterion (b): pool liquidity dropped >= 90%, excluding liquidity migrations
// - Irreversible: writes outcome once, never overwrites
// - INTEGRITY: NEVER calls the radar and NEVER reads radar verdicts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  getPendingTrades,
  updateTradeOutcome,
  checkDailyCeiling,
  incrementRequestCounter,
  logError,
  DEFAULT_DB_PATH,
  DEFAULT_DAILY_CEILING,
} from "./db.mjs";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");

const DEFAULT_ISSUER_FILE = path.resolve("ground-truth/issuer-controlled-mints.jsonl");
const DAILY_CEILING = parseInt(process.env.DAILY_REQUEST_CEILING || String(DEFAULT_DAILY_CEILING), 10);

/**
 * Loads pre-registered issuer controlled mints into a Map.
 */
export function loadIssuerControlledMints(filePath = DEFAULT_ISSUER_FILE) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;

  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record.mint) {
        map.set(record.mint, record);
      }
    } catch {}
  }
  return map;
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

      if (res.status === 404) {
        return null;
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
      if (db) logError(db, "outcomes", "fetchWithRetry", err, { url });
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
      if (db) logError(db, "outcomes", `rpcCall:${method}`, err);
      throw err;
    }
  }
}

/**
 * Checks Criterion (a): Buyer token account state.
 */
export async function checkBuyerAccountState(buyer, mint, db = null) {
  if (!buyer || buyer === "NO_BUYER") {
    return { state: "unresolvable", reason: "NO_BUYER recorded at t" };
  }

  try {
    const res = await rpcCall(
      "getTokenAccountsByOwner",
      [buyer, { mint }, { encoding: "jsonParsed" }],
      db
    );

    const accounts = res?.value;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return { state: "closed", reason: "ATA закрыт (not found on chain)" };
    }

    const info = accounts[0]?.account?.data?.parsed?.info;
    const state = info?.state;

    if (state === "frozen") {
      return { state: "frozen", reason: "buyer token account is frozen" };
    }

    return { state: state || "initialized", reason: "active" };
  } catch (err) {
    if (db) logError(db, "outcomes", "checkBuyerAccountState", err, { buyer, mint });
    return { state: "error", reason: err.message };
  }
}

/**
 * Checks Criterion (b): Pool liquidity drop and migration detection.
 */
export async function checkPoolLiquidityDrop(pair, mint, initialLiquidityUsd, db = null) {
  try {
    const pairData = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`, {}, db);
    let currentLiquidityUsd = null;

    if (pairData && pairData.pair && pairData.pair.liquidity) {
      currentLiquidityUsd = Number(pairData.pair.liquidity.usd ?? 0);
    } else if (pairData === null || !pairData?.pair) {
      // Pair missing from DexScreener: check tokens/{mint} per TESTER-SPEC.md v2.1
      let tokensHavePairs = false;
      try {
        const tokenCheck = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, db);
        tokensHavePairs = Array.isArray(tokenCheck?.pairs) && tokenCheck.pairs.length > 0;
      } catch {}

      if (!tokensHavePairs) {
        return {
          drop: null,
          initialLiquidityUsd,
          currentLiquidityUsd: 0,
          pairMissing: true,
          migration: false,
          reason: "невосстановимо (пара пропала из DexScreener)",
        };
      }
      currentLiquidityUsd = 0;
    }

    if (currentLiquidityUsd === null) {
      currentLiquidityUsd = 0;
    }

    const initLiq = initialLiquidityUsd ?? 0;
    let drop = 0;
    if (initLiq > 0) {
      drop = (initLiq - currentLiquidityUsd) / initLiq;
    } else {
      drop = currentLiquidityUsd <= 0 ? 1.0 : 0;
    }

    if (drop >= 0.90) {
      // Check for liquidity migration to a successor pool
      let successorFound = false;
      let successorPairs = [];

      try {
        const tokenData = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, db);
        if (Array.isArray(tokenData?.pairs)) {
          successorPairs = tokenData.pairs.filter(
            (p) => p.pairAddress !== pair && (p.liquidity?.usd ?? 0) >= 1000
          );
          if (successorPairs.length > 0) {
            successorFound = true;
          }
        }
      } catch (tokenErr) {
        if (db) logError(db, "outcomes", "checkPoolLiquidityDrop:migration", tokenErr, { mint });
      }

      return {
        drop,
        initialLiquidityUsd: initLiq,
        currentLiquidityUsd,
        migration: successorFound,
        successorPairs: successorPairs.map((p) => ({ pair: p.pairAddress, dexId: p.dexId, liq: p.liquidity?.usd })),
        reason: successorFound ? "миграция, не исход" : "liquidity dropped >= 90%",
      };
    }

    return {
      drop,
      initialLiquidityUsd: initLiq,
      currentLiquidityUsd,
      migration: false,
      reason: "liquidity maintained (drop < 90%)",
    };
  } catch (err) {
    if (db) logError(db, "outcomes", "checkPoolLiquidityDrop", err, { pair, mint });
    return {
      drop: 1.0,
      initialLiquidityUsd,
      currentLiquidityUsd: 0,
      migration: false,
      reason: `DexScreener query failed: ${err.message}`,
    };
  }
}

/**
 * Pure decision logic for classifying an outcome.
 */
export function classifyOutcome({ isIssuerControlled, checkA, checkB, buyer, issuerRecord = null }) {
  if (isIssuerControlled) {
    const fired = Boolean(checkA?.state === "frozen" || (checkB?.drop != null && checkB.drop >= 0.9));
    return {
      outcome: "ISSUER_CONTROLLED",
      details: {
        reason: "pre-registered issuer-controlled mint",
        issuer: issuerRecord?.issuer || "unknown",
        sourceUrl: issuerRecord?.sourceUrl || null,
        issuerControlledOutcomeFired: fired,
        checkA,
        checkB,
      },
    };
  }

  if (checkA?.state === "frozen") {
    return {
      outcome: "DANGEROUS",
      details: {
        reason: "criterion (a): buyer token account frozen",
        trigger: "frozen_ata",
        checkA,
        checkB,
      },
    };
  }

  if (checkB?.pairMissing) {
    return {
      outcome: "невосстановимо (пара пропала из DexScreener)",
      details: {
        reason: "criterion (b) exclusion: pair disappeared from DexScreener at t+N",
        checkA,
        checkB,
      },
    };
  }

  if (checkB?.drop != null && checkB.drop >= 0.90) {
    if (checkB.migration) {
      return {
        outcome: "миграция, не исход",
        details: {
          reason: "criterion (b) exclusion: liquidity migrated to successor pool",
          checkA,
          checkB,
        },
      };
    }
    return {
      outcome: "DANGEROUS",
      details: {
        reason: "criterion (b): pool liquidity dropped >= 90% without successor pool",
        trigger: "liquidity_collapse",
        checkA,
        checkB,
      },
    };
  }

  if (checkA?.state === "closed") {
    return {
      outcome: "невосстановимо (ATA закрыт)",
      details: {
        reason: "buyer token account closed before outcome evaluation",
        checkA,
        checkB,
      },
    };
  }

  if (buyer === "NO_BUYER") {
    return {
      outcome: "невосстановимо (NO_BUYER)",
      details: {
        reason: "buyer was not identifiable at initial trade observation",
        checkA,
        checkB,
      },
    };
  }

  return {
    outcome: "SAFE",
    details: {
      reason: "safe: active token account and liquidity maintained",
      checkA,
      checkB,
    },
  };
}

/**
 * Runs a single outcomes evaluation pass over pending trades.
 */
export async function runOutcomesWorker(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const minAgeDays = opts.minAgeDays != null ? opts.minAgeDays : 3;
  const dryRun = Boolean(opts.dryRun);
  const limit = opts.limit || null;

  const db = openDb(dbPath);
  const issuerMap = loadIssuerControlledMints(opts.issuerFilePath || DEFAULT_ISSUER_FILE);

  console.log(`[OUTCOMES] Starting worker. DB: ${dbPath}, Min Age Days: ${minAgeDays}`);
  console.log(`[OUTCOMES] Loaded ${issuerMap.size} pre-registered issuer-controlled mints.`);

  // Integrity assertion: check pending trades WITHOUT reading radar verdicts
  const pending = getPendingTrades(db, minAgeDays);
  console.log(`[OUTCOMES] Found ${pending.length} pending trades eligible for outcome computation.`);

  const batch = limit ? pending.slice(0, limit) : pending;
  let evaluatedCount = 0;

  for (const trade of batch) {
    try {
      const isIssuer = issuerMap.has(trade.mint);
      const issuerRecord = isIssuer ? issuerMap.get(trade.mint) : null;

      // 1. Check (a) buyer token account
      const checkA = await checkBuyerAccountState(trade.buyer, trade.mint, db);

      // 2. Check (b) pool liquidity
      const checkB = await checkPoolLiquidityDrop(trade.pair, trade.mint, trade.liquidity_usd, db);

      // 3. Classify
      const result = classifyOutcome({
        isIssuerControlled: isIssuer,
        checkA,
        checkB,
        buyer: trade.buyer,
        issuerRecord,
      });

      // 4. Irreversible write
      if (!dryRun) {
        updateTradeOutcome(db, trade.id, result.outcome, result.details);
      }

      evaluatedCount++;
      console.log(
        `[OUTCOME] ID ${trade.id} | Mint: ${trade.mint.slice(0, 8)}... | Buyer: ${trade.buyer === "NO_BUYER" ? "NO_BUYER" : trade.buyer.slice(0, 8) + "..."} -> ${result.outcome}`
      );
    } catch (err) {
      logError(db, "outcomes", `evaluateTrade:${trade.id}`, err);
      console.error(`[ERROR] Evaluating trade ${trade.id}:`, err.message);
    }

    await sleep(200);
  }

  console.log(`[OUTCOMES] Pass completed. Evaluated: ${evaluatedCount} trades.`);
  return { evaluated: evaluatedCount };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let minAgeDays = 3;
  let limit = null;
  let dryRun = false;
  let customDb = null;

  for (const a of args) {
    if (a.startsWith("--min-age-days=")) minAgeDays = parseFloat(a.split("=")[1]);
    else if (a === "--force-all") minAgeDays = 0;
    else if (a.startsWith("--limit=")) limit = parseInt(a.split("=")[1], 10);
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--db=")) customDb = a.split("=")[1];
  }

  runOutcomesWorker({ dbPath: customDb, minAgeDays, limit, dryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
