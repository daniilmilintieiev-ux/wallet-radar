import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectAnomalies,
  computeRiskScore,
  REGIME_MIN_BASELINE_TXS,
  REGIME_MIN_RECENT_TXS,
} from "../src/analyzer.js";
import { Baseline, EnhancedTx, SOL_MINT, USDC_MINT } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLET = "TestRegimeWallet111111111111111111111111111";
const BASE_TS = 1_710_000_000;

function makeTx(
  sig: string,
  ts: number,
  solAmount: number,
  source = "JUPITER",
  programs = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
): EnhancedTx {
  return {
    signature: sig,
    timestamp: ts,
    source,
    programs,
    swap: {
      tokenInputs: [
        {
          mint: SOL_MINT,
          rawTokenAmount: {
            tokenAmount: String(Math.round(solAmount * 1e9)),
            decimals: 9,
          },
        },
      ],
      tokenOutputs: [
        {
          mint: USDC_MINT,
          rawTokenAmount: {
            tokenAmount: String(Math.round(solAmount * 100 * 1e6)),
            decimals: 6,
          },
        },
      ],
    },
  };
}

function makeBaseline(opts: {
  txCount?: number;
  medianSwapAmount?: number;
  knownVenues?: string[];
  knownPrograms?: string[];
  medianTps?: number;
}): Baseline {
  return {
    walletAddress: WALLET,
    updatedAt: BASE_TS,
    knownVenues: opts.knownVenues ?? ["JUPITER"],
    knownPrograms: opts.knownPrograms ?? [
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    ],
    medianSwapAmount: opts.medianSwapAmount ?? 1.0,
    medianTps: opts.medianTps ?? 0,
    activeHours: [12, 13, 14],
    lastSeenAt: BASE_TS,
    txCount: opts.txCount ?? 10,
    recentSwapAmounts: Array.from({ length: opts.txCount ?? 10 }, () => opts.medianSwapAmount ?? 1.0),
  };
}

describe("REGIME_SHIFT (8th deterministic anomaly rule)", () => {
  test("No fire: steady behavior (recent ~= baseline)", () => {
    const baseline = makeBaseline({ txCount: 10, medianSwapAmount: 1.0 });
    const recentTxs: EnhancedTx[] = [
      makeTx("tx1", BASE_TS + 3600, 1.0),
      makeTx("tx2", BASE_TS + 7200, 1.0),
      makeTx("tx3", BASE_TS + 10800, 1.0),
      makeTx("tx4", BASE_TS + 14400, 1.0),
    ];

    const anomalies = detectAnomalies(WALLET, recentTxs, baseline);
    const regime = anomalies.find((a) => a.type === "REGIME_SHIFT");
    assert.equal(regime, undefined, "REGIME_SHIFT should not fire on steady behavior");
  });

  test("No fire: thin history (fewer than min samples)", () => {
    // Baseline has only 3 txs (< REGIME_MIN_BASELINE_TXS = 5)
    const baseline = makeBaseline({ txCount: 3, medianSwapAmount: 1.0 });
    assert.ok(baseline.txCount < REGIME_MIN_BASELINE_TXS);

    // Recent batch has sustained 10x swap sizes, but baseline is thin
    const recentTxs: EnhancedTx[] = [
      makeTx("tx1", BASE_TS + 3600, 10.0),
      makeTx("tx2", BASE_TS + 7200, 10.0),
      makeTx("tx3", BASE_TS + 10800, 10.0),
      makeTx("tx4", BASE_TS + 14400, 10.0),
    ];

    const anomalies = detectAnomalies(WALLET, recentTxs, baseline);
    const regime = anomalies.find((a) => a.type === "REGIME_SHIFT");
    assert.equal(
      regime,
      undefined,
      "REGIME_SHIFT must guard against thin baseline history",
    );
  });

  test("Fire: sustained amount-level shift (recent median >> baseline); reasons[] names the dimension", () => {
    const baseline = makeBaseline({ txCount: 15, medianSwapAmount: 1.0 });
    // 4 swaps with median 10.0 SOL (10x baseline median 1.0 SOL)
    const recentTxs: EnhancedTx[] = [
      makeTx("tx1", BASE_TS + 3600, 10.0),
      makeTx("tx2", BASE_TS + 7200, 10.0),
      makeTx("tx3", BASE_TS + 10800, 10.0),
      makeTx("tx4", BASE_TS + 14400, 10.0),
    ];

    const anomalies = detectAnomalies(WALLET, recentTxs, baseline);
    const regime = anomalies.find((a) => a.type === "REGIME_SHIFT");
    assert.ok(regime, "REGIME_SHIFT should fire on sustained amount-level shift");
    assert.equal(regime.severity, "medium", "Single dimension shift is medium severity");

    const evidence = regime.evidence as {
      reasons: string[];
      dimensions: string[];
    };
    assert.ok(Array.isArray(evidence.reasons), "evidence.reasons must be an array");
    assert.ok(
      evidence.reasons.some((r) => r.includes("amount")),
      `reasons[] must name the amount dimension: ${JSON.stringify(evidence.reasons)}`,
    );
    assert.ok(
      evidence.dimensions.includes("amount"),
      "dimensions must include 'amount'",
    );
  });

  test("Fire (high): two dimensions shift together", () => {
    const baseline = makeBaseline({
      txCount: 15,
      medianSwapAmount: 1.0,
      knownVenues: ["JUPITER"],
    });

    // Both amount shifted (10x) AND venue shifted (100% RAYDIUM, not in baseline)
    const recentTxs: EnhancedTx[] = [
      makeTx("tx1", BASE_TS + 3600, 10.0, "RAYDIUM"),
      makeTx("tx2", BASE_TS + 7200, 10.0, "RAYDIUM"),
      makeTx("tx3", BASE_TS + 10800, 10.0, "RAYDIUM"),
      makeTx("tx4", BASE_TS + 14400, 10.0, "RAYDIUM"),
    ];

    const anomalies = detectAnomalies(WALLET, recentTxs, baseline);
    const regime = anomalies.find((a) => a.type === "REGIME_SHIFT");
    assert.ok(regime, "REGIME_SHIFT should fire");
    assert.equal(
      regime.severity,
      "high",
      "Two dimensions shifting together must produce high severity",
    );

    const evidence = regime.evidence as {
      reasons: string[];
      dimensions: string[];
    };
    assert.ok(evidence.dimensions.includes("amount"));
    assert.ok(evidence.dimensions.includes("venue"));
    assert.ok(evidence.reasons.some((r) => r.includes("amount")));
    assert.ok(evidence.reasons.some((r) => r.includes("venue")));
  });

  test("Distinct from ACTIVITY_BURST: a single huge tx alone does NOT fire REGIME_SHIFT", () => {
    const baseline = makeBaseline({ txCount: 20, medianSwapAmount: 1.0 });

    // Case 1: single huge tx in a 1-tx batch
    const singleHugeTx = [makeTx("huge1", BASE_TS + 3600, 100.0)];
    const anomalies1 = detectAnomalies(WALLET, singleHugeTx, baseline);
    const hasLargeSwap1 = anomalies1.some((a) => a.type === "LARGE_SWAP");
    const hasRegimeShift1 = anomalies1.some((a) => a.type === "REGIME_SHIFT");
    assert.ok(hasLargeSwap1, "LARGE_SWAP should fire on the huge trade");
    assert.equal(
      hasRegimeShift1,
      false,
      "Single huge tx alone must NOT fire REGIME_SHIFT",
    );

    // Case 2: single huge tx embedded within normal-sized trades (not sustained)
    const mixedBatch: EnhancedTx[] = [
      makeTx("t1", BASE_TS + 3600, 1.0),
      makeTx("t2", BASE_TS + 7200, 1.0),
      makeTx("t3", BASE_TS + 10800, 100.0), // one-off spike
    ];
    const anomalies2 = detectAnomalies(WALLET, mixedBatch, baseline);
    const hasLargeSwap2 = anomalies2.some((a) => a.type === "LARGE_SWAP");
    const hasRegimeShift2 = anomalies2.some((a) => a.type === "REGIME_SHIFT");
    assert.ok(hasLargeSwap2, "LARGE_SWAP fires on the single outlier");
    assert.equal(
      hasRegimeShift2,
      false,
      "A single spike with normal median must NOT fire REGIME_SHIFT",
    );
  });

  test("computeRiskScore increases when REGIME_SHIFT fires", () => {
    // Cadence shift with normal swap sizes (no LARGE_SWAP):
    const baseline = makeBaseline({
      txCount: 15,
      medianSwapAmount: 1.0,
      medianTps: 1.0, // baseline interval = 60s
    });
    // 4 small swaps spaced 3s apart (interval = 3s vs baseline 60s, 20x faster)
    // Swap sizes are normal (1.0 SOL == baseline), so LARGE_SWAP does not fire
    const fastTxs: EnhancedTx[] = [
      makeTx("tx1", BASE_TS + 10, 1.0),
      makeTx("tx2", BASE_TS + 13, 1.0),
      makeTx("tx3", BASE_TS + 16, 1.0),
      makeTx("tx4", BASE_TS + 19, 1.0),
    ];

    const anomalies = detectAnomalies(WALLET, fastTxs, baseline);
    const regime = anomalies.find((a) => a.type === "REGIME_SHIFT");
    assert.ok(regime, "REGIME_SHIFT should be present");
    assert.equal(regime.severity, "medium");

    const scoreWith = computeRiskScore(anomalies);
    const scoreWithout = computeRiskScore(
      anomalies.filter((a) => a.type !== "REGIME_SHIFT"),
    );
    assert.ok(
      scoreWith > scoreWithout,
      `Score with REGIME_SHIFT (${scoreWith}) must be greater than without (${scoreWithout})`,
    );
    assert.equal(
      scoreWith - scoreWithout,
      15,
      "Medium severity REGIME_SHIFT must contribute exactly 15 points",
    );
  });

  test("Cadence dimension shift: accelerated inter-activity intervals", () => {
    // Baseline median interval: 1 tx/min = 60s
    const baseline = makeBaseline({
      txCount: 20,
      medianSwapAmount: 1.0,
      medianTps: 1.0,
    });

    // Recent batch has txs every 3 seconds (20x faster than baseline)
    const fastTxs: EnhancedTx[] = [
      makeTx("t1", BASE_TS + 100, 1.0),
      makeTx("t2", BASE_TS + 103, 1.0),
      makeTx("t3", BASE_TS + 106, 1.0),
      makeTx("t4", BASE_TS + 109, 1.0),
    ];

    const anomalies = detectAnomalies(WALLET, fastTxs, baseline);
    const regime = anomalies.find((a) => a.type === "REGIME_SHIFT");
    assert.ok(regime, "REGIME_SHIFT should fire on cadence shift");
    const evidence = regime.evidence as {
      reasons: string[];
      dimensions: string[];
    };
    assert.ok(evidence.dimensions.includes("cadence"));
    assert.ok(evidence.reasons.some((r) => r.includes("cadence")));
  });

  test("Any rule-count text now says 8", () => {
    const rootDir = process.cwd();
    const readme = fs.readFileSync(path.join(rootDir, "README.md"), "utf-8");
    const indexHtml = fs.readFileSync(
      path.join(rootDir, "docs/index.html"),
      "utf-8",
    );
    const httpServer = fs.readFileSync(
      path.join(rootDir, "src/http-server.ts"),
      "utf-8",
    );
    const mcp = fs.readFileSync(path.join(rootDir, "src/mcp.ts"), "utf-8");

    // Check README
    assert.ok(
      readme.includes("8 rules over the recent window"),
      "README must reference 8 rules in trust description",
    );
    assert.ok(
      readme.includes("the 8 behavioral rules"),
      "README must reference 8 behavioral rules in engine list",
    );
    assert.ok(
      readme.includes("analyzer (8 rules"),
      "README must reference 8 rules in status section",
    );
    assert.ok(
      !readme.includes("7 rules over the recent window"),
      "No stale '7 rules' in README trust section",
    );

    // Check docs/index.html
    assert.ok(
      indexHtml.includes("eight deterministic rules"),
      "index.html must reference eight deterministic rules",
    );
    assert.ok(
      indexHtml.includes("<b>8 deterministic rules</b>"),
      "index.html pipeline step must state 8 deterministic rules",
    );

    // Check http-server.ts
    assert.ok(
      httpServer.includes("8 deterministic anomaly rules"),
      "http-server /scan description must reference 8 deterministic anomaly rules",
    );

    // Check mcp.ts
    assert.ok(
      mcp.includes("runs 8 deterministic anomaly rules"),
      "mcp radar_scan must state 8 deterministic anomaly rules",
    );
    assert.ok(
      mcp.includes("Runs the 8 deterministic anomaly rules"),
      "mcp radar_analyze must state 8 deterministic anomaly rules",
    );
    assert.ok(
      mcp.includes("8 deterministic rules over the recent window"),
      "mcp radar_trust must state 8 deterministic rules",
    );
  });
});
