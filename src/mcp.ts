import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { digestAnomalies } from "./digest.js";
import { fetchWalletTransactions } from "./collector.js";
import { fetchSwapPrices } from "./pricing.js";
import { fetchSwapMintRisk } from "./mint.js";
import { runTrustCheck, runTrustChecks, buildShortlist } from "./trust.js";
import { anomalyReasons, anomalySummary, buildFreshness } from "./explain.js";
import { simulatePayment } from "./simulate.js";
import { Baseline, EnhancedTx } from "./types.js";
import { commitScan, ZKOracleClient, ScanLedgerRecord } from "./oracle/index.js";
import { computeVerdict } from "./htmlreport.js";

function json(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export interface McpServerOptions {
  oracleClient?: ZKOracleClient;
  commitScanFn?: typeof commitScan;
  enableOracle?: boolean;
  fetchTxs?: typeof fetchWalletTransactions;
  fetchPrices?: typeof fetchSwapPrices;
  fetchMintRisk?: typeof fetchSwapMintRisk;
}

export function buildServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "wallet-radar", version: "0.1.0" });

  server.registerTool(
    "radar_scan",
    {
      description:
        "One-shot continuous-monitoring scan of a Solana wallet: fetches recent transactions from Helius (env HELIUS_API_KEY required), fetches USD prices from the Jupiter Price API (keyless; falls back to major-only sizing if the feed is down), updates the behavioral baseline, runs 8 deterministic anomaly rules (LARGE_SWAP is compared in USD when prices are available). Returns riskScore (0-100), anomalies with structured evidence, per-rule reasons, a one-line summary, a human/LLM-readable digest, and data freshness.",
      inputSchema: {
        wallet: z.string().describe("Solana wallet address (base58)"),
      },
    },
    async ({ wallet }) => {
      const apiKey = process.env.HELIUS_API_KEY || (options.fetchTxs ? "mock-helius-key" : undefined);
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "HELIUS_API_KEY is not set. Configure it in the server env, or use radar_analyze with a transactions fixture." }],
          isError: true,
        };
      }
      try {
        const fetchTxsFn = options.fetchTxs ?? fetchWalletTransactions;
        const fetchPricesFn = options.fetchPrices ?? fetchSwapPrices;
        const fetchMintRiskFn = options.fetchMintRisk ?? fetchSwapMintRisk;

        const txs = await fetchTxsFn(apiKey, wallet);
        const prices = await fetchPricesFn(txs);
        const mintRisk = await fetchMintRiskFn(txs, { apiKey });
        const baseline: Baseline = updateBaseline(wallet, null, txs, Date.now() / 1000, prices);
        const anomalies = detectAnomalies(wallet, txs, null, undefined, prices, mintRisk);
        const riskScore = computeRiskScore(anomalies);
        const verdict = computeVerdict(riskScore);
        const stamps = txs.map((t) => t.timestamp).filter((n) => typeof n === "number");
        const lastActivity = stamps.length > 0 ? Math.max(...stamps) : null;
        const windowStart = stamps.length > 0 ? Math.min(...stamps) : null;

        const payload: Record<string, unknown> = {
          wallet,
          txCount: txs.length,
          lastSeenAt: baseline.lastSeenAt,
          pnl: baseline.pnl ?? null,
          pricesAvailable: prices !== null,
          priceCount: prices ? Object.keys(prices).length : 0,
          prices,
          riskScore,
          verdict,
          anomalies,
          reasons: anomalyReasons(anomalies),
          summary: anomalySummary(anomalies),
          digest: digestAnomalies(anomalies),
          freshness: buildFreshness(lastActivity, Math.floor(Date.now() / 1000), windowStart, lastActivity),
        };

        const isOracleEnabled =
          options.enableOracle ??
          (process.env.RADAR_ORACLE === "1" || options.oracleClient !== undefined);

        if (isOracleEnabled) {
          try {
            const commitFn = options.commitScanFn ?? commitScan;
            const topRules = Array.from(new Set(anomalies.map((a) => a.type)));
            const txSignatures = txs.map((t) => t.signature).filter(Boolean).slice(0, 10);
            const commitRes = await commitFn(
              {
                wallet,
                riskScore,
                verdict,
                timestamp: Math.floor(Date.now() / 1000),
                topRules,
                txSignatures,
              },
              { client: options.oracleClient },
            );
            if (commitRes.signature) {
              payload.onchainLedgerSig = commitRes.signature;
            }
            payload.oracle = commitRes;
          } catch (err) {
            if (process.env.RADAR_DEBUG === "1") {
              console.error("[mcp] radar_scan oracle commit failed:", err);
            }
          }
        }

        return json(payload);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Scan failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "radar_analyze",
    {
      description:
        "Runs the 8 deterministic anomaly rules over a JSON array of enhanced transactions without any network calls. Use when the agent already has the transaction data (e.g. from a Helius call). Returns riskScore (0-100), anomalies with evidence, per-rule reasons, a one-line summary, and a digest.",
      inputSchema: {
        wallet: z.string().describe("Solana wallet address (base58)"),
        txs: z
          .string()
          .describe('JSON array of transactions: [{"signature","timestamp","source?","programs?","swap?"}] (Helius enhanced-transaction subset)'),
      },
    },
    async ({ wallet, txs }) => {
      let parsed: EnhancedTx[];
      try {
        parsed = JSON.parse(txs) as EnhancedTx[];
        if (!Array.isArray(parsed)) throw new Error("not an array");
      } catch {
        return {
          content: [{ type: "text", text: "Invalid txs: expected a JSON array of transaction objects." }],
          isError: true,
        };
      }
      const anomalies = detectAnomalies(wallet, parsed, null);
      return json({ wallet, txCount: parsed.length, riskScore: computeRiskScore(anomalies), anomalies, reasons: anomalyReasons(anomalies), summary: anomalySummary(anomalies), digest: digestAnomalies(anomalies) });
    }
  );

  server.registerTool(
    "radar_trust",
    {
      description:
        "Pre-flight trust check for agent payments (x402 / agent-to-agent): combines Wallet Radar's behavioral risk score (8 deterministic rules over the recent window) with the wallet's payment capacity (SOL + USDC/USDT liquidity in USD) into one verdict — safe, hold, or unknown. Deterministic, no LLM in the verdict path; every verdict comes with machine-readable verdict reasons, a per-rule anomaly breakdown, a one-line summary, and data freshness. Use before paying or trusting an unverified counterparty wallet.",
      inputSchema: {
        wallet: z.string().describe("Solana wallet address (base58)"),
        maxRisk: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Max acceptable risk score (default 30)"),
        minLiquidityUsd: z
          .number()
          .min(0)
          .optional()
          .describe("Minimum acceptable liquidity in USD (default 50)"),
        windowDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Behavioral risk window in days (default 7)"),
      },
    },
    async ({ wallet, maxRisk, minLiquidityUsd, windowDays }) => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "HELIUS_API_KEY is not set. Configure it in the server env." }],
          isError: true,
        };
      }
      try {
        const result = await runTrustCheck(apiKey, wallet, { maxRisk, minLiquidityUsd, windowDays });
        return json(result);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Trust check failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "radar_batch",
    {
      description:
        "Batch pre-flight trust-gate over a set of Solana wallets (up to 20): runs the behavioral risk + payment-capacity trust check on each and returns a deterministic shortlist — which wallets are safe to copy/deal with right now (ranked by risk, then liquidity), plus the hold and unknown buckets. Use to gate an entire copy-trading book in one call. Requires HELIUS_API_KEY.",
      inputSchema: {
        wallets: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("Solana wallet addresses (base58), up to 20"),
        maxRisk: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Max acceptable risk score (default 30)"),
        minLiquidityUsd: z
          .number()
          .min(0)
          .optional()
          .describe("Minimum acceptable liquidity in USD (default 50)"),
        windowDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Behavioral risk window in days (default 7)"),
      },
    },
    async ({ wallets, maxRisk, minLiquidityUsd, windowDays }) => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "HELIUS_API_KEY is not set. Configure it in the server env." }],
          isError: true,
        };
      }
      try {
        const results = await runTrustChecks(apiKey, wallets, { maxRisk, minLiquidityUsd, windowDays });
        return json(buildShortlist(results));
      } catch (err) {
        return {
          content: [{ type: "text", text: `Batch trust check failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "radar_simulate",
    {
      description:
        "Pre-trade what-if simulation: 'if I send X USDC/SOL to wallet Y, what happens?' Runs the full trust check against the target wallet, then models the proposed payment's impact: does it exceed liquidity, trigger a LARGE_SWAP anomaly, raise the risk score? Returns an actionable decision (allow/throttle/block/manual_review) with a specific recommendation. The agent asks BEFORE signing, not after funds are in motion. Requires HELIUS_API_KEY.",
      inputSchema: {
        wallet: z.string().describe("Target Solana wallet address (base58)"),
        amountUsd: z.number().positive().describe("Proposed payment amount in USD"),
        token: z.enum(["usdc", "sol"]).optional().describe("Payment token (default: usdc)"),
        balances: z
          .object({
            sol: z.number().min(0).optional(),
            usdc: z.number().min(0).optional(),
            usdt: z.number().min(0).optional(),
          })
          .describe("Known balances of the target wallet: { sol, usdc, usdt }"),
        maxRisk: z.number().int().min(0).max(100).optional().describe("Max acceptable risk score (default 30)"),
        minLiquidityUsd: z.number().min(0).optional().describe("Minimum acceptable liquidity in USD (default 50)"),
      },
    },
    async ({ wallet, amountUsd, token, balances, maxRisk, minLiquidityUsd }) => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "HELIUS_API_KEY is not set. Configure it in the server env." }],
          isError: true,
        };
      }
      try {
        const trustResult = await runTrustCheck(apiKey, wallet, { maxRisk, minLiquidityUsd });
        const result = simulatePayment({
          wallet,
          amountUsd,
          token: token ?? "usdc",
          balances: {
            sol: balances?.sol ?? 0,
            usdc: balances?.usdc ?? 0,
            usdt: balances?.usdt ?? 0,
          },
          solPrice: trustResult.solPrice,
          riskScore: trustResult.riskScore,
          anomalies: trustResult.anomalies,
          medianSwapAmountUsd: trustResult.medianSwapAmountUsd,
          legacyVerdict: trustResult.verdict,
          maxRisk,
          minLiquidityUsd,
        });
        return json(result);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Simulation failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "radar_selftest",
    {
      description:
        "Offline smoke test: runs the anomaly rules over a built-in 2-transaction fixture. No network, no API keys. Use to verify the server is healthy before a real scan.",
      inputSchema: z.object({}),
    },
    async () => {
      const wallet = "DemoWallet11111111111111111111111111111111";
      const txs: EnhancedTx[] = [
        { signature: "sigA", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
        { signature: "sigB", timestamp: 1_700_000_120, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
      ];
      const anomalies = detectAnomalies(wallet, txs, null);
      return json({ ok: true, riskScore: computeRiskScore(anomalies), anomalies, reasons: anomalyReasons(anomalies), summary: anomalySummary(anomalies) });
    }
  );

  server.registerTool(
    "radar_benchmark",
    {
      description:
        "Reproducible quality proof: runs a versioned eval set of labeled test cases (safe + risky) through the full detection pipeline and reports precision, recall, accuracy, and per-case results. Deterministic — same eval set + same code = same numbers, every time. No network, no API keys. Use to verify the scanner's quality or to compare before/after changes.",
      inputSchema: z.object({}),
    },
    async () => {
      const { runBenchmark } = await import("./benchmark.js");
      return json(runBenchmark());
    }
  );

  return server;
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectRun) {
  serveStdio(() => buildServer());
}
