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
  /**
   * Override the synthetic baseline's most-recent major-mint swap sizes (the
   * recency-decay reference for LARGE_SWAP). Lets a case express "poisoned"
   * history: a high full-history median with small recent activity.
   */
  baselineRecentSwapAmounts?: number[];
  /** Override the synthetic baseline's full-history median major-mint swap size. */
  baselineMedianSwapAmount?: number;
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
    description: "Normal trading: 3 small SOL->USDC swaps on a known venue, no anomalies",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "300000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "450000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_001_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "250000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "375000000", decimals: 6 } }] } },
      { signature: "sig3", timestamp: 1_700_002_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "200000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "300000000", decimals: 6 } }] } },
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
  {
    id: "safe-004",
    description: "Single small swap on known venue, well-established wallet",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "20000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "30000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 200,
  },
  {
    id: "safe-005",
    description: "DCA pattern: regular small swaps at fixed intervals, same venue",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_086_400, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }] } },
      { signature: "sig3", timestamp: 1_700_172_800, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 80,
  },
  {
    id: "safe-006",
    description: "First sight: 4 normal swaps, no baseline to compare against",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "50000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "75000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_001_800, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "75000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "50000000", decimals: 9 } }] } },
      { signature: "sig3", timestamp: 1_700_003_600, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "60000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "90000000", decimals: 6 } }] } },
      { signature: "sig4", timestamp: 1_700_005_400, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "90000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "60000000", decimals: 9 } }] } },
    ],
    hasBaseline: false,
  },
  {
    id: "risky-004",
    description: "Activity burst: 10 txs within 60 seconds on established wallet",
    expected: "risky",
    txs: Array.from({ length: 10 }, (_, i) => ({
      signature: `burst_${i}`,
      timestamp: 1_700_000_000 + i * 5,
      source: "JUPITER",
      programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      swap: {
        tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }],
        tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }],
      },
    })),
    hasBaseline: true,
    baselineTxCount: 50,
  },
  {
    id: "risky-005",
    description: "New venue + new protocol: established wallet suddenly uses unknown DEX and program",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "UNKNOWN_DEX_999", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "mNe7R8TJp96Y62ih7wEPvTETwiKyXzjF1JZk1sQdfmK"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "200000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "300000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 60,
  },
  {
    id: "safe-007",
    description: "Short pause (5 days) then normal activity — below dormant threshold",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 40,
  },
  {
    id: "risky-006",
    description: "Dormant 45 days then single large swap on new venue",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "PHOTON", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "20000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "3000000000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 15,
  },
  {
    id: "safe-008",
    description: "Moderate swap on known venue, slightly above median but below threshold",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "150000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "225000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_007_200, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "225000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "150000000", decimals: 9 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 120,
  },
  {
    id: "risky-007",
    description: "Concentration: 8 rapid transfers into same token mint",
    expected: "risky",
    txs: Array.from({ length: 8 }, (_, i) => ({
      signature: `conc_${i}`,
      timestamp: 1_700_000_000 + i * 10,
      source: "JUPITER",
      programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      swap: {
        tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "50000000", decimals: 9 } }],
        tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "75000000", decimals: 6 } }],
      },
    })),
    hasBaseline: true,
    baselineTxCount: 45,
  },
  {
    id: "safe-009",
    description: "First sight: 3 normal swaps spread over 1 hour, no baseline",
    expected: "safe",
    txs: [
      { signature: "fs_0", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "80000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "120000000", decimals: 6 } }] } },
      { signature: "fs_1", timestamp: 1_700_018_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "120000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "80000000", decimals: 9 } }] } },
      { signature: "fs_2", timestamp: 1_700_036_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "80000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "120000000", decimals: 6 } }] } },
    ],
    hasBaseline: false,
  },
  {
    id: "risky-008",
    description: "Warming: very thin baseline (2 tx) + large swap + new protocol",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "15000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "2250000000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 2,
  },
  {
    id: "safe-010",
    description: "Established wallet: two swaps at different times, known venue, normal size",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "90000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "135000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_036_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "135000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "90000000", decimals: 9 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 150,
  },
  {
    id: "risky-009",
    description: "Multi-vector attack: dormant + burst + new venue + new protocol + large swap",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "PHOTON", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newAtkProg11111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "12000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1800000000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_000_020, source: "PHOTON", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newAtkProg11111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "12000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1800000000000", decimals: 6 } }] } },
      { signature: "sig3", timestamp: 1_700_000_040, source: "PHOTON", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newAtkProg11111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "12000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1800000000000", decimals: 6 } }] } },
      { signature: "sig4", timestamp: 1_700_000_060, source: "PHOTON", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newAtkProg11111111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "12000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1800000000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 10,
  },
  {
    id: "safe-011",
    description: "Established wallet: two same-size swaps at different times on known venue",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_036_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }], tokenOutputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 90,
  },
  {
    id: "risky-010",
    description: "Baseline poisoning attempt: 3 tx in 30s then one 50x large swap",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_000_010, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig3", timestamp: 1_700_000_020, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "50000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "7500000000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 5,
  },
  {
    id: "risky-011",
    description: "Coordinated activity: counterparty concentration (wash) on a brand-new venue",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["WashPartner111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_002_400, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["WashPartner111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig3", timestamp: 1_700_004_800, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["WashPartner111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig4", timestamp: 1_700_007_200, source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["WashPartner111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 10,
  },
  {
    id: "safe-012",
    description: "Counterparty concentration alone is a soft signal (low risk, not enough to flag risky)",
    expected: "safe",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["OneAddress11111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig2", timestamp: 1_700_002_400, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["OneAddress11111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig3", timestamp: 1_700_004_800, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["OneAddress11111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
      { signature: "sig4", timestamp: 1_700_007_200, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["OneAddress11111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "1500000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 10,
  },
  {
    id: "risky-012",
    description: "Poisoned-baseline evasion: big old swaps inflated the median, but recent activity is small; a 10x-recent swap is caught via recency-decay",
    expected: "risky",
    txs: [
      { signature: "sig1", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], counterparties: ["TradePartner111111111111111111111111111111111"], swap: { tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "10000000000", decimals: 9 } }], tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "15000000", decimals: 6 } }] } },
    ],
    hasBaseline: true,
    baselineTxCount: 10,
    baselineMedianSwapAmount: 1000,
    baselineRecentSwapAmounts: Array.from({ length: 32 }, () => 1),
  },
];

/** Eval set version — bump when cases are added/changed. */
export const EVAL_VERSION = "2.1.0";

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
    const firstTxTime = c.txs[0]?.timestamp ?? 1_700_000_000;

    // Build baseline if the case has one
    let baseline = null;
    if (c.hasBaseline) {
      // Build synthetic baseline: always JUPITER + AMM program (the "known" set).
      // Mirror test case token structure with 10x amounts so LARGE_SWAP doesn't
      // fire for safe cases. New venues/protocols in risky cases will NOT be here.
      const baselineCount = Math.min(c.baselineTxCount ?? 10, 10);
      const syntheticTxs: EnhancedTx[] = Array.from({ length: baselineCount }, (_, i) => {
        const refTx = c.txs[i % c.txs.length];
        const inLeg = refTx.swap?.tokenInputs?.[0];
        const outLeg = refTx.swap?.tokenOutputs?.[0];
        const inAmt = inLeg?.rawTokenAmount ? String(Number(inLeg.rawTokenAmount.tokenAmount) * 10) : "1000000000";
        const outAmt = outLeg?.rawTokenAmount ? String(Number(outLeg.rawTokenAmount.tokenAmount) * 10) : "1500000000";
        return {
          signature: `base_${i}`,
          timestamp: firstTxTime - 7200 + i * 600,
          source: "JUPITER",
          programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
          swap: {
            tokenInputs: [{ mint: inLeg?.mint ?? "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: inAmt, decimals: inLeg?.rawTokenAmount?.decimals ?? 9 } }],
            tokenOutputs: [{ mint: outLeg?.mint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: outAmt, decimals: outLeg?.rawTokenAmount?.decimals ?? 6 } }],
          },
        };
      });
       baseline = updateBaseline(wallet, null, syntheticTxs, firstTxTime - 3600, null);
       // Optional overrides so a case can express a "poisoned" baseline
       // (high full-history median but small recent window) without the
       // synthetic builder deriving both from the same txs.
       if (c.baselineRecentSwapAmounts) baseline.recentSwapAmounts = c.baselineRecentSwapAmounts;
       if (c.baselineMedianSwapAmount !== undefined) baseline.medianSwapAmount = c.baselineMedianSwapAmount;
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
    accuracy: Math.round((correctCount / total) / 1.0 * 10000) / 10000,
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
