import { extractSwap } from "./analyzer.js";
import { EnhancedTx, SwapEvent, USDC_MINT, USDT_MINT } from "./types.js";

/** mint -> USD price */
export type UsdPriceMap = Record<string, number>;

const KEYLESS_BASE = "https://lite-api.jup.ag/price/v3";
const KEYED_BASE = "https://api.jup.ag/price/v3";
const CHUNK_SIZE = 100;

/**
 * Parse a Jupiter Price API response (v2/v3). Accepts both the numeric
 * `usdPrice` (v3) and the string `price` (v2) shapes; drops unusable entries.
 */
export function parsePriceResponse(raw: unknown): UsdPriceMap {
  const out: UsdPriceMap = {};
  if (raw && typeof raw === "object") {
    for (const [mint, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const usd =
        typeof entry.usdPrice === "number" ? entry.usdPrice : Number(entry.price ?? Number.NaN);
      if (Number.isFinite(usd) && usd > 0) out[mint] = usd;
    }
  }
  return out;
}

const SAFE_MINT_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch USD prices for mints from the Jupiter Price API (GET, read-only).
 * Keyless by default (lite-api); set JUPITER_API_KEY for the higher-limit
 * api.jup.ag endpoint. JUPITER_PRICE_BASE overrides the URL entirely.
 */
export async function fetchUsdPrices(
  mints: string[],
  opts: { baseUrl?: string; apiKey?: string } = {},
): Promise<UsdPriceMap> {
  const apiKey = opts.apiKey ?? process.env.JUPITER_API_KEY;
  const baseUrl = opts.baseUrl ?? process.env.JUPITER_PRICE_BASE ?? (apiKey ? KEYED_BASE : KEYLESS_BASE);
  const unique = Array.from(new Set(mints.filter((m) => typeof m === "string" && SAFE_MINT_REGEX.test(m))));
  const out: UsdPriceMap = {};
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    const url = new URL(baseUrl);
    url.searchParams.set("ids", chunk.join(","));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Jupiter price fetch failed: ${res.status} ${res.statusText}`);
    }
    Object.assign(out, parsePriceResponse(await res.json()));
  }
  return out;
}

const STABLE_MINTS = [USDC_MINT, USDT_MINT];

/**
 * USD value of a swap. Prefers a stablecoin leg (USDC/USDT are 1:1 with USD,
 * no price feed needed), otherwise uses whichever side has a known price.
 * Returns null when neither leg is priceable — callers must fall back to
 * unnormalized (major-only) behavior. Results are rounded to the micro-USD
 * so float products of price * amount stay deterministic.
 */
export function swapUsdValue(swap: SwapEvent, prices: UsdPriceMap): number | null {
  for (const leg of [swap.tokenOut, swap.tokenIn]) {
    if (STABLE_MINTS.includes(leg.mint)) return leg.amount;
  }
  for (const leg of [swap.tokenIn, swap.tokenOut]) {
    const price = prices[leg.mint];
    if (price && price > 0) return Math.round(leg.amount * price * 1e6) / 1e6;
  }
  return null;
}

/** Collect the mints touched by a tx batch (both swap legs). */
export function collectSwapMints(txs: EnhancedTx[]): string[] {
  const mints = new Set<string>();
  for (const tx of txs) {
    const s = extractSwap(tx);
    if (s) {
      if (s.tokenIn.mint) mints.add(s.tokenIn.mint);
      if (s.tokenOut.mint) mints.add(s.tokenOut.mint);
    }
  }
  return Array.from(mints);
}

/**
 * Best-effort price fetch for a tx batch: returns null (major-only fallback)
 * when there are no swaps or the price feed is down — callers must not fail
 * because of a missing price feed.
 */
export async function fetchSwapPrices(
  txs: EnhancedTx[],
  opts?: { baseUrl?: string; apiKey?: string },
): Promise<UsdPriceMap | null> {
  const mints = collectSwapMints(txs);
  if (mints.length === 0) return null;
  try {
    return await fetchUsdPrices(mints, opts);
  } catch (err) {
    console.error(
      `price feed unavailable, falling back to major-only sizing: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
