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
import { runTrustCheck } from "./trust.js";
import { anomalyReasons, anomalySummary, buildFreshness } from "./explain.js";
import type { EnhancedTx } from "./types.js";

const SERVICE = "wallet-radar";

interface EndpointInfo {
  method: string;
  path: string;
  tool: string;
  description: string;
}

const ENDPOINTS: EndpointInfo[] = [
  { method: "POST", path: "/scan", tool: "radar_scan", description: "Full wallet risk scan: Helius history + Jupiter USD pricing + 7 deterministic anomaly rules. Returns riskScore (0-100), anomalies with evidence, per-rule reasons, summary, digest, and data freshness." },
  { method: "POST", path: "/analyze", tool: "radar_analyze", description: "Offline anomaly analysis over a client-supplied transactions fixture. No network calls. Returns riskScore, anomalies, per-rule reasons, summary, and digest." },
  { method: "POST", path: "/trust", tool: "radar_trust", description: "Pre-flight trust check: behavioral risk score + payment capacity (SOL + USDC/USDT liquidity) into a safe/hold/unknown verdict, with verdict reasons, per-rule anomaly reasons, summary, and data freshness." },
  { method: "POST", path: "/selftest", tool: "radar_selftest", description: "Free offline smoke test over a built-in fixture. Returns riskScore, anomalies, per-rule reasons, and summary." },
  { method: "GET", path: "/health", tool: "health", description: "Health check. No auth." },
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
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 2_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isBase58Address(v: unknown): v is string {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

async function toolScan(body: Record<string, unknown>): Promise<unknown> {
  const wallet = body.wallet;
  if (!isBase58Address(wallet)) throw new HttpError(400, "body.wallet must be a Solana base58 address.");
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new HttpError(503, "HELIUS_API_KEY is not set on the server.");
  const txs = await fetchWalletTransactions(apiKey, wallet);
  const prices = await fetchSwapPrices(txs);
  const mintRisk = await fetchSwapMintRisk(txs, { apiKey });
  const baseline = updateBaseline(wallet, null, txs, Date.now() / 1000, prices);
  const anomalies = detectAnomalies(wallet, txs, null, undefined, prices, mintRisk);
  const stamps = txs.map((t) => t.timestamp).filter((n) => typeof n === "number");
  const lastActivity = stamps.length > 0 ? Math.max(...stamps) : null;
  const windowStart = stamps.length > 0 ? Math.min(...stamps) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    wallet,
    txCount: txs.length,
    lastSeenAt: baseline.lastSeenAt,
    pnl: baseline.pnl ?? null,
    pricesAvailable: prices !== null,
    priceCount: prices ? Object.keys(prices).length : 0,
    riskScore: computeRiskScore(anomalies),
    anomalies,
    reasons: anomalyReasons(anomalies),
    summary: anomalySummary(anomalies),
    digest: digestAnomalies(anomalies),
    freshness: buildFreshness(lastActivity, nowSec, windowStart, lastActivity),
  };
}

async function toolAnalyze(body: Record<string, unknown>): Promise<unknown> {
  const wallet = typeof body.wallet === "string" ? body.wallet : "anonymous";
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
  const anomalies = detectAnomalies(wallet, parsed, null);
  return { wallet, txCount: parsed.length, riskScore: computeRiskScore(anomalies), anomalies, reasons: anomalyReasons(anomalies), summary: anomalySummary(anomalies), digest: digestAnomalies(anomalies) };
}

async function toolTrust(body: Record<string, unknown>): Promise<unknown> {
  const wallet = body.wallet;
  if (!isBase58Address(wallet)) throw new HttpError(400, "body.wallet must be a Solana base58 address.");
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new HttpError(503, "HELIUS_API_KEY is not set on the server.");
  return runTrustCheck(apiKey, wallet, {
    maxRisk: typeof body.maxRisk === "number" ? body.maxRisk : undefined,
    minLiquidityUsd: typeof body.minLiquidityUsd === "number" ? body.minLiquidityUsd : undefined,
    windowDays: typeof body.windowDays === "number" ? body.windowDays : undefined,
  });
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

const TOOL_BY_PATH: Record<string, (body: Record<string, unknown>) => Promise<unknown> | unknown> = {
  "/scan": toolScan,
  "/radar_scan": toolScan,
  "/analyze": toolAnalyze,
  "/radar_analyze": toolAnalyze,
  "/trust": toolTrust,
  "/radar_trust": toolTrust,
  "/selftest": toolSelftest,
  "/radar_selftest": toolSelftest,
};

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (method === "GET") {
      if (p === "/health") {
        sendJson(res, 200, healthPayload());
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

      // Path dispatch (primary).
      const byPath = TOOL_BY_PATH[p];
      if (byPath) {
        sendJson(res, 200, await byPath(body));
        return;
      }

      // Base-path dispatch: POST / with a "tool" (or "action") selector.
      if (p === "/" || p === "") {
        const sel = typeof body.tool === "string" ? body.tool : typeof body.action === "string" ? body.action : "";
        const norm = sel.replace(/^radar_/, "").toLowerCase();
        const target = TOOL_BY_PATH[`/${norm}`];
        if (target) {
          sendJson(res, 200, await target(body));
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
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
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
}

export function createServer(options: ServerOptions = {}): http.Server {
  const limit = options.rateLimitPerMin ?? Number(process.env.RADAR_RATE_LIMIT_PER_MIN ?? 120);
  const rateLimiter = limit > 0 ? createRateLimiter(limit) : null;
  return http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (rateLimiter && url !== "/health" && (req.method ?? "GET") !== "OPTIONS") {
      const rl = rateLimiter.check(req.socket.remoteAddress ?? "unknown");
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
    void handleRequest(req, res);
  });
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
  const server = startServer(port, host);
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
