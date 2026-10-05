import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "../src/mcp.js";

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: any;
}

async function createTestClient(options: Parameters<typeof buildServer>[0] = {}) {
  const server = buildServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const responses = new Map<number, JsonRpcResponse>();
  clientTransport.onmessage = (msg: any) => {
    if (msg.id !== undefined) responses.set(msg.id, msg);
  };
  await clientTransport.start();

  let id = 1;
  const request = async (method: string, params: unknown): Promise<JsonRpcResponse> => {
    const reqId = id++;
    await clientTransport.send({ jsonrpc: "2.0", id: reqId, method, params } as any);
    while (!responses.has(reqId)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return responses.get(reqId)!;
  };

  // MCP handshake
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as any);

  const close = async () => {
    await server.close();
    await clientTransport.close();
  };

  return { request, close };
}

test("MCP: tools/list includes radar_scan, radar_analyze, radar_trust, radar_batch, radar_selftest", async () => {
  const client = await createTestClient();
  try {
    const res = await client.request("tools/list", {});
    assert.ok(res.result?.tools);
    const names = res.result.tools.map((t: { name: string }) => t.name);

    assert.ok(names.includes("radar_scan"), "radar_scan should be registered");
    assert.ok(names.includes("radar_analyze"), "radar_analyze should be registered");
    assert.ok(names.includes("radar_trust"), "radar_trust should be registered");
    assert.ok(names.includes("radar_batch"), "radar_batch should be registered");
    assert.ok(names.includes("radar_selftest"), "radar_selftest should be registered");
  } finally {
    await client.close();
  }
});

test("MCP radar_selftest: returns offline health check fixture", async () => {
  const client = await createTestClient();
  try {
    const res = await client.request("tools/call", {
      name: "radar_selftest",
      arguments: {},
    });
    assert.equal(res.result.isError, undefined);
    assert.ok(Array.isArray(res.result.content));
    assert.equal(res.result.content[0].type, "text");

    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.riskScore, 0);
    assert.deepEqual(parsed.anomalies, []);
  } finally {
    await client.close();
  }
});

test("MCP radar_analyze: rejects invalid JSON / non-array txs with isError: true", async () => {
  const client = await createTestClient();
  try {
    // 1. Bad JSON syntax
    const res1 = await client.request("tools/call", {
      name: "radar_analyze",
      arguments: { wallet: "W1", txs: "{not json" },
    });
    assert.equal(res1.result.isError, true);
    assert.match(res1.result.content[0].text, /Invalid txs/);

    // 2. Valid JSON but not an array
    const res2 = await client.request("tools/call", {
      name: "radar_analyze",
      arguments: { wallet: "W1", txs: '{"not": "an array"}' },
    });
    assert.equal(res2.result.isError, true);
    assert.match(res2.result.content[0].text, /Invalid txs/);
  } finally {
    await client.close();
  }
});

test("MCP radar_analyze: analyzes valid transaction fixture", async () => {
  const client = await createTestClient();
  try {
    const fixture = [
      { signature: "tx1", timestamp: 1000, source: "RAYDIUM", programs: ["p1"] },
      { signature: "tx2", timestamp: 1010, source: "RAYDIUM", programs: ["p1"] },
      { signature: "tx3", timestamp: 1020, source: "RAYDIUM", programs: ["p1"] },
      { signature: "tx4", timestamp: 1030, source: "RAYDIUM", programs: ["p1"] },
      { signature: "tx5", timestamp: 1040, source: "RAYDIUM", programs: ["p1"] },
    ];

    const res = await client.request("tools/call", {
      name: "radar_analyze",
      arguments: { wallet: "W1", txs: JSON.stringify(fixture) },
    });

    assert.equal(res.result.isError, undefined);
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.wallet, "W1");
    assert.equal(parsed.txCount, 5);
    assert.equal(parsed.riskScore, 15);
    assert.equal(parsed.anomalies.length, 1);
    assert.equal(parsed.anomalies[0].type, "ACTIVITY_BURST");
  } finally {
    await client.close();
  }
});

test("MCP radar_scan: reports error when HELIUS_API_KEY is not set", async () => {
  const saved = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  const client = await createTestClient();
  try {
    const res = await client.request("tools/call", {
      name: "radar_scan",
      arguments: { wallet: "11111111111111111111111111111111" },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /HELIUS_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.HELIUS_API_KEY = saved;
    await client.close();
  }
});

test("MCP radar_gate_copy: fetches mintRisk for body.mint and blocks on freezeAuthority (mirrors http-server.ts toolGateCopy)", async () => {
  const originalFetch = globalThis.fetch;
  const savedApiKey = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "test_api_key";
  const targetWallet = "WappetTest111111111111111111111111111111111";
  const toxicMint = "7ktc9XbVMcShzkpV7gofTEBCqvSVTvw66MCvFCYDpump";

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const bodyStr = init?.body ? String(init.body) : "";

    // Helius history: clean wallet, no anomalies -> runTrustCheck resolves "safe".
    if (urlStr.includes("helius.xyz") || urlStr.includes("/v0/addresses")) {
      return new Response(
        JSON.stringify([
          { signature: "sigHist1", timestamp: Math.floor(Date.now() / 1000) - 3600, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("jup.ag")) {
      return new Response(JSON.stringify({ So11111111111111111111111111111111111111112: { usdPrice: 150 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (bodyStr) {
      let parsed: any;
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        parsed = null;
      }
      if (parsed?.method === "getBalance") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 1_000_000_000 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (parsed?.method === "getTokenAccountsByOwner") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 50 } } } } } }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (parsed?.method === "getAsset") {
        // DAS lookup fails -> fetchMintMetadata falls back to plain getAccountInfo below.
        return new Response(JSON.stringify({ error: "DAS not available in test" }), { status: 500 });
      }
      if (parsed?.method === "getAccountInfo") {
        const address = parsed.params?.[0];
        if (address === toxicMint) {
          // Mint account: active freezeAuthority, no supply field -> fetchMintMetadata
          // skips the top10Pct/getTokenLargestAccounts call entirely.
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { freezeAuthority: "FreezeAuth1111111111111111111111111111111", mintAuthority: null, isInitialized: true } } } } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Wallet account-authority check (trust.ts fetchAccountOwner) -> plain System account.
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { owner: "11111111111111111111111111111111" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  const client = await createTestClient();
  try {
    const res = await client.request("tools/call", {
      name: "radar_gate_copy",
      arguments: { targetWallet, copyAmountUsd: 50, mint: toxicMint },
    });
    assert.equal(res.result.isError, undefined);
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.allow, false, "should be blocked because the mint has an active freezeAuthority");
    assert.equal(parsed.action, "block");
    assert.ok(
      parsed.details?.simulation?.wouldTrigger?.includes("TOXIC_MINT"),
      `expected wouldTrigger to include TOXIC_MINT, got ${JSON.stringify(parsed.details?.simulation?.wouldTrigger)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (savedApiKey !== undefined) process.env.HELIUS_API_KEY = savedApiKey;
    else delete process.env.HELIUS_API_KEY;
    await client.close();
  }
});

test("MCP radar_batch: reports error when HELIUS_API_KEY is not set", async () => {
  const saved = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  const client = await createTestClient();
  try {
    const res = await client.request("tools/call", {
      name: "radar_batch",
      arguments: { wallets: ["5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8"] },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /HELIUS_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.HELIUS_API_KEY = saved;
    await client.close();
  }
});

test("A7: radar_trust and radar_batch validate address bounds and base58 charset", async () => {
  const savedKey = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "test_mock_key";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const client = await createTestClient();
  try {
    const invalidAddresses = [
      "1".repeat(31), // length 31 (under)
      "1".repeat(45), // length 45 (over)
      "0" + "1".repeat(31), // '0' is not base58
      "O" + "1".repeat(31), // 'O' is not base58
      "I" + "1".repeat(31), // 'I' is not base58
      "l" + "1".repeat(31), // 'l' is not base58
    ];

    for (const badAddr of invalidAddresses) {
      // radar_trust
      const resTrust = await client.request("tools/call", {
        name: "radar_trust",
        arguments: { wallet: badAddr },
      });
      assert.equal(resTrust.result.isError, true, `radar_trust with '${badAddr}' must return isError: true`);
      assert.match(resTrust.result.content[0].text, /base58|address/i);

      // radar_batch
      const resBatch = await client.request("tools/call", {
        name: "radar_batch",
        arguments: { wallets: [badAddr] },
      });
      assert.equal(resBatch.result.isError, true, `radar_batch with '${badAddr}' must return isError: true`);
      assert.match(resBatch.result.content[0].text, /base58|address/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey !== undefined) process.env.HELIUS_API_KEY = savedKey;
    else delete process.env.HELIUS_API_KEY;
    await client.close();
  }
});

test("A8: MCP radar_gate_copy returns tokenCheck ('applied', 'skipped_no_mint', 'skipped_no_amount', 'skipped_base_verdict')", async () => {
  const originalFetch = globalThis.fetch;
  const savedApiKey = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "test_api_key";
  const safeWallet = "SafeWa11et111111111111111111111111111111111";
  const unknownWallet = "UnknwnWa11et1111111111111111111111111111111";
  const testMint = "7ktc9XbVMcShzkpV7gofTEBCqvSVTvw66MCvFCYDpump";

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const bodyStr = init?.body ? String(init.body) : "";

    if (urlStr.includes(unknownWallet)) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (urlStr.includes("helius.xyz") || urlStr.includes("/v0/addresses")) {
      return new Response(
        JSON.stringify([
          { signature: "sig1", timestamp: Math.floor(Date.now() / 1000) - 3600, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("jup.ag")) {
      return new Response(JSON.stringify({ So11111111111111111111111111111111111111112: { usdPrice: 150 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (bodyStr) {
      let parsed: any;
      try { parsed = JSON.parse(bodyStr); } catch {}
      if (parsed?.method === "getBalance") {
        if (parsed.params?.[0] === unknownWallet) {
          return new Response(JSON.stringify({ error: "not found" }), { status: 500 });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 1_000_000_000 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (parsed?.method === "getTokenAccountsByOwner") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 100 } } } } } }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (parsed?.method === "getAccountInfo") {
        const address = parsed.params?.[0];
        if (address === testMint) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { freezeAuthority: null, mintAuthority: null, isInitialized: true } } } } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { owner: "11111111111111111111111111111111" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  const client = await createTestClient();
  try {
    // 1. skipped_base_verdict
    const resBase = await client.request("tools/call", {
      name: "radar_gate_copy",
      arguments: { targetWallet: unknownWallet, copyAmountUsd: 50, mint: testMint },
    });
    const parsedBase = JSON.parse(resBase.result.content[0].text);
    assert.equal(parsedBase.tokenCheck, "skipped_base_verdict");

    // 2. skipped_no_mint
    const resNoMint = await client.request("tools/call", {
      name: "radar_gate_copy",
      arguments: { targetWallet: safeWallet, copyAmountUsd: 50 },
    });
    const parsedNoMint = JSON.parse(resNoMint.result.content[0].text);
    assert.equal(parsedNoMint.tokenCheck, "skipped_no_mint");

    // 3. skipped_no_amount
    const resNoAmount = await client.request("tools/call", {
      name: "radar_gate_copy",
      arguments: { targetWallet: safeWallet, mint: testMint },
    });
    const parsedNoAmount = JSON.parse(resNoAmount.result.content[0].text);
    assert.equal(parsedNoAmount.tokenCheck, "skipped_no_amount");

    // 4. applied
    const resApplied = await client.request("tools/call", {
      name: "radar_gate_copy",
      arguments: { targetWallet: safeWallet, copyAmountUsd: 50, mint: testMint },
    });
    const parsedApplied = JSON.parse(resApplied.result.content[0].text);
    assert.equal(parsedApplied.tokenCheck, "applied");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedApiKey !== undefined) process.env.HELIUS_API_KEY = savedApiKey;
    else delete process.env.HELIUS_API_KEY;
    await client.close();
  }
});

test("B2: MCP radar_gate_copy caps the verdict at manual_review when fetchMintMetadata throws (tokenCheck='unavailable')", async () => {
  const originalFetch = globalThis.fetch;
  const savedApiKey = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "test_api_key";
  const safeWallet = "SafeWa11et111111111111111111111111111111111";
  const testMint = "7ktc9XbVMcShzkpV7gofTEBCqvSVTvw66MCvFCYDpump";

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const bodyStr = init?.body ? String(init.body) : "";
    if (urlStr.includes("helius.xyz") || urlStr.includes("/v0/addresses")) {
      return new Response(
        JSON.stringify([{ signature: "sig1", timestamp: Math.floor(Date.now() / 1000) - 3600, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("jup.ag")) {
      return new Response(JSON.stringify({ So11111111111111111111111111111111111111112: { usdPrice: 150 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (bodyStr) {
      let parsed: any;
      try { parsed = JSON.parse(bodyStr); } catch {}
      if (parsed?.method === "getBalance") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 1_000_000_000 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (parsed?.method === "getTokenAccountsByOwner") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 100 } } } } } }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  const client = await createTestClient({
    fetchMintMetadata: async () => {
      throw new Error("mocked RPC timeout");
    },
  });
  try {
    const res = await client.request("tools/call", {
      name: "radar_gate_copy",
      arguments: { targetWallet: safeWallet, copyAmountUsd: 50, mint: testMint },
    });
    assert.equal(res.result.isError, undefined);
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.tokenCheck, "unavailable", `expected tokenCheck 'unavailable', got ${JSON.stringify(parsed)}`);
    assert.equal(parsed.action, "manual_review", "a mint-check failure with a real USD amount must cap the verdict at manual_review");
    assert.equal(parsed.allow, false, "manual_review must not allow execution");
    assert.ok(parsed.details?.tokenCheckAnomaly, "response must include the TOKEN_CHECK_UNAVAILABLE anomaly");
    assert.equal(parsed.details.tokenCheckAnomaly.type, "TOKEN_CHECK_UNAVAILABLE");
    assert.equal(parsed.details.tokenCheckAnomaly.severity, "low");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedApiKey !== undefined) process.env.HELIUS_API_KEY = savedApiKey;
    else delete process.env.HELIUS_API_KEY;
    await client.close();
  }
});

