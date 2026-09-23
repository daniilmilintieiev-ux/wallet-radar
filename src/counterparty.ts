import { Anomaly, CounterpartyMemory, CounterpartyStat, EnhancedTx, SOL_MINT } from "./types.js";
import { extractSwap, txCounterparties } from "./analyzer.js";
import { swapUsdValue, UsdPriceMap } from "./pricing.js";

/** Max distinct counterparties retained in memory (top-N by interaction count). */
export const COUNTERPARTY_MEMORY_CAP = 64;
/** Min established relationships before a first-seen counterparty is a signal. */
export const NEW_COUNTERPARTY_MIN_KNOWN = 3;
/** Cap on NEW_COUNTERPARTY anomalies emitted per batch (most active first). */
export const NEW_COUNTERPARTY_MAX_EMIT = 3;
/** Min cumulative interactions before a single counterparty can be a "hub". */
export const HUB_MIN_TOTAL = 8;
/** % of cumulative counterparty interactions to one address that marks a hub. */
export const HUB_PCT = 50;
/** Min prior interactions with a counterparty before escalation can fire. */
export const ESCALATION_MIN_PRIOR = 2;
/** A batch needs this many interactions with a known counterparty to escalate. */
export const ESCALATION_MIN_BATCH = 5;

/**
 * Fold a batch of transactions into the wallet's cross-batch counterparty
 * relationship memory. Pure: (prev | null, txs, nowSec, prices) -> memory.
 * Bounded: only the top-N counterparties by interaction count are retained, but
 * the lifetime `total` interaction count is never truncated.
 */
export function foldCounterparties(
  prev: CounterpartyMemory | null | undefined,
  txs: EnhancedTx[],
  nowSec: number,
  prices: UsdPriceMap | null = null,
  wallet?: string,
): CounterpartyMemory {
  const map = new Map<string, CounterpartyStat>();
  let total = 0;
  if (prev) {
    total = prev.total;
    for (const e of prev.entries) map.set(e.address, { ...e });
  }
  for (const tx of txs) {
    const ts = typeof tx.timestamp === "number" ? tx.timestamp : nowSec;
    let usd = 0;
    const s = extractSwap(tx, wallet);
    if (s && prices) {
      const v = swapUsdValue(s, prices);
      if (v !== null) usd = v;
    }
    // Direct (non-swap) transfers: attribute the USD value of each leg to the
    // counterparty it moved to/from, so plain transfers build up volumeUsd too
    // (audit 3.6). Swap txs keep the whole-swap attribution above.
    const directUsd = new Map<string, number>();
    if (!s && prices) {
      const me = wallet ?? tx.feePayer;
      if (me) {
        for (const t of tx.tokenTransfers ?? []) {
          if (!t.mint) continue;
          if (t.fromUserAccount !== me && t.toUserAccount !== me) continue;
          // (string | undefined annotation: a later `cp === me` check in this
          // scope makes TS infer a circular type for cp without it -> TS7022)
          const cp: string | undefined = t.fromUserAccount === me ? t.toUserAccount : t.fromUserAccount;
          if (!cp || cp === me) continue;
          const amount = Number(t.tokenAmount ?? 0);
          const price = prices[t.mint];
          if (amount > 0 && price) directUsd.set(cp, (directUsd.get(cp) ?? 0) + amount * price);
        }
        for (const n of tx.nativeTransfers ?? []) {
          if (n.fromUserAccount !== me && n.toUserAccount !== me) continue;
          const cp: string | undefined = n.fromUserAccount === me ? n.toUserAccount : n.fromUserAccount;
          if (!cp || cp === me) continue;
          const amount = Number(n.amount ?? 0) / 1e9;
          const price = prices[SOL_MINT];
          if (amount > 0 && price) directUsd.set(cp, (directUsd.get(cp) ?? 0) + amount * price);
        }
      }
    }
    for (const cp of txCounterparties(tx, wallet)) {
      const cur =
        map.get(cp) ?? { address: cp, count: 0, volumeUsd: 0, firstSeen: ts, lastSeen: ts };
      cur.count += 1;
      cur.volumeUsd += usd + (directUsd.get(cp) ?? 0);
      if (ts < cur.firstSeen) cur.firstSeen = ts;
      if (ts > cur.lastSeen) cur.lastSeen = ts;
      map.set(cp, cur);
      total += 1;
    }
  }
  let entries = Array.from(map.values());
  if (entries.length > COUNTERPARTY_MEMORY_CAP) {
    entries = entries
      .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
      .slice(0, COUNTERPARTY_MEMORY_CAP);
  }
  return { total, entries };
}

/**
 * Cross-batch counterparty RELATIONSHIP signals — the wallet's relationships
 * over time, not a single batch:
 *  - NEW_COUNTERPARTY: an established wallet meets a never-seen counterparty.
 *  - COUNTERPARTY_HUB: one counterparty dominates the wallet's lifetime flow.
 *  - COUNTERPARTY_ESCALATION: a known counterparty's share spikes past its
 *    entire prior history in a single batch.
 * Pure: deterministic, no clock/random (timestamps come from the batch).
 */
export function detectCounterpartyAnomalies(
  wallet: string,
  txs: EnhancedTx[],
  memory: CounterpartyMemory | null | undefined,
): Anomaly[] {
  const out: Anomaly[] = [];
  if (txs.length === 0) return out;
  const newest = Math.max(0, ...txs.map((t) => t.timestamp ?? 0));

  // Interactions with each counterparty in THIS batch.
  const batch = new Map<string, number>();
  for (const tx of txs) {
    for (const cp of txCounterparties(tx, wallet)) {
      batch.set(cp, (batch.get(cp) ?? 0) + 1);
    }
  }
  const entries = memory?.entries ?? [];
  const knownSet = new Set(entries.map((e) => e.address));
  const priorCount = (cp: string): number => entries.find((e) => e.address === cp)?.count ?? 0;

  // NEW_COUNTERPARTY: an established wallet (>= NEW_COUNTERPARTY_MIN_KNOWN known
  // relationships) meets a counterparty never seen before.
  if (knownSet.size >= NEW_COUNTERPARTY_MIN_KNOWN) {
    const fresh: Array<{ address: string; count: number }> = [];
    for (const [cp, count] of batch) {
      if (!knownSet.has(cp)) fresh.push({ address: cp, count });
    }
    if (fresh.length > 0) {
      fresh.sort((a, b) => b.count - a.count);
      for (const n of fresh.slice(0, NEW_COUNTERPARTY_MAX_EMIT)) {
        out.push({
          type: "NEW_COUNTERPARTY",
          wallet,
          severity: "low",
          timestamp: newest,
          evidence: {
            counterparty: n.address,
            interactions: n.count,
            establishedCounterparties: knownSet.size,
          },
          text: `New counterparty ${n.address} (${n.count} interaction${
            n.count === 1 ? "" : "s"
          }) against ${knownSet.size} established relationships.`,
        });
      }
    }
  }

  // COUNTERPARTY_HUB: one counterparty accounts for >= HUB_PCT% of the wallet's
  // CUMULATIVE (lifetime) counterparty interactions, with enough history.
  const batchTotal = Array.from(batch.values()).reduce((a, b) => a + b, 0);
  const cumulativeTotal = (memory?.total ?? 0) + batchTotal;
  if (cumulativeTotal >= HUB_MIN_TOTAL) {
    let top = "";
    let topCount = 0;
    for (const cp of new Set<string>([...knownSet, ...batch.keys()])) {
      const cum = priorCount(cp) + (batch.get(cp) ?? 0);
      if (cum > topCount) {
        topCount = cum;
        top = cp;
      }
    }
    const pct = Math.round((topCount / cumulativeTotal) * 100);
    if (pct >= HUB_PCT) {
      out.push({
        type: "COUNTERPARTY_HUB",
        wallet,
        severity: "medium",
        timestamp: newest,
        evidence: { counterparty: top, cumulative: topCount, total: cumulativeTotal, pct },
        text: `${pct}% of ${cumulativeTotal} lifetime counterparty interactions go to one wallet (${top}). Dominant single relationship.`,
      });
    }
  }

  // COUNTERPARTY_ESCALATION: a single batch's interactions with a KNOWN
  // counterparty (>= ESCALATION_MIN_PRIOR history) reach ESCALATION_MIN_BATCH
  // AND exceed that counterparty's entire prior history.
  for (const [cp, count] of batch) {
    const prior = priorCount(cp);
    if (prior >= ESCALATION_MIN_PRIOR && count >= ESCALATION_MIN_BATCH && count > prior) {
      out.push({
        type: "COUNTERPARTY_ESCALATION",
        wallet,
        severity: "medium",
        timestamp: newest,
        evidence: { counterparty: cp, priorInteractions: prior, batchInteractions: count },
        text: `Sudden escalation: ${count} interactions with ${cp} this batch vs ${prior} in its entire prior history.`,
      });
    }
  }

  return out;
}
