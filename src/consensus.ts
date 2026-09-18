/**
 * Pillar 2 — Multi-agent consensus.
 *
 * The trust gate is re-expressed as a panel of specialized agents that each
 * vote on the wallet, combined by a deterministic aggregator. This is NOT a
 * cosmetic re-label of the legacy AND-gate:
 *
 *  - Each agent is an independent, inspectable voter with its own verdict,
 *    confidence, and reasons (transparency the legacy single gate lacked).
 *  - The aggregator is weight-aware and disagreement-aware: it reports the
 *    weighted agreement level and names the dissenting agents.
 *  - A fourth, advisory LLM voter can join the panel and cast a conservative
 *    hold-veto — it can make the consensus more cautious but never override a
 *    deterministic hold or turn an unknown into a safe.
 *
 * With the default "unanimous-safe" rule and no LLM voter, the consensus
 * reproduces the legacy `computeTrustVerdict` exactly (safe/hold/unknown), so
 * existing behavior and tests are preserved; the multi-agent machinery is a
 * strict superset of the legacy gate.
 *
 * Pure and deterministic: no I/O, no randomness.
 */

import type { AccountAuthority, TrustBalances } from "./trust.js";

export type AgentName = "behavior" | "solvency" | "identity" | "llm";

/** A single agent's verdict on the wallet. */
export type AgentVerdict = "safe" | "hold" | "unknown" | "abstain";

/** One agent's vote in the consensus panel. */
export interface AgentVote {
  agent: AgentName;
  verdict: AgentVerdict;
  /** This agent's confidence in its own verdict (0-1). */
  confidence: number;
  /** This agent's weight in the consensus (0-1; 1 = full trust). */
  weight: number;
  /** Why this agent voted this way (human-readable, may be empty). */
  reasons: string[];
  /** For the behavior agent: the underlying risk score, if scored. */
  riskScore?: number | null;
}

/** The aggregated outcome of the consensus panel. */
export interface ConsensusResult {
  /** Aggregated verdict; reproduces the legacy safe/hold/unknown domain. */
  verdict: "safe" | "hold" | "unknown";
  /** Weighted fraction of participating agents matching the verdict (0-1). */
  agreement: number;
  /** Confidence in the consensus verdict (== agreement). */
  confidence: number;
  /** All votes, including abstentions, for transparency. */
  votes: AgentVote[];
  /** Participating agents that voted against the final verdict. */
  dissent: AgentName[];
  /** Number of non-abstaining agents. */
  participants: number;
  /** The rule that produced the verdict. */
  rule: string;
}

export interface ConsensusOptions {
  /** Per-agent weight overrides. */
  weights?: Partial<Record<AgentName, number>>;
}

const DEFAULT_WEIGHTS: Record<AgentName, number> = {
  behavior: 1.0,
  solvency: 1.0,
  identity: 1.0,
  llm: 0.5,
};

function weightOf(vote: AgentVote, opts: ConsensusOptions): number {
  return opts.weights?.[vote.agent] ?? DEFAULT_WEIGHTS[vote.agent];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Behavior agent: does the wallet's on-chain behavior look risky? */
export function behaviorAgent(riskScore: number | null, maxRisk: number): AgentVote {
  const w = DEFAULT_WEIGHTS.behavior;
  if (riskScore === null) {
    return {
      agent: "behavior",
      verdict: "unknown",
      confidence: 0.2,
      weight: w,
      reasons: ["no history to score risk"],
      riskScore: null,
    };
  }
  if (riskScore > maxRisk) {
    const over = maxRisk > 0 ? (riskScore - maxRisk) / maxRisk : 1;
    return {
      agent: "behavior",
      verdict: "hold",
      confidence: round2(Math.min(0.95, 0.6 + over * 0.3)),
      weight: w,
      reasons: [`risk score ${riskScore} > max ${maxRisk}`],
      riskScore,
    };
  }
  const margin = maxRisk > 0 ? (maxRisk - riskScore) / maxRisk : 1;
  return {
    agent: "behavior",
    verdict: "safe",
    confidence: round2(Math.min(0.95, 0.6 + margin * 0.35)),
    weight: w,
    reasons: [],
    riskScore,
  };
}

/** Solvency agent: can the wallet actually pay (liquidity over the minimum)? */
export function solvencyAgent(
  balances: TrustBalances | null,
  liquidityUsd: number,
  minLiquidityUsd: number,
): AgentVote {
  const w = DEFAULT_WEIGHTS.solvency;
  if (balances === null) {
    return {
      agent: "solvency",
      verdict: "unknown",
      confidence: 0.2,
      weight: w,
      reasons: ["balance data unavailable"],
    };
  }
  if (liquidityUsd < minLiquidityUsd) {
    return {
      agent: "solvency",
      verdict: "hold",
      confidence: 0.7,
      weight: w,
      reasons: [`liquidity $${liquidityUsd.toFixed(2)} < min $${minLiquidityUsd.toFixed(2)}`],
    };
  }
  return { agent: "solvency", verdict: "safe", confidence: 0.7, weight: w, reasons: [] };
}

/** Identity agent: is the account a normal system-owned account (not a PDA)? */
export function identityAgent(authority: AccountAuthority | null | undefined): AgentVote {
  const w = DEFAULT_WEIGHTS.identity;
  if (!authority || authority.owner === null || authority.isSystemAccount === null) {
    return {
      agent: "identity",
      verdict: "abstain",
      confidence: 0,
      weight: w,
      reasons: ["account authority not determined (RPC unavailable)"],
    };
  }
  if (authority.isSystemAccount === false) {
    return {
      agent: "identity",
      verdict: "hold",
      confidence: 0.8,
      weight: w,
      reasons: [`account owner ${authority.owner} is not the system program (not a normal account)`],
    };
  }
  return { agent: "identity", verdict: "safe", confidence: 0.7, weight: w, reasons: [] };
}

/**
 * LLM agent: an advisory fourth voter. Returns null when no LLM opinion is
 * available (the panel then runs with the three deterministic agents). Under
 * the unanimous-safe rule the LLM can only make the consensus more
 * conservative (its "hold" casts a veto); it can never override a
 * deterministic hold or turn an unknown into a safe.
 */
export function llmAgent(
  verdict: "safe" | "hold" | "unknown" | null | undefined,
  note?: string,
): AgentVote | null {
  if (verdict === null || verdict === undefined) return null;
  return {
    agent: "llm",
    verdict,
    confidence: 0.5,
    weight: DEFAULT_WEIGHTS.llm,
    reasons: [note ?? "LLM heuristic assessment"],
  };
}

/**
 * Aggregate a panel of votes into a single verdict.
 *
 * Rule ("unanimous-safe"), reproducing the legacy AND-gate:
 *   - a core agent (behavior/solvency) has no data  -> "unknown"
 *   - else any participating agent votes "hold"     -> "hold"
 *   - else                                          -> "safe"
 */
export function aggregateConsensus(votes: AgentVote[], opts: ConsensusOptions = {}): ConsensusResult {
  const active = votes.filter((v) => v.verdict !== "abstain");

  if (active.length === 0) {
    return {
      verdict: "unknown",
      agreement: 0,
      confidence: 0,
      votes,
      dissent: [],
      participants: 0,
      rule: "no-active-voters",
    };
  }

  const coreUnknown = active.some(
    (v) => (v.agent === "behavior" || v.agent === "solvency") && v.verdict === "unknown",
  );

  let verdict: "safe" | "hold" | "unknown";
  let rule: string;
  if (coreUnknown) {
    verdict = "unknown";
    rule = "unknown-data-veto";
  } else if (active.some((v) => v.verdict === "hold")) {
    verdict = "hold";
    rule = "any-hold-veto";
  } else {
    verdict = "safe";
    rule = "unanimous-safe";
  }

  const totalWeight = active.reduce((s, v) => s + weightOf(v, opts), 0) || 1;
  const matchWeight = active
    .filter((v) => v.verdict === verdict)
    .reduce((s, v) => s + weightOf(v, opts), 0);
  const agreement = round2(matchWeight / totalWeight);
  const dissent = active.filter((v) => v.verdict !== verdict).map((v) => v.agent);

  return {
    verdict,
    agreement,
    confidence: agreement,
    votes,
    dissent,
    participants: active.length,
    rule,
  };
}
