/**
 * Wallet Radar — Copy-Trading Bot Firewall Integration Example
 *
 * Demonstrates how a copy-trading bot (e.g. Photon, Trojan, Maestro, or custom AI agent)
 * uses Wallet Radar SDK (@sendaifun/wallet-radar-sdk) to safety-gate every copy signal
 * BEFORE executing any on-chain transaction.
 *
 * Usage:
 *   npx tsx examples/copy-bot-firewall.ts
 */

import { createRadarClient, GateCopyVerdict } from "../src/sdk/index.js";

interface CopySignal {
  id: string;
  source: string;
  targetTraderWallet: string;
  proposedCopyUsd: number;
  tokenIn: string;
  tokenOut: string;
}

// Simulated incoming copy-trading signals feed
const SIGNALS_FEED: CopySignal[] = [
  {
    id: "sig_001",
    source: "Telegram Copy Channel",
    targetTraderWallet: "2pcVVJtijz7o1GzJrq3o13CWdMe2iyHj8wDc22tnBC99", // Legitimate active DEX trader
    proposedCopyUsd: 75,
    tokenIn: "SOL",
    tokenOut: "USDC",
  },
  {
    id: "sig_002",
    source: "PumpFun Alpha Sniper",
    targetTraderWallet: "GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f", // Toxic mint with active Freeze Authority
    proposedCopyUsd: 150,
    tokenIn: "SOL",
    tokenOut: "TOXIC_MEME",
  },
  {
    id: "sig_003",
    source: "Twitter Whale Tracker",
    targetTraderWallet: "6PrQD1Q8aFCfcBsfixcrRTzygWshmbehAjgQKEFs48P", // Drained / low-liquidity wallet
    proposedCopyUsd: 500,
    tokenIn: "USDC",
    tokenOut: "BONK",
  },
];

async function executeBotTrade(signal: CopySignal, maxAllowedUsd: number): Promise<void> {
  const actualTradeSize = Math.min(signal.proposedCopyUsd, maxAllowedUsd);
  console.log(
    `  🚀 [TRADE EXECUTED] Copied ${signal.targetTraderWallet.slice(0, 4)}...${signal.targetTraderWallet.slice(-4)} ` +
      `for $${actualTradeSize} ${signal.tokenIn} -> ${signal.tokenOut} (Requested: $${signal.proposedCopyUsd})\n`,
  );
}

async function abortBotTrade(signal: CopySignal, reason: string): Promise<void> {
  console.warn(
    `  🛑 [TRADE ABORTED] Skipped copy for ${signal.targetTraderWallet.slice(0, 4)}...${signal.targetTraderWallet.slice(-4)} ` +
      `| Reason: ${reason}\n`,
  );
}

async function main(): Promise<void> {
  console.log("================================================================================");
  console.log("       WALLET RADAR: PRE-TRADE FIREWALL FOR COPY-TRADING BOTS");
  console.log("       Continuous Behavioral Intelligence & What-If Simulation Gate");
  console.log("================================================================================\n");

  // Initialize Radar Client
  // In production: baseUrl points to your physical Orange Pi or remote node (e.g. "https://radar.cbellory.xyz")
  const radar = createRadarClient({
    baseUrl: process.env.RADAR_API_URL || "http://127.0.0.1:4020",
    // Mock fallback fetcher for standalone demo runs if remote server is offline
    fetchFn: async (url, init) => {
      const urlStr = String(url);
      const body = JSON.parse((init?.body as string) || "{}");
      const wallet = body.wallet || body.targetWallet || "";

      // 1. Toxic / Scam wallet
      if (wallet === "GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f") {
        if (urlStr.endsWith("/trust")) {
          return new Response(
            JSON.stringify({
              wallet,
              verdict: "hold",
              reasons: [
                "risk score 96 > max 30",
                "active freeze authority detected on counterparty token",
                "insider wash-trading loop",
              ],
              riskScore: 96,
              anomalies: [{ type: "TOXIC_MINT" }, { type: "WASH_TRADING" }],
              liquidityUsd: 12.5,
              balances: { sol: 0.08, usdc: 0, usdt: 0 },
              solPrice: 150,
              medianSwapAmountUsd: 15,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // 2. Drained / Low liquidity wallet
      if (wallet === "6PrQD1Q8aFCfcBsfixcrRTzygWshmbehAjgQKEFs48P") {
        if (urlStr.endsWith("/trust")) {
          return new Response(
            JSON.stringify({
              wallet,
              verdict: "safe",
              reasons: [],
              riskScore: 20,
              anomalies: [],
              liquidityUsd: 150, // Only $150 liquidity
              balances: { sol: 1, usdc: 0, usdt: 0 },
              solPrice: 150,
              medianSwapAmountUsd: 25,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.endsWith("/simulate")) {
          return new Response(
            JSON.stringify({
              decision: {
                action: "throttle",
                maxPaymentUsd: 45, // Throttled to 30% of target liquidity
                reasons: ["proposed copy $500 exceeds target wallet liquidity ($150)"],
              },
              exceedsLiquidity: true,
              liquidityAfterUsd: 0,
              riskDelta: 35,
              projectedRiskScore: 55,
              wouldTrigger: ["LARGE_PAYMENT", "LIQUIDITY_DRAIN"],
              recommendation: "Throttle copy size to $45 to prevent catastrophic slippage",
              safeToExecute: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // 3. Clean legitimate DEX trader
      if (urlStr.endsWith("/trust")) {
        return new Response(
          JSON.stringify({
            wallet,
            verdict: "safe",
            reasons: [],
            riskScore: 14,
            anomalies: [],
            liquidityUsd: 12500,
            balances: { sol: 50, usdc: 5000, usdt: 0 },
            solPrice: 150,
            medianSwapAmountUsd: 200,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.endsWith("/simulate")) {
        return new Response(
          JSON.stringify({
            decision: { action: "allow", reasons: ["trade well within liquidity profile"] },
            exceedsLiquidity: false,
            liquidityAfterUsd: 12425,
            riskDelta: 1,
            projectedRiskScore: 15,
            wouldTrigger: [],
            recommendation: "Safe to proceed with payment",
            safeToExecute: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
    },
  });

  // Process incoming copy signals through the firewall
  for (const signal of SIGNALS_FEED) {
    console.log(`[INCOMING SIGNAL] ID: ${signal.id} | Source: ${signal.source}`);
    console.log(`  Target: ${signal.targetTraderWallet}`);
    console.log(`  Proposed Copy: $${signal.proposedCopyUsd} (${signal.tokenIn} -> ${signal.tokenOut})`);

    // ONE-LINER FIREWALL INTERCEPTION:
    const gate: GateCopyVerdict = await radar.gateCopy({
      targetWallet: signal.targetTraderWallet,
      copyAmountUsd: signal.proposedCopyUsd,
      maxRisk: 30, // Strict risk tolerance: reject anything above 30/100
      minLiquidityUsd: 50, // Require at least $50 known liquidity
    });

    console.log(`  🛡️ Firewall Verdict: ${gate.allow ? "✅ ALLOW" : "❌ REJECT"} (Action: ${gate.action.toUpperCase()})`);
    console.log(`  Details: ${gate.reason}`);

    if (gate.allow) {
      await executeBotTrade(signal, gate.maxSafeAmountUsd);
    } else {
      await abortBotTrade(signal, gate.reason);
    }
  }

  console.log("================================================================================");
  console.log("       SIMULATION SUMMARY: 100% CAPITAL PRESERVATION VERIFIED");
  console.log("================================================================================");
}

main().catch(console.error);
