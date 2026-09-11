/** Well-known mints (SOL wrapper + stablecoins). Dependency-free: shared by analyzer, baseline, pricing. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** A single decoded DEX swap extracted from a Helius enhanced transaction. */
export interface SwapEvent {
  dex: string;
  signature: string;
  timestamp: number;
  tokenIn: { mint: string; amount: number };
  tokenOut: { mint: string; amount: number };
}

/** A single enhanced transaction as returned by Helius (subset we care about). */
export interface EnhancedTx {
  signature: string;
  timestamp: number;
  source?: string;
  programs?: string[];
  swap?: {
    tokenInputs?: Array<{ mint?: string; rawTokenAmount?: { tokenAmount?: string; decimals?: number } }>;
    tokenOutputs?: Array<{ mint?: string; rawTokenAmount?: { tokenAmount?: string; decimals?: number } }>;
    nativeInput?: { amount?: number };
    nativeOutput?: { amount?: number };
  };
  /** Newer Helius response shape: no top-level `swap` field; swap legs must be
   *  reconstructed from the transfer lists relative to the fee payer. */
  type?: string;
  feePayer?: string;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
    mint?: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
  instructions?: Array<{ programId?: string }>;
}

export interface OpenLot {
  amount: number;
  pricePerUnit: number;
}

export interface PnlSummary {
  realizedUsd: number | null;
  winRate: number | null;
  roundTrips: number;
}

/** Learned behavioral profile for a watched wallet. */
export interface Baseline {
  walletAddress: string;
  updatedAt: number;
  knownVenues: string[];
  knownPrograms: string[];
  medianSwapAmount: number;
  /** Median swap size in USD (Jupiter price feed). Set only when prices were available. */
  medianSwapAmountUsd?: number;
  /** Realized PnL summary approximated via FIFO over closed swap round-trips. */
  pnl?: PnlSummary;
  /** Open buy lots per token pair for incremental cross-batch FIFO matching. */
  openLots?: Record<string, OpenLot[]>;
  medianTps: number;
  activeHours: number[];
  lastSeenAt: number | null;
  txCount: number;
}

export type AnomalyType =
  | "DORMANT_ACTIVE"
  | "ACTIVITY_BURST"
  | "NEW_VENUE"
  | "LARGE_SWAP"
  | "CONCENTRATION"
  | "NEW_PROTOCOL"
  | "TOXIC_MINT";

export interface MintRiskInfo {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Top-10 holder concentration, % of total supply (0-100). `null` = unknown. */
  top10Pct?: number | null;
}

export type MintRiskMap = Record<string, MintRiskInfo>;

export type Severity = "low" | "medium" | "high";

/** A detected behavioral anomaly with human- and agent-readable evidence. */
export interface Anomaly {
  type: AnomalyType;
  wallet: string;
  severity: Severity;
  timestamp: number;
  /** Structured evidence (tx signatures, numbers) for verification. */
  evidence: Record<string, unknown>;
  /** One-sentence human-readable description. */
  text: string;
}

/** Recency of the analyzed activity, so a gate is honest about the age of its data. */
export interface Freshness {
  /** Last observed on-chain activity (unix seconds); null if none in the window. */
  lastActivity: number | null;
  /** Whole days since last activity; null when no activity was observed. */
  daysSinceLastActivity: number | null;
  /** Analysis window start (unix seconds); null when not applicable. */
  windowStart: number | null;
  /** Analysis window end (unix seconds); null when not applicable. */
  windowEnd: number | null;
  /** True when last activity is older than `staleAfterDays`, or none was observed. */
  stale: boolean;
  /** Staleness threshold in days. */
  staleAfterDays: number;
}

export interface RadarConfig {
  pollMs: number;
  dormantDays: number;
  burstWindowMin: number;
  burstThreshold: number;
  largeSwapMultiplier: number;
  concentrationWindowMin: number;
  concentrationCount: number;
  quietPolls: number;
  maxPollMs: number;
}

export const DEFAULT_CONFIG: RadarConfig = {
  pollMs: 300_000,
  dormantDays: 7,
  burstWindowMin: 10,
  burstThreshold: 5,
  largeSwapMultiplier: 3,
  concentrationWindowMin: 30,
  concentrationCount: 2,
  quietPolls: 3,
  maxPollMs: 3_600_000,
};

export interface SettledPayment {
  signature: string;
  payer: string;
  recipient: string;
  amount: number;
  endpoint: string;
  settledAt: number;
}
