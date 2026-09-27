import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, computeRiskScore } from "../src/analyzer.js";
import { updateBaseline } from "../src/baseline.js";
import {
  foldCounterparties,
  detectCounterpartyAnomalies,
  COUNTERPARTY_MEMORY_CAP,
  isProtocolInfrastructure,
  KNOWN_PROTOCOL_INFRASTRUCTURE,
} from "../src/counterparty.js";
import { EnhancedTx, Baseline, CounterpartyMemory, USDC_MINT, SOL_MINT } from "../src/types.js";

const WALLET = "DemoWallet11111111111111111111111111111111";

/** A tx that interacts with the given counterparties (explicit form). */
function cpTx(sig: string, ts: number, cps: string[]): EnhancedTx {
  return { signature: sig, timestamp: ts, source: "JUPITER", counterparties: cps };
}

/** A USDC-output swap that also names one counterparty (for volumeUsd attribution). */
function usdcSwapTx(sig: string, ts: number, usdcAmount: number, cp: string): EnhancedTx {
  return {
    signature: sig,
    timestamp: ts,
    source: "JUPITER",
    counterparties: [cp],
    swap: {
      tokenInputs: [{ mint: "SOL", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }],
      tokenOutputs: [
        { mint: USDC_MINT, rawTokenAmount: { tokenAmount: String(usdcAmount * 1e6), decimals: 6 } },
      ],
    },
  };
}

/** A balanced memory: `n` distinct counterparties, each with `per` interactions. */
function memory(n: number, per: number, startTs = 1_000_000): CounterpartyMemory {
  const entries = Array.from({ length: n }, (_, i) => ({
    address: `cp${i}`,
    count: per,
    volumeUsd: 0,
    firstSeen: startTs,
    lastSeen: startTs,
  }));
  return { total: n * per, entries };
}

// --- foldCounterparties ---

test("fold: null prev + no txs -> empty memory", () => {
  const m = foldCounterparties(null, [], 1_000);
  assert.equal(m.total, 0);
  assert.deepEqual(m.entries, []);
});

test("fold: accumulates per-counterparty count and first/last seen", () => {
  const txs = [cpTx("a", 100, ["cpA"]), cpTx("b", 200, ["cpA", "cpB"])];
  const m = foldCounterparties(null, txs, 300);
  assert.equal(m.total, 3);
  const a = m.entries.find((e) => e.address === "cpA");
  const b = m.entries.find((e) => e.address === "cpB");
  assert.equal(a?.count, 2);
  assert.equal(a?.firstSeen, 100);
  assert.equal(a?.lastSeen, 200);
  assert.equal(b?.count, 1);
  assert.equal(b?.firstSeen, 200);
});

test("fold: merges with prev memory (cumulative count + total)", () => {
  const prev: CounterpartyMemory = {
    total: 5,
    entries: [{ address: "cpA", count: 3, volumeUsd: 0, firstSeen: 1, lastSeen: 2 }],
  };
  const txs = [cpTx("x", 10, ["cpA"]), cpTx("y", 11, ["cpC"])];
  const m = foldCounterparties(prev, txs, 20);
  assert.equal(m.total, 7);
  assert.equal(m.entries.find((e) => e.address === "cpA")?.count, 4);
  assert.equal(m.entries.find((e) => e.address === "cpC")?.count, 1);
});

test("fold: caps entries at CAP but preserves the lifetime total", () => {
  const txs = Array.from({ length: COUNTERPARTY_MEMORY_CAP + 6 }, (_, i) =>
    cpTx("s" + i, 100 + i, [`cp${i}`]),
  );
  const m = foldCounterparties(null, txs, 200);
  assert.equal(m.total, COUNTERPARTY_MEMORY_CAP + 6);
  assert.equal(m.entries.length, COUNTERPARTY_MEMORY_CAP);
});

test("fold: attributes stablecoin swap USD volume to the counterparty", () => {
  const txs = [usdcSwapTx("u1", 100, 5000, "cpA")];
  const m = foldCounterparties(null, txs, 200, {});
  assert.equal(m.entries.find((e) => e.address === "cpA")?.volumeUsd, 5000);
});

test("fold: direct (non-swap) token + native transfers build up volumeUsd (audit 3.6)", () => {
  const txs: EnhancedTx[] = [
    // 500 USDC sent to cpA (UI units, USDC priced at 1)
    {
      signature: "t1",
      timestamp: 100,
      type: "TRANSFER",
      tokenTransfers: [
        { fromUserAccount: WALLET, toUserAccount: "cpA", tokenAmount: 500, mint: USDC_MINT },
      ],
    },
    // 2 SOL sent to cpB (lamports, SOL priced at 100)
    {
      signature: "t2",
      timestamp: 200,
      type: "TRANSFER",
      nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: "cpB", amount: 2e9 }],
    },
  ];
  const prices = { [USDC_MINT]: 1, [SOL_MINT]: 100 };
  const m = foldCounterparties(null, txs, 300, prices, WALLET);
  assert.equal(m.entries.find((e) => e.address === "cpA")?.volumeUsd, 500);
  assert.equal(m.entries.find((e) => e.address === "cpB")?.volumeUsd, 200);
});

test("fold: incoming direct transfer is also attributed to the sending counterparty (audit 3.6)", () => {
  // cpA SENDS 250 USDC to the wallet — the counterparty is still cpA.
  const txs: EnhancedTx[] = [
    {
      signature: "t1",
      timestamp: 100,
      type: "TRANSFER",
      tokenTransfers: [
        { fromUserAccount: "cpA", toUserAccount: WALLET, tokenAmount: 250, mint: USDC_MINT },
      ],
    },
  ];
  const m = foldCounterparties(null, txs, 200, { [USDC_MINT]: 1 }, WALLET);
  assert.equal(m.entries.find((e) => e.address === "cpA")?.volumeUsd, 250);
});

test("updateBaseline folds counterparty memory into the baseline", () => {
  const txs = [
    cpTx("a", 1_700_000_000, ["cpX", "cpY"]),
    cpTx("b", 1_700_000_300, ["cpX"]),
  ];
  const b = updateBaseline(WALLET, null, txs);
  assert.equal(b.counterparties?.total, 3);
  assert.equal(b.counterparties?.entries.find((e) => e.address === "cpX")?.count, 2);
});

// --- detectCounterpartyAnomalies ---

test("detect: no anomalies on an empty batch", () => {
  assert.deepEqual(detectCounterpartyAnomalies(WALLET, [], memory(5, 2)), []);
});

test("detect: deterministic (same input -> same output)", () => {
  const txs = [cpTx("a", 100, ["cpNew"]), cpTx("b", 101, ["cpX"])];
  const m = memory(3, 1);
  assert.deepEqual(
    detectCounterpartyAnomalies(WALLET, txs, m),
    detectCounterpartyAnomalies(WALLET, txs, m),
  );
});

test("NEW_COUNTERPARTY: no fire on a wallet with no established relationships", () => {
  const txs = [cpTx("a", 100, ["cpX"]), cpTx("b", 101, ["cpY"])];
  assert.equal(detectCounterpartyAnomalies(WALLET, txs, null).some((a) => a.type === "NEW_COUNTERPARTY"), false);
});

test("NEW_COUNTERPARTY: fires when an established wallet meets a new counterparty", () => {
  const txs = [cpTx("a", 100, ["cpNew"]), cpTx("b", 101, ["cp0"])];
  const nc = detectCounterpartyAnomalies(WALLET, txs, memory(3, 1)).filter(
    (a) => a.type === "NEW_COUNTERPARTY",
  );
  assert.equal(nc.length, 1);
  assert.equal(nc[0].evidence.counterparty, "cpNew");
});

test("NEW_COUNTERPARTY: emission is capped", () => {
  // 3 known (cp0..cp2); the batch introduces 5 brand-new counterparties -> cap at 3.
  const txs = ["n0", "n1", "n2", "n3", "n4"].map((cp, i) => cpTx("s" + i, 100 + i, [cp]));
  assert.equal(
    detectCounterpartyAnomalies(WALLET, txs, memory(3, 1)).filter(
      (a) => a.type === "NEW_COUNTERPARTY",
    ).length,
    3,
  );
});

test("COUNTERPARTY_HUB: no fire below the cumulative-interaction floor", () => {
  const txs = Array.from({ length: 6 }, (_, i) => cpTx("s" + i, 100 + i, ["cpA"]));
  assert.equal(detectCounterpartyAnomalies(WALLET, txs, null).some((a) => a.type === "COUNTERPARTY_HUB"), false);
});

test("COUNTERPARTY_HUB: fires when one counterparty dominates lifetime flow", () => {
  // History: cpA 10, cpB 2 (total 12). Batch adds cpA -> cpA ~85% of 13.
  const prev: CounterpartyMemory = {
    total: 12,
    entries: [
      { address: "cpA", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 2 },
      { address: "cpB", count: 2, volumeUsd: 0, firstSeen: 1, lastSeen: 2 },
    ],
  };
  const hub = detectCounterpartyAnomalies(WALLET, [cpTx("s", 100, ["cpA"])], prev).find(
    (a) => a.type === "COUNTERPARTY_HUB",
  );
  assert.ok(hub);
  assert.equal(hub.evidence.counterparty, "cpA");
});

test("COUNTERPARTY_HUB: no fire when flow is balanced across counterparties", () => {
  // 3 balanced counterparties; the batch touches a known one -> top ~40%, under the hub line.
  const txs = [cpTx("s", 100, ["cp0"])];
  assert.equal(detectCounterpartyAnomalies(WALLET, txs, memory(3, 3)).some((a) => a.type === "COUNTERPARTY_HUB"), false);
});

test("COUNTERPARTY_ESCALATION: no fire when the counterparty's history is too thin", () => {
  // cpA prior = 1 (< ESCALATION_MIN_PRIOR=2); batch has 6 but prior < 2 -> no escalation.
  const prev: CounterpartyMemory = {
    total: 1,
    entries: [{ address: "cpA", count: 1, volumeUsd: 0, firstSeen: 1, lastSeen: 1 }],
  };
  const txs = Array.from({ length: 6 }, (_, i) => cpTx("s" + i, 100 + i, ["cpA"]));
  assert.equal(
    detectCounterpartyAnomalies(WALLET, txs, prev).some((a) => a.type === "COUNTERPARTY_ESCALATION"),
    false,
  );
});

test("COUNTERPARTY_ESCALATION: no fire when the batch does not exceed prior history", () => {
  // cpA prior = 10 (>=2); batch has 5 (>= MIN_BATCH) but 5 < 10 -> no escalation.
  // A balanced 3-way memory keeps the top share under the hub line.
  const prev: CounterpartyMemory = {
    total: 30,
    entries: [
      { address: "cpA", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
      { address: "cpB", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
      { address: "cpC", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
    ],
  };
  const txs = Array.from({ length: 5 }, (_, i) => cpTx("s" + i, 100 + i, ["cpA"]));
  assert.equal(
    detectCounterpartyAnomalies(WALLET, txs, prev).some((a) => a.type === "COUNTERPARTY_ESCALATION"),
    false,
  );
});

test("COUNTERPARTY_ESCALATION: fires when a batch exceeds the counterparty's whole prior history", () => {
  // cp0 prior = 2 (>=2); batch has 6 (>=5) and 6 > 2 -> escalation.
  // A balanced 8-way memory keeps cp0's share under the hub line.
  const txs = Array.from({ length: 6 }, (_, i) => cpTx("s" + i, 100 + i, ["cp0"]));
  const esc = detectCounterpartyAnomalies(WALLET, txs, memory(8, 2)).find(
    (a) => a.type === "COUNTERPARTY_ESCALATION",
  );
  assert.ok(esc);
  assert.equal(esc.evidence.counterparty, "cp0");
});

// --- integration through detectAnomalies / computeRiskScore ---

test("detectAnomalies surfaces counterparty signals from the baseline memory", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
    counterparties: memory(3, 1),
  };
  const txs = [cpTx("new", 1_700_000_600, ["cpBrandNew"])];
  assert.ok(detectAnomalies(WALLET, txs, baseline).some((a) => a.type === "NEW_COUNTERPARTY"));
});

test("computeRiskScore rises when counterparty signals fire", () => {
  // A dominant-hub baseline makes the identical batch score higher than without memory.
  const base: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
  const withMemory: Baseline = {
    ...base,
    counterparties: {
      total: 12,
      entries: [
        { address: "cpA", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
        { address: "cpB", count: 2, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
      ],
    },
  };
  const txs = [cpTx("s", 1_700_000_600, ["cpA"])];
  const scoreWith = computeRiskScore(detectAnomalies(WALLET, txs, withMemory));
  const scoreWithout = computeRiskScore(detectAnomalies(WALLET, txs, base));
  assert.ok(scoreWith > scoreWithout);
});

test("isProtocolInfrastructure: identifies major DEX routers and system accounts", () => {
  // Jupiter v6 router
  assert.equal(isProtocolInfrastructure("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), true);
  // Raydium AMM Auth
  assert.equal(isProtocolInfrastructure("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), true);
  // Meteora DLMM
  assert.equal(isProtocolInfrastructure("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"), true);
  // Orca Whirlpools
  assert.equal(isProtocolInfrastructure("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"), true);
  // Pump.fun
  assert.equal(isProtocolInfrastructure("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), true);
  // System Program
  assert.equal(isProtocolInfrastructure("11111111111111111111111111111111"), true);
  // Normal user wallet is NOT infrastructure
  assert.equal(isProtocolInfrastructure(WALLET), false);
  assert.equal(isProtocolInfrastructure("cpUser1111111111111111111111111111111111"), false);
});

test("foldCounterparties & detectCounterpartyAnomalies: filters out protocol infrastructure", () => {
  const jupRouter = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
  const raydiumAuth = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

  // Batch with both router interactions and real peer interaction
  const txs: EnhancedTx[] = [
    cpTx("t1", 100, [jupRouter, "realPeer111"]),
    cpTx("t2", 101, [raydiumAuth]),
    cpTx("t3", 102, [jupRouter]),
  ];

  const m = foldCounterparties(null, txs, 200);
  // Only realPeer111 should be recorded, router and AMM auth are ignored
  assert.equal(m.entries.length, 1);
  assert.equal(m.entries[0].address, "realPeer111");
  assert.equal(m.entries[0].count, 1);

  // Established memory with 3 known peers
  const establishedMem: CounterpartyMemory = {
    total: 30,
    entries: [
      { address: "peer1", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
      { address: "peer2", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
      { address: "peer3", count: 10, volumeUsd: 0, firstSeen: 1, lastSeen: 1 },
    ],
  };

  // User trades on Jupiter and Raydium — should NOT emit NEW_COUNTERPARTY or COUNTERPARTY_HUB
  const dexTxs: EnhancedTx[] = [
    cpTx("d1", 200, [jupRouter]),
    cpTx("d2", 201, [raydiumAuth]),
    cpTx("d3", 202, [jupRouter]),
  ];
  const anomalies = detectCounterpartyAnomalies(WALLET, dexTxs, establishedMem);
  assert.equal(anomalies.some((a) => a.type === "NEW_COUNTERPARTY"), false);
  assert.equal(anomalies.some((a) => a.type === "COUNTERPARTY_HUB"), false);
});

