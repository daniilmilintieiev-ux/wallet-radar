import type { Store } from "./store.js";

/**
 * Unit economics / self-funding loop for the Wallet Radar agent.
 *
 * Revenue  = USDC actually settled on-chain via x402 (the `settled_payments`
 *            ledger written by the x402 server when a real payment verifies).
 * Cost     = tracked API spend (Helius enhanced-tx calls + LLM digests)
 *            recorded in `cost_events` each time a live endpoint consumes it.
 *
 * The agent is "self-sustaining" when its on-chain revenue covers its
 * tracked operating cost (netUsd >= 0 with revenue > 0). USDC is treated as
 * 1:1 with USD (stablecoin) unless `usdcUsd` is overridden.
 */

export interface CostRates {
  /** USD cost per Helius enhanced-tx API call. */
  heliusPerCallUsd: number;
  /** USD cost per LLM digest call. */
  llmPerCallUsd: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  heliusPerCallUsd: 0.0005,
  llmPerCallUsd: 0.001,
};

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Read cost rates from env, falling back to sensible defaults. */
export function loadCostRates(env: Record<string, string | undefined> = process.env): CostRates {
  const helius = num(env.RADAR_HELIUS_COST_PER_CALL_USD);
  const llm = num(env.RADAR_LLM_COST_PER_CALL_USD);
  return {
    heliusPerCallUsd: Number.isFinite(helius) ? helius : DEFAULT_COST_RATES.heliusPerCallUsd,
    llmPerCallUsd: Number.isFinite(llm) ? llm : DEFAULT_COST_RATES.llmPerCallUsd,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface EndpointRevenue {
  count: number;
  amountUsdc: number;
}

export interface DayEconomics {
  day: string; // YYYY-MM-DD
  revenueUsd: number;
  costUsd: number;
  netUsd: number;
}

export interface EconomicsReport {
  service: string;
  generatedAt: number; // unix ms
  usdcUsd: number;
  note: string;
  revenue: {
    totalUsdc: number;
    totalUsd: number;
    payments: number;
    byEndpoint: Record<string, EndpointRevenue>;
  };
  cost: {
    totalUsd: number;
    byCategory: Record<string, number>;
    events: number;
  };
  net: {
    usd: number;
    marginPct: number | null;
    selfSustaining: boolean;
  };
  unitEconomics: {
    paidScans: number;
    avgRevenuePerPaidScanUsd: number | null;
    avgCostPerScanUsd: number | null;
    netPerScanUsd: number | null;
  };
  perDay: DayEconomics[];
  rates: CostRates;
}

/**
 * Compute the agent's P&L from the shared store.
 */
export function computeEconomics(
  store: Store,
  opts: { rates?: CostRates; now?: number; days?: number; usdcUsd?: number } = {},
): EconomicsReport {
  const rates = opts.rates ?? loadCostRates();
  const usdcUsd = opts.usdcUsd ?? 1.0;
  const days = opts.days ?? 30;
  const now = opts.now ?? Date.now();

  const rev = store.getRevenueSummary();
  const cost = store.getCostSummary();

  const revTotalUsd = round6(rev.totalUsdc * usdcUsd);
  const costTotalUsd = round6(cost.totalUsd);
  const netUsd = round6(revTotalUsd - costTotalUsd);
  const marginPct = revTotalUsd > 0 ? round6((netUsd / revTotalUsd) * 100) : null;
  const selfSustaining = revTotalUsd > 0 && netUsd >= 0;

  const paidScans = rev.byEndpoint["/scan"]?.count ?? 0;
  const scanRevenueUsd = round6((rev.byEndpoint["/scan"]?.amountUsdc ?? 0) * usdcUsd);
  const avgRevenuePerPaidScanUsd = paidScans > 0 ? round6(scanRevenueUsd / paidScans) : null;
  const avgCostPerScanUsd = cost.events > 0 ? round6(costTotalUsd / cost.events) : null;
  const netPerScanUsd = paidScans > 0 ? round6((scanRevenueUsd - costTotalUsd) / paidScans) : null;

  const revByDay = new Map<string, number>();
  for (const r of store.getRevenuePerDay(days)) revByDay.set(r.day, round6(r.revenueUsdc * usdcUsd));
  const costByDay = new Map<string, number>();
  for (const c of store.getCostPerDay(days)) costByDay.set(c.day, round6(c.costUsd));
  const daySet = new Set<string>([...revByDay.keys(), ...costByDay.keys()]);
  const perDay: DayEconomics[] = [...daySet]
    .sort()
    .map((day) => {
      const revenueUsd = revByDay.get(day) ?? 0;
      const costUsd = costByDay.get(day) ?? 0;
      return { day, revenueUsd, costUsd, netUsd: round6(revenueUsd - costUsd) };
    });

  return {
    service: "wallet-radar",
    generatedAt: now,
    usdcUsd,
    note:
      "revenue = USDC settled on-chain via x402 (x USDC/USD rate); cost = tracked API spend (Helius + LLM). " +
      "selfSustaining = netUsd >= 0 with revenue > 0.",
    revenue: {
      totalUsdc: rev.totalUsdc,
      totalUsd: revTotalUsd,
      payments: rev.payments,
      byEndpoint: rev.byEndpoint,
    },
    cost: { totalUsd: costTotalUsd, byCategory: cost.byCategory, events: cost.events },
    net: { usd: netUsd, marginPct, selfSustaining },
    unitEconomics: {
      paidScans,
      avgRevenuePerPaidScanUsd,
      avgCostPerScanUsd,
      netPerScanUsd,
    },
    perDay,
    rates,
  };
}

/** Record one Helius API-call cost (called after each live Helius-consuming endpoint). */
export function recordHeliusCost(store: Store, detail?: string, rates?: CostRates): void {
  const r = rates ?? loadCostRates();
  store.recordCostEvent({
    category: "helius",
    quantity: 1,
    unitPriceUsd: r.heliusPerCallUsd,
    totalUsd: r.heliusPerCallUsd,
    detail,
  });
}
