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

async function createTestClient() {
  const server = buildServer();
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

test("MCP: tools/list includes radar_scan, radar_analyze, radar_selftest", async () => {
  const client = await createTestClient();
  try {
    const res = await client.request("tools/list", {});
    assert.ok(res.result?.tools);
    const names = res.result.tools.map((t: { name: string }) => t.name);

    assert.ok(names.includes("radar_scan"), "radar_scan should be registered");
    assert.ok(names.includes("radar_analyze"), "radar_analyze should be registered");
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
      arguments: { wallet: "DemoWallet" },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /HELIUS_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.HELIUS_API_KEY = saved;
    await client.close();
  }
});
