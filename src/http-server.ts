#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getVersion } from "./mcp-server.js";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { digestAnomalies } from "./digest.js";
import { fetchWalletTransactions } from "./collector.js";
import { fetchSwapPrices } from "./pricing.js";
import { fetchSwapMintRisk } from "./mint.js";
import { runTrustCheck, runTrustChecks, buildShortlist, formatTrustLine, type TrustResult, type TrustVerdict, type TrustBalances } from "./trust.js";
import { anomalyReasons, anomalySummary, buildFreshness } from "./explain.js";
import { simulatePayment, type SimulateInput } from "./simulate.js";
import { runBenchmark } from "./benchmark.js";
import { Store } from "./store.js";
import { watchOnce, watchLoop } from "./watch.js";
import { enforcementFor, enforceVerdict } from "./defense.js";
import type { DefenseStateInfo, DefenseView } from "./defense.js";
import type { ActionVerdict } from "./decision.js";
import { makeSink, type AlertSink } from "./alerts.js";
import type { MintRiskMap } from "./mint.js";
import { homedir } from "node:os";
import type { EnhancedTx } from "./types.js";
import { commitScan, type ZKOracleClient } from "./oracle/index.js";
import { computeVerdict } from "./htmlreport.js";
import { handleDashboardHttpRequest } from "./dashboard.js";
import { computeEconomics, recordHeliusCost } from "./economics.js";

const SERVICE = "wallet-radar";

interface EndpointInfo {
  method: string;
  path: string;
  tool: string;
  description: string;
}

const ENDPOINTS: EndpointInfo[] = [
  { method: "POST", path: "/scan", tool: "radar_scan", description: "Full wallet risk scan: Helius history + Jupiter USD pricing + 8 deterministic anomaly rules. Returns riskScore (0-100), anomalies with evidence, per-rule reasons, summary, digest, and data freshness." },
  { method: "POST", path: "/analyze", tool: "radar_analyze", description: "Offline anomaly analysis over a client-supplied transactions fixture. No network calls. Returns riskScore, anomalies, per-rule reasons, summary, and digest." },
  { method: "POST", path: "/trust", tool: "radar_trust", description: "Pre-flight trust check: behavioral risk score + payment capacity (SOL + USDC/USDT liquidity) into a safe/hold/unknown verdict, with verdict reasons, per-rule anomaly reasons, summary, and data freshness." },
  { method: "POST", path: "/batch", tool: "radar_batch", description: "Batch trust-gate over up to 20 Solana wallets: runs the pre-flight trust check (behavioral risk + SOL/USDC/USDT payment capacity) on each and returns a deterministic shortlist — safe (ranked by risk, then liquidity), hold, and unknown buckets. Gate a whole copy-trading book at once." },
  { method: "POST", path: "/simulate", tool: "radar_simulate", description: "Pre-trade what-if simulation: 'if I send X USDC/SOL to wallet Y, what happens?' Models liquidity impact, LARGE_SWAP trigger, risk score delta, and returns an actionable decision (allow/throttle/block/manual_review) with a specific recommendation. The agent asks BEFORE signing." },
  { method: "GET", path: "/watch", tool: "radar_watch", description: "List the monitoring watchlist: each watched wallet with its seed status and unalerted-anomaly count. Requires the watch store (start the server with RADAR_WATCH=1)." },
  { method: "POST", path: "/watch", tool: "radar_watch", description: "Add a wallet to the monitoring watchlist so it is continuously re-checked for new anomalies (webhook/Telegram on detection). Requires the watch store (RADAR_WATCH=1)." },
  { method: "POST", path: "/unwatch", tool: "radar_unwatch", description: "Remove a wallet from the monitoring watchlist. Requires the watch store (RADAR_WATCH=1)." },
  { method: "GET", path: "/alerts", tool: "radar_alerts", description: "Recent recorded anomalies from the monitoring watchlist, most recent first. Requires the watch store (RADAR_WATCH=1)." },
  { method: "GET", path: "/defense", tool: "radar_defense", description: "Active-defense posture (Pillar 3): the current defense stance per watched wallet (armed/alerting/gated/blocked) with the enforcement each stance implies. The radar acts, not just reports." },
  { method: "GET", path: "/defense/:wallet", tool: "radar_defense_wallet", description: "One wallet's defense stance plus its audited transition trail (armed -> alerting -> gated -> blocked -> ...). Requires the watch store (RADAR_WATCH=1)." },
  { method: "POST", path: "/defense/:wallet/clear", tool: "radar_defense_clear", description: "Manually reset a wallet's defense stance back to armed (operator override), recorded as an audit event. Requires the watch store (RADAR_WATCH=1)." },
  { method: "POST", path: "/poll", tool: "radar_poll", description: "Immediately re-check the whole monitoring watchlist for new activity and fire webhooks/Telegram on any new anomaly (re-check your copied wallet now). Requires the watch store + HELIUS_API_KEY (RADAR_WATCH=1)." },
  { method: "POST", path: "/selftest", tool: "radar_selftest", description: "Free offline smoke test over a built-in fixture. Returns riskScore, anomalies, per-rule reasons, and summary." },
  { method: "POST", path: "/benchmark", tool: "radar_benchmark", description: "Reproducible quality proof: runs a versioned eval set of labeled test cases through the full detection pipeline and reports precision, recall, accuracy, and per-case results. Deterministic — same input, same numbers, every time. No network calls." },
  { method: "GET", path: "/dashboard", tool: "radar_dashboard", description: "Minimal web dashboard reading the on-chain ZK scan ledger and rendering risk history + latest verdict." },
  { method: "GET", path: "/api/ledger", tool: "radar_ledger", description: "JSON API reading historical on-chain ZK scan attestations for a given wallet." },
  { method: "GET", path: "/economics", tool: "radar_economics", description: "Live unit economics (the agent's P&L): on-chain revenue (USDC settled via x402) vs. tracked operating cost (Helius/LLM), net, margin, self-sustaining status, per-day trend, and per-paid-scan unit economics." },
  { method: "GET", path: "/health", tool: "health", description: "Health check. No auth." },
  { method: "GET", path: "/.well-known/agent.json", tool: "a2a_card", description: "A2A agent card (a2a-protocol.org) for the Wallet Radar Trust Gate agent — describes the screen-wallet skill and the /a2a RPC endpoint." },
  { method: "POST", path: "/a2a", tool: "a2a", description: "A2A JSON-RPC endpoint. Send message/send with a wallet address (or POST {wallet}) to run the pre-flight trust gate: returns a safe/hold/unknown verdict, risk score, liquidity, and anomaly reasons." },
];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (status === 413) headers["Connection"] = "close";
  res.writeHead(status, headers);
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      data += chunk.toString();
      if (data.length > 1_000_000) {
        rejected = true;
        reject(new HttpError(413, "Payload Too Large"));
        req.resume();
      }
    });
    req.on("end", () => {
      if (!rejected) resolve(data);
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

function isBase58Address(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{32,44}$/.test(v);
}

async function toolScan(body: Record<string, unknown>, ctx: RequestContext = {}): Promise<unknown> {
  const wallet = body.wallet;
  if (!isBase58Address(wallet)) throw new HttpError(400, "body.wallet must be a Solana base58 address.");
  const apiKey = ctx.apiKey ?? process.env.HELIUS_API_KEY;
  if (!apiKey) throw new HttpError(503, "HELIUS_API_KEY is not set on the server. Live endpoints (/scan, /trust, /simulate) require it. Offline endpoints that still work: GET /selftest, POST /analyze (with your own txs), GET /benchmark, GET /metrics.");
  const txs = ctx.fetchTxs ? await ctx.fetchTxs(wallet) : await fetchWalletTransactions(apiKey, wallet);
  const prices = ctx.fetchPrices ? await ctx.fetchPrices(txs) : await fetchSwapPrices(txs);
  const mintRisk = ctx.fetchMintRisk ? await ctx.fetchMintRisk(txs) : await fetchSwapMintRisk(txs, { apiKey });
  const baseline = updateBaseline(wallet, null, txs, Date.now() / 1000, prices);
  const anomalies = detectAnomalies(wallet, txs, null, undefined, prices, mintRisk);
  const stamps = txs.map((t) => t.timestamp).filter((n) => typeof n === "number");
  const lastActivity = stamps.length > 0 ? Math.max(...stamps) : null;
  const windowStart = stamps.length > 0 ? Math.min(...stamps) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const riskScore = computeRiskScore(anomalies);
  const verdict = computeVerdict(riskScore);
  const result: Record<string, unknown> = {
    wallet,
    txCount: txs.length,
    lastSeenAt: baseline.lastSeenAt,
    pnl: baseline.pnl ?? null,
    pricesAvailable: prices !== null,
    priceCount: prices ? Object.keys(prices).length : 0,
    riskScore,
    verdict,
    anomalies,
    reasons: anomalyReasons(anomalies),
    summary: anomalySummary(anomalies),
    digest: digestAnomalies(anomalies),
    freshness: buildFreshness(lastActivity, nowSec, windowStart, lastActivity),
  };

  if (process.env.RADAR_ORACLE === "1") {
    try {
      const topRules = Array.from(new Set(anomalies.map((a) => a.type)));
      const txSignatures = txs.map((t) => t.signature).filter(Boolean).slice(0, 10);
      const commitRes = await commitScan({
        wallet,
        riskScore,
        verdict,
        timestamp: nowSec,
        topRules,
        txSignatures,
      });
      if (commitRes.signature) {
        result.onchainLedgerSig = commitRes.signature;
      }
      result.oracle = commitRes;
    } catch (err) {
      if (process.env.RADAR_DEBUG === "1") {
        console.error("[http-server] toolScan oracle commit failed:", err);
      }
    }
  }

  return result;
}

async function toolAnalyze(body: Record<string, unknown>): Promise<unknown> {
  const wallet = typeof body.wallet === "string" ? body.wallet : "anonymous";
  if (typeof wallet !== "string" || wallet.length > 64) {
    throw new HttpError(400, "body.wallet must be a string up to 64 characters.");
  }
  const raw = body.txs;
  let parsed: EnhancedTx[];
  if (Array.isArray(raw)) {
    parsed = raw as EnhancedTx[];
  } else if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as EnhancedTx[];
    } catch {
      throw new HttpError(400, "body.txs must be a JSON array of transaction objects.");
    }
    if (!Array.isArray(parsed)) throw new HttpError(400, "body.txs must be a JSON array of transaction objects.");
  } else {
    throw new HttpError(400, "body.txs must be an array of transactions (or a JSON string encoding one).");
  }
  if (parsed.length > 1000) {
    throw new HttpError(400, "body.txs: at most 1000 transactions allowed.");
  }
  const anomalies = detectAnomalies(wallet, parsed, null);
  return { wallet, txCount: parsed.length, riskScore: computeRiskScore(anomalies), anomalies, reasons: anomalyReasons(anomalies), summary: anomalySummary(anomalies), digest: digestAnomalies(anomalies) };
}

async function toolTrust(body: Record<string, unknown>): Promise<unknown> {
  const wallet = body.wallet;
  if (!isBase58Address(wallet)) throw new HttpError(400, "body.wallet must be a Solana base58 address.");
  if (body.maxRisk !== undefined && (typeof body.maxRisk !== "number" || !Number.isFinite(body.maxRisk) || body.maxRisk < 0 || body.maxRisk > 100)) {
    throw new HttpError(400, "body.maxRisk must be a number between 0 and 100.");
  }
  if (body.minLiquidityUsd !== undefined && (typeof body.minLiquidityUsd !== "number" || !Number.isFinite(body.minLiquidityUsd) || body.minLiquidityUsd < 0)) {
    throw new HttpError(400, "body.minLiquidityUsd must be a non-negative number.");
  }
  if (body.windowDays !== undefined && (typeof body.windowDays !== "number" || !Number.isFinite(body.windowDays) || body.windowDays <= 0)) {
    throw new HttpError(400, "body.windowDays must be a positive number.");
  }
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new HttpError(503, "HELIUS_API_KEY is not set on the server. Live endpoints (/scan, /trust, /simulate) require it. Offline endpoints that still work: GET /selftest, POST /analyze (with your own txs), GET /benchmark, GET /metrics.");
  return runTrustCheck(apiKey, wallet, {
    maxRisk: typeof body.maxRisk === "number" ? body.maxRisk : undefined,
    minLiquidityUsd: typeof body.minLiquidityUsd === "number" ? body.minLiquidityUsd : undefined,
    windowDays: typeof body.windowDays === "number" ? body.windowDays : undefined,
  });
}

async function toolBatch(body: Record<string, unknown>): Promise<unknown> {
  const wallets = body.wallets;
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new HttpError(400, "body.wallets must be a non-empty array of Solana base58 addresses.");
  }
  if (wallets.length > 20) {
    throw new HttpError(400, `body.wallets: at most 20 wallets per batch (got ${String(wallets.length)}).`);
  }
  for (const w of wallets) {
    if (!isBase58Address(w)) throw new HttpError(400, "body.wallets must all be Solana base58 addresses: " + String(w));
  }
  if (body.maxRisk !== undefined && (typeof body.maxRisk !== "number" || !Number.isFinite(body.maxRisk) || body.maxRisk < 0 || body.maxRisk > 100)) {
    throw new HttpError(400, "body.maxRisk must be a number between 0 and 100.");
  }
  if (body.minLiquidityUsd !== undefined && (typeof body.minLiquidityUsd !== "number" || !Number.isFinite(body.minLiquidityUsd) || body.minLiquidityUsd < 0)) {
    throw new HttpError(400, "body.minLiquidityUsd must be a non-negative number.");
  }
  if (body.windowDays !== undefined && (typeof body.windowDays !== "number" || !Number.isFinite(body.windowDays) || body.windowDays <= 0)) {
    throw new HttpError(400, "body.windowDays must be a positive number.");
  }
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new HttpError(503, "HELIUS_API_KEY is not set on the server. Live endpoints (/scan, /trust, /simulate) require it. Offline endpoints that still work: GET /selftest, POST /analyze (with your own txs), GET /benchmark, GET /metrics.");
  const results = await runTrustChecks(apiKey, wallets, {
    maxRisk: typeof body.maxRisk === "number" ? body.maxRisk : undefined,
    minLiquidityUsd: typeof body.minLiquidityUsd === "number" ? body.minLiquidityUsd : undefined,
    windowDays: typeof body.windowDays === "number" ? body.windowDays : undefined,
  });
  return buildShortlist(results);
}

async function toolSimulate(body: Record<string, unknown>): Promise<unknown> {
  const wallet = body.wallet;
  if (!isBase58Address(wallet)) throw new HttpError(400, "body.wallet must be a Solana base58 address.");
  const amountUsd = body.amountUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new HttpError(400, "body.amountUsd must be a positive number.");
  }
  const balances = body.balances as { sol?: number; usdc?: number; usdt?: number } | undefined;
  if (!balances || typeof balances !== "object" || Array.isArray(balances)) {
    throw new HttpError(400, "body.balances is required: { sol, usdc, usdt }.");
  }
  for (const [k, v] of Object.entries(balances)) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new HttpError(400, `body.balances.${k} must be a non-negative number.`);
    }
  }
  const token = typeof body.token === "string" ? body.token : "usdc";
  if (token !== "usdc" && token !== "sol") throw new HttpError(400, "body.token must be 'usdc' or 'sol'.");
  if (body.maxRisk !== undefined && (typeof body.maxRisk !== "number" || !Number.isFinite(body.maxRisk) || body.maxRisk < 0 || body.maxRisk > 100)) {
    throw new HttpError(400, "body.maxRisk must be a number between 0 and 100.");
  }
  if (body.minLiquidityUsd !== undefined && (typeof body.minLiquidityUsd !== "number" || !Number.isFinite(body.minLiquidityUsd) || body.minLiquidityUsd < 0)) {
    throw new HttpError(400, "body.minLiquidityUsd must be a non-negative number.");
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new HttpError(503, "HELIUS_API_KEY is not set on the server. Live endpoints (/scan, /trust, /simulate) require it. Offline endpoints that still work: GET /selftest, POST /analyze (with your own txs), GET /benchmark, GET /metrics.");

  // Fetch current risk data for the wallet
  const trustResult = await runTrustCheck(apiKey, wallet, {
    maxRisk: typeof body.maxRisk === "number" ? body.maxRisk : undefined,
    minLiquidityUsd: typeof body.minLiquidityUsd === "number" ? body.minLiquidityUsd : undefined,
    includeAudit: typeof body.audit === "boolean" ? body.audit : false,
  });

  const simInput: SimulateInput = {
    wallet,
    amountUsd,
    token,
    balances: {
      sol: balances.sol ?? 0,
      usdc: balances.usdc ?? 0,
      usdt: balances.usdt ?? 0,
    },
    solPrice: trustResult.solPrice,
    riskScore: trustResult.riskScore,
    anomalies: trustResult.anomalies,
    medianSwapAmountUsd: trustResult.medianSwapAmountUsd,
    legacyVerdict: trustResult.verdict,
    maxRisk: typeof body.maxRisk === "number" ? body.maxRisk : undefined,
    minLiquidityUsd: typeof body.minLiquidityUsd === "number" ? body.minLiquidityUsd : undefined,
  };

  return simulatePayment(simInput);
}

function toolSelftest(): unknown {
  const wallet = "DemoWallet11111111111111111111111111111111";
  const txs: EnhancedTx[] = [
    { signature: "sigA", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    { signature: "sigB", timestamp: 1_700_000_120, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
  ];
  const anomalies = detectAnomalies(wallet, txs, null);
  return { ok: true, riskScore: computeRiskScore(anomalies), anomalies, reasons: anomalyReasons(anomalies), summary: anomalySummary(anomalies) };
}

function toolBenchmark(): unknown {
  return runBenchmark();
}

function healthPayload(): Record<string, unknown> {
  return {
    ok: true,
    status: "ok",
    service: SERVICE,
    version: getVersion(),
    transport: "http",
    endpoints: ENDPOINTS,
    env: { heliusConfigured: Boolean(process.env.HELIUS_API_KEY) },
  };
}

/**
 * A2A (a2a-protocol.org) surface for the Wallet Radar Trust Gate agent.
 * The agent's T3N/ERC-8004 card (hosted on T3N, did:t3n:11099118...) lists
 * `/.well-known/agent.json` as its A2A endpoint; this is that card plus the
 * `message/send` JSON-RPC handler that runs the pre-flight trust gate.
 */
const A2A_PUBLIC_URL = (process.env.RADAR_PUBLIC_URL ?? "https://radar.cbellory.xyz").replace(/\/+$/, "");
const A2A_AGENT_DID = process.env.RADAR_AGENT_DID ?? "did:t3n:11099118c31352cdb07c5c992f5da31426f2052f";

function a2aCard(): Record<string, unknown> {
  return {
    name: "Wallet Radar Trust Gate",
    description:
      "Pre-flight trust gate for Solana wallets. Given a wallet address it screens the wallet via Wallet Radar (behavioral risk, payment capacity, top-holder concentration, mint toxicity, data freshness) and returns a deterministic safe/hold/unknown verdict with the reasons — so a paying agent can gate a transaction before it commits.",
    url: `${A2A_PUBLIC_URL}/a2a`,
    version: "0.3.0",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "application/json"],
    agentId: A2A_AGENT_DID,
    skills: [
      {
        id: "screen-wallet",
        name: "Screen a Solana wallet",
        description:
          "Run the pre-flight trust check on one Solana wallet. Provide the wallet address (in the message text or as a structured wallet field); receive a safe/hold/unknown verdict, a 0-100 risk score, USD liquidity, and per-rule anomaly reasons.",
        tags: ["solana", "risk", "trust-gate", "payments", "x402", "agent-to-agent"],
        examples: [
          "Screen wallet 8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j",
          "Is it safe to pay this wallet before I commit: <address>",
        ],
        inputModes: ["text"],
        outputModes: ["text", "application/json"],
      },
    ],
  };
}

function extractWallet(body: Record<string, unknown>): string | null {
  if (typeof body.wallet === "string" && isBase58Address(body.wallet)) return body.wallet;
  const msg =
    body.message ??
    (body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>).message : undefined);
  const fromText = (t: string): string | null => {
    const m = t.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    return m ? m[0] : null;
  };
  const walk = (node: unknown): string | null => {
    if (node == null) return null;
    if (typeof node === "string") return fromText(node);
    if (Array.isArray(node)) {
      for (const it of node) {
        const r = walk(it);
        if (r) return r;
      }
      return null;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.wallet === "string" && isBase58Address(o.wallet)) return o.wallet;
      if (typeof o.text === "string") {
        const r = fromText(o.text);
        if (r) return r;
      }
      for (const k of ["parts", "data", "message"]) {
        const r = walk(o[k]);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(msg) ?? walk(body);
}

function defenseView(wallet: string, st: DefenseStateInfo): DefenseView {
  return {
    wallet,
    state: st.state,
    riskAt: st.riskAt,
    setAt: st.setAt,
    quietStreak: st.quietStreak,
    actions: st.actions,
    enforcement: enforcementFor(st.state),
  };
}

/**
 * Active-defense enforcement (Pillar 3): when a wallet has an active stance,
 * attach it to the response and, when the stance gates payments (gated/blocked),
 * tighten the actionable verdict — the more conservative of fresh vs. stance wins.
 * No-op for wallets with no stance (the common case).
 */
function applyDefense(store: Store, body: Record<string, unknown>, out: Record<string, unknown>): void {
  const wallet = typeof body.wallet === "string" ? body.wallet : undefined;
  if (!wallet) return;
  const st = store.getDefenseState(wallet);
  if (!st) return;
  const view = defenseView(wallet, st);
  if (view.enforcement.gating) {
    const action = out.action;
    if (action && typeof action === "object" && "verdict" in (action as Record<string, unknown>)) {
      (action as Record<string, unknown>).verdict = enforceVerdict(
        (action as Record<string, unknown>).verdict as ActionVerdict,
        st.state,
      );
    }
  }
  out.defense = view;
}

/** Defense enforcement for the A2A surface (operates on a TrustResult). */
function applyDefenseToTrust(store: Store, result: TrustResult): TrustResult {
  const st = store.getDefenseState(result.wallet);
  if (!st) return result;
  const action = result.action;
  if (!action) return { ...result, defense: defenseView(result.wallet, st) };
  const enforced = enforceVerdict(action.verdict, st.state);
  return {
    ...result,
    action: { ...action, verdict: enforced, enforcedByDefense: enforced !== action.verdict },
    defense: defenseView(result.wallet, st),
  };
}

async function handleA2A(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  recordCost?: (detail?: string) => void,
  store?: Store,
): Promise<void> {
  const isRpc = body.jsonrpc === "2.0";
  const id = body.id !== undefined ? body.id : "1";
  const wallet = extractWallet(body);
  if (!wallet) {
    if (isRpc) {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "No Solana wallet address found. Send it in the message text (e.g. 'Screen wallet <address>') or as body.wallet." },
      });
      return;
    }
    throw new HttpError(400, "Provide a Solana wallet address in the message text or as body.wallet.");
  }
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    if (isRpc) {
      sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32603, message: "HELIUS_API_KEY is not set on the server." } });
      return;
    }
    throw new HttpError(503, "HELIUS_API_KEY is not set on the server.");
  }
  let result: TrustResult = await runTrustCheck(apiKey, wallet, {
    maxRisk: typeof body.maxRisk === "number" ? body.maxRisk : undefined,
    minLiquidityUsd: typeof body.minLiquidityUsd === "number" ? body.minLiquidityUsd : undefined,
    windowDays: typeof body.windowDays === "number" ? body.windowDays : undefined,
  });
  recordCost?.("/a2a");
  if (store) result = applyDefenseToTrust(store, result);
  if (isRpc) {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "message",
        role: "agent",
        parts: [{ kind: "text", text: formatTrustLine(result) }, { kind: "data", data: result }],
      },
    });
  } else {
    sendJson(res, 200, result);
  }
}

const TOOL_BY_PATH: Record<string, (body: Record<string, unknown>, ctx: RequestContext) => Promise<unknown> | unknown> = {
  "/scan": toolScan,
  "/radar_scan": toolScan,
  "/analyze": toolAnalyze,
  "/radar_analyze": toolAnalyze,
  "/trust": toolTrust,
  "/radar_trust": toolTrust,
  "/batch": toolBatch,
  "/radar_batch": toolBatch,
  "/simulate": toolSimulate,
  "/radar_simulate": toolSimulate,
  "/selftest": toolSelftest,
  "/radar_selftest": toolSelftest,
  "/benchmark": toolBenchmark,
  "/radar_benchmark": toolBenchmark,
};

/** Endpoints that hit Helius (fetch real wallet history) — each incurs a tracked API cost. */
const LIVE_HELIUS_PATHS = new Set([
  "/scan",
  "/radar_scan",
  "/trust",
  "/radar_trust",
  "/simulate",
  "/radar_simulate",
  "/batch",
  "/radar_batch",
]);

export interface RequestContext {
  store?: Store;
  sink?: AlertSink;
  apiKey?: string;
  rpcUrl?: string;
  oracleClient?: ZKOracleClient;
  fetchTxs?: (wallet: string) => Promise<EnhancedTx[]>;
  fetchPrices?: (txs: EnhancedTx[]) => Promise<Record<string, number> | null>;
  fetchMintRisk?: (txs: EnhancedTx[]) => Promise<MintRiskMap>;
}

function requireStore(ctx: RequestContext): Store {
  if (!ctx.store) {
    throw new HttpError(503, "watch store not enabled — start the server with RADAR_WATCH=1 (or provide a Store).");
  }
  return ctx.store;
}

function watchListPayload(store: Store): unknown {
  const wallets = store.listWallets().map((w) => ({
    wallet: w,
    seeded: store.getBaseline(w) !== null,
    unalerted: store.unalertedCount(w),
  }));
  return { watching: wallets, count: wallets.length };
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext = {}): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    // Dashboard & ZK Ledger routes
    if (p === "/dashboard" || p === "/api/ledger") {
      const handled = await handleDashboardHttpRequest(req, res, {
        store: ctx.store,
        rpcUrl: ctx.rpcUrl,
        oracleClient: ctx.oracleClient,
      });
      if (handled) return;
    }

    if (method === "GET") {
      if (p === "/health") {
        sendJson(res, 200, healthPayload());
        return;
      }
      if (p === "/economics") {
        if (!ctx.store) throw new HttpError(503, "economics store not available (start the server with a shared RADAR_DB).");
        sendJson(res, 200, computeEconomics(ctx.store));
        return;
      }
      if (p === "/" || p === "") {
        sendJson(res, 200, {
          service: SERVICE,
          version: getVersion(),
          description: "Solana wallet & transaction risk scoring. POST /scan, /analyze, /trust, /selftest. GET /health.",
          endpoints: ENDPOINTS,
        });
        return;
      }
      // Monitoring watchlist (store-backed, enabled with RADAR_WATCH=1).
      if (p === "/watch") {
        sendJson(res, 200, watchListPayload(requireStore(ctx)));
        return;
      }
      if (p === "/alerts") {
        const store = requireStore(ctx);
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 20)) : 20;
        const anomalies = store.recentAnomalies(null, limit);
        sendJson(res, 200, { anomalies, count: anomalies.length });
        return;
      }
      // Active defense (Pillar 3): stance list + per-wallet stance & audit trail.
      if (p === "/defense") {
        const store = requireStore(ctx);
        const states = store.listDefenseStates();
        sendJson(res, 200, {
          count: states.length,
          states: states.map((s) => defenseView(s.wallet, s.state)),
        });
        return;
      }
      const defenseMatch = p.match(/^\/defense\/([^/]+)$/);
      if (defenseMatch) {
        const store = requireStore(ctx);
        const wallet = defenseMatch[1];
        if (!isBase58Address(wallet)) throw new HttpError(400, "wallet must be a Solana base58 address.");
        const st = store.getDefenseState(wallet);
        const events = store.recentDefenseEvents(wallet, 20);
        sendJson(res, 200, {
          wallet,
          state: st,
          enforcement: st ? enforcementFor(st.state) : null,
          events,
        });
        return;
      }
      // A2A agent card (a2a-protocol.org well-known location).
      if (p === "/.well-known/agent.json") {
        sendJson(res, 200, a2aCard());
        return;
      }
      // Health-friendly: a GET on a tool path returns 200 with its descriptor.
      const info = ENDPOINTS.find((e) => e.path === p);
      if (info) {
        sendJson(res, 200, { tool: info.tool, method: info.method, path: info.path, description: info.description });
        return;
      }
      throw new HttpError(404, `unknown GET route ${p}`);
    }

    if (method === "POST") {
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
          else throw new Error("not an object");
        } catch {
          throw new HttpError(400, "body must be a JSON object.");
        }
      }

      // Monitoring watchlist management (store-backed, enabled with RADAR_WATCH=1).
      if (p === "/watch") {
        const store = requireStore(ctx);
        const wallet = body.wallet;
        if (!isBase58Address(wallet)) throw new HttpError(400, "body.wallet must be a Solana base58 address.");
        store.addWallet(wallet);
        sendJson(res, 200, { ok: true, wallet, watching: store.listWallets() });
        return;
      }
      if (p === "/unwatch") {
        const store = requireStore(ctx);
        const wallet = body.wallet;
        if (!isBase58Address(wallet)) throw new HttpError(400, "body.wallet must be a Solana base58 address.");
        store.removeWallet(wallet);
        sendJson(res, 200, { ok: true, wallet, watching: store.listWallets() });
        return;
      }
      const defenseClearMatch = p.match(/^\/defense\/([^/]+)\/clear$/);
      if (defenseClearMatch) {
        const store = requireStore(ctx);
        const wallet = defenseClearMatch[1];
        if (!isBase58Address(wallet)) throw new HttpError(400, "wallet must be a Solana base58 address.");
        const st = store.getDefenseState(wallet);
        if (!st) throw new HttpError(404, "no defense state for this wallet (it has not been escalated).");
        const nowSec = Math.floor(Date.now() / 1000);
        const next = { state: "armed" as const, riskAt: st.riskAt, setAt: nowSec, quietStreak: 0, actions: st.actions + 1 };
        store.setDefenseState(wallet, next);
        store.recordDefenseEvent({
          wallet,
          ts: nowSec,
          fromState: st.state,
          toState: "armed",
          action: "clear",
          risk: st.riskAt,
          reason: "Manual clear: operator reset the defense stance to armed.",
        });
        sendJson(res, 200, { wallet, cleared: true, from: st.state, state: next });
        return;
      }
      if (p === "/poll") {
        const store = requireStore(ctx);
        const apiKey = ctx.apiKey ?? process.env.HELIUS_API_KEY;
        if (!apiKey) throw new HttpError(503, "HELIUS_API_KEY is not set on the server. Live endpoints (/scan, /trust, /simulate) require it. Offline endpoints that still work: GET /selftest, POST /analyze (with your own txs), GET /benchmark, GET /metrics.");
        const report = await watchOnce(store, apiKey, {
          sink: ctx.sink,
          fetchTxs: ctx.fetchTxs,
          fetchPrices: ctx.fetchPrices,
          fetchMintRisk: ctx.fetchMintRisk,
          usePrices: typeof body.usePrices === "boolean" ? body.usePrices : true,
        });
        sendJson(res, 200, report);
        return;
      }

      // A2A JSON-RPC trust-gate endpoint.
      if (p === "/a2a") {
        const a2aStore = ctx.store;
        await handleA2A(res, body, a2aStore ? (d?: string) => recordHeliusCost(a2aStore, d) : undefined, ctx.store);
        return;
      }

      // Path dispatch (primary).
      const byPath = TOOL_BY_PATH[p];
      if (byPath) {
        let out = await byPath(body, ctx);
        if (ctx.store) applyDefense(ctx.store, body, out as Record<string, unknown>);
        if (ctx.store && LIVE_HELIUS_PATHS.has(p)) recordHeliusCost(ctx.store, p);
        sendJson(res, 200, out);
        return;
      }

      // Base-path dispatch: POST / with a "tool" (or "action") selector.
      if (p === "/" || p === "") {
        const sel = typeof body.tool === "string" ? body.tool : typeof body.action === "string" ? body.action : "";
        const norm = sel.replace(/^radar_/, "").toLowerCase();
        const target = TOOL_BY_PATH[`/${norm}`];
        if (target) {
          let out = await target(body, ctx);
          if (ctx.store) applyDefense(ctx.store, body, out as Record<string, unknown>);
          sendJson(res, 200, out);
          return;
        }
        throw new HttpError(400, 'POST / requires body.tool or body.action to be one of: scan, analyze, trust, selftest.');
      }

      throw new HttpError(404, `unknown POST route ${p}`);
    }

    throw new HttpError(405, `method ${method} not allowed for ${p}`);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
    } else {
      if (process.env.RADAR_DEBUG === "1") {
        console.error("[http-server] unhandled error:", err);
      }
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
}

interface RateLimiter {
  check(ip: string): { ok: boolean; retryAfterSec?: number };
}

function createRateLimiter(limitPerMin: number): RateLimiter {
  const WINDOW_MS = 60_000;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (now >= b.resetAt) buckets.delete(ip);
  }, WINDOW_MS);
  timer.unref();
  return {
    check(ip: string): { ok: boolean; retryAfterSec?: number } {
      const now = Date.now();
      const b = buckets.get(ip);
      if (!b || now >= b.resetAt) {
        buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return { ok: true };
      }
      b.count += 1;
      if (b.count > limitPerMin) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
      }
      return { ok: true };
    },
  };
}

export interface ServerOptions {
  rateLimitPerMin?: number;
  /** Watchlist store (enables /watch, /unwatch, /alerts, /poll + the in-process loop). */
  store?: Store;
  /** Alert sink for the watch loop (webhook/Telegram/console). */
  sink?: AlertSink;
  /** Run the continuous watch loop in-process (requires a store + a Helius key). */
  watch?: boolean;
  /** Poll interval for the in-process loop (ms). Defaults to DEFAULT_CONFIG.pollMs. */
  pollMs?: number;
  /** Helius API key for the loop/poll (env HELIUS_API_KEY if omitted). */
  apiKey?: string;
  /** Injectable tx source for the loop/poll (tests). */
  fetchTxs?: (wallet: string) => Promise<EnhancedTx[]>;
  /** Injectable price source for the loop/poll (tests). */
  fetchPrices?: (txs: EnhancedTx[]) => Promise<Record<string, number> | null>;
  /** Injectable mint-risk source for the loop/poll (tests). */
  fetchMintRisk?: (txs: EnhancedTx[]) => Promise<MintRiskMap>;
  /** Optional Solana RPC URL for on-chain queries */
  rpcUrl?: string;
  /** Injectable ZK oracle client */
  oracleClient?: ZKOracleClient;
}

export function createServer(options: ServerOptions = {}): http.Server {
  const limit = options.rateLimitPerMin ?? Number(process.env.RADAR_RATE_LIMIT_PER_MIN ?? 120);
  const rateLimiter = limit > 0 ? createRateLimiter(limit) : null;
  const ctx: RequestContext = {
    store: options.store,
    sink: options.sink,
    apiKey: options.apiKey,
    rpcUrl: options.rpcUrl,
    oracleClient: options.oracleClient,
    fetchTxs: options.fetchTxs,
    fetchPrices: options.fetchPrices,
    fetchMintRisk: options.fetchMintRisk,
  };
  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const pathname = new URL(rawUrl, "http://localhost").pathname;
    const isExempt = pathname === "/health" || (req.method ?? "GET") === "OPTIONS";
    if (rateLimiter && !isExempt) {
      const rawIp = req.socket.remoteAddress ?? "unknown";
      const ip = rawIp.replace(/^::ffff:/, "");
      const rl = rateLimiter.check(ip);
      if (!rl.ok) {
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(rl.retryAfterSec ?? 60),
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ error: "Too Many Requests", retryAfterSec: rl.retryAfterSec ?? 60 }));
        return;
      }
    }
    void handleRequest(req, res, ctx);
  });

  // Continuous in-process watch loop (opt-in): poll the watchlist and fire alerts.
  if (options.watch && options.store) {
    const apiKey = options.apiKey ?? process.env.HELIUS_API_KEY;
    if (apiKey) {
      const abort = new AbortController();
      void watchLoop(
        options.store,
        apiKey,
        {
          sink: options.sink,
          pollMs: options.pollMs,
          fetchTxs: options.fetchTxs,
          fetchPrices: options.fetchPrices,
          fetchMintRisk: options.fetchMintRisk,
          signal: abort.signal,
        },
        (report) => {
          const active = report.wallets.filter((w) => w.anomalyCount > 0);
          if (active.length > 0) {
            console.log(`[watch] ${active.map((w) => `${w.wallet} risk=${w.riskScore} anomalies=${w.anomalyCount}`).join(", ")}`);
          }
        },
      ).catch((err) => {
        if (!abort.signal.aborted) {
          console.error("watch loop error:", err instanceof Error ? err.message : String(err));
        }
      });
      server.on("close", () => abort.abort());
    } else {
      console.warn("RADAR_WATCH=1 but no Helius key — in-process watch loop not started (set HELIUS_API_KEY).");
    }
  }

  return server;
}

export function startServer(port: number, host = "0.0.0.0", options: ServerOptions = {}): http.Server {
  const server = createServer(options);
  server.listen(port, host);
  return server;
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--version") || args.includes("-v")) {
    console.log(getVersion());
    return;
  }
  if (args.includes("--health")) {
    loadEnv();
    console.log(JSON.stringify(healthPayload(), null, 2));
    return;
  }
  loadEnv();
  const port = Number(process.env.PORT ?? 7690);
  const host = process.env.HOST ?? "0.0.0.0";

  // Optional in-process monitoring: RADAR_WATCH=1 (or --watch) opens a shared Store
  // and runs the watch loop, firing WEBHOOK_URL / Telegram alerts on new anomalies.
  const watchEnabled = process.env.RADAR_WATCH === "1" || args.includes("--watch");
  const options: ServerOptions = {};
  // Always open the shared store so /economics (and the watch endpoints) can
  // read on-chain revenue (settled_payments) + tracked cost (cost_events).
  // This store shares the RADAR_DB file with the x402 server. The continuous
  // watch LOOP still only starts when RADAR_WATCH=1.
  const dbPath = process.env.RADAR_DB ?? path.join(homedir(), ".wallet-radar", "radar.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  options.store = new Store(dbPath);
  if (watchEnabled) {
    options.sink = makeSink();
    options.watch = true;
    const pollMsRaw = process.env.RADAR_POLL_MS;
    if (pollMsRaw) {
      const parsed = parseInt(pollMsRaw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.pollMs = parsed;
    }
    const sinkName = process.env.WEBHOOK_URL ? "webhook" : process.env.TG_BOT_TOKEN ? "telegram" : "console";
    console.log(`${SERVICE} monitoring enabled — store ${dbPath}, alert sink: ${sinkName}`);
  } else {
    console.log(`${SERVICE} economics store ready — ${dbPath} (set RADAR_WATCH=1 to also run the live watch loop).`);
  }

  const server = startServer(port, host, options);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  console.log(`${SERVICE} HTTP server listening on http://${host}:${port}`);
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectRun) {
  runCli().catch((err) => {
    console.error("HTTP server failed:", err);
    process.exit(1);
  });
}
