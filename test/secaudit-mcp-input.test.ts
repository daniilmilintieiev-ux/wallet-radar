import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "../src/mcp.js";

// SECAUDIT step 5(b): MCP tool arguments are untrusted (an LLM agent can be prompt-
// injected into sending hostile values). Wallet/mint arguments must be rejected
// before any upstream call. fetch is replaced by a counter: any network attempt fails the test.

async function client() {
  const server = buildServer({});
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const responses = new Map<number, any>();
  c.onmessage = (m: any) => {
    if (m.id !== undefined) responses.set(m.id, m);
  };
  await c.start();
  let id = 1;
  const request = async (method: string, params: unknown) => {
    const rid = id++;
    await c.send({ jsonrpc: "2.0", id: rid, method, params } as any);
    while (!responses.has(rid)) await new Promise((r) => setTimeout(r, 5));
    return responses.get(rid);
  };
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await c.send({ jsonrpc: "2.0", method: "notifications/initialized" } as any);
  return { request, close: async () => { await server.close(); await c.close(); } };
}

const HOSTILE = ["../../etc/passwd", "https://evil.example/x?k=", "A".repeat(5000), "abc def", "<script>alert(1)</script>", "11111111111111111111111111111111111111111111111111"];

describe("secaudit MCP: hostile wallet arguments are rejected before any network call", () => {
  const realFetch = globalThis.fetch;
  const savedKey = process.env.HELIUS_API_KEY;
  let netCalls = 0;
  globalThis.fetch = (async () => {
    netCalls++;
    throw new Error("network must not be reached");
  }) as typeof fetch;
  process.env.HELIUS_API_KEY = "test-key-not-real";
  after(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = savedKey;
  });

  test("radar_scan, radar_trust, radar_simulate reject invalid wallets with isError", async () => {
    const c = await client();
    try {
      for (const bad of HOSTILE) {
        for (const [name, args] of [
          ["radar_scan", { wallet: bad }],
          ["radar_trust", { wallet: bad }],
          ["radar_simulate", { wallet: bad, amountUsd: 5 }],
        ] as const) {
          const res = await c.request("tools/call", { name, arguments: args });
          assert.equal(res.result?.isError, true, `${name} must reject ${bad.slice(0, 30)}`);
        }
      }
      assert.equal(netCalls, 0);
    } finally {
      await c.close();
    }
  });

  test("radar_batch rejects a batch containing any invalid wallet and caps the batch at 20", async () => {
    const c = await client();
    try {
      const good = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
      let res = await c.request("tools/call", { name: "radar_batch", arguments: { wallets: [good, HOSTILE[1]] } });
      assert.equal(res.result?.isError, true);
      res = await c.request("tools/call", { name: "radar_batch", arguments: { wallets: Array.from({ length: 21 }, () => good) } });
      assert.ok(res.error || res.result?.isError, "21 wallets must be refused");
      assert.equal(netCalls, 0);
    } finally {
      await c.close();
    }
  });

  test("radar_gate_copy: hostile targetWallet and mint do not reach the network", async () => {
    const c = await client();
    try {
      for (const bad of HOSTILE) {
        const res = await c.request("tools/call", { name: "radar_gate_copy", arguments: { targetWallet: bad, copyAmountUsd: 10, mint: bad } });
        assert.equal(res.result?.isError, true, `gate_copy must refuse ${bad.slice(0, 30)}`);
      }
      assert.equal(netCalls, 0);
    } finally {
      await c.close();
    }
  });

  test("radar_analyze rejects non-array, non-JSON and schema-invalid txs", async () => {
    const c = await client();
    try {
      const w = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
      for (const txs of ["not json", "{}", '[{"signature":1}]', '[{"timestamp":"x"}]', "[null]"]) {
        const res = await c.request("tools/call", { name: "radar_analyze", arguments: { wallet: w, txs } });
        assert.equal(res.result?.isError, true, `txs=${txs}`);
      }
    } finally {
      await c.close();
    }
  });

  test("numeric arguments out of range are refused by the schema", async () => {
    const c = await client();
    try {
      const w = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
      for (const args of [{ wallet: w, amountUsd: -1 }, { wallet: w, amountUsd: 0 }, { wallet: w, amountUsd: 1, maxRisk: 101 }]) {
        const res = await c.request("tools/call", { name: "radar_simulate", arguments: args });
        assert.ok(res.error || res.result?.isError, JSON.stringify(args));
      }
    } finally {
      await c.close();
    }
  });
});
