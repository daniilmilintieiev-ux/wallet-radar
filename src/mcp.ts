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
import { runTrustCheck } from "./trust.js";
import { Baseline, EnhancedTx } from "./types.js";

function json(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "wallet-radar", version: "0.1.0" });

  server.registerTool(
    "radar_scan",
    {
      description:
        "One-shot continuous-monitoring scan of a Solana wallet: fetches recent transactions from Helius (env HELIUS_API_KEY required), fetches USD prices from the Jupiter Price API (keyless; falls back to major-only sizing if the feed is down), updates the behavioral baseline, runs 6 deterministic anomaly rules (LARGE_SWAP is compared in USD when prices are available). Returns riskScore (0-100), anomalies with structured evidence, and a human/LLM-readable digest.",
      inputSchema: {
        wallet: z.string().describe("Solana wallet address (base58)"),
      },
    },
    async ({ wallet }) => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "HELIUS_API_KEY is not set. Configure it in the server env, or use radar_analyze with a transactions fixture." }],
          isError: true,
        };
      }
      try {
        const txs = await fetchWalletTransactions(apiKey, wallet);
        const prices = await fetchSwapPrices(txs);
        const mintRisk = await fetchSwapMintRisk(txs, { apiKey });
        const baseline: Baseline = updateBaseline(wallet, null, txs, Date.now() / 1000, prices);
        const anomalies = detectAnomalies(wallet, txs, null, undefined, prices, mintRisk);
        return json({
          wallet,
          txCount: txs.length,
          lastSeenAt: baseline.lastSeenAt,
          pnl: baseline.pnl ?? null,
          pricesAvailable: prices !== null,
          priceCount: prices ? Object.keys(prices).length : 0,
          prices,
          riskScore: computeRiskScore(anomalies),
          anomalies,
          digest: digestAnomalies(anomalies),
        });
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
        "Runs the 6 anomaly rules over a JSON array of enhanced transactions without any network calls. Use when the agent already has the transaction data (e.g. from a Helius call). Returns riskScore (0-100), anomalies with evidence, and a digest.",
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
      return json({ wallet, txCount: parsed.length, riskScore: computeRiskScore(anomalies), anomalies, digest: digestAnomalies(anomalies) });
    }
  );

  server.registerTool(
    "radar_trust",
    {
      description:
        "Pre-flight trust check for agent payments (x402 / agent-to-agent): combines Wallet Radar's behavioral risk score (6 deterministic rules over the recent window) with the wallet's payment capacity (SOL + USDC/USDT liquidity in USD) into one verdict — safe, hold, or unknown. Deterministic, no LLM in the verdict path; every verdict comes with machine-readable reasons. Use before paying or trusting an unverified counterparty wallet.",
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
      return json({ ok: true, riskScore: computeRiskScore(anomalies), anomalies });
    }
  );

  return server;
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectRun) {
  serveStdio(buildServer);
}
