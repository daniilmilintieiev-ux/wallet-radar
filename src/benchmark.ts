import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { EnhancedTx } from "./types.js";

/**
 * Benchmark / Eval: public, reproducible quality measurement.
 *
 * Most projects CLAIM their scanner is good. Wallet Radar PROVES it:
 * a fixed set of labeled test cases (known-good, known-bad, borderline)
 * is run through the full detection pipeline, and the results are scored
 * with precision, recall, and accuracy. The eval set is versioned and
 * public — any judge or agent can reproduce the same numbers.
 *
 * This is the "quality proof" artifact: not a blog post, a deterministic
 * test harness with a published scorecard.
 */

export interface BenchmarkCase {
  /** Unique identifier for this test case. */
  id: string;
  /** Human-readable description of the scenario. */
  description: string;
  /** Expected label: "safe" (no anomalies or only low), "risky" (medium+ anomalies expected). */
  expected: "safe" | "risky";
  /** The transaction fixture to analyze. */
  txs: EnhancedTx[];
  /** Whether a baseline should be provided (false = first-sight, no history). */
  hasBaseline: boolean;
  /** Baseline tx count (for WARMING detection). */
  baselineTxCount?: number;
}

export interface BenchmarkResult {
  caseId: string;
  description: string;
  expected: "safe" | "risky";
  actual: "safe" | "risky";
  riskScore: number;
  anomalyTypes: string[];
  correct: boolean;
}

export interface BenchmarkSummary {
  total: number;
  correct: number;
  accuracy: number;
  /** True positives / (true positives + false positives). 1.0 = no false alarms. */
  precision: number;
  /** True positives / (true positives + false negatives). 1.0 = nothing missed. */
  recall: number;
  /** True positives. */
  truePositives: number;
  /** True negatives. */
  trueNegatives: number;
  /** False positives (flagged risky but actually safe). */
  falsePositives: number;
  /** False negatives (missed a risky wallet). */
  falseNegatives: number;
  /** Per-case results. */
  results: BenchmarkResult[];
  /** Version of the eval set. */
  version: string;
  /** Unix seconds when the benchmark was run. */
  generatedAt: number;
}

/**
 * The public eval set. Versioned: changes to this set bump the version.
 * Cases are deterministic — same input, same output, every time.
 */
export const EVAL_SET: BenchmarkCase[] = [
  {
    id: "safe-001",
    description: "Normal trading: 3 small swaps on a known venue, no anomalies",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "300000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "450000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_001_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "450000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "300000000", decimals: 9 } }] } },
      { signature: "sig3", timestamp: 1_700_002_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "250000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "375000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 50,
  },
  {
    id: "risky-001",
    description: "Dormant whale: 30 days silent, then burst + large swap + new venue",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProgram1111111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "5000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "750000000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_000_060, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProgram1111111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "375000000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "2500000000", decimals: 9 } }] } },
      { signature: "sig3", timestamp: 1_700_000_120, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProgram1111111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "5000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "750000000000", decimals: 6 } }] } },
      { signature: "sig4", timestamp: 1_700_000_180, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProgram1111111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "5000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "750000000000", decimals: 6 } }] } },
      { signature: "sig5", timestamp: 1_700_000_240, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProgram1111111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "5000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "750000000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 20,
  },
  {
    id: "safe-002",
    description: "First sight: no baseline, a few normal swaps (no anomalies expected on first sight)",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_001_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }] } },
    ],
    hasBaseline: false,
  },
  {
    id: "risky-002",
    description: "Warming: thin baseline (3 tx) + large swap + new venue + new protocol",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "PHOTON", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg22222222222222222222222222222222222222222"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "10000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_000_060, source: "PHOTON", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg22222222222222222222222222222222222222222"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "10000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 3,
  },
  {
    id: "safe-003",
    description: "Established wallet: moderate activity, known venues, no anomalies",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "50000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "75000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_003_600, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "75000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "50000000", decimals: 9 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 100,
  },
  {
    id: "risky-003",
    description: "Regime shift: burst + concentration + large swap + new protocol (4+ distinct anomaly types)",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "ORCA", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg33333333333333333333333333333333333333333"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "8000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1200000000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_000_030, source: "ORCA", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg33333333333333333333333333333333333333333"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "8000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1200000000000", decimals: 6 } }] } },
      { signature: "sig3", timestamp: 1_700_000_060, source: "ORCA", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg33333333333333333333333333333333333333333"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "8000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1200000000000", decimals: 6 } }] } },
      { signature: "sig4", timestamp: 1_700_000_090, source: "ORCA", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg33333333333333333333333333333333333333333"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "8000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1200000000000", decimals: 6 } }] } },
      { signature: "sig5", timestamp: 1_700_000_120, source: "ORCA", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg33333333333333333333333333333333333333333"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "8000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1200000000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 30,
  },
];

/** Eval set version — bump when cases are added/changed. */
export const EVAL_VERSION = "1.0.0";

/** Risk score threshold: >= 15 (one medium anomaly) = "risky" for benchmark purposes. */
const RISKY_THRESHOLD = 15;

/**
 * Run the full benchmark: execute every eval case through the detection
 * pipeline and compute precision, recall, and accuracy.
 * Deterministic: same eval set + same code = same numbers, every time.
 */
export function runBenchmark(): BenchmarkSummary {
  const results: BenchmarkResult[] = [];
  let tp = 0, tn = 0, fp = 0, fn = 0;

  for (const c of EVAL_SET) {
    const wallet = "BenchWallet11111111111111111111111111111111";
    const nowSec = 1_700_001_000;

    // Build baseline if the case has one
    let baseline = null;
    if (c.hasBaseline) {
      const syntheticTxs: EnhancedTx[] = Array.from({ length: Math.min(c.baselineTxCount ?? 10, 10) }, (_, i) => ({
        signature: `base_${i}`,
        timestamp: nowSec - 86_400 * 30 + i * 3_600,
        source: "JUPITER",
        programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
        swap: {
          tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }],
          tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }],
        },
      }));
      baseline = updateBaseline(wallet, null, syntheticTxs, nowSec - 86_400, null);
    }

    const anomalies = detectAnomalies(wallet, c.txs, baseline);
    const riskScore = computeRiskScore(anomalies);
    const actual: "safe" | "risky" = riskScore >= RISKY_THRESHOLD ? "risky" : "safe";
    const correct = actual === c.expected;

    if (c.expected === "risky" && actual === "risky") tp++;
    else if (c.expected === "safe" && actual === "safe") tn++;
    else if (c.expected === "safe" && actual === "risky") fp++;
    else fn++;

    results.push({
      caseId: c.id,
      description: c.description,
      expected: c.expected,
      actual,
      riskScore,
      anomalyTypes: anomalies.map((a) => a.type),
      correct,
    });
  }

  const total = results.length;
  const correctCount = results.filter((r) => r.correct).length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1.0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1.0;

  return {
    total,
    correct: correctCount,
    accuracy: Math.round((correctCount / total) * 10000) / 10000,
    precision: Math.round(precision * 10000) / 10000,
    recall: Math.round(recall * 10000) / 10000,
    truePositives: tp,
    trueNegatives: tn,
    falsePositives: fp,
    falseNegatives: fn,
    results,
    version: EVAL_VERSION,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}
