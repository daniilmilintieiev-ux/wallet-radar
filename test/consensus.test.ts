import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateConsensus,
  behaviorAgent,
  solvencyAgent,
  identityAgent,
  llmAgent,
} from "../src/consensus.js";
import type { TrustBalances } from "../src/trust.js";

const SYS = "11111111111111111111111111111111";
const PDA = "SomeProgram11111111111111111111111111111111";
const bal = (usdc: number): TrustBalances => ({ sol: 0, usdc, usdt: 0 });

// A clean wallet: low risk, ample liquidity, a normal system account.
function cleanVotes() {
  return [
    behaviorAgent(10, 30),
    solvencyAgent(bal(60), 60, 50),
    identityAgent({ owner: SYS, isSystemAccount: true }),
  ];
}

test("unanimous-safe: all agents safe -> safe, agreement 1.0", () => {
  const c = aggregateConsensus(cleanVotes());
  assert.equal(c.verdict, "safe");
  assert.equal(c.rule, "unanimous-safe");
  assert.equal(c.agreement, 1);
  assert.equal(c.confidence, 1);
  assert.deepEqual(c.dissent, []);
  assert.equal(c.participants, 3);
});

test("any-hold-veto: behavior hold, solvency safe -> hold, dissent names solvency", () => {
  const votes = [behaviorAgent(75, 30), solvencyAgent(bal(60), 60, 50), identityAgent({ owner: SYS, isSystemAccount: true })];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "hold");
  assert.equal(c.rule, "any-hold-veto");
  assert.deepEqual(c.dissent, ["solvency", "identity"]);
});

test("identity hold (PDA) forces hold even with clean behavior/solvency", () => {
  const votes = [behaviorAgent(5, 30), solvencyAgent(bal(60), 60, 50), identityAgent({ owner: PDA, isSystemAccount: false })];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "hold");
  assert.deepEqual(c.dissent, ["behavior", "solvency"]);
  assert.ok(c.votes.find((v) => v.agent === "identity")?.reasons.some((r) => /not the system program/.test(r)));
});

test("core unknown-data veto: no history -> unknown", () => {
  const votes = [behaviorAgent(null, 30), solvencyAgent(bal(60), 60, 50), identityAgent({ owner: SYS, isSystemAccount: true })];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.rule, "unknown-data-veto");
});

test("core unknown-data veto: balances unavailable -> unknown", () => {
  const votes = [behaviorAgent(10, 30), solvencyAgent(null, 0, 50), identityAgent({ owner: null, isSystemAccount: null })];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.rule, "unknown-data-veto");
});

test("identity abstains when authority unknown; excluded from participants", () => {
  const votes = [behaviorAgent(10, 30), solvencyAgent(bal(60), 60, 50), identityAgent({ owner: null, isSystemAccount: null })];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "safe");
  assert.equal(c.participants, 2);
  const id = c.votes.find((v) => v.agent === "identity");
  assert.equal(id?.verdict, "abstain");
  assert.equal(c.agreement, 1);
});

test("LLM hold-veto: conservative fourth voter flips clean panel to hold", () => {
  const votes = [...cleanVotes(), llmAgent("hold", "LLM: unusual holder concentration")!];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "hold");
  assert.equal(c.rule, "any-hold-veto");
  assert.deepEqual(c.dissent, ["behavior", "solvency", "identity"]);
  // LLM weight 0.5 vs 3.0 for the safe majority -> low agreement, dissenting minority.
  assert.equal(c.agreement, 0.14);
});

test("LLM safe cannot override a deterministic hold", () => {
  const votes = [behaviorAgent(75, 30), solvencyAgent(bal(60), 60, 50), identityAgent({ owner: SYS, isSystemAccount: true }), llmAgent("safe", "LLM: looks fine")!];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "hold");
});

test("LLM unknown does not block when core agents have data", () => {
  const votes = [...cleanVotes(), llmAgent("unknown")!];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "safe");
});

test("no LLM opinion -> llmAgent returns null and panel runs with three agents", () => {
  assert.equal(llmAgent(undefined), null);
  assert.equal(llmAgent(null), null);
  const c = aggregateConsensus(cleanVotes());
  assert.equal(c.votes.length, 3);
});

test("weight override changes agreement (unanimous-safe verdict unchanged by weight)", () => {
  // behavior holds; even with a low behavior weight the verdict is still hold
  // (any-hold-veto), but the agreement level reflects the (re)weighted panel.
  const votes = [behaviorAgent(75, 30), solvencyAgent(bal(60), 60, 50), identityAgent({ owner: SYS, isSystemAccount: true })];
  const c = aggregateConsensus(votes, { weights: { behavior: 0.2 } });
  assert.equal(c.verdict, "hold");
  assert.equal(c.rule, "any-hold-veto");
  // matchWeight = behavior 0.2; totalWeight = 0.2 + 1 + 1 = 2.2 -> 0.2/2.2 = 0.09
  assert.equal(c.agreement, 0.09);
});

test("is deterministic across repeated calls", () => {
  const a = aggregateConsensus(cleanVotes());
  const b = aggregateConsensus(cleanVotes());
  assert.deepEqual(a, b);
});

test("behavior agent confidence is higher with more risk margin", () => {
  const safe = behaviorAgent(5, 30);
  const risky = behaviorAgent(29, 30);
  assert.ok(safe.verdict === "safe" && risky.verdict === "safe");
  assert.ok(safe.confidence > risky.confidence);
});

test("behavior agent at exact boundary riskScore === maxRisk votes safe", () => {
  const vote = behaviorAgent(30, 30);
  assert.equal(vote.verdict, "safe");
  assert.equal(vote.confidence, 0.6); // 0 margin -> base confidence
});

test("solvency agent at exact boundary liquidityUsd === minLiquidityUsd votes safe", () => {
  const vote = solvencyAgent(bal(50), 50, 50);
  assert.equal(vote.verdict, "safe");
  assert.equal(vote.confidence, 0.7);
});

test("solvency agent with balances null votes unknown with reason", () => {
  const vote = solvencyAgent(null, 0, 50);
  assert.equal(vote.verdict, "unknown");
  assert.equal(vote.confidence, 0.2);
  assert.ok(vote.reasons.includes("balance data unavailable"));
});

test("identity agent: non-system account (PDA) votes hold with confidence 0.8", () => {
  const vote = identityAgent({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSystemAccount: false });
  assert.equal(vote.verdict, "hold");
  assert.equal(vote.confidence, 0.8);
  assert.ok(vote.reasons[0].includes("is not the system program"));
});

test("all four agents in consensus panel: unanimous agreement when all safe", () => {
  const votes = [
    behaviorAgent(10, 30),
    solvencyAgent(bal(100), 100, 50),
    identityAgent({ owner: SYS, isSystemAccount: true }),
    llmAgent("safe", "LLM approves")!,
  ];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "safe");
  assert.equal(c.participants, 4);
  assert.equal(c.agreement, 1.0);
  assert.deepEqual(c.dissent, []);
});

test("core unknown-data veto takes precedence over identity hold veto", () => {
  // Behavior agent has no data (unknown) while Identity agent votes hold (PDA)
  const votes = [
    behaviorAgent(null, 30),
    solvencyAgent(bal(100), 100, 50),
    identityAgent({ owner: PDA, isSystemAccount: false }),
  ];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.rule, "unknown-data-veto");
});

test("core unknown-data veto takes precedence over behavior hold veto", () => {
  // Solvency agent has no data (unknown) while Behavior agent votes hold (high risk)
  const votes = [
    behaviorAgent(85, 30),
    solvencyAgent(null, 0, 50),
    identityAgent({ owner: SYS, isSystemAccount: true }),
  ];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.rule, "unknown-data-veto");
});

test("behaviorAgent handles maxRisk: 0 boundary cleanly", () => {
  // 0 risk with 0 maxRisk -> margin is 1 -> safe
  const zeroRisk = behaviorAgent(0, 0);
  assert.equal(zeroRisk.verdict, "safe");
  assert.equal(zeroRisk.confidence, 0.95);

  // Positive risk with 0 maxRisk -> over is 1 -> hold
  const overRisk = behaviorAgent(10, 0);
  assert.equal(overRisk.verdict, "hold");
  assert.equal(overRisk.confidence, 0.9);
});

test("aggregateConsensus handles all-abstaining panel without crashing", () => {
  const votes = [identityAgent({ owner: null, isSystemAccount: null })];
  const c = aggregateConsensus(votes);
  assert.equal(c.verdict, "safe");
  assert.equal(c.participants, 0);
  assert.equal(c.agreement, 0);
});


