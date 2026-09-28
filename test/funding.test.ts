import test from "node:test";
import assert from "node:assert/strict";
import { checkFundingSource, KNOWN_EXPLOITERS } from "../src/analyzer.js";
import { isExistentialThreat } from "../src/defense.js";
import { EnhancedTx } from "../src/types.js";

test("checkFundingSource: detects initial funding from known exploiter", () => {
  const targetWallet = "VictimOrSybil11111111111111111111111111111";
  const exploiter = Array.from(KNOWN_EXPLOITERS)[0];

  const txs: EnhancedTx[] = [
    {
      signature: "initial_funding_tx",
      timestamp: 1_690_000_000,
      nativeTransfers: [
        {
          fromUserAccount: exploiter,
          toUserAccount: targetWallet,
          amount: 500_000_000, // 0.5 SOL
        },
      ],
    },
    {
      signature: "later_tx",
      timestamp: 1_690_001_000,
      nativeTransfers: [],
    },
  ];

  const anomaly = checkFundingSource(targetWallet, txs);
  assert.ok(anomaly !== null);
  assert.equal(anomaly.type, "TAINTED_FUNDING");
  assert.equal(anomaly.severity, "high");
  assert.equal(anomaly.evidence.funder, exploiter);
  assert.equal(anomaly.evidence.amountSol, 0.5);

  // Assert TAINTED_FUNDING is treated as an existential threat
  assert.equal(isExistentialThreat(anomaly), true);
});

test("checkFundingSource: returns null for clean funding", () => {
  const targetWallet = "CleanTrader1111111111111111111111111111111";
  const cleanFunder = "CleanFriend11111111111111111111111111111111";

  const txs: EnhancedTx[] = [
    {
      signature: "clean_funding_tx",
      timestamp: 1_690_000_000,
      nativeTransfers: [
        {
          fromUserAccount: cleanFunder,
          toUserAccount: targetWallet,
          amount: 1_000_000_000, // 1 SOL
        },
      ],
    },
  ];

  const anomaly = checkFundingSource(targetWallet, txs);
  assert.equal(anomaly, null);
});
