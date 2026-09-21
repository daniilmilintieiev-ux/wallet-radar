import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalletTransactions, fetchWalletHistory, HttpError } from "../src/collector.js";
import { USDC_MINT } from "../src/types.js";
import type { EnhancedTx } from "../src/types.js";

const WALLET = "WappetTest1111111111111111111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("fetchWalletTransactions passes validated txs through with all fields intact", async () => {
  const originalFetch = globalThis.fetch;
  const txs: EnhancedTx[] = [
    {
      signature: "sig1",
      timestamp: 1700000000,
      source: "JUPITER",
      programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      swap: {
        nativeInput: { amount: 1000 },
        tokenOutputs: [{ mint: USDC_MINT, rawTokenAmount: { tokenAmount: "50", decimals: 6 } }],
      },
      tokenTransfers: [
        {
          fromUserAccount: WALLET,
          toUserAccount: "OtherWallet11111111111111111111111",
          tokenAmount: 50,
          mint: USDC_MINT,
        },
      ],
      counterparties: ["OtherWallet11111111111111111111111"],
    },
  ];
  globalThis.fetch = async () => jsonResponse(txs);
  try {
    const out = await fetchWalletTransactions("key", WALLET);
    assert.deepEqual(out, txs);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWalletTransactions skips malformed items and warns", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };
  const body: unknown[] = [
    { signature: "good1", timestamp: 1 },
    { signature: "", timestamp: 2 },
    { signature: "good3", timestamp: "soon" },
    null,
    { signature: "good5", timestamp: 5 },
  ];
  globalThis.fetch = async () => jsonResponse(body);
  try {
    const out = await fetchWalletTransactions("key", WALLET);
    assert.deepEqual(out.map((t) => t.signature), ["good1", "good5"]);
    assert.ok(warnings >= 1, "expected a warning for skipped items");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("fetchWalletTransactions degrades to an empty list on a non-array body", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };
  globalThis.fetch = async () => jsonResponse({ error: "weird shape" });
  try {
    const out = await fetchWalletTransactions("key", WALLET);
    assert.deepEqual(out, []);
    assert.ok(warnings >= 1, "expected a warning for the non-array body");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("fetchWalletTransactions rejects an invalid wallet address with HttpError 400", async () => {
  await assert.rejects(
    () => fetchWalletTransactions("key", "0OOO111111111111111111111111111111111111"),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );
});

test("fetchWalletHistory pages with signature cursors and stops on a short page", async () => {
  const originalFetch = globalThis.fetch;
  const page1: EnhancedTx[] = [
    { signature: "sigA", timestamp: 1 },
    { signature: "sigB", timestamp: 2 },
    { signature: "sigC", timestamp: 3 },
  ];
  const page2: EnhancedTx[] = [{ signature: "sigD", timestamp: 4 }];
  const seenUrls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const u = String(input);
    seenUrls.push(u);
    if (u.includes("before=sigC")) return jsonResponse(page2);
    return jsonResponse(page1);
  };
  try {
    const out = await fetchWalletHistory("key", WALLET, { limit: 3, maxPages: 5 });
    assert.deepEqual(out.map((t) => t.signature), ["sigA", "sigB", "sigC", "sigD"]);
    assert.equal(seenUrls.length, 2);
    assert.ok(seenUrls[1].includes("before=sigC"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWalletHistory uses the last valid item signature as the paging cursor", async () => {
  const originalFetch = globalThis.fetch;
  const page1: EnhancedTx[] = [
    { signature: "sigA", timestamp: 1 },
    { signature: "sigB", timestamp: 2 },
    { signature: "sigC", timestamp: 3 },
  ];
  const page2: unknown[] = [
    { signature: "sigD", timestamp: 4 },
    { signature: "", timestamp: 5 },
    { signature: "sigF", timestamp: 6 },
  ];
  const seenUrls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const u = String(input);
    seenUrls.push(u);
    if (u.includes("before=sigC")) return jsonResponse(page2);
    return jsonResponse(page1);
  };
  try {
    const out = await fetchWalletHistory("key", WALLET, { limit: 3, maxPages: 5 });
    assert.deepEqual(out.map((t) => t.signature), ["sigA", "sigB", "sigC", "sigD", "sigF"]);
    assert.ok(seenUrls[1].includes("before=sigC"));
    assert.equal(seenUrls.length, 2, "short (post-filter) page must stop pagination");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWalletHistory stops cleanly when a page is not an array", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ error: "weird shape" });
  };
  try {
    const out = await fetchWalletHistory("key", WALLET, { limit: 10, maxPages: 5 });
    assert.deepEqual(out, []);
    assert.equal(calls, 1, "must not loop when the page degrades to an empty batch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
