import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, MATERIAL_SWAP_FLOOR_USD, MATERIAL_SWAP_FLOOR_SOL, MATERIAL_SWAP_FLOOR_MAJOR_STABLE } from "../src/analyzer.js";
import { Baseline, DEFAULT_CONFIG, EnhancedTx, SOL_MINT, USDC_MINT } from "../src/types.js";

test("materiality floor: swaps below $50 do not trigger LARGE_SWAP even if 5x median", () => {
  const wallet = "MicroTrader1111111111111111111111111111111";
  const baseline: Baseline = {
    walletAddress: wallet,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 0.02,
    medianSwapAmountUsd: 3.0, // Median swap is $3
    medianTps: 0.1,
    activeHours: Array(24).fill(1),
    lastSeenAt: 1_700_000_000,
    txCount: 20,
    recentSwapAmountsUsd: [3.0, 3.0, 3.0],
  };

  // 5x median = $15 (still below $50 floor)
  const swapTx: EnhancedTx = {
    signature: "micro_swap_1",
    timestamp: 1_700_000_100,
    type: "SWAP",
    source: "JUPITER",
    tokenTransfers: [
      {
        fromUserAccount: wallet,
        toUserAccount: "Pool1111111111111111111111111111111111111",
        tokenAmount: 15.0,
        mint: USDC_MINT,
      },
      {
        fromUserAccount: "Pool1111111111111111111111111111111111111",
        toUserAccount: wallet,
        tokenAmount: 0.1,
        mint: SOL_MINT,
      },
    ],
  };

  const prices = { [USDC_MINT]: 1.0, [SOL_MINT]: 150.0 };
  const anomalies = detectAnomalies(wallet, [swapTx], baseline, DEFAULT_CONFIG, prices);
  const largeSwap = anomalies.find((a) => a.type === "LARGE_SWAP");
  assert.equal(largeSwap, undefined, "Swap below $50 materiality floor should not trigger LARGE_SWAP");
});

test("materiality floor: swaps above $50 trigger LARGE_SWAP when >= 3x median", () => {
  const wallet = "NormalTrader1111111111111111111111111111111";
  const baseline: Baseline = {
    walletAddress: wallet,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 0.15,
    medianSwapAmountUsd: 25.0,
    medianTps: 0.1,
    activeHours: Array(24).fill(1),
    lastSeenAt: 1_700_000_000,
    txCount: 20,
    recentSwapAmountsUsd: [25.0, 25.0, 25.0],
  };

  // 4x median = $100 (above $50 floor and above 3x median)
  const swapTx: EnhancedTx = {
    signature: "normal_swap_1",
    timestamp: 1_700_000_100,
    type: "SWAP",
    source: "JUPITER",
    tokenTransfers: [
      {
        fromUserAccount: wallet,
        toUserAccount: "Pool1111111111111111111111111111111111111",
        tokenAmount: 100.0,
        mint: USDC_MINT,
      },
      {
        fromUserAccount: "Pool1111111111111111111111111111111111111",
        toUserAccount: wallet,
        tokenAmount: 0.66,
        mint: SOL_MINT,
      },
    ],
  };

  const prices = { [USDC_MINT]: 1.0, [SOL_MINT]: 150.0 };
  const anomalies = detectAnomalies(wallet, [swapTx], baseline, DEFAULT_CONFIG, prices);
  const largeSwap = anomalies.find((a) => a.type === "LARGE_SWAP");
  assert.ok(largeSwap !== undefined, "Swap above $50 and 3x median should trigger LARGE_SWAP");
  assert.equal(largeSwap.severity, "high");
});
