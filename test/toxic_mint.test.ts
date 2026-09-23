import test from "node:test";
import assert from "node:assert/strict";
import {
  detectAnomalies,
  MAJOR_MINTS,
  TOP10_CONCENTRATION_PCT,
  TOP10_HIGH_PCT,
} from "../src/analyzer.js";
import {
  collectCandidateMints,
  computeTop10Pct,
  fetchMintMetadata,
  fetchSwapMintRisk,
  getPumpFunBondingCurvePda,
  KNOWN_AMM_OWNERS,
  parseDasAssetResponse,
  parseDasAssetSupply,
  parseRpcAccountInfoResponse,
  parseRpcMintSupply,
  resolveSystemHolderAddresses,
} from "../src/mint.js";
import { Store } from "../src/store.js";
import { watchOnce } from "../src/watch.js";
import { EnhancedTx, SOL_MINT, USDC_MINT } from "../src/types.js";

const WALLET = "DemoWallet11111111111111111111111111111111";
const TOXIC_MINT = "ToxicMint1111111111111111111111111111111111";
const SAFE_MINT = "SafeMint11111111111111111111111111111111111";
const FREEZE_AUTH = "FreezeAuth111111111111111111111111111111111";
const MINT_AUTH = "MintAuth11111111111111111111111111111111111";

function makeSwapTx(sig: string, mintIn: string, mintOut: string, ts: number = 1000): EnhancedTx {
  return {
    signature: sig,
    timestamp: ts,
    source: "RAYDIUM",
    swap: {
      tokenInputs: [{ mint: mintIn, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }],
      tokenOutputs: [{ mint: mintOut, rawTokenAmount: { tokenAmount: "2000000", decimals: 6 } }],
    },
  };
}

test("parseDasAssetResponse: extracts authorities from DAS token_info", () => {
  const dasResponse = {
    jsonrpc: "2.0",
    result: {
      id: TOXIC_MINT,
      token_info: {
        mint_authority: MINT_AUTH,
        freeze_authority: FREEZE_AUTH,
        supply: 1000000000,
        decimals: 6,
      },
    },
  };

  const parsed = parseDasAssetResponse(dasResponse);
  assert.ok(parsed);
  assert.equal(parsed.mint, TOXIC_MINT);
  assert.equal(parsed.mintAuthority, MINT_AUTH);
  assert.equal(parsed.freezeAuthority, FREEZE_AUTH);
});

test("parseDasAssetResponse: handles renounced mint (null authorities)", () => {
  const dasResponse = {
    jsonrpc: "2.0",
    result: {
      id: SAFE_MINT,
      token_info: {
        mint_authority: null,
        freeze_authority: null,
        supply: 1000000000,
        decimals: 6,
      },
    },
  };

  const parsed = parseDasAssetResponse(dasResponse);
  assert.ok(parsed);
  assert.equal(parsed.mint, SAFE_MINT);
  assert.equal(parsed.mintAuthority, null);
  assert.equal(parsed.freezeAuthority, null);
});

test("parseDasAssetResponse: extracts from authorities array fallback", () => {
  const dasResponse = {
    jsonrpc: "2.0",
    result: {
      id: TOXIC_MINT,
      authorities: [
        { address: MINT_AUTH, scopes: ["mint"] },
        { address: FREEZE_AUTH, scopes: ["freeze"] },
      ],
    },
  };

  const parsed = parseDasAssetResponse(dasResponse);
  assert.ok(parsed);
  assert.equal(parsed.mintAuthority, MINT_AUTH);
  assert.equal(parsed.freezeAuthority, FREEZE_AUTH);
});

test("parseRpcAccountInfoResponse: parses standard Solana parsed account data", () => {
  const rpcResponse = {
    jsonrpc: "2.0",
    result: {
      value: {
        data: {
          parsed: {
            info: {
              mintAuthority: MINT_AUTH,
              freezeAuthority: null,
              decimals: 6,
              supply: "500000000",
            },
            type: "mint",
          },
          program: "spl-token",
        },
      },
    },
  };

  const parsed = parseRpcAccountInfoResponse(TOXIC_MINT, rpcResponse);
  assert.ok(parsed);
  assert.equal(parsed.mint, TOXIC_MINT);
  assert.equal(parsed.mintAuthority, MINT_AUTH);
  assert.equal(parsed.freezeAuthority, null);
});

test("collectCandidateMints: collects swap mints excluding MAJOR_MINTS", () => {
  const txs = [
    makeSwapTx("s1", USDC_MINT, TOXIC_MINT),
    makeSwapTx("s2", TOXIC_MINT, SOL_MINT),
    makeSwapTx("s3", USDC_MINT, SOL_MINT),
  ];

  const candidates = collectCandidateMints(txs);
  assert.deepEqual(candidates, [TOXIC_MINT]);
});

test("detectAnomalies TOXIC_MINT: freeze-authority mint fires high severity", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  const mintRisk = {
    [TOXIC_MINT]: {
      mint: TOXIC_MINT,
      freezeAuthority: FREEZE_AUTH,
      mintAuthority: null,
    },
  };

  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  const toxic = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.ok(toxic);
  assert.equal(toxic.severity, "high");
  assert.equal(toxic.evidence.mint, TOXIC_MINT);
  assert.equal(toxic.evidence.freezeAuthority, FREEZE_AUTH);
  assert.equal(toxic.evidence.mintAuthority, null);
  assert.match(toxic.text, /freeze authority/);
});

test("detectAnomalies TOXIC_MINT: mint-authority only fires medium severity", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  const mintRisk = {
    [TOXIC_MINT]: {
      mint: TOXIC_MINT,
      freezeAuthority: null,
      mintAuthority: MINT_AUTH,
    },
  };

  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  const toxic = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.ok(toxic);
  assert.equal(toxic.severity, "medium");
  assert.equal(toxic.evidence.mintAuthority, MINT_AUTH);
  assert.match(toxic.text, /mint authority/);
});

test("detectAnomalies TOXIC_MINT: both authorities present fires high severity with both reasons", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  const mintRisk = {
    [TOXIC_MINT]: {
      mint: TOXIC_MINT,
      freezeAuthority: FREEZE_AUTH,
      mintAuthority: MINT_AUTH,
    },
  };

  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  const toxic = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.ok(toxic);
  assert.equal(toxic.severity, "high");
  assert.match(toxic.text, /freeze authority/);
  assert.match(toxic.text, /mint authority/);
});

test("detectAnomalies TOXIC_MINT: renounced mint passes (no anomaly)", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, SAFE_MINT, 1700000000)];
  const mintRisk = {
    [SAFE_MINT]: {
      mint: SAFE_MINT,
      freezeAuthority: null,
      mintAuthority: null,
    },
  };

  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  assert.equal(anomalies.filter((a) => a.type === "TOXIC_MINT").length, 0);
});

test("detectAnomalies TOXIC_MINT: skips MAJOR_MINTS even if passed in mintRisk", () => {
  const txs = [makeSwapTx("s1", SOL_MINT, USDC_MINT, 1700000000)];
  const mintRisk = {
    [USDC_MINT]: {
      mint: USDC_MINT,
      freezeAuthority: "CircleFreeze111",
      mintAuthority: "CircleMint111",
    },
  };

  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  assert.equal(anomalies.filter((a) => a.type === "TOXIC_MINT").length, 0);
});

test("detectAnomalies TOXIC_MINT: API error / missing metadata skips the rule without crashing", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  // Empty mintRisk map (metadata fetch failed for TOXIC_MINT)
  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, {});
  assert.equal(anomalies.filter((a) => a.type === "TOXIC_MINT").length, 0);
});

test("detectAnomalies TOXIC_MINT: deduplicates multiple swaps of same toxic mint in batch", () => {
  const txs = [
    makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000),
    makeSwapTx("s2", TOXIC_MINT, USDC_MINT, 1700000010),
    makeSwapTx("s3", USDC_MINT, TOXIC_MINT, 1700000020),
  ];
  const mintRisk = {
    [TOXIC_MINT]: {
      mint: TOXIC_MINT,
      freezeAuthority: FREEZE_AUTH,
      mintAuthority: null,
    },
  };

  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  const toxicList = anomalies.filter((a) => a.type === "TOXIC_MINT");
  assert.equal(toxicList.length, 1);
});

test("fetchMintMetadata: caches in store with TTL and survives without redundant network calls", async () => {
  const store = new Store(":memory:");
  let networkCalls = 0;

  const stubFetch: typeof fetch = async () => {
    networkCalls++;
    return {
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        result: {
          id: TOXIC_MINT,
          token_info: {
            mint_authority: MINT_AUTH,
            freeze_authority: FREEZE_AUTH,
          },
        },
      }),
    } as any;
  };

  const nowSec = 1000;
  // 1. Initial fetch: makes network call
  const info1 = await fetchMintMetadata(TOXIC_MINT, {
    store,
    nowSec,
    ttlSec: 14400, // 4 hours
    rpcUrl: "http://stub-rpc",
    fetchFn: stubFetch,
  });
  assert.equal(networkCalls, 1);
  assert.equal(info1?.freezeAuthority, FREEZE_AUTH);

  // 2. Second call within TTL: returns from SQLite store cache without network call
  const info2 = await fetchMintMetadata(TOXIC_MINT, {
    store,
    nowSec: nowSec + 3600, // 1 hour later
    ttlSec: 14400,
    rpcUrl: "http://stub-rpc",
    fetchFn: stubFetch,
  });
  assert.equal(networkCalls, 1);
  assert.equal(info2?.freezeAuthority, FREEZE_AUTH);

  // 3. Third call after TTL expiration (5 hours later): triggers fresh fetch
  const info3 = await fetchMintMetadata(TOXIC_MINT, {
    store,
    nowSec: nowSec + 18000, // 5 hours later
    ttlSec: 14400,
    rpcUrl: "http://stub-rpc",
    fetchFn: stubFetch,
  });
  assert.equal(networkCalls, 2);
  assert.equal(info3?.freezeAuthority, FREEZE_AUTH);

  // 4. cleanExpiredMintCache removes expired entries
  const cleaned = store.cleanExpiredMintCache(nowSec + 100000);
  assert.equal(cleaned, 1);
  assert.equal(store.getMintMetadata(TOXIC_MINT, nowSec + 100000), null);

  store.close();
});

test("fetchMintMetadata: returns null on API error without throwing", async () => {
  const stubFailingFetch: typeof fetch = async () => {
    throw new Error("RPC endpoint unreachable (500)");
  };

  const info = await fetchMintMetadata(TOXIC_MINT, {
    rpcUrl: "http://stub-rpc",
    fetchFn: stubFailingFetch,
  });
  assert.equal(info, null);
});

test("watchOnce: fires TOXIC_MINT alert on fresh activity when mint has unrenounced authority", async () => {
  const store = new Store(":memory:");
  store.addWallet(WALLET);

  // Seed baseline
  await watchOnce(store, "dummy-key", {
    fetchTxs: async () => [makeSwapTx("seed_tx", USDC_MINT, SOL_MINT, 1000)],
    fetchPrices: async () => null,
    fetchMintRisk: async () => ({}),
  });

  // Second poll with fresh swap involving TOXIC_MINT
  const sentAlerts: string[] = [];
  const report = await watchOnce(store, "dummy-key", {
    fetchTxs: async () => [makeSwapTx("fresh_tx", USDC_MINT, TOXIC_MINT, 2000)],
    fetchPrices: async () => null,
    fetchMintRisk: async () => ({
      [TOXIC_MINT]: {
        mint: TOXIC_MINT,
        freezeAuthority: FREEZE_AUTH,
        mintAuthority: null,
      },
    }),
    sink: {
      send: async (text) => {
        sentAlerts.push(text);
      },
    },
  });

  const walletReport = report.wallets.find((w) => w.wallet === WALLET);
  assert.ok(walletReport);
  assert.equal(walletReport.anomalyCount, 2);
  assert.equal(walletReport.riskScore, 45); // TOXIC_MINT(30) + WARMING(15)

  const recorded = store.recentAnomalies(WALLET, 10);
  assert.equal(recorded.length, 2);
  assert.ok(recorded.some((a) => a.type === "TOXIC_MINT"));
  const toxic = recorded.find((a) => a.type === "TOXIC_MINT");
  assert.equal(toxic?.severity, "high");

  assert.equal(sentAlerts.length, 1);
  assert.match(sentAlerts[0], /TOXIC_MINT/);

  store.close();
});

// --- top-10 holder concentration sub-signal ---

test("computeTop10Pct: sums top-10 holders as % of supply", () => {
  // supply 1e9 base / 1e6 = 1_000 tokens. Top-10 hold 700 tokens (500+200) => 70%.
  const accounts = [
    { amount: "500000000", uiAmount: 500 },
    { amount: "200000000", uiAmount: 200 },
  ];
  assert.equal(computeTop10Pct("1000000000", 6, accounts), 70);
});

test("computeTop10Pct: only the top 10 accounts are counted", () => {
  // 12 accounts of 100 tokens each; only the first 10 (1_000 tokens) count => 100%.
  const accounts = Array.from({ length: 12 }, () => ({ amount: "100000000", uiAmount: 100 }));
  const pct = computeTop10Pct("1000000000", 6, accounts);
  assert.ok(pct != null && pct >= 99.99);
});

test("computeTop10Pct: falls back to amount when uiAmount is null", () => {
  const accounts = [{ amount: "300000000", uiAmount: null }];
  assert.equal(computeTop10Pct("1000000000", 6, accounts), 30);
});

test("computeTop10Pct: clamps to 100 and returns null on invalid supply", () => {
  const accounts = [{ amount: "5000000000", uiAmount: 5_000_000 }];
  assert.equal(computeTop10Pct("1000000000", 6, accounts), 100);
  assert.equal(computeTop10Pct("0", 6, [{ amount: "100", uiAmount: 1 }]), null);
  assert.equal(computeTop10Pct("abc", 6, [{ amount: "100", uiAmount: 1 }]), null);
});

test("computeTop10Pct: excludes AMM pool vaults / incinerator via systemHolders (audit 3.2)", () => {
  // supply 1_000_000. One pool vault (600k) + incinerator (200k) + 2 wallets (100k each).
  // Unfiltered top-10 = 100%; with the 2 system accounts excluded = 20%.
  const accounts = [
    { address: "PoolVaultAAA", amount: "600000000000", uiAmount: 600_000 },
    { address: "BurnVaultCCC", amount: "200000000000", uiAmount: 200_000 },
    { address: "Wallet1", amount: "100000000000", uiAmount: 100_000 },
    { address: "Wallet2", amount: "100000000000", uiAmount: 100_000 },
  ];
  const system = new Set(["PoolVaultAAA", "BurnVaultCCC"]);
  assert.equal(computeTop10Pct("1000000000000", 6, accounts), 100);
  assert.equal(computeTop10Pct("1000000000000", 6, accounts, system), 20);
});

test("fetchMintMetadata: pool vaults + incinerator excluded from top-10 (audit 3.2, end-to-end)", async () => {
  const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
  const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
  const stubFetch: typeof fetch = async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.method === "getAsset") {
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            id: TOXIC_MINT,
            token_info: { mint_authority: null, freeze_authority: null, supply: "1000000000000", decimals: 6 },
          },
        }),
      } as any;
    }
    if (body.method === "getTokenLargestAccounts") {
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            value: [
              { address: "PoolVaultAAA", amount: "400000000000", uiAmount: 400_000 },
              { address: "PoolVaultBBB", amount: "200000000000", uiAmount: 200_000 },
              { address: "BurnVaultCCC", amount: "200000000000", uiAmount: 200_000 },
              { address: "Wallet1", amount: "100000000000", uiAmount: 100_000 },
              { address: "Wallet2", amount: "100000000000", uiAmount: 100_000 },
            ],
          },
        }),
      } as any;
    }
    if (body.method === "getMultipleAccounts") {
      // Token accounts: top-level owner is always the SPL Token program; the
      // real holder lives in data.parsed.info.owner (verified on mainnet).
      const holders = [RAYDIUM_AMM, RAYDIUM_AMM, INCINERATOR, "Wallet1Owner", "Wallet2Owner"];
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            value: holders.map((owner) => ({
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              data: { parsed: { info: { owner } } },
            })),
          },
        }),
      } as any;
    }
    throw new Error("unexpected RPC method: " + body.method);
  };
  const info = await fetchMintMetadata(TOXIC_MINT, { fetchFn: stubFetch, rpcUrl: "http://rpc.test" });
  assert.ok(info, "metadata should be fetched");
  // Unfiltered would be 100%; with 2 pool vaults + incinerator excluded: 20%
  assert.equal(info.top10Pct, 20);
});

test("fetchMintMetadata: falls back to unfiltered top-10 when owner resolution fails (audit 3.2)", async () => {
  const stubFetch: typeof fetch = async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.method === "getAsset") {
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            id: TOXIC_MINT,
            token_info: { mint_authority: null, freeze_authority: null, supply: "1000000000000", decimals: 6 },
          },
        }),
      } as any;
    }
    if (body.method === "getTokenLargestAccounts") {
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            value: [
              { address: "PoolVaultAAA", amount: "750000000000", uiAmount: 750_000 },
              { address: "Wallet1", amount: "20000000000", uiAmount: 20_000 },
            ],
          },
        }),
      } as any;
    }
    if (body.method === "getMultipleAccounts") {
      return { ok: false, json: async () => ({}) } as any;
    }
    throw new Error("unexpected RPC method: " + body.method);
  };
  const info = await fetchMintMetadata(TOXIC_MINT, { fetchFn: stubFetch, rpcUrl: "http://rpc.test" });
  assert.ok(info, "metadata should be fetched");
  // getMultipleAccounts failed -> unfiltered: 770k / 1M = 77%
  assert.equal(info.top10Pct, 77);
});

test("parseDasAssetSupply: extracts supply and decimals from DAS token_info", () => {
  const data = { result: { id: TOXIC_MINT, token_info: { supply: "1000000000", decimals: 6 } } };
  const { supply, decimals } = parseDasAssetSupply(data);
  assert.equal(supply, "1000000000");
  assert.equal(decimals, 6);
});

test("parseRpcMintSupply: extracts supply and decimals from getAccountInfo", () => {
  const data = {
    result: { value: { data: { parsed: { info: { supply: "5000000000", decimals: 9 } } } } },
  };
  const { supply, decimals } = parseRpcMintSupply(data);
  assert.equal(supply, "5000000000");
  assert.equal(decimals, 9);
});

test("fetchMintMetadata: computes top10Pct from DAS supply + getTokenLargestAccounts", async () => {
  let largestCalled = false;
  const stubFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.method === "getAsset") {
      return {
        ok: true,
        json: async () => ({
          result: {
            id: TOXIC_MINT,
            token_info: {
              mint_authority: null,
              freeze_authority: null,
              supply: "1000000000",
              decimals: 6,
            },
          },
        }),
      } as Response;
    }
    if (body.method === "getTokenLargestAccounts") {
      largestCalled = true;
      const accounts = [
        { amount: "500000000", uiAmount: 500 },
        { amount: "200000000", uiAmount: 200 },
      ];
      return { ok: true, json: async () => ({ result: { value: accounts } }) } as Response;
    }
    throw new Error("unexpected method " + body.method);
  };

  const info = await fetchMintMetadata(TOXIC_MINT, { rpcUrl: "http://stub", fetchFn: stubFetch });
  assert.ok(info);
  assert.equal(largestCalled, true);
  assert.ok(info.top10Pct != null);
  assert.ok(Math.abs(info.top10Pct! - 70) < 1e-6, `expected ~70%, got ${info.top10Pct}`);
});

test("detectAnomalies TOXIC_MINT: top-10 concentration at/above 60% fires medium", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  const mintRisk = {
    [TOXIC_MINT]: { mint: TOXIC_MINT, freezeAuthority: null, mintAuthority: null, top10Pct: 60 },
  };
  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  const toxic = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.ok(toxic);
  assert.equal(toxic.severity, "medium");
  assert.match(toxic.text, /top-10 holders control/);
  assert.equal(toxic.evidence.top10Pct, 60);
});

test("detectAnomalies TOXIC_MINT: top-10 concentration >= 80% fires high severity", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  const mintRisk = {
    [TOXIC_MINT]: { mint: TOXIC_MINT, freezeAuthority: null, mintAuthority: null, top10Pct: 90 },
  };
  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  const toxic = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.ok(toxic);
  assert.equal(toxic.severity, "high");
  assert.equal(toxic.evidence.top10Pct, 90);
});

test("detectAnomalies TOXIC_MINT: concentration below threshold does not fire", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  const mintRisk = {
    [TOXIC_MINT]: { mint: TOXIC_MINT, freezeAuthority: null, mintAuthority: null, top10Pct: 59 },
  };
  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  assert.equal(anomalies.filter((a) => a.type === "TOXIC_MINT").length, 0);
});

test("detectAnomalies TOXIC_MINT: renounced authorities but concentrated still fires", () => {
  const txs = [makeSwapTx("s1", USDC_MINT, TOXIC_MINT, 1700000000)];
  const mintRisk = {
    [TOXIC_MINT]: { mint: TOXIC_MINT, freezeAuthority: null, mintAuthority: null, top10Pct: 75 },
  };
  const anomalies = detectAnomalies(WALLET, txs, null, undefined, null, mintRisk);
  const toxic = anomalies.find((a) => a.type === "TOXIC_MINT");
  assert.ok(toxic);
  assert.equal(toxic.severity, "medium");
  assert.match(toxic.text, /top-10 holders control 75%/);
  assert.doesNotMatch(toxic.text, /authority/);
});

test("audit 3.1: fetchSwapMintRisk bounds concurrency and chunks requests", async () => {
  // Generate 9 distinct non-major mints
  const mints = Array.from({ length: 9 }, (_, i) => `CustomMint${i}111111111111111111111111111111111`);
  const txs = mints.map((m, i) => makeSwapTx(`sig_${i}`, USDC_MINT, m, 1700000000 + i));

  let activeRequests = 0;
  let maxActiveRequests = 0;
  const processedMints: string[] = [];

  const mockFetchMint = async (mint: string) => {
    activeRequests++;
    if (activeRequests > maxActiveRequests) {
      maxActiveRequests = activeRequests;
    }
    // Artificial small delay to measure concurrency
    await new Promise((r) => setTimeout(r, 10));
    processedMints.push(mint);
    activeRequests--;
    return {
      mint,
      freezeAuthority: null,
      mintAuthority: null,
      top10Pct: 50,
    };
  };

  const concurrency = 3;
  const result = await fetchSwapMintRisk(txs, {
    fetchMintFn: mockFetchMint,
    concurrency,
  });

  assert.equal(Object.keys(result).length, 9);
  assert.equal(processedMints.length, 9);
  assert.ok(
    maxActiveRequests <= concurrency,
    `Max active concurrent requests (${maxActiveRequests}) exceeded concurrency limit (${concurrency})`,
  );
});

test("audit 2.1: getPumpFunBondingCurvePda derives valid PDA with bonding-curve seeds", () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const pda = getPumpFunBondingCurvePda(mint);
  assert.equal(typeof pda, "string");
  assert.ok(pda && pda.length >= 32 && pda.length <= 44);
});

test("audit 2.1: resolveSystemHolderAddresses includes Raydium v4 authority and bonding curve PDA", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const mockFetch: any = async () => ({
    ok: true,
    json: async () => ({
      result: {
        value: [
          { data: { parsed: { info: { owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" } } } },
        ],
      },
    }),
  });
  const tokenAccount = "RaydiumPoolVault1111111111111111111111111111";
  const systemAddrs = await resolveSystemHolderAddresses(mockFetch, "https://api.devnet.solana.com", [tokenAccount], mint);
  assert.ok(systemAddrs);
  assert.ok(systemAddrs.has(tokenAccount), "Token account owned by Raydium v4 authority must be included");
  const bondingCurve = getPumpFunBondingCurvePda(mint);
  assert.ok(bondingCurve && systemAddrs.has(bondingCurve), "pump.fun bonding curve PDA must be included");
});

test("audit 2.1: computeTop10Pct excludes AMM and bonding curve accounts from concentration calculation", () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const bondingCurve = getPumpFunBondingCurvePda(mint)!;
  const totalSupplyBaseUnits = "1000000000000000"; // 1B with 6 decimals

  // 1. Without filtering: bonding curve holds 80% -> top10 would be 80% (high toxic concentration)
  const holdersWithAmm = [
    { address: bondingCurve, amount: "800000000000000" },
    { address: "Holder111111111111111111111111111111111111", amount: "50000000000000" },
    { address: "Holder222222222222222222222222222222222222", amount: "50000000000000" },
  ];

  // 2. With systemHolders: bonding curve is excluded, remaining top holders only hold 100M / 1B = 10%
  const systemHolders = new Set([bondingCurve]);
  const top10Pct = computeTop10Pct(totalSupplyBaseUnits, 6, holdersWithAmm, systemHolders);
  assert.equal(top10Pct, 10, "AMM/bonding curve pools must be excluded so top10 is only 10%");
});
