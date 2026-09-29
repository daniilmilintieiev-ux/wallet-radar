#!/usr/bin/env node
// Prospective Shadow Collector for Wallet Radar.
//
// Stage 7B fix (see docs/SHADOW-COLLECTOR.md "Источник новых пулов" for the
// real-request comparison that led to this choice): pool discovery now uses
// GeckoTerminal's `new_pools` endpoint (real pool_created_at timestamps,
// ~1 minute observed latency, 30 req/min documented limit), NOT DexScreener
// search -- DexScreener has no "newest pools" listing, only keyword search,
// which is not a genuine discovery source. `t` is now the blockTime of the
// ACTUAL PURCHASE transaction (not pairCreatedAt, which is the pool's
// creation time, not any specific trade's time).
//
// Rules enforced:
// - HELIUS_API_KEY from environment only, never printed, radar.env never read.
// - Daily request quota ceiling enforced.
// - Retries with exponential backoff on 429 / network errors.
// - Errors recorded to error_logs.
// - 5 consecutive RADAR_ERROR responses (non-200 from /gate-copy) abort the
//   whole run with a non-zero exit code -- a persistently broken radar
//   should not silently produce a database full of RADAR_ERROR rows.

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
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// --- Config constants (task 1/2/4) ---
export const POOL_MAX_AGE_MINUTES = 15; // pool must be this fresh AT COLLECTION TIME (not at any later check)
export const TOKEN_MAX_AGE_DAYS = 14; // min pairCreatedAt across ALL of the mint's DexScreener pairs must be within this
export const COPY_AMOUNT_USD = 10; // fixed, recorded verbatim per trade (task 4)
export const MAX_CONSECUTIVE_RADAR_ERRORS = 5;
const DEX_ID_REGEX = /^(raydium|pump-?fun|pumpswap)/i;
const BUYER_CANDIDATE_SCAN_LIMIT = 20; // how many post-creation signatures to try before giving up

/**
 * Determine sampling stratum (docs/TESTER-SPEC.md v2.1 section 1).
 */
export function determineStrat({ mintAuthority, freezeAuthority }) {
  if (mintAuthority != null || freezeAuthority != null) {
    return "B";
  }
  return "A";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches JSON from URL with retry on 429 and network errors. */
export async function fetchWithRetry(url, opts = {}, db = null, retries = 3, fetchImpl = fetch) {
  if (db) {
    const status = checkDailyCeiling(db, DAILY_CEILING);
    if (!status.allowed) {
      throw new Error(`Daily request ceiling (${status.ceiling}) reached for ${status.date}`);
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (db) incrementRequestCounter(db, 1);
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
        throw new Error(`HTTP 429 Too Many Requests: ${url}`);
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

/** Executes a Solana JSON-RPC call with 429 backoff and ceiling tracking. */
export async function rpcCall(method, params, db = null, retries = 3, fetchImpl = fetch) {
  if (db) {
    const status = checkDailyCeiling(db, DAILY_CEILING);
    if (!status.allowed) {
      throw new Error(`Daily request ceiling (${status.ceiling}) reached for ${status.date}`);
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (db) incrementRequestCounter(db, 1);
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
      if (db) logError(db, "collect", `rpcCall:${method}`, err);
      throw err;
    }
  }
}

/**
 * Classifies an account returned by getAccountInfo(jsonParsed) as a "regular
 * buyer wallet" candidate: must exist, be owned by the System Program, and
 * not be executable (task 3: "System-owned не executable, не PDA").
 * A null value (account never funded) is explicitly REJECTED as unresolvable
 * -- a wallet that paid transaction fees for its own purchase must hold
 * lamports, so a null account cannot be that transaction's real payer/buyer.
 */
export function classifyAccountForBuyer(accountInfoValue) {
  if (accountInfoValue === null || accountInfoValue === undefined) {
    return { isRegularWallet: false, reason: "account never funded (value=null) -- cannot be the fee-paying buyer" };
  }
  const owner = accountInfoValue.owner;
  const executable = Boolean(accountInfoValue.executable);
  if (owner === SYSTEM_PROGRAM && !executable) {
    return { isRegularWallet: true, reason: "System-owned, non-executable" };
  }
  return { isRegularWallet: false, reason: `owner=${owner} executable=${executable} -- PDA or program account, not a plain wallet` };
}

/**
 * Extracts a candidate buyer address from a transaction: the account whose
 * token balance for targetMint increased, excluding the pool/pair address
 * and the System Program placeholder.
 */
export function extractBuyerFromTx(tx, targetMint, pairAddress) {
  if (!tx || !tx.meta) return null;
  const post = tx.meta.postTokenBalances || [];
  const pre = tx.meta.preTokenBalances || [];

  for (const postBal of post) {
    if (postBal.mint !== targetMint) continue;
    const owner = postBal.owner;
    if (!owner) continue;
    if (owner === pairAddress) continue;
    if (owner === SYSTEM_PROGRAM) continue;

    const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex);
    const postAmt = BigInt(postBal.uiTokenAmount?.amount || "0");
    const preAmt = BigInt(preBal?.uiTokenAmount?.amount || "0");

    if (postAmt > preAmt) {
      return owner;
    }
  }
  return null;
}

function txFeePayer(tx) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const first = keys[0];
  return typeof first === "string" ? first : first?.pubkey ?? null;
}

/**
 * Resolves the pool-creation transaction for a pair: the OLDEST signature
 * returned for the pair address (a pool this fresh cannot plausibly exceed
 * the 1000-signature page in the time it has existed).
 */
export async function resolvePoolCreationTx(pairAddress, db = null) {
  const sigs = await rpcCall("getSignaturesForAddress", [pairAddress, { limit: 1000 }], db);
  if (!Array.isArray(sigs) || sigs.length === 0) return null;
  const oldest = sigs[sigs.length - 1];
  const tx = await rpcCall("getTransaction", [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }], db);
  return { signature: oldest.signature, blockTime: oldest.blockTime, tx, allSignaturesNewestFirst: sigs };
}

/**
 * Resolves the first REAL buyer after pool creation (task 3):
 * - the transaction must come strictly after the pool-creation signature
 *   (not the creation transaction itself),
 * - the candidate owner must not be the pool-creation transaction's fee payer,
 * - the candidate owner must pass classifyAccountForBuyer (System-owned,
 *   non-executable, not a PDA), verified via a live getAccountInfo call.
 * Returns { buyer, buyerTxSignature, t } or { buyer: null, buyerTxSignature: null, t: null }.
 */
export async function resolveBuyer(pairAddress, targetMint, poolCreation, db = null) {
  if (!poolCreation) return { buyer: null, buyerTxSignature: null, t: null, rejectedCandidates: [] };

  const creatorFeePayer = txFeePayer(poolCreation.tx);
  // Signatures are returned newest-first; the ones OLDER than or equal to the
  // creation signature (i.e. at/after it in the array, since array is
  // newest-first) come before creation chronologically and must be excluded.
  // Candidates are every signature that is NEWER than creation, oldest of
  // those first (closest in time to creation), up to the scan limit.
  const all = poolCreation.allSignaturesNewestFirst;
  const creationIdx = all.findIndex((s) => s.signature === poolCreation.signature);
  const afterCreation = creationIdx > 0 ? all.slice(0, creationIdx) : [];
  const candidatesOldestFirst = [...afterCreation].reverse().slice(0, BUYER_CANDIDATE_SCAN_LIMIT);

  const rejectedCandidates = [];

  for (const sigInfo of candidatesOldestFirst) {
    const tx = await rpcCall("getTransaction", [sigInfo.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }], db);
    const candidate = extractBuyerFromTx(tx, targetMint, pairAddress);
    if (!candidate) continue;

    if (candidate === creatorFeePayer) {
      rejectedCandidates.push({ signature: sigInfo.signature, owner: candidate, reason: "is the pool-creation transaction's fee payer" });
      continue;
    }

    const accountInfo = await rpcCall("getAccountInfo", [candidate, { encoding: "jsonParsed" }], db);
    const classification = classifyAccountForBuyer(accountInfo?.value ?? null);
    if (!classification.isRegularWallet) {
      rejectedCandidates.push({ signature: sigInfo.signature, owner: candidate, reason: classification.reason });
      continue;
    }

    return { buyer: candidate, buyerTxSignature: sigInfo.signature, t: tx.blockTime ?? sigInfo.blockTime, rejectedCandidates };
  }

  return { buyer: null, buyerTxSignature: null, t: null, rejectedCandidates };
}

/** Fetches mint state (mintAuthority, freezeAuthority, Token-2022 extensions). */
export async function fetchMintStateAtT(mint, db = null) {
  try {
    const accountInfo = await rpcCall("getAccountInfo", [mint, { encoding: "jsonParsed" }], db);
    const value = accountInfo?.value;
    if (!value) return { mintAuthority: null, freezeAuthority: null, tokenProgram: null, extensions: [] };
    const info = value.data?.parsed?.info || {};
    return {
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      tokenProgram: value.owner || null,
      extensions: info.extensions || [],
    };
  } catch (err) {
    if (db) logError(db, "collect", "fetchMintStateAtT", err, { mint });
    return { mintAuthority: null, freezeAuthority: null, tokenProgram: null, extensions: [] };
  }
}

/**
 * Checks token age via DexScreener: the MINIMUM pairCreatedAt across ALL
 * pairs for this mint must be within TOKEN_MAX_AGE_DAYS of now (task 2).
 * A brand-new pool for an already-established token must not enter the frame.
 */
export async function checkTokenAge(mint, db = null, fetchImpl = fetch) {
  const data = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, db, 3, fetchImpl);
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const created = pairs.map((p) => p.pairCreatedAt).filter((v) => typeof v === "number" && v > 0);
  if (created.length === 0) {
    // No indexed pairs at all yet -- too new to judge, but cannot be TOO OLD either; accept.
    return { tooOld: false, minPairCreatedAt: null };
  }
  const minCreatedAt = Math.min(...created);
  const ageMs = Date.now() - minCreatedAt;
  const tooOld = ageMs > TOKEN_MAX_AGE_DAYS * 86400 * 1000;
  return { tooOld, minPairCreatedAt: minCreatedAt };
}

export function getRadarCommitHash() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Determines whether the radar's response shows mintRisk was actually
 * fetched and used (task 4). /gate-copy's JSON response has no explicit
 * boolean for this -- the only positive proof is a TOXIC_MINT/CONCENTRATION
 * entry in details.simulation.wouldTrigger (that can only appear if the
 * mint metadata fetch succeeded and returned a freeze/mint authority or
 * concentration figure). Absence of such an entry does NOT prove the fetch
 * was skipped -- the mint may simply be clean. So the honest determination
 * is: true if positive evidence is present, "NOT_DETERMINABLE" otherwise --
 * never a false "false".
 */
export function determineMintRiskFetched(radarResponseBody) {
  const wouldTrigger = radarResponseBody?.details?.simulation?.wouldTrigger;
  if (Array.isArray(wouldTrigger) && (wouldTrigger.includes("TOXIC_MINT") || wouldTrigger.includes("CONCENTRATION"))) {
    return true;
  }
  return "NOT_DETERMINABLE";
}

/**
 * Queries POST /gate-copy. Returns { httpStatus, body, isRadarError }.
 * A non-200 response (or a network failure reaching the radar) is
 * RADAR_ERROR and is NEVER treated as a verdict (task 4/5).
 */
export async function queryGateCopy(radarUrl, buyer, mint, copyAmountUsd = COPY_AMOUNT_USD) {
  try {
    const res = await fetch(`${radarUrl}/gate-copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetWallet: buyer, mint, copyAmountUsd }),
      signal: AbortSignal.timeout(10000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body, isRadarError: res.status !== 200 };
  } catch (err) {
    return { httpStatus: null, body: { error: `Radar call failed: ${err.message}` }, isRadarError: true };
  }
}

/**
 * Fetches fresh Solana pools from GeckoTerminal's new_pools endpoint,
 * filtered to pools created within POOL_MAX_AGE_MINUTES of NOW (task 1).
 */
export async function fetchFreshPools(db = null, fetchImpl = fetch, maxPages = 5) {
  const pools = [];
  const seen = new Set();
  const cutoffMs = POOL_MAX_AGE_MINUTES * 60 * 1000;
  const now = Date.now();

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}`;
    let data;
    try {
      data = await fetchWithRetry(url, {}, db, 3, fetchImpl);
    } catch (err) {
      if (db) logError(db, "collect", `fetchFreshPools:page${page}`, err);
      break;
    }
    const items = Array.isArray(data?.data) ? data.data : [];
    if (items.length === 0) break;

    let anyFresh = false;
    for (const p of items) {
      const address = p.attributes?.address;
      if (!address || seen.has(address)) continue;
      seen.add(address);
      const dexId = p.relationships?.dex?.data?.id || "";
      if (!DEX_ID_REGEX.test(dexId)) continue;
      const createdAtStr = p.attributes?.pool_created_at;
      if (!createdAtStr) continue;
      const createdAtMs = new Date(createdAtStr).getTime();
      const ageMs = now - createdAtMs;
      if (ageMs >= 0 && ageMs <= cutoffMs) {
        anyFresh = true;
        const baseTokenId = p.relationships?.base_token?.data?.id || "";
        const mint = baseTokenId.startsWith("solana_") ? baseTokenId.slice("solana_".length) : null;
        if (!mint) continue;
        pools.push({ pair: address, mint, dexId, poolCreatedAtMs: createdAtMs, poolCreatedAtIso: createdAtStr });
      }
    }
    // Pages are newest-first; once a page has no fresh entries, older pages are all stale too.
    if (!anyFresh) break;
  }

  return pools;
}

/** Runs a single collection cycle. */
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

  const rawPools = await fetchFreshPools(db);
  console.log(`[COLLECT] Fetched ${rawPools.length} fresh Solana candidate pools (<= ${POOL_MAX_AGE_MINUTES} min old) from GeckoTerminal.`);

  const candidatePools = limit ? rawPools.slice(0, limit) : rawPools;
  let savedCount = 0;
  let tokenTooOldCount = 0;
  let noBuyerCount = 0;
  let consecutiveRadarErrors = 0;
  const rows = [];

  for (const p of candidatePools) {
    const { mint, pair, dexId } = p;
    try {
      const ageCheck = await checkTokenAge(mint, db);
      if (ageCheck.tooOld) {
        tokenTooOldCount++;
        console.log(`[TOKEN_TOO_OLD] ${mint.slice(0, 8)}... minPairCreatedAt=${new Date(ageCheck.minPairCreatedAt).toISOString()}`);
        continue;
      }

      const mintState = await fetchMintStateAtT(mint, db);
      const strat = determineStrat(mintState);

      const poolCreation = await resolvePoolCreationTx(pair, db);
      const buyerRes = await resolveBuyer(pair, mint, poolCreation, db);
      if (!buyerRes.buyer) noBuyerCount++;

      const gateCopyRes = buyerRes.buyer
        ? await queryGateCopy(radarUrl, buyerRes.buyer, mint, COPY_AMOUNT_USD)
        : { httpStatus: null, body: null, isRadarError: false }; // no buyer -> never called the radar, not a RADAR_ERROR

      if (buyerRes.buyer) {
        if (gateCopyRes.isRadarError) {
          consecutiveRadarErrors++;
        } else {
          consecutiveRadarErrors = 0;
        }
      }

      const mintRiskFetched = buyerRes.buyer && !gateCopyRes.isRadarError ? determineMintRiskFetched(gateCopyRes.body) : "NOT_DETERMINABLE";

      const record = {
        mint,
        pair,
        t: buyerRes.t ?? Math.floor((p.poolCreatedAtMs || Date.now()) / 1000),
        liquidity_usd: null,
        mint_authority: mintState.mintAuthority,
        freeze_authority: mintState.freezeAuthority,
        token_program: mintState.tokenProgram,
        token_2022_extensions: mintState.extensions,
        strat,
        buyer: buyerRes.buyer,
        buyer_tx_signature: buyerRes.buyerTxSignature,
        http_status: gateCopyRes.httpStatus,
        copy_amount_usd: COPY_AMOUNT_USD,
        mint_risk_fetched: mintRiskFetched,
        radar_verdict: gateCopyRes.isRadarError ? null : gateCopyRes.body,
        radar_error: gateCopyRes.isRadarError ? gateCopyRes.body : null,
        radar_code_version: gitCommit,
        recorded_at: new Date().toISOString(),
      };

      rows.push(record);

      if (!dryRun) {
        try {
          insertTrade(db, record);
          savedCount++;
        } catch (dbErr) {
          if (!/UNIQUE constraint failed/i.test(dbErr.message)) throw dbErr;
        }
      } else {
        savedCount++;
      }

      console.log(
        `[SAVED] strat=${strat} mint=${mint.slice(0, 8)}... pair=${pair.slice(0, 8)}... buyer=${buyerRes.buyer ? buyerRes.buyer.slice(0, 8) + "..." : "NONE"} httpStatus=${gateCopyRes.httpStatus ?? "n/a"} mintRiskFetched=${mintRiskFetched} action=${gateCopyRes.body?.action ?? (gateCopyRes.isRadarError ? "RADAR_ERROR" : "n/a")}`
      );

      if (consecutiveRadarErrors >= MAX_CONSECUTIVE_RADAR_ERRORS) {
        console.error(`[FATAL] ${MAX_CONSECUTIVE_RADAR_ERRORS} consecutive RADAR_ERROR responses -- aborting run.`);
        return { collected: savedCount, ceilingReached: false, tokenTooOldCount, noBuyerCount, rows, fatalRadarError: true };
      }
    } catch (itemErr) {
      logError(db, "collect", `processPool:${pair}`, itemErr);
      console.error(`[ERROR] Processing pool ${pair}:`, itemErr.message);
    }

    await sleep(200);
  }

  console.log(`[COLLECT] Cycle completed. Saved: ${savedCount}. TOKEN_TOO_OLD: ${tokenTooOldCount}. NO_BUYER: ${noBuyerCount}.`);
  return { collected: savedCount, ceilingReached: false, tokenTooOldCount, noBuyerCount, rows, fatalRadarError: false };
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
  const runOnce = () =>
    runCollectionCycle(opts).then((res) => {
      if (res.fatalRadarError) process.exit(1);
      return res;
    });

  if (once) {
    runOnce()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
      });
  } else {
    console.log(`[SERVICE] Running continuous collection every ${intervalMin} minutes.`);
    runOnce().catch((err) => {
      console.error(err);
      process.exit(1);
    });
    setInterval(() => {
      runOnce().catch((err) => {
        console.error(err);
        process.exit(1);
      });
    }, intervalMin * 60 * 1000);
  }
}
