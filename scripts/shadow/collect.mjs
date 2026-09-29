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
  incrementSkipCounter,
  recordPoolCandidate,
  DEFAULT_DB_PATH,
  DEFAULT_DAILY_CEILING_COLLECT,
} from "./db.mjs";
// Imported from the actual compiled radar code (dist/src/, built via `npm run build`),
// not copied literals -- same pattern already used by scripts/audit/pilot-scan-candidates.mjs.
// Stage 7E task 3: radar_token_check_missing must whitelist exactly what the radar itself
// whitelists, not a hand-maintained duplicate that can drift out of sync with src/.
import { MAJOR_MINTS } from "../../dist/src/types.js";
import { KNOWN_SAFE_MINTS } from "../../dist/src/mint.js";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");

const RADAR_URL = (process.env.RADAR_URL || "http://localhost:7690").replace(/\/+$/, "");
// Stage 7H task 2: own ceiling/counter key ("collect"), separate from outcomes.mjs's --
// DAILY_REQUEST_CEILING (shared, unscoped) is no longer read.
const DAILY_CEILING = parseInt(process.env.DAILY_REQUEST_CEILING_COLLECT || String(DEFAULT_DAILY_CEILING_COLLECT), 10);
const REQUEST_COUNTER_SCRIPT = "collect";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// --- Config constants (task 1/2/4) ---
export const POOL_MAX_AGE_MINUTES = 15; // pool must be this fresh AT COLLECTION TIME (not at any later check)
export const TOKEN_MAX_AGE_DAYS = 14; // min pairCreatedAt across ALL of the mint's DexScreener pairs must be within this
export const COPY_AMOUNT_USD = 10; // fixed, recorded verbatim per trade (task 4)
export const MAX_CONSECUTIVE_RADAR_ERRORS = 5;
const DEX_ID_REGEX = /^(raydium|pump-?fun|pumpswap)/i;
const BUYER_CANDIDATE_SCAN_LIMIT = 20; // how many post-creation signatures to try before giving up

// --- Task 3 (stage 7H): time-of-day budget spreading ---
// Without a per-cycle budget, a cycle greedily processes every fresh pool
// fetchFreshPools returns and exhausts the whole day's DAILY_REQUEST_CEILING_COLLECT
// within the first 1-2 hours, leaving zero collection for the rest of the day.
export const REQUESTS_PER_POOL = 7; // measured in the 20-pool dry run: 138 requests / 20 pools = 6.9, rounded up
export const DEFAULT_POLL_INTERVAL_MINUTES = 15;

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

// Stage 7H task 1: was 0, bumped to 1 after a real dry-run failure (RPC error -32015,
// "Transaction version (1) is not supported") on pair JtfZS5Pc3C63xRer87yhPqjJAM4bReRhsskuRqxqKe1
// -- confirmed live that maxSupportedTransactionVersion:1 alone resolves that specific case.
export const GETTRANSACTION_MAX_SUPPORTED_VERSION = 1;
const VERSION_ERROR_RE = /^RPC Error \[-32015\]:.*maxSupportedTransactionVersion["']?\s*:\s*(\d+)/;

/**
 * getTransaction with a ONE-TIME retry on RPC error -32015: parses the version number
 * Solana's own error message names ("...following configuration parameter:
 * \"maxSupportedTransactionVersion\": N") and retries once with that exact N, in case a
 * future transaction version (2, 3, ...) appears beyond GETTRANSACTION_MAX_SUPPORTED_VERSION.
 * Any other error, or a second failure, is rethrown -- the caller's per-pool catch block
 * (runCollectionCycle) already turns that into PROCESSING_ERROR + skip_counters, so this
 * function does not duplicate that bookkeeping.
 */
export async function getTransactionWithVersionRetry(signature, db = null, fetchImpl = fetch) {
  try {
    return await rpcCall("getTransaction", [signature, { maxSupportedTransactionVersion: GETTRANSACTION_MAX_SUPPORTED_VERSION, encoding: "jsonParsed" }], db, 3, fetchImpl);
  } catch (err) {
    const match = VERSION_ERROR_RE.exec(err.message);
    if (!match) throw err;
    const retryVersion = parseInt(match[1], 10);
    return await rpcCall("getTransaction", [signature, { maxSupportedTransactionVersion: retryVersion, encoding: "jsonParsed" }], db, 3, fetchImpl);
  }
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
  const tx = await getTransactionWithVersionRetry(oldest.signature, db);
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
    const tx = await getTransactionWithVersionRetry(sigInfo.signature, db);
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

/**
 * Fetches mint state (mintAuthority, freezeAuthority, Token-2022 extensions)
 * via the COLLECTOR'S OWN getAccountInfo call -- independent of whatever the
 * radar does or does not fetch server-side for /gate-copy (task 2, stage 7D).
 *
 * `/gate-copy`'s response never echoes back whether it actually fetched mint
 * metadata (verified by reading src/simulate.ts's simulatePayment return
 * object and src/http-server.ts's toolGateCopy response body -- neither
 * contains `mintRisk` or any derivative of it); `mint_risk_fetched`
 * (determineMintRiskFetched) is only an INDIRECT inference from whether
 * TOXIC_MINT/CONCENTRATION fired, which proves risk was found, never that a
 * check was attempted on a clean mint. `fetched` here is a genuinely
 * independent, direct signal: did OUR OWN RPC call for this mint's account
 * succeed, right now, regardless of what the radar's response says.
 */
export async function fetchMintStateAtT(mint, db = null, fetchImpl = fetch) {
  try {
    const accountInfo = await rpcCall("getAccountInfo", [mint, { encoding: "jsonParsed" }], db, 3, fetchImpl);
    const value = accountInfo?.value;
    if (!value) return { mintAuthority: null, freezeAuthority: null, tokenProgram: null, extensions: [], fetched: false };
    const info = value.data?.parsed?.info || {};
    return {
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      tokenProgram: value.owner || null,
      extensions: info.extensions || [],
      fetched: true,
    };
  } catch (err) {
    if (db) logError(db, "collect", "fetchMintStateAtT", err, { mint });
    return { mintAuthority: null, freezeAuthority: null, tokenProgram: null, extensions: [], fetched: false };
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
 * Task 3 (stage 7E) / task 2 (stage 7F): where /gate-copy lists which
 * anomalies/rules fired, and a four-state result that keeps the TOXIC_MINT
 * asymmetry honest instead of collapsing it into a boolean.
 *
 * Read by walking src/simulate.ts and src/http-server.ts's toolGateCopy:
 * - src/simulate.ts:246,319-330 -- simulatePayment's return field `wouldTrigger`
 *   (a SimulateAnomaly[]) is the ONLY place fired rules are listed. TOXIC_MINT
 *   fires ONLY on `input.mintRisk.freezeAuthority` truthy (src/simulate.ts:324) --
 *   NOT on mintAuthority alone. A mint with an active mintAuthority but
 *   freezeAuthority === null can never trigger TOXIC_MINT no matter what the
 *   radar fetched -- that is a structural gap in the RULE, not evidence the
 *   mint wasn't checked. Stage 7E's first version flagged such mints
 *   `true` ("missing"), which was misleading: it isn't that the check is
 *   missing, it's that the rule was never applicable to begin with. Fixed in
 *   stage 7F by returning NOT_APPLICABLE for exactly this case (and for the
 *   whitelist), so `true`/`false` are reserved for mints where TOXIC_MINT
 *   COULD have fired (freezeAuthority present, not whitelisted).
 * - src/http-server.ts's toolGateCopy (431-548): `wouldTrigger` reaches the
 *   client ONLY inside `details.simulation.wouldTrigger`, and `details.simulation`
 *   is populated ONLY when execution reaches the simulatePayment call
 *   (copyAmountUsd > 0, which the collector always sends). When
 *   `trustResult.verdict` is `"hold"` (444-452) or `"unknown"` (453-461), the
 *   function returns EARLY with `details: { trust: trustResult }` only --
 *   `simulatePayment` never runs, so whether TOXIC_MINT would have fired is
 *   genuinely unknown, not "no". Those cases return NOT_DETERMINABLE,
 *   never a guessed boolean.
 *
 * Four possible results:
 * - NOT_APPLICABLE: no freezeAuthority at all (mintAuthority-only counts here
 *   too -- TOXIC_MINT structurally cannot fire on it), OR the mint is in
 *   MAJOR_MINTS/KNOWN_SAFE_MINTS (correctly whitelisted, suppression intended).
 * - NOT_DETERMINABLE: freezeAuthority present, not whitelisted, but
 *   details.simulation is absent (simulatePayment never ran) -- can't tell.
 * - true: freezeAuthority present, not whitelisted, details.simulation
 *   present, but TOXIC_MINT did NOT fire -- the check that should have run
 *   apparently didn't confirm anything (missing).
 * - false: same setup, but TOXIC_MINT DID fire -- confirmed working.
 *
 * Whitelists (MAJOR_MINTS, KNOWN_SAFE_MINTS) are imported from the actual
 * compiled radar code, not copied, so this can't silently drift from src/.
 */
export function determineRadarTokenCheckMissing(mintState, mint, radarResponseBody) {
  const hasFreezeAuthority = Boolean(mintState?.freezeAuthority);
  if (!hasFreezeAuthority) return "NOT_APPLICABLE"; // includes mintAuthority-only mints -- TOXIC_MINT can't fire on those
  if (MAJOR_MINTS.includes(mint) || KNOWN_SAFE_MINTS.has(mint)) return "NOT_APPLICABLE"; // correctly whitelisted

  const simulation = radarResponseBody?.details?.simulation;
  if (!simulation) return "NOT_DETERMINABLE"; // simulatePayment never ran (early trust-check block) -- can't tell

  const wouldTrigger = simulation.wouldTrigger;
  const toxicMintFired = Array.isArray(wouldTrigger) && wouldTrigger.includes("TOXIC_MINT");
  return !toxicMintFired;
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

/**
 * Deterministic 32-bit FNV-1a hash of a string. Used only to score candidates for
 * pseudo-random selection (below) -- NOT for anything security-sensitive.
 */
function fnv1aHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * How many pools a single cycle may process without exceeding the daily ceiling,
 * spread evenly across the day's cycles (task 3 stage 7H).
 * budget_pools = max(1, floor(ceiling / cycles_per_day / requestsPerPool))
 */
export function computeBudgetPools({ dailyCeiling, pollIntervalMinutes = DEFAULT_POLL_INTERVAL_MINUTES, requestsPerPool = REQUESTS_PER_POOL } = {}) {
  const cyclesPerDay = 1440 / pollIntervalMinutes;
  return Math.max(1, Math.floor(dailyCeiling / cyclesPerDay / requestsPerPool));
}

/**
 * Selects up to `budgetPools` candidates pseudo-randomly, seeded by `seed` (the cycle
 * timestamp, task 3 stage 7H). Each candidate's selection score is fnv1aHash(`${seed}:${pair}`)
 * -- a function of the candidate's OWN identity and the seed, never of its position in
 * the input array -- so sorting by score and taking the lowest `budgetPools` always
 * yields the same SET of selected pools for a given (seed, candidate set), regardless of
 * what order `candidates` is passed in. Returns every candidate with a `__selected` flag
 * (never drops any -- callers that need to record "seen" candidates still see them all).
 */
export function selectCandidatesPseudoRandom(candidates, budgetPools, seed) {
  const scored = candidates.map((c) => ({ candidate: c, score: fnv1aHash(`${seed}:${c.pair}`) }));
  scored.sort((a, b) => a.score - b.score);
  const selectedPairs = new Set(scored.slice(0, budgetPools).map((s) => s.candidate.pair));
  return candidates.map((c) => ({ ...c, __selected: selectedPairs.has(c.pair) }));
}

/** Runs a single collection cycle. */
export async function runCollectionCycle(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const radarUrl = opts.radarUrl || RADAR_URL;
  const limit = opts.limit || null;
  const dryRun = Boolean(opts.dryRun);
  const pollIntervalMinutes = opts.pollIntervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES;
  // Seed for pseudo-random candidate selection (task 3 stage 7H) -- the cycle's own
  // timestamp, recorded into pool_candidates.cycle_ts so the choice is reproducible
  // from the database alone, not just from in-memory state.
  const cycleTs = opts.cycleTs ?? Date.now();

  const db = openDb(dbPath);
  // Everything below is wrapped in try/finally (stage 7F fix): runCollectionCycle
  // previously never closed its db handle at all -- a real leak, one live SQLite
  // connection per cycle, never freed, most visible in continuous mode (setInterval
  // in the CLI entry point below) where a new one opens every POLL_INTERVAL_MINUTES
  // forever, and on Windows where an unclosed handle keeps the file locked.
  try {
    const gitCommit = getRadarCommitHash();

    console.log(`[COLLECT] Starting cycle. DB: ${dbPath}, Radar: ${radarUrl}, Commit: ${gitCommit}`);

    const ceilingStatus = checkDailyCeiling(db, DAILY_CEILING, REQUEST_COUNTER_SCRIPT);
    if (!ceilingStatus.allowed) {
      console.warn(`[COLLECT] Daily ceiling reached (${ceilingStatus.current}/${ceilingStatus.ceiling}). Skipping cycle.`);
      return { collected: 0, ceilingReached: true };
    }

    // opts.pools: test-only injection point, bypasses fetchFreshPools (already tested on
    // its own) so POOL_TOO_OLD can be exercised deterministically without racing the real
    // wall clock across a live network round trip.
    const rawPools = opts.pools || (await fetchFreshPools(db));
    console.log(`[COLLECT] Fetched ${rawPools.length} fresh Solana candidate pools (<= ${POOL_MAX_AGE_MINUTES} min old) from GeckoTerminal.`);

    // Task 3 (stage 7H): budget the cycle instead of greedily processing every fresh
    // pool seen (which used to exhaust DAILY_REQUEST_CEILING_COLLECT in 1-2 hours).
    // opts.budgetPools overrides the formula outright (test-only escape hatch, e.g. for
    // tests that inject a small, deliberately-crafted pool list and need every one of
    // them processed regardless of the real-world ceiling/interval math).
    const budgetPools = opts.budgetPools ?? computeBudgetPools({ dailyCeiling: DAILY_CEILING, pollIntervalMinutes, requestsPerPool: opts.requestsPerPool || REQUESTS_PER_POOL });
    const withSelection = selectCandidatesPseudoRandom(rawPools, budgetPools, cycleTs);
    console.log(`[COLLECT] Budget: ${budgetPools} pools/cycle (seed=${cycleTs}). Selected ${withSelection.filter((p) => p.__selected).length}/${rawPools.length} seen candidates.`);

    // Record EVERY seen candidate (task 3), selected or not -- purely local writes, no
    // additional external requests.
    const seenAt = new Date().toISOString();
    for (const p of withSelection) {
      recordPoolCandidate(db, { cycleTs, pool: p.pair, mint: p.mint, seenAt, selected: p.__selected });
    }

    const selectedPools = withSelection.filter((p) => p.__selected);
    const candidatePools = limit ? selectedPools.slice(0, limit) : selectedPools;
    let savedCount = 0;
    let tokenTooOldCount = 0;
    let noBuyerCount = 0;
    let poolTooOldCount = 0;
    let processingErrorCount = 0;
    let consecutiveRadarErrors = 0;
    const rows = [];

    for (const p of candidatePools) {
      const { mint, pair, dexId } = p;
      try {
        // POOL_TOO_OLD (task 3 stage 7F): fetchFreshPools already filtered this pool to
        // <= POOL_MAX_AGE_MINUTES at discovery time, but real time passes while earlier
        // items in candidatePools are processed (network calls, retries, the sleep(200)
        // between iterations below) -- a pool that WAS fresh when fetched can be stale by
        // the time its own turn comes up. Re-check right before doing any network work on
        // it, purely locally (no request spent), rather than silently letting a stale pool
        // through the frame's own <15min guarantee.
        if (p.poolCreatedAtMs) {
          const ageAtProcessingMs = Date.now() - p.poolCreatedAtMs;
          if (ageAtProcessingMs > POOL_MAX_AGE_MINUTES * 60 * 1000) {
            poolTooOldCount++;
            incrementSkipCounter(db, "POOL_TOO_OLD");
            console.log(`[POOL_TOO_OLD] ${pair.slice(0, 8)}... aged ${(ageAtProcessingMs / 60000).toFixed(1)}min by processing time (limit ${POOL_MAX_AGE_MINUTES}min)`);
            continue;
          }
        }

        const ageCheck = await checkTokenAge(mint, db);
        if (ageCheck.tooOld) {
          tokenTooOldCount++;
          incrementSkipCounter(db, "TOKEN_TOO_OLD");
          console.log(`[TOKEN_TOO_OLD] ${mint.slice(0, 8)}... minPairCreatedAt=${new Date(ageCheck.minPairCreatedAt).toISOString()}`);
          continue;
        }

        const mintState = await fetchMintStateAtT(mint, db);
        const strat = determineStrat(mintState);

        const poolCreation = await resolvePoolCreationTx(pair, db);
        const buyerRes = await resolveBuyer(pair, mint, poolCreation, db);
        if (!buyerRes.buyer) {
          noBuyerCount++;
          incrementSkipCounter(db, "NO_BUYER");
        }

        const gateCopyRes = buyerRes.buyer
          ? await queryGateCopy(radarUrl, buyerRes.buyer, mint, COPY_AMOUNT_USD)
          : { httpStatus: null, body: null, isRadarError: false }; // no buyer -> never called the radar, not a RADAR_ERROR

        if (buyerRes.buyer) {
          if (gateCopyRes.isRadarError) {
            consecutiveRadarErrors++;
            incrementSkipCounter(db, "RADAR_ERROR");
          } else {
            consecutiveRadarErrors = 0;
          }
        }

        const mintRiskFetched = buyerRes.buyer && !gateCopyRes.isRadarError ? determineMintRiskFetched(gateCopyRes.body) : "NOT_DETERMINABLE";
        // Only meaningful when a real verdict exists (task 3 stage 7E) -- no buyer or a
        // RADAR_ERROR means there is no response body to inspect at all, not "not missing".
        const radarTokenCheckMissing =
          buyerRes.buyer && !gateCopyRes.isRadarError ? determineRadarTokenCheckMissing(mintState, mint, gateCopyRes.body) : null;

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
          // Independent of mint_risk_fetched (inferred from the radar's response, task 4 stage 7B):
          // this is the collector's OWN getAccountInfo(mint) result, task 2 stage 7D.
          mint_metadata_fetched: mintState.fetched,
          // A real verdict was returned, but our own independent mint check failed -- we cannot
          // vouch that ANY mint data (ours or the radar's own internal fetch) was available for
          // this trade. Never set when there is no verdict at all (RADAR_ERROR/NO_BUYER already
          // excluded elsewhere, task 4/5 stage 7B) -- this flag is specifically about a verdict
          // that WAS produced without a confirmed mint check backing it.
          verdict_unconfirmed_mint_check: Boolean(gateCopyRes.body) && !gateCopyRes.isRadarError && !mintState.fetched,
          // true/false/"NOT_DETERMINABLE"/null (task 3 stage 7E) -- see determineRadarTokenCheckMissing.
          radar_token_check_missing: radarTokenCheckMissing,
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
          return { collected: savedCount, ceilingReached: false, tokenTooOldCount, noBuyerCount, poolTooOldCount, processingErrorCount, rows, fatalRadarError: true };
        }
      } catch (itemErr) {
        // Any other rejection reason (task 3 stage 7F): an unexpected RPC/parsing failure
        // mid-pool, not one of the named checks above. Already logged with a stack trace
        // via logError; skip_counters gets the same event as a queryable daily aggregate.
        processingErrorCount++;
        incrementSkipCounter(db, "PROCESSING_ERROR");
        logError(db, "collect", `processPool:${pair}`, itemErr);
        console.error(`[ERROR] Processing pool ${pair}:`, itemErr.message);
      }

      await sleep(200);
    }

    console.log(`[COLLECT] Cycle completed. Saved: ${savedCount}. TOKEN_TOO_OLD: ${tokenTooOldCount}. NO_BUYER: ${noBuyerCount}. POOL_TOO_OLD: ${poolTooOldCount}. PROCESSING_ERROR: ${processingErrorCount}.`);
    return { collected: savedCount, ceilingReached: false, tokenTooOldCount, noBuyerCount, poolTooOldCount, processingErrorCount, rows, fatalRadarError: false };
  } finally {
    db.close();
  }
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

  const opts = { dbPath: customDb, limit, dryRun, pollIntervalMinutes: intervalMin };
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
