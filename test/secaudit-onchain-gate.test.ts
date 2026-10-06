import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import { createServer } from "../src/http-server.js";

// SECAUDIT-H4: POST /scan triggers on-chain side effects (hook-bridge write to
// the destination wallet's scan-record PDA, and the oracle memo commit when
// RADAR_ORACLE=1) signed and paid for by the operator's key. /scan was
// reachable by anonymous callers unless RADAR_AUTH_HEAVY=1, so any client could
// make the operator's key sign and pay for transactions for arbitrary wallets.
// On-chain writes must now require a valid API token (or an explicit opt-in).
// Only non-default config (a hook bridge or RADAR_ORACLE=1) makes this reachable.

function bridgeSpy() {
  const calls: unknown[] = [];
  return {
    calls,
    hookBridge: async (rec: unknown) => {
      calls.push(rec);
      return { success: true, signature: "sig", slot: 1 };
    },
  };
}

async function start(opts: Parameters<typeof createServer>[0]) {
  const server = createServer({
    rateLimitPerMin: 0,
    apiKey: "k",
    fetchTxs: async () => [],
    fetchPrices: async () => ({}),
    fetchMintRisk: async () => ({}),
    ...opts,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function scan(base: string, wallet: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ wallet }),
  });
}

describe("secaudit: on-chain side effects of /scan require authorization", () => {
  // Let undici sockets finish closing before --test-force-exit tears the process down
  // (otherwise libuv aborts on Windows: UV_HANDLE_CLOSING assertion).
  after(() => new Promise<void>((r) => setTimeout(r, 200)));

  test("anonymous /scan returns the verdict but does NOT invoke the hook bridge", async () => {
    const prev = process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_ALLOW_ANON_ONCHAIN_WRITES;
    const spy = bridgeSpy();
    const s = await start({ hookBridge: spy.hookBridge, apiToken: "tok-123" });
    try {
      const res = await scan(s.base, Keypair.generate().publicKey.toBase58());
      assert.equal(res.status, 200, "read-only scan stays available to anonymous callers");
      const body = (await res.json()) as Record<string, unknown>;
      assert.ok("riskScore" in body);
      assert.equal(spy.calls.length, 0, "anonymous caller must not trigger an operator-signed on-chain write");
      assert.equal(body.hookBridge, undefined);
    } finally {
      await s.close();
      if (prev !== undefined) process.env.RADAR_API_TOKEN = prev;
    }
  });

  test("no token configured at all: still no on-chain write for anonymous callers", async () => {
    const prev = process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_ALLOW_ANON_ONCHAIN_WRITES;
    const spy = bridgeSpy();
    const s = await start({ hookBridge: spy.hookBridge });
    try {
      const res = await scan(s.base, Keypair.generate().publicKey.toBase58());
      assert.equal(res.status, 200);
      await res.arrayBuffer();
      assert.equal(spy.calls.length, 0);
    } finally {
      await s.close();
      if (prev !== undefined) process.env.RADAR_API_TOKEN = prev;
    }
  });

  test("a wrong token does not unlock the on-chain write", async () => {
    const spy = bridgeSpy();
    const s = await start({ hookBridge: spy.hookBridge, apiToken: "tok-123" });
    try {
      const res = await scan(s.base, Keypair.generate().publicKey.toBase58(), { Authorization: "Bearer nope" });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
      assert.equal(spy.calls.length, 0);
    } finally {
      await s.close();
    }
  });

  test("a valid Bearer token still publishes to the hook bridge", async () => {
    const spy = bridgeSpy();
    const s = await start({ hookBridge: spy.hookBridge, apiToken: "tok-123" });
    try {
      const res = await scan(s.base, Keypair.generate().publicKey.toBase58(), { Authorization: "Bearer tok-123" });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
      assert.equal(spy.calls.length, 1);
    } finally {
      await s.close();
    }
  });

  test("explicit opt-in allowAnonymousOnchainWrites restores anonymous publishing", async () => {
    const spy = bridgeSpy();
    const s = await start({ hookBridge: spy.hookBridge, allowAnonymousOnchainWrites: true });
    try {
      const res = await scan(s.base, Keypair.generate().publicKey.toBase58());
      assert.equal(res.status, 200);
      await res.arrayBuffer();
      assert.equal(spy.calls.length, 1);
    } finally {
      await s.close();
    }
  });
});
