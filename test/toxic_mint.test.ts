import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, MAJOR_MINTS } from "../src/analyzer.js";
import {
  collectCandidateMints,
  fetchMintMetadata,
  fetchSwapMintRisk,
  parseDasAssetResponse,
  parseRpcAccountInfoResponse,
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
  assert.equal(walletReport.anomalyCount, 1);
  assert.equal(walletReport.riskScore, 30); // high severity = 30 pts

  const recorded = store.recentAnomalies(WALLET, 10);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "TOXIC_MINT");
  assert.equal(recorded[0].severity, "high");

  assert.equal(sentAlerts.length, 1);
  assert.match(sentAlerts[0], /TOXIC_MINT/);

  store.close();
});
