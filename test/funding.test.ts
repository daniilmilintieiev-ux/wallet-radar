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

test("B4: checkFundingSource checks ALL incoming transfers, not just the first -- a clean first transfer followed by a tainted second must still fire", () => {
  const targetWallet = "VictimSecondTx111111111111111111111111111111";
  const cleanFunder = "CleanFriend11111111111111111111111111111111";
  const exploiter = Array.from(KNOWN_EXPLOITERS)[0];

  const txs: EnhancedTx[] = [
    {
      signature: "first_clean_funding_tx",
      timestamp: 1_690_000_000,
      nativeTransfers: [
        { fromUserAccount: cleanFunder, toUserAccount: targetWallet, amount: 1_000_000_000 }, // 1 SOL, clean
      ],
    },
    {
      signature: "second_tainted_funding_tx",
      timestamp: 1_690_001_000,
      nativeTransfers: [
        { fromUserAccount: exploiter, toUserAccount: targetWallet, amount: 250_000_000 }, // 0.25 SOL, from a known exploiter
      ],
    },
  ];

  const anomaly = checkFundingSource(targetWallet, txs);
  assert.ok(anomaly !== null, "the tainted SECOND incoming transfer must still be detected");
  assert.equal(anomaly.type, "TAINTED_FUNDING");
  assert.equal(anomaly.severity, "high");
  assert.equal(anomaly.evidence.funder, exploiter);
  assert.equal(anomaly.evidence.amountSol, 0.25);
  assert.equal(anomaly.evidence.sig, "second_tainted_funding_tx");
  assert.equal(anomaly.timestamp, 1_690_001_000);
});

test("B4: checkFundingSource fires on the EARLIEST tainted transfer when multiple incoming transfers are tainted", () => {
  const targetWallet = "VictimMultiTaint11111111111111111111111111111";
  const exploiters = Array.from(KNOWN_EXPLOITERS);
  const exploiter1 = exploiters[0];
  const exploiter2 = exploiters.length > 1 ? exploiters[1] : exploiters[0];

  const txs: EnhancedTx[] = [
    {
      signature: "first_tainted_tx",
      timestamp: 1_690_000_000,
      nativeTransfers: [{ fromUserAccount: exploiter1, toUserAccount: targetWallet, amount: 500_000_000 }],
    },
    {
      signature: "second_tainted_tx",
      timestamp: 1_690_002_000,
      nativeTransfers: [{ fromUserAccount: exploiter2, toUserAccount: targetWallet, amount: 500_000_000 }],
    },
  ];

  const anomaly = checkFundingSource(targetWallet, txs);
  assert.ok(anomaly !== null);
  assert.equal(anomaly.evidence.sig, "first_tainted_tx", "must report the earliest tainted transfer, not a later one");
  assert.equal(anomaly.timestamp, 1_690_000_000);
});
