import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline, resolveScoringBaseline } from "./baseline.js";
import { maxOf, minOf } from "./stats.js";
import { digestAnomalies } from "./digest.js";
import { fetchWalletTransactions, ENHANCED_TX_SCHEMA } from "./collector.js";
import { fetchSwapPrices } from "./pricing.js";
import { fetchSwapMintRisk, fetchMintMetadata } from "./mint.js";
import { isValidSolanaAddress } from "./config.js";
import { runTrustCheck, runTrustChecks, buildShortlist } from "./trust.js";
import { anomalyReasons, anomalySummary, buildFreshness } from "./explain.js";
import { simulatePayment } from "./simulate.js";
import { Baseline, EnhancedTx, Anomaly } from "./types.js";
import { Store } from "./store.js";
import { commitScan, ZKOracleClient, ScanLedgerRecord } from "./oracle/index.js";
import { computeVerdict } from "./htmlreport.js";
import { getVersion } from "./version.js";
import { applyDefense, applyDefenseToTrust } from "./http-server.js";

function json(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * All tool names registered in buildServer — single source of truth for the
 * MCP health report (mcp-server.ts getHealth). Keep in sync when registering
 * tools.
 */
export const MCP_TOOL_NAMES = [
  "radar_scan",
  "radar_analyze",
  "radar_trust",
  "radar_batch",
  "radar_simulate",
  "radar_gate_copy",
  "radar_selftest",
  "radar_benchmark",
] as const;

export interface McpServerOptions {
  oracleClient?: ZKOracleClient;
  commitScanFn?: typeof commitScan;
  enableOracle?: boolean;
  store?: Store;
  fetchTxs?: typeof fetchWalletTransactions;
  fetchPrices?: typeof fetchSwapPrices;
  fetchMintRisk?: typeof fetchSwapMintRisk;
  fetchMintMetadata?: typeof fetchMintMetadata;
}

export function buildServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "wallet-radar", version: getVersion() });

  server.registerTool(
    "radar_scan",
    {
      description:
        "One-shot continuous-monitoring scan of a Solana wallet: fetches recent transactions from Helius (env HELIUS_API_KEY required), fetches USD prices from the Jupiter Price API (keyless; falls back to major-only sizing if the feed is down), updates the behavioral baseline, runs 9 behavioral rules plus a funding-source check (TAINTED_FUNDING) and supporting signals (LARGE_SWAP is compared in USD when prices are available). Returns riskScore (0-100), anomalies with structured evidence, per-rule reasons, a one-line summary, a human/LLM-readable digest, and data freshness.",
      inputSchema: {
        wallet: z.string().describe("Solana wallet address (base58)"),
      },
    },
    async ({ wallet }) => {
      if (!isValidSolanaAddress(wallet)) {
        return {
          content: [{ type: "text", text: `Invalid Solana wallet address: "${wallet}". Must be 32-44 base58 characters.` }],
          isError: true,
        };
      }
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
        const prices = await fetchPricesFn(txs, { wallet });
        const mintRisk = await fetchMintRiskFn(txs, { apiKey, wallet });
        const storedBaseline = options.store ? options.store.getBaseline(wallet) : null;
        const baseline: Baseline = updateBaseline(wallet, storedBaseline, txs, Date.now() / 1000, prices);
        if (options.store) options.store.saveBaseline(baseline);
        const scoringBaseline = resolveScoringBaseline(wallet, storedBaseline, txs, prices);
        const anomalies = detectAnomalies(wallet, txs, scoringBaseline, undefined, prices, mintRisk);
        const riskScore = computeRiskScore(anomalies);
        const verdict = computeVerdict(riskScore);
        const stamps = txs.map((t) => t.timestamp).filter((n) => typeof n === "number");
        const lastActivity = stamps.length > 0 ? maxOf(stamps) : null;
        const windowStart = stamps.length > 0 ? minOf(stamps) : null;

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
          ...(prices === null ? { degraded: ["PRICES_UNAVAILABLE"] } : {}),
        };

        if (options.store) {
          applyDefense(options.store, { wallet }, payload);
        }

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
        "Runs 9 behavioral rules plus a funding-source check (TAINTED_FUNDING) and supporting signals over a JSON array of enhanced transactions without any network calls. Use when the agent already has the transaction data (e.g. from a Helius call). Returns riskScore (0-100), anomalies with evidence, per-rule reasons, a one-line summary, and a digest.",
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
      for (let i = 0; i < parsed.length; i++) {
        const res = ENHANCED_TX_SCHEMA.safeParse(parsed[i]);
        if (!res.success) {
          return {
            content: [{ type: "text", text: `Invalid txs[${i}]: expected transaction object with signature (string) and timestamp (number).` }],
            isError: true,
          };
        }
      }
      const storedBaseline = options.store ? options.store.getBaseline(wallet) : null;
      const scoringBaseline = resolveScoringBaseline(wallet, storedBaseline, parsed);
      const anomalies = detectAnomalies(wallet, parsed, scoringBaseline);
      return json({ wallet, txCount: parsed.length, riskScore: computeRiskScore(anomalies), anomalies, reasons: anomalyReasons(anomalies), summary: anomalySummary(anomalies), digest: digestAnomalies(anomalies) });
    }
  );

  server.registerTool(
    "radar_trust",
    {
      description:
        "Pre-flight trust check for agent payments (x402 / agent-to-agent): combines Wallet Radar's behavioral risk score (9 behavioral rules plus a funding-source check (TAINTED_FUNDING) and supporting signals over the recent window) with the wallet's payment capacity (SOL + USDC/USDT liquidity in USD) into one verdict — safe, hold, or unknown. Deterministic, no LLM in the verdict path; every verdict comes with machine-readable verdict reasons, a per-rule anomaly breakdown, a one-line summary, and data freshness. Does not check the token mint; use radar_gate_copy for token checks. Use before paying or trusting an unverified counterparty wallet.",
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
      if (!isValidSolanaAddress(wallet)) {
        return {
          content: [{ type: "text", text: `Invalid Solana wallet address: "${wallet}". Must be 32-44 base58 characters.` }],
          isError: true,
        };
      }
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "HELIUS_API_KEY is not set. Configure it in the server env." }],
          isError: true,
        };
      }
      try {
        let result = await runTrustCheck(apiKey, wallet, { maxRisk, minLiquidityUsd, windowDays });
        if (options.store) {
          result = applyDefenseToTrust(options.store, result);
        }
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
        "Batch pre-flight trust-gate over a set of Solana wallets (up to 20): runs the behavioral risk + payment-capacity trust check on each and returns a deterministic shortlist — which wallets are safe to copy/deal with right now (ranked by risk, then liquidity), plus the hold and unknown buckets. Does not check the token mint; use radar_gate_copy for token checks. Use to gate an entire copy-trading book in one call. Requires HELIUS_API_KEY.",
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
      for (const w of wallets) {
        if (!isValidSolanaAddress(w)) {
          return {
            content: [{ type: "text", text: `Invalid Solana wallet address in batch: "${w}". Must be 32-44 base58 characters.` }],
            isError: true,
          };
        }
      }
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
        "Pre-trade what-if simulation: 'if wallet Y pays out X USDC/SOL, what happens to Y?' The wallet under analysis is the PAYER (the outgoing payment reduces its liquidity). Runs the full trust check against the wallet, then models the outgoing payment's impact: does it exceed liquidity, count as a large payment relative to the wallet's median swap, drain liquidity, raise the risk score? Returns an actionable decision (allow/throttle/block/manual_review) with a specific recommendation. The agent asks BEFORE signing, not after funds are in motion. Requires HELIUS_API_KEY.",
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
    "radar_gate_copy",
    {
      description:
        "Pre-trade copy-trading firewall: gates a proposed copy-trade, swap, or payment before execution. Evaluates behavioral risk against the wallet's history. When both an amount and a specific token mint are supplied, additionally checks that mint's freeze authority and top-10-holder concentration (not mint authority) before allowing execution. Returns an immediate ALLOW, THROTTLE, or BLOCK verdict.",
      inputSchema: {
        targetWallet: z.string().describe("Target trader or counterparty Solana wallet address (base58)"),
        copyAmountUsd: z.number().positive().optional().describe("Proposed trade or copy amount in USD (e.g. 50)"),
        mint: z.string().optional().describe("Optional SPL token mint being acquired (checks freeze/mint authority)"),
        maxRisk: z.number().int().min(0).max(100).optional().describe("Max acceptable risk score 0-100 (default 30)"),
        minLiquidityUsd: z.number().min(0).optional().describe("Minimum acceptable liquidity in USD (default 50)"),
      },
    },
    async ({ targetWallet, copyAmountUsd, mint, maxRisk, minLiquidityUsd }) => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "HELIUS_API_KEY is not set. Configure it in the server env." }],
          isError: true,
        };
      }
      try {
        const trustResult = await runTrustCheck(apiKey, targetWallet, { maxRisk, minLiquidityUsd });
        if (trustResult.verdict === "hold") {
          const reasonsStr = trustResult.reasons?.length > 0 ? trustResult.reasons.join("; ") : "Risk or liquidity thresholds exceeded";
          return json({
            allow: false,
            reason: `BLOCKED by pre-trade firewall: ${reasonsStr}`,
            action: "block",
            tokenCheck: "skipped_base_verdict",
            riskScore: trustResult.riskScore,
            maxSafeAmountUsd: 0,
            executionTier: "blocked",
            degraded: trustResult.degraded,
            details: { trust: trustResult },
          });
        }
        if (trustResult.verdict === "unknown") {
          return json({
            allow: false,
            reason: "HOLD: insufficient historical data or unverified balance to establish trust baseline",
            action: "manual_review",
            tokenCheck: "skipped_base_verdict",
            riskScore: trustResult.riskScore,
            maxSafeAmountUsd: 0,
            degraded: trustResult.degraded,
            details: { trust: trustResult },
          });
        }

        const hasMint = Boolean(mint && isValidSolanaAddress(mint));
        const hasAmount = copyAmountUsd !== undefined && copyAmountUsd > 0;
        let tokenCheck: "applied" | "skipped_no_mint" | "skipped_no_amount" | "unavailable" = !hasMint
          ? "skipped_no_mint"
          : !hasAmount
          ? "skipped_no_amount"
          : "applied";
        let tokenCheckAnomaly: Anomaly | null = null;

        let simRes: any;
        if (hasAmount) {
          let mintRisk = null;
          if (hasMint) {
            try {
              const fetchMintMetadataFn = options.fetchMintMetadata ?? fetchMintMetadata;
              mintRisk = await fetchMintMetadataFn(mint!, { apiKey, store: options.store });
              if (mintRisk === null) {
                throw new Error("mint metadata unavailable (DAS and RPC fallback both failed, or no RPC endpoint configured)");
              }
            } catch (err) {
              tokenCheck = "unavailable";
              tokenCheckAnomaly = {
                type: "TOKEN_CHECK_UNAVAILABLE",
                wallet: targetWallet,
                severity: "low",
                timestamp: Math.floor(Date.now() / 1000),
                evidence: { mint, error: err instanceof Error ? err.message : String(err) },
                text: `Token mint check for ${mint} was unavailable: ${err instanceof Error ? err.message : String(err)}.`,
              };
            }
          }
          simRes = simulatePayment({
            wallet: targetWallet,
            amountUsd: copyAmountUsd!,
            balances: trustResult.balances ?? { sol: 0, usdc: 0, usdt: 0 },
            solPrice: trustResult.solPrice,
            riskScore: trustResult.riskScore,
            anomalies: trustResult.anomalies,
            medianSwapAmountUsd: trustResult.medianSwapAmountUsd,
            legacyVerdict: trustResult.verdict,
            maxRisk,
            minLiquidityUsd,
            mint,
            mintRisk,
          });

          const simAction = (simRes.decision as any)?.action ?? (simRes.decision as any)?.verdict;
          const isBlocked = simAction === "block" || simRes.executionTier === "blocked" || (simRes.wouldTrigger && simRes.wouldTrigger.includes("TOXIC_MINT"));
          const isThrottled = !isBlocked && (simAction === "throttle" || simRes.executionTier === "guarded");
          // B2: never more permissive than manual_review when the mint could
          // not be checked at all for a real USD amount.
          const detailsWithAnomaly = () => ({ trust: trustResult, simulation: simRes, ...(tokenCheckAnomaly ? { tokenCheckAnomaly } : {}) });

          if (isBlocked) {
            return json({
              allow: false,
              reason: simRes.recommendation || `BLOCKED: simulated payment exceeds risk capacity (${(simRes.decision as any)?.reasons?.join("; ") || "unacceptable risk"})`,
              action: "block",
              tokenCheck,
              riskScore: simRes.projectedRiskScore ?? trustResult.riskScore,
              maxSafeAmountUsd: 0,
              executionTier: "blocked",
              slippageToleranceBps: 0,
              cooldownSec: simRes.suggestedCooldownSec ?? (simRes.decision?.recommendedDelaySec ?? 300),
              degraded: trustResult.degraded,
              details: detailsWithAnomaly(),
            });
          }

          if (tokenCheck === "unavailable") {
            return json({
              allow: false,
              reason: `MANUAL_REVIEW: token mint check unavailable (mint metadata fetch failed) -- cannot verify ${mint} is safe for a $${copyAmountUsd} payment.`,
              action: "manual_review",
              tokenCheck,
              riskScore: simRes.projectedRiskScore ?? trustResult.riskScore,
              maxSafeAmountUsd: 0,
              executionTier: simRes.executionTier ?? "standard",
              slippageToleranceBps: simRes.slippageToleranceBps ?? 50,
              cooldownSec: simRes.suggestedCooldownSec ?? 60,
              degraded: trustResult.degraded,
              details: detailsWithAnomaly(),
            });
          }

          if (isThrottled) {
            const maxSafe = (simRes.decision as any)?.suggestedLimitUsd ?? (simRes.decision as any)?.maxPaymentUsd ?? simRes.tieredLimits?.guarded?.maxAmountUsd ?? simRes.tieredLimits?.standard?.maxAmountUsd ?? copyAmountUsd;
            return json({
              allow: true,
              reason: `THROTTLED: ${simRes.recommendation || "payment permitted up to tiered limit"}`,
              action: "throttle",
              tokenCheck,
              riskScore: simRes.projectedRiskScore ?? trustResult.riskScore,
              maxSafeAmountUsd: maxSafe,
              executionTier: simRes.executionTier ?? "guarded",
              slippageToleranceBps: simRes.slippageToleranceBps ?? 50,
              cooldownSec: simRes.suggestedCooldownSec ?? ((simRes.decision as any)?.recommendedDelaySec ?? 60),
              degraded: trustResult.degraded,
              details: { trust: trustResult, simulation: simRes },
            });
          }

          if (!simRes.safeToExecute) {
            return json({
              allow: false,
              reason: simRes.recommendation || `HOLD: simulated payment cannot be safely executed as requested`,
              action: "manual_review",
              tokenCheck,
              riskScore: simRes.projectedRiskScore ?? trustResult.riskScore,
              maxSafeAmountUsd: (simRes.decision as any)?.suggestedLimitUsd ?? (simRes.decision as any)?.maxPaymentUsd ?? 0,
              executionTier: simRes.executionTier ?? "standard",
              slippageToleranceBps: simRes.slippageToleranceBps ?? 50,
              cooldownSec: simRes.suggestedCooldownSec ?? 60,
              degraded: trustResult.degraded,
              details: { trust: trustResult, simulation: simRes },
            });
          }
        }

        const safeMax = copyAmountUsd ?? (simRes?.tieredLimits?.standard?.maxAmountUsd ?? (trustResult.liquidityUsd > 0 ? Math.round(trustResult.liquidityUsd * 0.2 * 100) / 100 : 100));
        return json({
          allow: true,
          reason: `VERIFIED_SAFE: risk ${trustResult.riskScore ?? 0} <= ${maxRisk ?? 30}, liquidity $${trustResult.liquidityUsd} >= $${minLiquidityUsd ?? 50}${simRes?.executionTier ? ` (Tier: ${simRes.executionTier.toUpperCase()})` : ""}`,
          action: "allow",
          tokenCheck,
          riskScore: trustResult.riskScore,
          maxSafeAmountUsd: safeMax,
          executionTier: simRes?.executionTier ?? "instant",
          slippageToleranceBps: simRes?.slippageToleranceBps ?? 100,
          cooldownSec: simRes?.suggestedCooldownSec ?? 0,
          degraded: trustResult.degraded,
              details: { trust: trustResult, simulation: simRes },
        });
      } catch (err) {
        return {
          content: [{ type: "text", text: `Gate copy failed: ${err instanceof Error ? err.message : String(err)}` }],
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
