import test from "node:test";
import assert from "node:assert/strict";
import { parsePriceResponse, swapUsdValue, fetchUsdPrices, fetchSwapPrices, collectSwapMints } from "../src/pricing.js";
import { detectAnomalies, SOL_MINT, USDC_MINT } from "../src/analyzer.js";
import { updateBaseline } from "../src/baseline.js";
import { Baseline, EnhancedTx, SwapEvent } from "../src/types.js";

const WALLET = "DemoWallet11111111111111111111111111111111";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

function makeSwap(
  tokenIn: { mint: string; amount: number },
  tokenOut: { mint: string; amount: number },
): SwapEvent {
  return { dex: "JUPITER", signature: "s", timestamp: 1_700_000_000, tokenIn, tokenOut };
}

function usdBaseline(medianUsd: number): Baseline {
  return {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    medianSwapAmount: 0,
    medianSwapAmountUsd: medianUsd,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
}

function swapTx(
  sig: string,
  inMint: string,
  inAmount: number,
  inDecimals: number,
  outMint: string,
  outAmount: number,
  outDecimals: number,
): EnhancedTx {
  return {
    signature: sig,
    timestamp: 1_700_000_600,
    source: "JUPITER",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: inMint, rawTokenAmount: { tokenAmount: String(Math.round(inAmount * 10 ** inDecimals)), decimals: inDecimals } }],
      tokenOutputs: [{ mint: outMint, rawTokenAmount: { tokenAmount: String(Math.round(outAmount * 10 ** outDecimals)), decimals: outDecimals } }],
    },
  };
}

test("parsePriceResponse reads v3 usdPrice and v2 price, drops bad entries", () => {
  const map = parsePriceResponse({
    [SOL_MINT]: { usdPrice: 103.5, liquidity: 123 },
    [USDC_MINT]: { price: "1.0" },
    neg: { usdPrice: -5 },
    nan: { usdPrice: Number.NaN },
    notNum: { price: "abc" },
    notObj: "scalar",
  });
  assert.equal(map[SOL_MINT], 103.5);
  assert.equal(map[USDC_MINT], 1);
  assert.equal(Object.keys(map).length, 2);
});

test("swapUsdValue prefers stablecoin legs at 1:1 USD", () => {
  const s = makeSwap({ mint: SOL_MINT, amount: 2 }, { mint: USDC_MINT, amount: 200 });
  // Stable leg wins even when the other side is priced.
  assert.equal(swapUsdValue(s, { [SOL_MINT]: 100 }), 200);
  // And works with an empty price map (no feed needed for stable legs).
  assert.equal(swapUsdValue(s, {}), 200);
  // Stable input leg counts too.
  const s2 = makeSwap({ mint: USDC_MINT, amount: 75 }, { mint: BONK, amount: 1e7 });
  assert.equal(swapUsdValue(s2, {}), 75);
});

test("swapUsdValue uses priced legs when no stablecoin is present", () => {
  const s = makeSwap({ mint: SOL_MINT, amount: 2 }, { mint: BONK, amount: 5e7 });
  assert.equal(swapUsdValue(s, { [SOL_MINT]: 100 }), 200);
  assert.equal(swapUsdValue(s, { [BONK]: 0.00002 }), 1000);
  assert.equal(swapUsdValue(s, {}), null);
});

test("LARGE_SWAP (USD) fires for a non-major mint above the USD threshold", () => {
  const baseline = usdBaseline(1000); // median $1,000 → threshold $3,000
  // 50M BONK in, $5,000 USDC out — invisible to the major-only rule.
  const txs = [swapTx("h", BONK, 50_000_000, 8, USDC_MINT, 5000, 6)];
  const anomalies = detectAnomalies(WALLET, txs, baseline, undefined, {});
  const large = anomalies.filter((a) => a.type === "LARGE_SWAP");
  assert.equal(large.length, 1);
  assert.equal(large[0].evidence.usd, 5000);
  assert.equal(large[0].evidence.medianUsd, 1000);
});

test("LARGE_SWAP (USD) stays silent below the threshold", () => {
  const baseline = usdBaseline(1000);
  const txs = [swapTx("i", BONK, 10_000_000, 8, USDC_MINT, 1000, 6)]; // $1,000 < $3,000
  const anomalies = detectAnomalies(WALLET, txs, baseline, undefined, {});
  assert.equal(anomalies.some((a) => a.type === "LARGE_SWAP"), false);
});

test("LARGE_SWAP (USD) skips swaps neither leg of which is priceable", () => {
  const baseline = usdBaseline(1000);
  const txs = [swapTx("j", WIF, 1e9, 6, BONK, 5e7, 8)];
  const anomalies = detectAnomalies(WALLET, txs, baseline, undefined, {});
  assert.equal(anomalies.some((a) => a.type === "LARGE_SWAP"), false);
});

test("LARGE_SWAP falls back to major-only without a USD median", () => {
  const baseline = usdBaseline(0); // prices present, but no learned USD median yet
  baseline.medianSwapAmount = 10;
  const txs = [swapTx("k", SOL_MINT, 100, 9, USDC_MINT, 1000, 6)]; // 100 >= 3*10
  const anomalies = detectAnomalies(WALLET, txs, baseline, undefined, { [SOL_MINT]: 100 });
  const large = anomalies.filter((a) => a.type === "LARGE_SWAP");
  assert.equal(large.length, 1);
  assert.equal(large[0].evidence.size, 100);
});

test("updateBaseline tracks the USD median when prices are available", () => {
  const txs = [
    swapTx("m1", SOL_MINT, 10, 9, USDC_MINT, 1000, 6), // $1,000
    swapTx("m2", SOL_MINT, 30, 9, USDC_MINT, 3000, 6), // $3,000
  ];
  const b = updateBaseline(WALLET, null, txs, 1_700_000_000, { [SOL_MINT]: 100 });
  assert.equal(b.medianSwapAmountUsd, 2000);
  assert.equal(b.medianSwapAmount, 20); // major-only raw median still tracked
});

test("updateBaseline leaves the USD median untouched without prices", () => {
  const txs = [swapTx("n1", SOL_MINT, 10, 9, USDC_MINT, 1000, 6)];
  const b = updateBaseline(WALLET, null, txs);
  assert.equal(b.medianSwapAmountUsd, undefined);
});

test("collectSwapMints dedupes both legs across the batch", () => {
  const txs = [
    swapTx("p1", SOL_MINT, 1, 9, USDC_MINT, 100, 6),
    swapTx("p2", SOL_MINT, 2, 9, USDC_MINT, 200, 6),
  ];
  assert.deepEqual(collectSwapMints(txs), [SOL_MINT, USDC_MINT]);
});

test("fetchSwapPrices returns null for a batch without swaps", async () => {
  const txs: EnhancedTx[] = [{ signature: "o", timestamp: 1, source: "JUPITER" }];
  assert.equal(await fetchSwapPrices(txs), null);
});

test("fetchUsdPrices calls the endpoint once per chunk and parses the response", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ [SOL_MINT]: { usdPrice: 100 } }) };
  }) as unknown as typeof fetch;
  try {
    const map = await fetchUsdPrices([SOL_MINT, USDC_MINT], { baseUrl: "https://example.invalid/price/v3" });
    assert.equal(map[SOL_MINT], 100);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("ids="));
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsdPrices chunks large mint lists (100 per request)", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  }) as unknown as typeof fetch;
  try {
    const mints = Array.from({ length: 150 }, (_, i) => `MINT${i}`);
    await fetchUsdPrices(mints, { baseUrl: "https://example.invalid/price/v3" });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsdPrices throws on non-2xx responses", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 429, statusText: "Too Many Requests" })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => fetchUsdPrices([SOL_MINT], { baseUrl: "https://example.invalid/price/v3" }),
      /429/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsdPrices with empty mints array returns empty object without fetching", async () => {
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
  try {
    const res = await fetchUsdPrices([]);
    assert.deepEqual(res, {});
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("swapUsdValue returns null on malformed swap or unpriced tokens", () => {
  const malformed = makeSwap({ mint: "UnknownMint1", amount: 0 }, { mint: "UnknownMint2", amount: 0 });
  assert.equal(swapUsdValue(malformed, {}), null);
});

test("collectSwapMints returns empty array when no txs have swap data", () => {
  const txs: EnhancedTx[] = [
    { signature: "tx1", timestamp: 100, source: "SYSTEM" },
    { signature: "tx2", timestamp: 200, source: "UNKNOWN" },
  ];
  assert.deepEqual(collectSwapMints(txs), []);
});

test("fetchSwapPrices falls back to null when price feed fetch fails", async () => {
  const original = globalThis.fetch;
  const originalConsoleError = console.error;
  console.error = () => {}; // suppress intentional fallback error log
  globalThis.fetch = (async () => ({ ok: false, status: 500, statusText: "Internal Error" })) as unknown as typeof fetch;
  try {
    const txs: EnhancedTx[] = [swapTx("s1", SOL_MINT, 1, 9, BONK, 1000, 8)];
    const prices = await fetchSwapPrices(txs, { baseUrl: "https://example.invalid/price/v3" });
    assert.equal(prices, null);
  } finally {
    globalThis.fetch = original;
    console.error = originalConsoleError;
  }
});

test("fetchUsdPrices sends x-api-key header and custom baseUrl when configured", async () => {
  const original = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedUrl = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ [SOL_MINT]: { usdPrice: 150 } }) };
  }) as unknown as typeof fetch;
  try {
    const res = await fetchUsdPrices([SOL_MINT], { baseUrl: "https://custom.jupiter.api/price/v3", apiKey: "test-jup-key" });
    assert.equal(res[SOL_MINT], 150);
    assert.ok(capturedUrl.startsWith("https://custom.jupiter.api/price/v3"));
    assert.equal(capturedHeaders["x-api-key"], "test-jup-key");
  } finally {
    globalThis.fetch = original;
  }
});

test("swapUsdValue supports USDT stablecoin and rounds to micro-USD precision", () => {
  const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const swapWithUsdt = makeSwap({ mint: SOL_MINT, amount: 1 }, { mint: USDT, amount: 125.5 });
  assert.equal(swapUsdValue(swapWithUsdt, {}), 125.5);

  // Micro-USD rounding test: 0.123456789 * 10 = 1.23456789 -> 1.234568
  const swapFloat = makeSwap({ mint: BONK, amount: 0.123456789 }, { mint: "RandomMint", amount: 1 });
  assert.equal(swapUsdValue(swapFloat, { [BONK]: 10 }), 1.234568);
});


