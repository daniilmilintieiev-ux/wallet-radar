import type { ActionVerdict } from "./decision.js";

/**
 * Active defense (Pillar 3): the radar does not just report risk, it acts.
 *
 * Each watched wallet carries a defense stance that the autonomous watch loop
 * escalates when risk fires and relaxes when the wallet stays quiet. The stance
 * is enforced on the trust/scan surface (a gated or blocked wallet stays gated or
 * blocked even on a fresh, calmer scan) and every transition is recorded as an
 * auditable defense event.
 *
 * This module is PURE and deterministic: no I/O, no randomness, no clock reads.
 * Any process can recompute the same defense action from the same inputs, which
 * is what makes the autonomous loop testable end to end.
 */

export type DefenseState = "armed" | "alerting" | "gated" | "blocked";

export interface DefenseStateInfo {
  state: DefenseState;
  /** Risk score (0-100) at the moment the state was last set. */
  riskAt: number;
  /** Unix seconds the state was last set. */
  setAt: number;
  /** Consecutive quiet polls observed while in this state (drives de-escalation). */
  quietStreak: number;
  /** Lifetime count of state transitions for this wallet. */
  actions: number;
}

export type DefenseActionType = "hold" | "escalate" | "de-escalate" | "clear";

export interface DefenseEnforcement {
  /** The actionable verdict the enforcement implies for this stance. */
  verdict: ActionVerdict;
  /** Suggested max payment (USD) under this stance; 0 = actively refusing. */
  limitUsd: number | null;
  /** True when the stance actively gates payments (gated | blocked). */
  gating: boolean;
}

/** A defense stance rendered for an API response (stance + its enforcement). */
export interface DefenseView {
  wallet: string;
  state: DefenseState;
  riskAt: number;
  setAt: number;
  quietStreak: number;
  actions: number;
  enforcement: DefenseEnforcement;
}

export interface DefenseAction {
  /** The wallet's defense state after this tick. */
  state: DefenseState;
  /** Whether the state changed this tick. */
  changed: boolean;
  /** The action taken this tick. */
  action: DefenseActionType;
  /** One-line, human/agent-readable account of what the defense did. */
  reason: string;
  /** The enforcement implied by the resulting state. */
  enforcement: DefenseEnforcement;
}

export interface DefenseContext {
  /** Risk score (0-100) for this tick (0 when the tick was quiet). */
  riskScore: number;
  /** Whether this tick saw a high-severity anomaly. */
  hasHighSeverity: boolean;
  /** True when this tick had fresh activity (an escalation candidate). */
  active: boolean;
  /** The wallet's current persisted stance, or null (treated as "armed"). */
  current: DefenseStateInfo | null;
  /** Consecutive quiet polls observed (from the watch pacing). */
  quietStreak: number;
  /** Unix seconds of this tick. */
  nowSec: number;
}

/** Risk / quiet thresholds for the defense ladder. */
export const DEFENSE_THRESHOLDS = {
  /** risk >= alerting raises the floor to "alerting". */
  alerting: 30,
  /** risk >= gated raises the floor to "gated" (actively throttle). */
  gated: 50,
  /** risk >= blocked, or any high-severity anomaly, raises the floor to "blocked". */
  blocked: 75,
  /** Consecutive quiet polls needed to step down one level. */
  deescalateQuietPolls: 3,
  /** Consecutive quiet polls needed to fully clear back to "armed". */
  clearQuietPolls: 6,
} as const;

const STATE_ORDER: readonly DefenseState[] = ["armed", "alerting", "gated", "blocked"];

function stateRank(s: DefenseState): number {
  return STATE_ORDER.indexOf(s);
}

/**
 * Pure, deterministic defense state machine.
 *
 * Active tick (fresh activity): the stance only ever escalates — to the max of
 * its current level and the risk floor for this tick (hysteresis: a spike holds
 * the stance; a single active poll never relaxes it).
 *   - any high-severity anomaly, or risk >= blocked, raises the floor to "blocked"
 *   - risk >= gated raises the floor to "gated"
 *   - risk >= alerting raises the floor to "alerting"
 *
 * Quiet tick (no fresh activity): the stance relaxes only with sustained quiet —
 * one level down after `deescalateQuietPolls`, fully cleared to "armed" after
 * `clearQuietPolls`. A single quiet poll never relaxes it (no flapping).
 */
export function computeDefenseAction(ctx: DefenseContext): DefenseAction {
  const cur = ctx.current?.state ?? "armed";

  if (ctx.active) {
    let floor: DefenseState = "armed";
    if (ctx.hasHighSeverity || ctx.riskScore >= DEFENSE_THRESHOLDS.blocked) {
      floor = "blocked";
    } else if (ctx.riskScore >= DEFENSE_THRESHOLDS.gated) {
      floor = "gated";
    } else if (ctx.riskScore >= DEFENSE_THRESHOLDS.alerting) {
      floor = "alerting";
    }

    const next = stateRank(floor) > stateRank(cur) ? floor : cur;
    const changed = next !== cur;
    return {
      state: next,
      changed,
      action: changed ? "escalate" : "hold",
      reason: changed
        ? `Defense escalated ${cur} -> ${next}: risk ${ctx.riskScore}/100${
            ctx.hasHighSeverity ? " with a high-severity anomaly" : ""
          }.`
        : `Defense holds ${cur}: risk ${ctx.riskScore}/100 stays within the current stance.`,
      enforcement: enforcementFor(next),
    };
  }

  const quiet = ctx.quietStreak;
  let next: DefenseState = cur;
  if (quiet >= DEFENSE_THRESHOLDS.clearQuietPolls) {
    next = "armed";
  } else if (quiet >= DEFENSE_THRESHOLDS.deescalateQuietPolls && stateRank(cur) > 0) {
    next = STATE_ORDER[stateRank(cur) - 1];
  }
  const changed = next !== cur;
  return {
    state: next,
    changed,
    action: changed ? (next === "armed" ? "clear" : "de-escalate") : "hold",
    reason: changed
      ? next === "armed"
        ? `Defense cleared after ${quiet} consecutive quiet polls: the threat subsided, wallet is armed again.`
        : `Defense de-escalated ${cur} -> ${next} after ${quiet} quiet polls (monitoring continues).`
      : `Defense holds ${cur}: ${quiet} quiet poll(s) (relaxes after ${DEFENSE_THRESHOLDS.deescalateQuietPolls}).`,
    enforcement: enforcementFor(next),
  };
}

/** The enforcement a defense stance implies (a pure function of the state). */
const ENFORCEMENT: Record<DefenseState, DefenseEnforcement> = {
  armed: { verdict: "allow", limitUsd: null, gating: false },
  alerting: { verdict: "manual_review", limitUsd: null, gating: false },
  gated: { verdict: "throttle", limitUsd: null, gating: true },
  blocked: { verdict: "block", limitUsd: 0, gating: true },
};

export function enforcementFor(state: DefenseState): DefenseEnforcement {
  return ENFORCEMENT[state];
}

/** Conservativeness of an actionable verdict: the higher, the stricter. */
const CONSERVATIVENESS: Record<ActionVerdict, number> = {
  allow: 0,
  manual_review: 1,
  throttle: 2,
  block: 3,
};

/**
 * Combine a freshly-computed decision verdict with an active defense stance: the
 * more conservative of the two wins. This is how the radar "acts" — a gated or
 * blocked wallet stays gated/blocked even if a fresh scan looks calmer.
 */
export function enforceVerdict(fresh: ActionVerdict, state: DefenseState): ActionVerdict {
  const forced = enforcementFor(state).verdict;
  return CONSERVATIVENESS[forced] > CONSERVATIVENESS[fresh] ? forced : fresh;
}
