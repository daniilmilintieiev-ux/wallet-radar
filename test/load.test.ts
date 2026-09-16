import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import { createServer } from "../src/http-server.js";
import type { EnhancedTx } from "../src/types.js";

function startServer(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const close = () =>
        new Promise<void>((res) => {
          (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close(() => res());
        });
      resolve({ port: addr.port, close });
    });
  });
}

const directLookup: http.RequestOptions["lookup"] = (_hostname, _options, callback) => {
  callback(null, "127.0.0.1", 4);
};

function postScan(
  port: number,
  payload: string,
  agent: http.Agent,
): Promise<{ status: number; body: Record<string, unknown>; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/scan",
        method: "POST",
        agent,
        lookup: directLookup,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const durationMs = performance.now() - t0;
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), durationMs });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Load Test: POST /scan concurrency and latency", () => {
  test("50 concurrent POST /scan requests meet latency, status, and payload assertions", async () => {
    const mockTx: EnhancedTx = {
      signature: "5wK4JkU1Z7v4Kq8qF7v4Kq8qF7v4Kq8qF7v4Kq8qF7v4Kq8qF7v4Kq8qF7v4Kq8qF7v4Kq8qF7v4Kq8qF7v4Kq8q",
      timestamp: Math.floor(Date.now() / 1000) - 120,
      source: "JUPITER",
      programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    };

    const server = createServer({
      apiKey: "mock-helius-key",
      rateLimitPerMin: 10000,
      fetchTxs: async (_wallet: string) => [mockTx],
      fetchPrices: async () => ({}),
      fetchMintRisk: async () => ({}),
    });

    const { port, close } = await startServer(server);
    const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });

    try {
      const sampleWallet = Keypair.generate().publicKey.toBase58();
      const payload = JSON.stringify({ wallet: sampleWallet });
      const totalRequests = 50;

      // Warm-up connections to initialize sockets and handlers
      await Promise.all(
        Array.from({ length: 10 }, () => postScan(port, payload, httpAgent)),
      );

      const requests = Array.from({ length: totalRequests }, () =>
        postScan(port, payload, httpAgent),
      );

      const results = await Promise.all(requests);

      // Latency percentiles
      const latencies = results.map((r) => r.durationMs).sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.50)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];

      console.log(`[load-test] Total: ${results.length} reqs | p50: ${p50.toFixed(2)}ms | p95: ${p95.toFixed(2)}ms | p99: ${p99.toFixed(2)}ms`);

      // Assertions
      for (const r of results) {
        assert.ok(r.status < 500, `Expected non-5xx response, got ${r.status}`);
        assert.equal(r.status, 200, `Expected 200 status, got ${r.status}`);
        assert.equal(typeof r.body.riskScore, "number", "response must contain riskScore number");
        assert.equal(typeof r.body.verdict, "string", "response must contain verdict string");
      }

      assert.ok(p99 < 200, `p99 latency (${p99.toFixed(2)}ms) must be < 200ms`);
    } finally {
      httpAgent.destroy();
      await close();
    }
  });
});
