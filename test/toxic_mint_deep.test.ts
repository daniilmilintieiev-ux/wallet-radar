import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies } from "../src/analyzer.js";
import { KNOWN_SAFE_MINTS } from "../src/mint.js";
import { Baseline, DEFAULT_CONFIG, EnhancedTx, MintRiskMap, SOL_MINT } from "../src/types.js";

test("TOXIC_MINT: verified bluechip tokens (WBTC, WETH, mSOL) never trigger TOXIC_MINT", () => {
  const wallet = "WhaleTrader1111111111111111111111111111111";
  const baseline: Baseline = {
    walletAddress: wallet,
    updatedAt: 1_700_000_000,
    knownVenues: ["ORCA"],
    knownPrograms: [],
    medianSwapAmount: 10,
    medianSwapAmountUsd: 1500,
    medianTps: 0.1,
    activeHours: Array(24).fill(1),
    lastSeenAt: 1_700_000_000,
    txCount: 20,
  };

  const wbtcMint = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
  assert.ok(KNOWN_SAFE_MINTS.has(wbtcMint));

  const swapTx: EnhancedTx = {
    signature: "wbtc_swap_tx",
    timestamp: 1_700_000_100,
    type: "SWAP",
    source: "ORCA",
    tokenTransfers: [
      {
        fromUserAccount: wallet,
        toUserAccount: "OrcaVault111111111111111111111111111111111",
        tokenAmount: 0.5,
        mint: wbtcMint,
      },
      {
        fromUserAccount: "OrcaVault111111111111111111111111111111111",
        toUserAccount: wallet,
        tokenAmount: 200,
        mint: SOL_MINT,
      },
    ],
  };

  // Even if mock metadata reports concentration (e.g. bridge vault holds supply)
  const mockMintRisk: MintRiskMap = {
    [wbtcMint]: {
      mint: wbtcMint,
      mintAuthority: "WormholeBridgeAuthority1111111111111111111111",
      freezeAuthority: null,
      top10Pct: 95,
    },
  };

  const anomalies = detectAnomalies(wallet, [swapTx], baseline, DEFAULT_CONFIG, null, mockMintRisk);
  const toxicMintAnomaly = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.equal(toxicMintAnomaly, undefined, "Verified bluechip WBTC should never be flagged as TOXIC_MINT");
});

test("TOXIC_MINT: pump.fun token with active freeze authority is flagged high severity", () => {
  const wallet = "ScamVictim11111111111111111111111111111111";
  const baseline: Baseline = {
    walletAddress: wallet,
    updatedAt: 1_700_000_000,
    knownVenues: ["PUMP_AMM"],
    knownPrograms: [],
    medianSwapAmount: 1,
    medianSwapAmountUsd: 150,
    medianTps: 0.1,
    activeHours: Array(24).fill(1),
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };

  const pumpMint = "PredatoryRugToken11111111111111111111111pump";

  const swapTx: EnhancedTx = {
    signature: "pump_swap_tx",
    timestamp: 1_700_000_100,
    type: "SWAP",
    source: "PUMP_AMM",
    tokenTransfers: [
      {
        fromUserAccount: wallet,
        toUserAccount: "PumpVault111111111111111111111111111111111",
        tokenAmount: 1,
        mint: SOL_MINT,
      },
      {
        fromUserAccount: "PumpVault111111111111111111111111111111111",
        toUserAccount: wallet,
        tokenAmount: 1_000_000,
        mint: pumpMint,
      },
    ],
  };

  const mockMintRisk: MintRiskMap = {
    [pumpMint]: {
      mint: pumpMint,
      mintAuthority: "Attacker11111111111111111111111111111111111",
      freezeAuthority: "Attacker11111111111111111111111111111111111",
      top10Pct: 88,
      isPumpFun: true,
    },
  };

  const anomalies = detectAnomalies(wallet, [swapTx], baseline, DEFAULT_CONFIG, null, mockMintRisk);
  const toxic = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.ok(toxic !== undefined);
  assert.equal(toxic.severity, "high");
  assert.equal(toxic.evidence.isPumpFun, true);
});
