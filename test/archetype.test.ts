import test from "node:test";
import assert from "node:assert/strict";
import { classifyWalletArchetype, MULTISIG_PROGRAM_IDS, VOTE_PROGRAM_ID } from "../src/archetype.js";
import { EnhancedTx, Baseline } from "../src/types.js";

test("classifyWalletArchetype: identifies validator vote accounts", () => {
  const voteTxs: EnhancedTx[] = Array.from({ length: 10 }, (_, i) => ({
    signature: `vote_sig_${i}`,
    timestamp: 1_700_000_000 + i * 2,
    source: "VOTE_PROGRAM",
    instructions: [{ programId: VOTE_PROGRAM_ID }],
  }));

  const archetype = classifyWalletArchetype("Validator111111111111111111111111111111111", voteTxs);
  assert.equal(archetype, "high_tps_infrastructure");
});

test("classifyWalletArchetype: identifies protocol infrastructure via callback", () => {
  const txs: EnhancedTx[] = [
    { signature: "tx1", timestamp: 1_700_000_000, source: "UNKNOWN" },
  ];
  const isInfra = (addr: string) => addr === "KnownRouter11111111111111111111111111111111";
  const archetype = classifyWalletArchetype("KnownRouter11111111111111111111111111111111", txs, null, isInfra);
  assert.equal(archetype, "high_tps_infrastructure");
});

test("classifyWalletArchetype: identifies DAO multisig vaults (Squads)", () => {
  const squadsTx: EnhancedTx = {
    signature: "squads_sig_1",
    timestamp: 1_700_000_000,
    source: "UNKNOWN",
    instructions: [{ programId: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pcf" }],
  };

  const archetype = classifyWalletArchetype("SquadsVault1111111111111111111111111111111", [squadsTx]);
  assert.equal(archetype, "protocol_vault");
});

test("classifyWalletArchetype: identifies whale DeFi accounts with large median swap", () => {
  const baseline: Baseline = {
    walletAddress: "Whale1111111111111111111111111111111111111",
    updatedAt: 1_700_000_000,
    knownVenues: ["ORCA"],
    knownPrograms: [],
    medianSwapAmount: 250,
    medianSwapAmountUsd: 45_000,
    medianTps: 0.1,
    activeHours: Array(24).fill(1),
    lastSeenAt: 1_700_000_000,
    txCount: 20,
  };

  const archetype = classifyWalletArchetype(baseline.walletAddress, [], baseline);
  assert.equal(archetype, "whale_defi");
});

test("classifyWalletArchetype: defaults normal trader to clean_retail", () => {
  const retailTxs: EnhancedTx[] = [
    {
      signature: "retail_1",
      timestamp: 1_700_000_000,
      source: "JUPITER",
      tokenTransfers: [
        {
          fromUserAccount: "RetailUser11111111111111111111111111111111",
          toUserAccount: "Other1111111111111111111111111111111111111",
          tokenAmount: 1.5,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      ],
    },
  ];

  const archetype = classifyWalletArchetype("RetailUser11111111111111111111111111111111", retailTxs);
  assert.equal(archetype, "clean_retail");
});
