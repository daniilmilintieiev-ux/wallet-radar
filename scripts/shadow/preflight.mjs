#!/usr/bin/env node
// Preflight readiness check for the Wallet Radar Shadow Collector (Stage 7C).
//
// Every check catches its own errors and reports FAIL with a reason --
// this script must never throw uncaught, even with no network at all.
// HELIUS_API_KEY is read from the environment only (radar.env is never
// read, and the key's value is never printed -- only whether it is set).

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DB_PATH } from "./db.mjs";
import { POOL_MAX_AGE_MINUTES, fetchFreshPools, determineMintRiskFetched } from "./collect.mjs";

// node:sqlite ships without a flag, "1.1 Active development" stability, since
// Node v22.13.0 (introduced experimental behind --experimental-sqlite in
// v22.5.0, flag dropped in v22.13.0). See docs/SHADOW-RUNBOOK.md section 0
// and https://nodejs.org/docs/latest-v22.x/api/sqlite.html
export const MIN_NODE_VERSION = "22.13.0";
export const NODE_SQLITE_DOC_URL = "https://nodejs.org/docs/latest-v22.x/api/sqlite.html";
export const MIN_FREE_DISK_MB = 500;
export const MAX_CLOCK_SKEW_SECONDS = 5;
export const PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";
// System Program address: deterministic, always valid base58, belongs to no
// individual -- used only to smoke-test /gate-copy connectivity, never a real trade.
export const PREFLIGHT_TEST_WALLET = "11111111111111111111111111111111";
// USDC mint: mature, widely-known token, used only for the same connectivity smoke test.
export const PREFLIGHT_TEST_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SHADOW_DIR = path.dirname(DEFAULT_DB_PATH);
// DexScreener's GET endpoints reliably send a Date header (verified live --
// see the stage 7C report). The public Solana RPC's own bare-GET landing
// page does NOT send one (only its JSON-RPC POST responses do), so it is
// not used as the default clock-skew reference here.
export const CLOCK_CHECK_URL = `https://api.dexscreener.com/latest/dex/tokens/${PREFLIGHT_TEST_MINT}`;

const RADAR_URL = (process.env.RADAR_URL || "http://localhost:7690").replace(/\/+$/, "");

function parseVersion(v) {
  const parts = String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function versionGte(a, b) {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

/** Check: Node version meets the node:sqlite minimum, and the module actually imports. */
export async function checkNodeSqlite(nodeVersion = process.version) {
  const id = "node_sqlite";
  const label = "Node version + node:sqlite import";
  const meetsMinVersion = versionGte(nodeVersion, MIN_NODE_VERSION);
  if (!meetsMinVersion) {
    return { id, label, pass: false, detail: `Node ${nodeVersion} < required ${MIN_NODE_VERSION} (see ${NODE_SQLITE_DOC_URL})` };
  }
  try {
    await import("node:sqlite");
    return { id, label, pass: true, detail: `Node ${nodeVersion} >= ${MIN_NODE_VERSION}, import("node:sqlite") succeeded (see ${NODE_SQLITE_DOC_URL})` };
  } catch (err) {
    return { id, label, pass: false, detail: `Node ${nodeVersion} >= ${MIN_NODE_VERSION} but import("node:sqlite") failed: ${err.message}` };
  }
}

/** Check: HELIUS_API_KEY is set. Prints presence only, never the value. */
export function checkHeliusKeyPresence(env = process.env) {
  const present = Boolean(env.HELIUS_API_KEY);
  return {
    id: "helius_key_env",
    label: "HELIUS_API_KEY set in environment",
    pass: present,
    detail: present ? "yes (value not printed)" : "no -- export HELIUS_API_KEY before running the collector",
  };
}

/** Check: a Solana JSON-RPC endpoint answers getSlot, with response time. */
export async function checkRpcGetSlot(id, label, url, fetchImpl = fetch) {
  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      signal: AbortSignal.timeout(10000),
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      return { id, label, pass: false, detail: `HTTP ${res.status} after ${elapsedMs}ms` };
    }
    const json = await res.json();
    if (typeof json?.result !== "number") {
      return { id, label, pass: false, detail: `no numeric result after ${elapsedMs}ms: ${JSON.stringify(json).slice(0, 200)}` };
    }
    return { id, label, pass: true, detail: `getSlot=${json.result} in ${elapsedMs}ms` };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    return { id, label, pass: false, detail: `${err.message} after ${elapsedMs}ms` };
  }
}

/** Check: GET {RADAR_URL}/health returns 200 and reports the Helius key configured server-side. */
export async function checkRadarHealth(radarUrl = RADAR_URL, fetchImpl = fetch) {
  const id = "radar_health";
  const label = "GET /health";
  try {
    const res = await fetchImpl(`${radarUrl}/health`, { signal: AbortSignal.timeout(10000) });
    if (res.status !== 200) {
      return { id, label, pass: false, detail: `HTTP ${res.status}` };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const heliusConfigured = body?.env?.heliusConfigured === true;
    return {
      id,
      label,
      pass: heliusConfigured,
      detail: heliusConfigured ? "HTTP 200, env.heliusConfigured=true" : `HTTP 200 but env.heliusConfigured=${JSON.stringify(body?.env?.heliusConfigured)}`,
    };
  } catch (err) {
    return { id, label, pass: false, detail: `unreachable: ${err.message}` };
  }
}

/**
 * Check: a smoke-test POST {RADAR_URL}/gate-copy responds HTTP 200 (not 503).
 * Prints only status, action, and mintRiskFetched (inferred the same way
 * collect.mjs's determineMintRiskFetched does -- see docs/SHADOW-COLLECTOR.md).
 */
export async function checkGateCopy(radarUrl = RADAR_URL, fetchImpl = fetch) {
  const id = "radar_gate_copy";
  const label = "POST /gate-copy (smoke test)";
  try {
    const res = await fetchImpl(`${radarUrl}/gate-copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetWallet: PREFLIGHT_TEST_WALLET, mint: PREFLIGHT_TEST_MINT, copyAmountUsd: 10 }),
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const action = body?.action ?? null;
    const mintRiskFetched = determineMintRiskFetched(body);
    const pass = res.status === 200;
    return {
      id,
      label,
      pass,
      detail: `status=${res.status}, action=${JSON.stringify(action)}, mintRiskFetched=${JSON.stringify(mintRiskFetched)}`,
      status: res.status,
      action,
      mintRiskFetched,
    };
  } catch (err) {
    return { id, label, pass: false, detail: `unreachable: ${err.message}` };
  }
}

/** Check: the pool-discovery source chosen in 7B (GeckoTerminal new_pools) responds with fresh pools. */
export async function checkPoolSource(fetchImpl = fetch) {
  const id = "pool_source";
  const label = `New pool source (GeckoTerminal new_pools, < ${POOL_MAX_AGE_MINUTES}min)`;
  const start = Date.now();
  try {
    const pools = await fetchFreshPools(null, fetchImpl, 5);
    const elapsedMs = Date.now() - start;
    const pass = pools.length > 0;
    return {
      id,
      label,
      pass,
      detail: `${pools.length} pools younger than ${POOL_MAX_AGE_MINUTES}min, fetched in ${elapsedMs}ms${pass ? "" : " -- source responded but returned zero fresh pools right now"}`,
      freshPoolCount: pools.length,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    return { id, label, pass: false, detail: `${err.message} after ${elapsedMs}ms` };
  }
}

/** Check: shadow/ directory is writable and has at least MIN_FREE_DISK_MB free. */
export async function checkShadowDirWritable(shadowDir = SHADOW_DIR, minFreeMb = MIN_FREE_DISK_MB) {
  const id = "shadow_dir";
  const label = `shadow/ writable + >= ${minFreeMb}MB free`;
  try {
    if (!fs.existsSync(shadowDir)) {
      fs.mkdirSync(shadowDir, { recursive: true });
    }
    const testFile = path.join(shadowDir, `.preflight-write-test-${process.pid}`);
    fs.writeFileSync(testFile, "preflight");
    fs.unlinkSync(testFile);

    if (typeof fsPromises.statfs !== "function") {
      return { id, label, pass: true, detail: "writable (test file created+removed); free-space check unsupported on this Node/platform (fs.promises.statfs unavailable)" };
    }

    const stats = await fsPromises.statfs(shadowDir);
    const freeMb = (stats.bavail * stats.bsize) / (1024 * 1024);
    const pass = freeMb >= minFreeMb;
    return { id, label, pass, detail: `writable, ${freeMb.toFixed(0)}MB free` };
  } catch (err) {
    return { id, label, pass: false, detail: `${err.message}` };
  }
}

/** Check: system clock skew against a server's Date response header, <= MAX_CLOCK_SKEW_SECONDS. */
export async function checkClockSkew(url = CLOCK_CHECK_URL, fetchImpl = fetch, maxSkewSeconds = MAX_CLOCK_SKEW_SECONDS) {
  const id = "clock_skew";
  const label = `System clock vs server Date header (<= ${maxSkewSeconds}s)`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    const dateHeader = res.headers?.get ? res.headers.get("date") : res.headers?.date;
    if (!dateHeader) {
      return { id, label, pass: false, detail: "no Date header in response" };
    }
    const serverMs = new Date(dateHeader).getTime();
    if (Number.isNaN(serverMs)) {
      return { id, label, pass: false, detail: `unparseable Date header: ${dateHeader}` };
    }
    const skewSeconds = Math.abs(Date.now() - serverMs) / 1000;
    const pass = skewSeconds <= maxSkewSeconds;
    return { id, label, pass, detail: `skew=${skewSeconds.toFixed(1)}s (server Date: ${dateHeader})`, skewSeconds };
  } catch (err) {
    return { id, label, pass: false, detail: `unreachable: ${err.message}` };
  }
}

/**
 * Runs every preflight check. Never throws -- each check swallows its own
 * errors and returns pass:false with a reason instead.
 */
export async function runPreflight(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const radarUrl = opts.radarUrl || RADAR_URL;
  const nodeVersion = opts.nodeVersion || process.version;
  const shadowDir = opts.shadowDir || SHADOW_DIR;
  const env = opts.env || process.env;
  const clockCheckUrl = opts.clockCheckUrl || CLOCK_CHECK_URL;

  const results = [];

  results.push(await checkNodeSqlite(nodeVersion));
  results.push(checkHeliusKeyPresence(env));

  if (env.HELIUS_API_KEY) {
    const heliusUrl = opts.heliusRpcUrl || `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
    results.push(await checkRpcGetSlot("rpc_helius", "RPC reachable (keyed, Helius)", heliusUrl, fetchImpl));
  } else {
    results.push({ id: "rpc_helius", label: "RPC reachable (keyed, Helius)", pass: false, detail: "HELIUS_API_KEY not set -- cannot test keyed RPC" });
  }
  results.push(await checkRpcGetSlot("rpc_public", "RPC reachable (public)", opts.publicRpcUrl || PUBLIC_RPC_URL, fetchImpl));

  results.push(await checkRadarHealth(radarUrl, fetchImpl));
  results.push(await checkGateCopy(radarUrl, fetchImpl));
  results.push(await checkPoolSource(fetchImpl));
  results.push(await checkShadowDirWritable(shadowDir));
  results.push(await checkClockSkew(clockCheckUrl, fetchImpl));

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

export function formatReport(results) {
  const lines = results.map((r) => `[${r.pass ? "PASS" : "FAIL"}] ${r.label}: ${r.detail}`);
  return lines.join("\n");
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPreflight()
    .then(({ results, allPass }) => {
      console.log(formatReport(results));
      console.log("");
      console.log(allPass ? "[PREFLIGHT] ALL CHECKS PASSED." : "[PREFLIGHT] ONE OR MORE CHECKS FAILED.");
      process.exit(allPass ? 0 : 1);
    })
    .catch((err) => {
      // Defensive only -- individual checks should never let an error escape here.
      console.error("[PREFLIGHT] Unexpected internal error:", err);
      process.exit(1);
    });
}
