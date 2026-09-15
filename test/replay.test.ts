import test from "node:test";
import assert from "node:assert/strict";
import { splitTxs, buildReplay, replayWallet, parseTime } from "../src/replay.js";
import { SOL_MINT, USDC_MINT } from "../src/analyzer.js";
import { HistoryQuery } from "../src/collector.js";
import { AlertSink } from "../src/alerts.js";
import { EnhancedTx } from "../src/types.js";

const WALLET = "DemoWhale111111111111111111111111111111111";

function swapTx(sig: string, ts: number, source: string, solIn: number, usdcOut: number, programs: string[] = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]): EnhancedTx {
  return {
    signature: sig,
    timestamp: ts,
    source,
    programs,
    swap: {
      tokenInputs: [{ mint: SOL_MINT, rawTokenAmount: { tokenAmount: String(Math.round(solIn * 1e9)), decimals: 9 } }],
      tokenOutputs: [{ mint: USDC_MINT, rawTokenAmount: { tokenAmount: String(Math.round(usdcOut * 1e6)), decimals: 6 } }],
    },
  };
}

// A 163-day gap: last "normal" activity, then the awakening.
const T0 = 1_750_000_000;
const GAP = 163 * 86_400;
const HISTORY = [
  swapTx("h1", T0 - 30 * 86_400, "JUPITER", 10, 1000),
  swapTx("h2", T0 - 10 * 86_400, "JUPITER", 12, 1200),
  swapTx("h3", T0, "JUPITER", 10, 1000),
];
// Awakening: one large swap on a NEW venue touching 3 NEW programs.
const BURST = [
  swapTx("b1", T0 + GAP, "OKX_DEX_ROUTER", 39.96, 3996, [
    "OkxProgram111111111111111111111111111111111111",
    "OkxProgram222222222222222222222222222222222222",
    "OkxProgram333333333333333333333333333333333333",
  ]),
];
const PRICES = { [SOL_MINT]: 100 };

test("splitTxs splits at the since boundary, keeps until exclusive, sorts ascending", () => {
  const txs = [
    { signature: "a", timestamp: 100 },
    { signature: "b", timestamp: 200 }, // == since -> burst
    { signature: "c", timestamp: 300 },
    { signature: "d", timestamp: 400 }, // == until -> dropped
    { signature: "e", timestamp: 500 },
  ];
  const { history, burst } = splitTxs(txs, 200, 400);
  assert.deepEqual(history.map((t) => t.signature), ["a"]);
  assert.deepEqual(burst.map((t) => t.signature), ["b", "c"]);
});

test("splitTxs dedupes pagination overlap by signature", () => {
  const txs = [
    { signature: "x", timestamp: 100 },
    { signature: "x", timestamp: 100 },
    { signature: "y", timestamp: 300 },
  ];
  const { history, burst } = splitTxs(txs, 200);
  assert.deepEqual(history.map((t) => t.signature), ["x"]); // duplicate collapsed
  assert.equal(burst.length, 1);
});

test("buildReplay reproduces the dormant-whale case: DORMANT_ACTIVE + LARGE_SWAP + NEW_VENUE + 3x NEW_PROTOCOL + REGIME_SHIFT + WARMING", () => {
  const { baseline, anomalies, riskScore } = buildReplay(WALLET, HISTORY, BURST, PRICES);
  assert.equal(baseline.lastSeenAt, T0);
  assert.ok(Math.abs((baseline.medianSwapAmountUsd ?? 0) - 1000) < 1); // median of [1000, 1200, 1000]
  const types = anomalies.map((a) => a.type).sort();
  assert.deepEqual(types, ["DORMANT_ACTIVE", "LARGE_SWAP", "NEW_PROTOCOL", "NEW_PROTOCOL", "NEW_PROTOCOL", "NEW_VENUE", "REGIME_SHIFT", "WARMING"]);
  assert.equal(riskScore, 100); // 30 + 30 + 30 + 15 + 3x5 + 30 (REGIME_SHIFT high) + 15 (WARMING medium) = 125, capped at 100
  const dormant = anomalies.find((a) => a.type === "DORMANT_ACTIVE");
  assert.equal(dormant?.evidence.daysSilent, 163.0);
});

test("buildReplay: burst without prices falls back to major-only sizing", () => {
  const { riskScore } = buildReplay(WALLET, HISTORY, BURST, null);
  // DORMANT_ACTIVE + NEW_VENUE + 3x NEW_PROTOCOL + LARGE_SWAP (39.96 >= 3*10.67 major) + REGIME_SHIFT + WARMING
  assert.equal(riskScore, 100);
});

test("replayWallet: empty window throws", async () => {
  const fetchHistory = async (_w: string, _q: HistoryQuery) => HISTORY;
  await assert.rejects(
    replayWallet("key", WALLET, { sinceSec: T0 + GAP + 1000 }, { fetchHistory }),
    /no transactions in the replay window/,
  );
});

test("replayWallet: end-to-end with injected fetcher, counts deduped, sink gets the alert", async () => {
  const calls: HistoryQuery[] = [];
  const fetchHistory = async (_w: string, q: HistoryQuery) => {
    calls.push(q);
    return [...HISTORY, ...BURST]; // both sides return everything; splitTxs dedupes
  };
  const sent: string[] = [];
  const sink: AlertSink = { send: async (t) => { sent.push(t); } };
  const result = await replayWallet("key", WALLET, { sinceSec: T0 + GAP, untilSec: T0 + GAP + 600 }, {
    fetchHistory,
    sink,
  });
  assert.equal(result.historyTxCount, 3);
  assert.equal(result.burstTxCount, 1);
  assert.equal(result.riskScore, 100);
  assert.equal(result.pricesAvailable, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].gteTime === T0 + GAP);
  assert.ok(calls[1].ltTime === T0 + GAP);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /risk 100\/100/);
  assert.match(sent[0], /DORMANT_ACTIVE/);
});

test("parseTime accepts unix seconds, ISO 8601, and rejects garbage", () => {
  assert.equal(parseTime("1750000000", "--since"), 1_750_000_000);
  assert.equal(parseTime("2026-03-11T07:36:15Z", "--since"), Math.floor(Date.parse("2026-03-11T07:36:15Z") / 1000));
  assert.throws(() => parseTime("yesterday", "--until"), /unparseable time/);
});
