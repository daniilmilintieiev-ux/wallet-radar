import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDefenseAction,
  enforcementFor,
  enforceVerdict,
  DEFENSE_THRESHOLDS,
  type DefenseStateInfo,
} from "../src/defense.js";
import { Store } from "../src/store.js";
import { watchOnce } from "../src/watch.js";
import { createServer } from "../src/http-server.js";
import type http from "node:http";
import { EnhancedTx } from "../src/types.js";
import type { ActionVerdict } from "../src/decision.js";

const NOW = 1_700_000_000;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOXIC_MINT = "Tox1cM1nt111111111111111111111111111111111111";
const FREEZE_AUTH = "FreezeAuth1111111111111111111111111111111111";

function stance(state: DefenseStateInfo["state"], quietStreak = 0): DefenseStateInfo {
  return { state, riskAt: 0, setAt: NOW - 100, quietStreak, actions: 0 };
}

function makeSwapTx(sig: string, timestamp: number, inMint: string, inAmount: number, outMint: string, outAmount: number): EnhancedTx {
  return {
    signature: sig,
    timestamp,
    source: "JUPITER",
    type: "SWAP",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: inMint, rawTokenAmount: { tokenAmount: String(Math.round(inAmount * 1_000_000)), decimals: 6 } }],
      tokenOutputs: [{ mint: outMint, rawTokenAmount: { tokenAmount: String(Math.round(outAmount * 1_000_000)), decimals: 6 } }],
    },
  };
}

// ---------------------------------------------------------------------------
// Pure state machine: deterministic, no I/O.
// ---------------------------------------------------------------------------
describe("defense state machine (pure)", () => {
  test("holds armed for a quiet wallet with no stance", () => {
    const a = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: null, quietStreak: 0, nowSec: NOW });
    assert.equal(a.state, "armed");
    assert.equal(a.action, "hold");
    assert.equal(a.changed, false);
  });

  test("escalates armed -> alerting at risk >= alerting threshold", () => {
    const a = computeDefenseAction({ riskScore: DEFENSE_THRESHOLDS.alerting, hasHighSeverity: false, active: true, current: null, quietStreak: 0, nowSec: NOW });
    assert.equal(a.state, "alerting");
    assert.equal(a.action, "escalate");
    assert.equal(a.changed, true);
  });

  test("escalates to gated at risk >= gated threshold", () => {
    const a = computeDefenseAction({ riskScore: DEFENSE_THRESHOLDS.gated, hasHighSeverity: false, active: true, current: null, quietStreak: 0, nowSec: NOW });
    assert.equal(a.state, "gated");
  });

  test("escalates to blocked at risk >= blocked threshold", () => {
    const a = computeDefenseAction({ riskScore: DEFENSE_THRESHOLDS.blocked, hasHighSeverity: false, active: true, current: null, quietStreak: 0, nowSec: NOW });
    assert.equal(a.state, "blocked");
  });

  test("escalates to blocked on any high-severity anomaly regardless of risk", () => {
    const a = computeDefenseAction({ riskScore: 1, hasHighSeverity: true, active: true, current: null, quietStreak: 0, nowSec: NOW });
    assert.equal(a.state, "blocked");
  });

  test("hysteresis: a calm active tick never relaxes the stance", () => {
    const a = computeDefenseAction({ riskScore: 5, hasHighSeverity: false, active: true, current: stance("gated"), quietStreak: 0, nowSec: NOW });
    assert.equal(a.state, "gated");
    assert.equal(a.action, "hold");
    assert.equal(a.changed, false);
  });

  test("escalates a lower stance up to a higher floor on an active tick", () => {
    const a = computeDefenseAction({ riskScore: DEFENSE_THRESHOLDS.blocked, hasHighSeverity: false, active: true, current: stance("alerting"), quietStreak: 0, nowSec: NOW });
    assert.equal(a.state, "blocked");
    assert.equal(a.action, "escalate");
  });

  test("does not de-escalate before the quiet threshold is met", () => {
    const a = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: stance("gated"), quietStreak: 2, nowSec: NOW });
    assert.equal(a.state, "gated");
    assert.equal(a.action, "hold");
  });

  test("de-escalates one level after deescalateQuietPolls quiet polls", () => {
    const a = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: stance("gated"), quietStreak: DEFENSE_THRESHOLDS.deescalateQuietPolls, nowSec: NOW });
    assert.equal(a.state, "alerting");
    assert.equal(a.action, "de-escalate");
    assert.equal(a.changed, true);
  });

  test("fully clears to armed after clearQuietPolls quiet polls", () => {
    const a = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: stance("gated"), quietStreak: DEFENSE_THRESHOLDS.clearQuietPolls, nowSec: NOW });
    assert.equal(a.state, "armed");
    assert.equal(a.action, "clear");
  });

  test("is deterministic: identical inputs yield identical output", () => {
    const ctx = { riskScore: 42, hasHighSeverity: false, active: true, current: stance("armed"), quietStreak: 0, nowSec: NOW };
    assert.deepEqual(computeDefenseAction(ctx), computeDefenseAction(ctx));
  });

  test("active tick on already blocked wallet holds blocked state", () => {
    const a = computeDefenseAction({
      riskScore: 90,
      hasHighSeverity: true,
      active: true,
      current: stance("blocked"),
      quietStreak: 0,
      nowSec: NOW,
    });
    assert.equal(a.state, "blocked");
    assert.equal(a.action, "hold");
    assert.equal(a.changed, false);
  });

  test("stepwise de-escalation from blocked -> gated -> alerting -> armed across quiet streaks", () => {
    // blocked at quietStreak 3 -> gated
    const step1 = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: stance("blocked"), quietStreak: 3, nowSec: NOW });
    assert.equal(step1.state, "gated");
    assert.equal(step1.action, "de-escalate");

    // gated at quietStreak 3 -> alerting
    const step2 = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: stance("gated"), quietStreak: 3, nowSec: NOW });
    assert.equal(step2.state, "alerting");
    assert.equal(step2.action, "de-escalate");

    // alerting at quietStreak 3 -> armed (clears back to armed)
    const step3 = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: stance("alerting"), quietStreak: 3, nowSec: NOW });
    assert.equal(step3.state, "armed");
    assert.equal(step3.action, "clear");

    // armed remains armed
    const step4 = computeDefenseAction({ riskScore: 0, hasHighSeverity: false, active: false, current: stance("armed"), quietStreak: 3, nowSec: NOW });
    assert.equal(step4.state, "armed");
    assert.equal(step4.action, "hold");
  });
});

// ---------------------------------------------------------------------------
// Enforcement: the stance -> verdict mapping and the monotonic "more
// conservative wins" combination.
// ---------------------------------------------------------------------------
describe("defense enforcement", () => {
  test("maps each stance to its enforcement", () => {
    assert.deepEqual(enforcementFor("armed"), { verdict: "allow", limitUsd: null, gating: false });
    assert.deepEqual(enforcementFor("alerting"), { verdict: "manual_review", limitUsd: null, gating: false });
    assert.deepEqual(enforcementFor("gated"), { verdict: "throttle", limitUsd: null, gating: true });
    assert.deepEqual(enforcementFor("blocked"), { verdict: "block", limitUsd: 0, gating: true });
  });

  test("enforceVerdict: the more conservative verdict wins", () => {
    assert.equal(enforceVerdict("allow", "armed"), "allow");
    assert.equal(enforceVerdict("allow", "alerting"), "manual_review");
    assert.equal(enforceVerdict("allow", "gated"), "throttle");
    assert.equal(enforceVerdict("allow", "blocked"), "block");
    assert.equal(enforceVerdict("throttle", "blocked"), "block");
    assert.equal(enforceVerdict("block", "armed"), "block");
    // a fresh block is never relaxed by a calmer stance
    assert.equal(enforceVerdict("block", "gated"), "block");
  });

  test("enforceVerdict never makes the verdict less conservative than the fresh one", () => {
    const order: Record<string, number> = { allow: 0, manual_review: 1, throttle: 2, block: 3 };
    const freshes = Object.keys(order) as ActionVerdict[];
    for (const fresh of freshes) {
      for (const st of ["armed", "alerting", "gated", "blocked"] as const) {
        const e = enforceVerdict(fresh, st);
        assert.ok(order[e] >= order[fresh], `fresh=${fresh} stance=${st} -> ${e}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Store: defense stance + audit event persistence.
// ---------------------------------------------------------------------------
describe("defense store persistence", () => {
  function tmpStore(): { store: Store; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "radar-defense-"));
    return { store: new Store(join(dir, "test.db")), dir };
  }

  test("stance round-trip and list", () => {
    const { store, dir } = tmpStore();
    assert.equal(store.getDefenseState("W1"), null);
    store.setDefenseState("W1", { state: "gated", riskAt: 62, setAt: NOW, quietStreak: 1, actions: 2 });
    assert.deepEqual(store.getDefenseState("W1"), { state: "gated", riskAt: 62, setAt: NOW, quietStreak: 1, actions: 2 });
    store.setDefenseState("W1", { state: "alerting", riskAt: 40, setAt: NOW + 10, quietStreak: 0, actions: 3 });
    assert.equal(store.getDefenseState("W1")?.state, "alerting");
    store.setDefenseState("W2", { state: "blocked", riskAt: 90, setAt: NOW, quietStreak: 0, actions: 1 });
    const list = store.listDefenseStates();
    assert.equal(list.length, 2);
    const w2 = list.find((s) => s.wallet === "W2");
    assert.equal(w2?.state.state, "blocked");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("audit events are recorded and retrievable per wallet", () => {
    const { store, dir } = tmpStore();
    store.recordDefenseEvent({ wallet: "W1", ts: NOW, fromState: "armed", toState: "gated", action: "escalate", risk: 62, reason: "risk fired" });
    store.recordDefenseEvent({ wallet: "W1", ts: NOW + 5, fromState: "gated", toState: "alerting", action: "de-escalate", risk: 0, reason: "quiet" });
    store.recordDefenseEvent({ wallet: "W2", ts: NOW, fromState: "armed", toState: "blocked", action: "escalate", risk: 90, reason: "high severity" });
    const w1 = store.recentDefenseEvents("W1", 20);
    assert.equal(w1.length, 2);
    assert.equal(w1[0].toState, "alerting"); // most recent first
    assert.equal(store.recentDefenseEvents("W2").length, 1);
    assert.equal(store.recentDefenseEvents("W3").length, 0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("removeWallet clears defense stance and events", () => {
    const { store, dir } = tmpStore();
    store.addWallet("W1");
    store.setDefenseState("W1", { state: "gated", riskAt: 62, setAt: NOW, quietStreak: 0, actions: 1 });
    store.recordDefenseEvent({ wallet: "W1", ts: NOW, fromState: "armed", toState: "gated", action: "escalate", risk: 62, reason: "x" });
    store.removeWallet("W1");
    assert.equal(store.getDefenseState("W1"), null);
    assert.equal(store.recentDefenseEvents("W1").length, 0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Autonomous watch: the loop escalates on risk and relaxes on sustained quiet,
// recording an auditable transition trail.
// ---------------------------------------------------------------------------
describe("defense in the watch loop (autonomous)", () => {
  test("escalates to blocked on a high-severity anomaly, then de-escalates on sustained quiet", async () => {
    const store = new Store(":memory:");
    const wallet = "Defen5eWallet1111111111111111111111111111";
    store.addWallet(wallet);

    // 1. Seed a baseline (defense is not evaluated on the seed tick).
    await watchOnce(store, "k", {
      fetchTxs: async () => [makeSwapTx("seed_tx", NOW, USDC_MINT, 100, SOL_MINT, 10)],
      fetchPrices: async () => null,
      fetchMintRisk: async () => ({}),
      nowSec: NOW,
    });

    // 2. Live tick with a high-severity (freeze-authority) toxic mint -> escalate to blocked.
    const sent: string[] = [];
    const live = await watchOnce(store, "k", {
      fetchTxs: async () => [makeSwapTx("toxic_tx", NOW + 10, USDC_MINT, 2000, TOXIC_MINT, 1_000_000)],
      fetchPrices: async () => null,
      fetchMintRisk: async () => ({ [TOXIC_MINT]: { mint: TOXIC_MINT, freezeAuthority: FREEZE_AUTH, mintAuthority: null } }),
      sink: { send: async (text: string) => { sent.push(text); } },
      nowSec: NOW + 10,
    });
    const liveReport = live.wallets.find((w) => w.wallet === wallet);
    assert.ok(liveReport);
    assert.ok(liveReport.defense, "live tick must carry a defense action");
    assert.equal(liveReport.defense!.state, "blocked");
    assert.equal(liveReport.defense!.changed, true);
    assert.equal(store.getDefenseState(wallet)?.state, "blocked");
    assert.equal(store.recentDefenseEvents(wallet).length, 1);
    assert.equal(store.recentDefenseEvents(wallet)[0].fromState, "armed");
    assert.equal(store.recentDefenseEvents(wallet)[0].toState, "blocked");
    assert.ok(sent.some((s) => s.includes("DEFENSE:")), "the alert must carry the defense line");

    // 3. Three sustained quiet polls relax the stance one level (blocked -> gated).
    for (let i = 1; i <= 3; i++) {
      await watchOnce(store, "k", {
        fetchTxs: async () => [],
        fetchPrices: async () => null,
        fetchMintRisk: async () => ({}),
        nowSec: NOW + 10 + i * 100_000,
      });
    }
    assert.equal(store.getDefenseState(wallet)?.state, "gated");
    const trail = store.recentDefenseEvents(wallet);
    assert.equal(trail[0].action, "de-escalate");
    assert.equal(trail[0].toState, "gated");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP surface: /defense list + per-wallet + clear, and defense attached to
// offline tool responses.
// ---------------------------------------------------------------------------
async function withServer(store: Store, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer({ store, rateLimitPerMin: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("defense over HTTP", () => {
  test("GET /defense lists stances with enforcement; GET /defense/:wallet shows the audit trail; POST clear resets to armed", async () => {
    const store = new Store(":memory:");
    const wallet = "Defen5eWallet1111111111111111111111111111";
    store.addWallet(wallet);
    store.setDefenseState(wallet, { state: "gated", riskAt: 62, setAt: NOW, quietStreak: 0, actions: 1 });
    store.recordDefenseEvent({ wallet, ts: NOW, fromState: "armed", toState: "gated", action: "escalate", risk: 62, reason: "risk fired" });

    await withServer(store, async (base) => {
      const list = await (await fetch(`${base}/defense`)).json();
      assert.equal(list.count, 1);
      assert.equal(list.states[0].wallet, wallet);
      assert.equal(list.states[0].state, "gated");
      assert.equal(list.states[0].enforcement.verdict, "throttle");
      assert.equal(list.states[0].enforcement.gating, true);

      const one = await (await fetch(`${base}/defense/${wallet}`)).json();
      assert.equal(one.state.state, "gated");
      assert.equal(one.events.length, 1);
      assert.equal(one.events[0].toState, "gated");

      const cleared = await (
        await fetch(`${base}/defense/${wallet}/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      ).json();
      assert.equal(cleared.cleared, true);
      assert.equal(cleared.from, "gated");
      assert.equal(cleared.state.state, "armed");
      assert.equal(store.getDefenseState(wallet)?.state, "armed");
      assert.equal(store.recentDefenseEvents(wallet)[0].action, "clear");
    });
    store.close();
  });

  test("an offline tool response is annotated with the active defense stance", async () => {
    const store = new Store(":memory:");
    const wallet = "Defen5eWallet1111111111111111111111111111";
    store.setDefenseState(wallet, { state: "blocked", riskAt: 90, setAt: NOW, quietStreak: 0, actions: 1 });

    await withServer(store, async (base) => {
      const res = await fetch(`${base}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, txs: [makeSwapTx("t1", NOW, USDC_MINT, 10, SOL_MINT, 1)] }),
      });
      const out = (await res.json()) as { defense?: { state: string; enforcement: { verdict: string } } };
      assert.equal(out.defense?.state, "blocked");
      assert.equal(out.defense?.enforcement.verdict, "block");
    });
    store.close();
  });

  test("GET /defense/:wallet returns null state for wallet without stance; POST clear returns 404", async () => {
    const store = new Store(":memory:");
    const unescalated = "UnescalatedWallet111111111111111111111111";

    await withServer(store, async (base) => {
      // 1. GET returns 200 with state null
      const resGet = await fetch(`${base}/defense/${unescalated}`);
      assert.equal(resGet.status, 200);
      const dataGet = (await resGet.json()) as any;
      assert.equal(dataGet.wallet, unescalated);
      assert.equal(dataGet.state, null);
      assert.equal(dataGet.enforcement, null);
      assert.deepEqual(dataGet.events, []);

      // 2. POST clear on unescalated wallet returns 404
      const resClear = await fetch(`${base}/defense/${unescalated}/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(resClear.status, 404);
      const dataClear = (await resClear.json()) as any;
      assert.ok(dataClear.error.includes("no defense state for this wallet"));
    });
    store.close();
  });
});

// Let the event loop settle (drain any half-closed keep-alive sockets from the
// HTTP tests) before --test-force-exit fires, which otherwise can trip a
// Windows libuv CLOSING-handle assertion (the same quirk seen in replay.test.ts).
test("__drain: settle before forced exit", async () => {
  await new Promise((r) => setTimeout(r, 300));
});
