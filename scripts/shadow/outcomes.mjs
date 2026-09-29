#!/usr/bin/env node
// Independent Outcomes Calculator for Wallet Radar.
// Evaluates prospective trades at t + N days (unified N=3 for both (a) and
// (b), docs/TESTER-SPEC.md v2.1 section 8) using objective on-chain and
// market facts:
// - ISSUER_CONTROLLED: pre-registered mint in ground-truth/issuer-controlled-mints.jsonl
// - Criterion (a): buyer token account frozen on chain
// - Criterion (b): pool liquidity dropped >= 90%, excluding liquidity migrations
//   whose successor pool was created AFTER t (task 5c)
// - PAIR_MISSING: pair disappeared from DexScreener at t+N -- its own class,
//   reported with two bounds (see docs/SHADOW-RUNBOOK.md reporting section),
//   never silently folded into DANGEROUS or SAFE.
// - Any API/network error during evaluation leaves outcome NULL for retry on
//   the next pass -- it is NEVER written as DANGEROUS (task 5a; this was a
//   real bug in the previous version, which defaulted a failed liquidity
//   check to drop=1.0, i.e. maximal danger, on error).
// - Irreversible: writes outcome once, never overwrites.
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
  DEFAULT_DAILY_CEILING_OUTCOMES,
} from "./db.mjs";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");

const DEFAULT_ISSUER_FILE = path.resolve("ground-truth/issuer-controlled-mints.jsonl");
// Stage 7H task 2: own ceiling/counter key ("outcomes"), separate from collect.mjs's --
// previously shared (date)-only counter meant the 03:00 UTC outcomes run could find the
// day's ceiling already exhausted by collect.mjs's own cycles and compute zero outcomes.
const DAILY_CEILING = parseInt(process.env.DAILY_REQUEST_CEILING_OUTCOMES || String(DEFAULT_DAILY_CEILING_OUTCOMES), 10);
const REQUEST_COUNTER_SCRIPT = "outcomes";
export const OUTCOME_HORIZON_DAYS = 3; // unified N for (a) and (b), docs/TESTER-SPEC.md v2.1 section 8

// --- Stage 7J task 2: criterion (b), unified L_t/L_t3 source (GeckoTerminal) ---
// Stage 7I found L_t was never actually recorded (collect.mjs hardcoded liquidity_usd:
// null), and that checkPoolLiquidityDrop's drop formula could only ever be exactly 0 or
// exactly 1.0 as a result -- never a real intermediate drop. Task 1 (this same stage)
// fixed L_t to come from GeckoTerminal's reserve_in_usd (already fetched in
// fetchFreshPools, no extra request). L_t3 below now also comes from GeckoTerminal
// (the SAME field, same source, same methodology) -- was DexScreener's
// pairs/solana/{pair} liquidity.usd before, a genuinely different measurement.
export const MIN_INITIAL_LIQUIDITY_USD = 1000; // L_t below this (or missing) -- irrecoverable, never attempt L_t3
export const LIQUIDITY_T3_RETRY_MAX_DAYS = 3; // max days of retrying L_t3 past t+OUTCOME_HORIZON_DAYS before giving up permanently

/** Loads pre-registered issuer controlled mints into a Map. */
export function loadIssuerControlledMints(filePath = DEFAULT_ISSUER_FILE) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record.mint) map.set(record.mint, record);
    } catch {}
  }
  return map;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches JSON from URL with retry on 429 and network errors. `fetchImpl` is injectable for tests. */
export async function fetchWithRetry(url, opts = {}, db = null, retries = 3, fetchImpl = fetch) {
  if (db) {
    const status = checkDailyCeiling(db, DAILY_CEILING, REQUEST_COUNTER_SCRIPT);
    if (!status.allowed) {
      throw new Error(`Daily request ceiling (${status.ceiling}) reached for ${status.date}`);
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (db) incrementRequestCounter(db, 1, REQUEST_COUNTER_SCRIPT);
    try {
      const res = await fetchImpl(url, {
        ...opts,
        headers: { "User-Agent": "wallet-radar-shadow/2.1", ...(opts.headers || {}) },
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        if (attempt < retries) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`DexScreener 429 Too Many Requests: ${url}`);
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
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

/** Executes a Solana JSON-RPC call with 429 backoff and ceiling tracking. `fetchImpl` is injectable for tests. */
export async function rpcCall(method, params, db = null, retries = 3, fetchImpl = fetch) {
  if (db) {
    const status = checkDailyCeiling(db, DAILY_CEILING, REQUEST_COUNTER_SCRIPT);
    if (!status.allowed) {
      throw new Error(`Daily request ceiling (${status.ceiling}) reached for ${status.date}`);
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (db) incrementRequestCounter(db, 1, REQUEST_COUNTER_SCRIPT);
    try {
      const res = await fetchImpl(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        if (attempt < retries) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw new Error("Solana RPC 429 Too Many Requests");
      }

      const data = await res.json();
      if (data?.error) {
        if (data.error.code === 429 && attempt < retries) {
          await sleep(1000 * Math.pow(2, attempt));
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

/** Checks Criterion (a): Buyer token account state. `fetchImpl` injectable for tests. */
export async function checkBuyerAccountState(buyer, mint, db = null, fetchImpl = fetch) {
  if (!buyer) {
    return { state: "unresolvable", reason: "no buyer recorded at t" };
  }

  try {
    const res = await rpcCall("getTokenAccountsByOwner", [buyer, { mint }, { encoding: "jsonParsed" }], db, 3, fetchImpl);
    const accounts = res?.value;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return { state: "closed", reason: "ATA закрыт (not found on chain)" };
    }
    const info = accounts[0]?.account?.data?.parsed?.info;
    const state = info?.state;
    if (state === "frozen") return { state: "frozen", reason: "buyer token account is frozen" };
    return { state: state || "initialized", reason: "active" };
  } catch (err) {
    if (db) logError(db, "outcomes", "checkBuyerAccountState", err, { buyer, mint });
    return { state: "error", apiError: true, reason: err.message };
  }
}

/**
 * Fetches ONE pool's current reserve_in_usd from GeckoTerminal (task 2 stage 7J --
 * L_t3's source, unified with L_t's source in collect.mjs). NEVER defaults to 0 on
 * any failure; the caller decides retry-vs-give-up.
 * Returns { notFound: true } on HTTP 404 (task 2: "HTTP 404 на пул -> PAIR_MISSING").
 * Returns { reserveInUsd: number } on success.
 * Throws on any other failure: network error, non-404/non-2xx HTTP (429 included,
 * after its own retries), unparseable body, or a missing/non-numeric reserve_in_usd
 * field -- all of these mean "we don't actually know the current liquidity", which
 * the stage 7I finding showed must never be silently treated as 0.
 */
export async function fetchGeckoTerminalPoolReserve(pair, db = null, fetchImpl = fetch, retries = 3) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair}`;
  if (db) {
    const status = checkDailyCeiling(db, DAILY_CEILING, REQUEST_COUNTER_SCRIPT);
    if (!status.allowed) throw new Error(`Daily request ceiling (${status.ceiling}) reached for ${status.date}`);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (db) incrementRequestCounter(db, 1, REQUEST_COUNTER_SCRIPT);
    let res;
    try {
      res = await fetchImpl(url, { headers: { "User-Agent": "wallet-radar-shadow/2.1" }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      if (attempt < retries && /timeout|fetch failed/i.test(err.message)) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (db) logError(db, "outcomes", "fetchGeckoTerminalPoolReserve", err, { pair });
      throw err;
    }

    if (res.status === 404) return { notFound: true };
    if (res.status === 429) {
      if (attempt < retries) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      const err = new Error(`GeckoTerminal 429 Too Many Requests: ${url}`);
      if (db) logError(db, "outcomes", "fetchGeckoTerminalPoolReserve", err, { pair });
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`GeckoTerminal HTTP ${res.status}: ${url}`);
      if (db) logError(db, "outcomes", "fetchGeckoTerminalPoolReserve", err, { pair });
      throw err;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      if (db) logError(db, "outcomes", "fetchGeckoTerminalPoolReserve:parse", err, { pair });
      throw new Error(`GeckoTerminal response not JSON: ${err.message}`);
    }
    const raw = data?.data?.attributes?.reserve_in_usd;
    if (raw == null || !Number.isFinite(Number(raw))) {
      const err = new Error("GeckoTerminal response missing reserve_in_usd");
      if (db) logError(db, "outcomes", "fetchGeckoTerminalPoolReserve:missingField", err, { pair });
      throw err;
    }
    return { reserveInUsd: Number(raw) };
  }
}

/**
 * Checks Criterion (b): Pool liquidity drop and migration detection (task 2 stage 7J
 * rewrite -- see docs/PREREGISTRATION.md section 15б for the rules this implements).
 * `t` (unix seconds, the ORIGINAL purchase time) is REQUIRED to validate that any
 * successor pool was created after the trade, not before it (task 5c stage 7F) -- a
 * pool that already existed at t is not a "migration away from" this trade.
 *
 * Return shapes (mutually exclusive):
 *   { irrecoverable: "NO_LIQUIDITY_AT_T", ... }        -- L_t missing or < MIN_INITIAL_LIQUIDITY_USD
 *   { irrecoverable: "LIQUIDITY_T3_UNAVAILABLE", ... } -- L_t3 unobtainable past the retry deadline
 *   { apiError: true, ... }                            -- L_t3 unobtainable, still within the retry window -- retry later, NEVER a drop
 *   { pairMissing: true, drop: null, ... }              -- GeckoTerminal HTTP 404 on the pool
 *   { drop, migrationUndetermined: true, ... }          -- drop>=0.9 but a candidate successor pair has no liquidity field to check
 *   { drop, migration: true/false, ... }                -- normal result, drop is a real number (can be negative)
 */
export async function checkPoolLiquidityDrop(pair, mint, initialLiquidityUsd, t, db = null, fetchImpl = fetch, nowMs = Date.now()) {
  // Rule: L_t missing or below the floor -- irrecoverable, never even attempt L_t3
  // (there is nothing meaningful to compute a ratio against).
  if (initialLiquidityUsd == null || initialLiquidityUsd < MIN_INITIAL_LIQUIDITY_USD) {
    return {
      irrecoverable: "NO_LIQUIDITY_AT_T",
      initialLiquidityUsd: initialLiquidityUsd ?? null,
      drop: null,
      reason:
        initialLiquidityUsd == null
          ? "L_t missing (liquidity_usd is NULL)"
          : `L_t=${initialLiquidityUsd} below MIN_INITIAL_LIQUIDITY_USD=${MIN_INITIAL_LIQUIDITY_USD}`,
    };
  }

  let reserveRes;
  try {
    reserveRes = await fetchGeckoTerminalPoolReserve(pair, db, fetchImpl);
  } catch (err) {
    // Rule: API error/429/missing field -- retry later, UNLESS the 3-day retry window
    // past t+OUTCOME_HORIZON_DAYS has elapsed, in which case give up permanently.
    // NEVER default the missing L_t3 to 0 (the exact stage 7I bug).
    const deadlineMs = (t + (OUTCOME_HORIZON_DAYS + LIQUIDITY_T3_RETRY_MAX_DAYS) * 86400) * 1000;
    if (nowMs > deadlineMs) {
      return {
        irrecoverable: "LIQUIDITY_T3_UNAVAILABLE",
        initialLiquidityUsd,
        drop: null,
        reason: `L_t3 unavailable after ${LIQUIDITY_T3_RETRY_MAX_DAYS} days of retries past t+${OUTCOME_HORIZON_DAYS}: ${err.message}`,
      };
    }
    return { apiError: true, initialLiquidityUsd, reason: `GeckoTerminal query failed: ${err.message}` };
  }

  if (reserveRes.notFound) {
    // Rule: HTTP 404 on the pool -> PAIR_MISSING (task 2's own class, same name/semantics
    // as before, now triggered by GeckoTerminal's 404 rather than a DexScreener lookup miss).
    return {
      pairMissing: true,
      initialLiquidityUsd,
      currentLiquidityUsd: null,
      drop: null,
      migration: false,
      reason: "PAIR_MISSING: GeckoTerminal вернул HTTP 404 на пул",
    };
  }

  const currentLiquidityUsd = reserveRes.reserveInUsd;
  // Real number, can be negative (liquidity increased) -- never clamped.
  const drop = (initialLiquidityUsd - currentLiquidityUsd) / initialLiquidityUsd;

  if (drop >= 0.9) {
    // Successor/migration search still uses DexScreener /tokens/{mint} (unchanged source
    // for THIS sub-check -- only the L_t/L_t3 comparison itself moved to GeckoTerminal).
    let tokenData;
    try {
      tokenData = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, db, 3, fetchImpl);
    } catch (err) {
      if (db) logError(db, "outcomes", "checkPoolLiquidityDrop:migration", err, { mint });
      // The drop itself IS known (from GeckoTerminal, independent of this call) -- only
      // the migration-vs-not distinction is unknown, so this is undetermined, not apiError.
      return { drop, initialLiquidityUsd, currentLiquidityUsd, migration: false, migrationUndetermined: true, reason: `миграция не определена: DexScreener tokens query failed: ${err.message}` };
    }

    const allPairs = Array.isArray(tokenData?.pairs) ? tokenData.pairs : [];
    const otherPairs = allPairs.filter((p) => p.pairAddress !== pair);
    // Rule: if the liquidity field is missing on ANY of the token's other pairs, we
    // cannot reliably rule them in or out as a successor -- do not guess in either
    // direction (not DANGEROUS, not "миграция, не исход"), report undetermined instead.
    const hasUncheckableLiquidity = otherPairs.some((p) => p.liquidity == null || p.liquidity.usd == null);
    if (hasUncheckableLiquidity) {
      return { drop, initialLiquidityUsd, currentLiquidityUsd, migration: false, migrationUndetermined: true, reason: "миграция не определена: у одной или нескольких пар токена в DexScreener отсутствует поле liquidity" };
    }

    const tMs = typeof t === "number" ? t * 1000 : null;
    const successorPairs = otherPairs.filter((p) => {
      if ((p.liquidity?.usd ?? 0) < 1000) return false;
      // Task 5c: successor must have been created AFTER t. If t is unknown or the pair
      // has no pairCreatedAt, we cannot prove the ordering -- do not count it.
      if (tMs === null || typeof p.pairCreatedAt !== "number") return false;
      return p.pairCreatedAt > tMs;
    });
    const successorFound = successorPairs.length > 0;

    return {
      drop,
      initialLiquidityUsd,
      currentLiquidityUsd,
      migration: successorFound,
      successorPairs: successorPairs.map((p) => ({ pair: p.pairAddress, dexId: p.dexId, liq: p.liquidity?.usd, pairCreatedAt: p.pairCreatedAt })),
      reason: successorFound ? "миграция, не исход (successor created after t)" : "liquidity dropped >= 90%",
    };
  }

  return { drop, initialLiquidityUsd, currentLiquidityUsd, migration: false, reason: "liquidity maintained (drop < 90%)" };
}

/**
 * Pure decision logic for classifying an outcome. Returns
 * `{ outcome: null, ... }` when the result cannot yet be determined (any
 * API error) -- callers must NOT write a null outcome to the database; that
 * leaves the row pending for retry (task 5a).
 */
export function classifyOutcome({ isIssuerControlled, checkA, checkB, buyer, issuerRecord = null }) {
  // Any API/network error in EITHER check: do not classify at all, retry later.
  if (checkA?.apiError || checkB?.apiError) {
    return {
      outcome: null,
      details: { reason: "retry later: API error during outcome evaluation", checkA, checkB },
    };
  }

  if (isIssuerControlled) {
    const fired = Boolean(checkA?.state === "frozen" || (checkB?.drop != null && checkB.drop >= 0.9 && !checkB.migration && !checkB.migrationUndetermined));
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
    return { outcome: "DANGEROUS", details: { reason: "criterion (a): buyer token account frozen", trigger: "frozen_ata", checkA, checkB } };
  }

  // Stage 7J task 2: L_t missing/too-low, or L_t3 unobtainable past the retry deadline --
  // each its own irrecoverable class, checked before the generic pairMissing/drop logic
  // (both make criterion (b) itself unevaluable, for different reasons than PAIR_MISSING).
  if (checkB?.irrecoverable === "NO_LIQUIDITY_AT_T") {
    return { outcome: "невосстановимо (нет ликвидности на t)", details: { reason: checkB.reason, checkA, checkB } };
  }
  if (checkB?.irrecoverable === "LIQUIDITY_T3_UNAVAILABLE") {
    return { outcome: "невосстановимо (ликвидность недоступна)", details: { reason: checkB.reason, checkA, checkB } };
  }

  if (checkB?.pairMissing) {
    return { outcome: "PAIR_MISSING", details: { reason: "criterion (b) exclusion: GeckoTerminal returned HTTP 404 on the pool at t+N", checkA, checkB } };
  }

  // Must be checked BEFORE the generic drop>=0.9 branch below: migrationUndetermined
  // rows also carry a real (>=0.9) drop value, but whether a successor exists is
  // unknown, so neither DANGEROUS nor "миграция, не исход" would be honest here.
  if (checkB?.migrationUndetermined) {
    return { outcome: "миграция не определена", details: { reason: checkB.reason, checkA, checkB } };
  }

  if (checkB?.drop != null && checkB.drop >= 0.9) {
    if (checkB.migration) {
      return { outcome: "миграция, не исход", details: { reason: "criterion (b) exclusion: liquidity migrated to a successor pool created after t", checkA, checkB } };
    }
    return { outcome: "DANGEROUS", details: { reason: "criterion (b): pool liquidity dropped >= 90% without a valid successor pool", trigger: "liquidity_collapse", checkA, checkB } };
  }

  if (checkA?.state === "closed") {
    return { outcome: "невосстановимо (ATA закрыт)", details: { reason: "buyer token account closed before outcome evaluation", checkA, checkB } };
  }

  if (!buyer) {
    return { outcome: "невосстановимо (NO_BUYER)", details: { reason: "buyer was not identifiable at initial trade observation", checkA, checkB } };
  }

  return { outcome: "SAFE", details: { reason: "safe: active token account and liquidity maintained", checkA, checkB } };
}

/** Runs a single outcomes evaluation pass over pending trades. */
export async function runOutcomesWorker(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const minAgeDays = opts.minAgeDays != null ? opts.minAgeDays : OUTCOME_HORIZON_DAYS;
  const dryRun = Boolean(opts.dryRun);
  const limit = opts.limit || null;

  const db = openDb(dbPath);
  const issuerMap = loadIssuerControlledMints(opts.issuerFilePath || DEFAULT_ISSUER_FILE);

  console.log(`[OUTCOMES] Starting worker. DB: ${dbPath}, Min Age Days: ${minAgeDays}`);
  console.log(`[OUTCOMES] Loaded ${issuerMap.size} pre-registered issuer-controlled mints.`);

  const pending = getPendingTrades(db, minAgeDays);
  console.log(`[OUTCOMES] Found ${pending.length} pending trades eligible for outcome computation.`);

  const batch = limit ? pending.slice(0, limit) : pending;
  let evaluatedCount = 0;
  let deferredCount = 0;

  for (const trade of batch) {
    try {
      const isIssuer = issuerMap.has(trade.mint);
      const issuerRecord = isIssuer ? issuerMap.get(trade.mint) : null;

      const checkA = await checkBuyerAccountState(trade.buyer, trade.mint, db);
      const checkB = await checkPoolLiquidityDrop(trade.pair, trade.mint, trade.liquidity_usd, trade.t, db);

      const result = classifyOutcome({ isIssuerControlled: isIssuer, checkA, checkB, buyer: trade.buyer, issuerRecord });

      if (result.outcome === null) {
        deferredCount++;
        console.log(`[DEFERRED] ID ${trade.id} | Mint: ${trade.mint.slice(0, 8)}... -> API error, left NULL for retry`);
        continue;
      }

      if (!dryRun) {
        updateTradeOutcome(db, trade.id, result.outcome, result.details);
      }

      evaluatedCount++;
      console.log(`[OUTCOME] ID ${trade.id} | Mint: ${trade.mint.slice(0, 8)}... | Buyer: ${trade.buyer ? trade.buyer.slice(0, 8) + "..." : "NONE"} -> ${result.outcome}`);
    } catch (err) {
      logError(db, "outcomes", `evaluateTrade:${trade.id}`, err);
      console.error(`[ERROR] Evaluating trade ${trade.id}:`, err.message);
    }

    await sleep(200);
  }

  console.log(`[OUTCOMES] Pass completed. Evaluated: ${evaluatedCount}. Deferred (API error, retry later): ${deferredCount}.`);
  return { evaluated: evaluatedCount, deferred: deferredCount };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let minAgeDays = OUTCOME_HORIZON_DAYS;
  let limit = null;
  let dryRun = false;
  let customDb = null;
  let forceAll = false;

  for (const a of args) {
    if (a.startsWith("--min-age-days=")) minAgeDays = parseFloat(a.split("=")[1]);
    else if (a === "--force-all") forceAll = true;
    else if (a.startsWith("--limit=")) limit = parseInt(a.split("=")[1], 10);
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--db=")) customDb = a.split("=")[1];
  }

  // Task 5e: --force-all (minAgeDays=0, evaluates trades regardless of age)
  // is only permitted against an explicit, separate dry database -- never
  // against the default production DB, where it could prematurely score
  // trades before their real N-day horizon.
  if (forceAll) {
    if (!customDb || path.resolve(customDb) === path.resolve(DEFAULT_DB_PATH)) {
      console.error(
        "[REFUSED] --force-all requires an explicit --db=<path> pointing at a SEPARATE dry-run database, not the default DB. Refusing to run."
      );
      process.exit(1);
    }
    minAgeDays = 0;
  }

  runOutcomesWorker({ dbPath: customDb, minAgeDays, limit, dryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
