import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import { createServer, clientIp, createRateLimiter } from "../src/http-server.js";
import { getVersion } from "../src/mcp-server.js";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { watchOnce } from "../src/watch.js";
import type { EnhancedTx } from "../src/types.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverScript = path.join(rootDir, "dist/src/http-server.js");
const binScript = path.join(rootDir, "bin/http-server");

function runCommand(file: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: rootDir }, (err, stdout, stderr) => {
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: err ? (err.code as number ?? 1) : 0 });
    });
  });
}

interface Running {
  base: string;
  close: () => Promise<void>;
}

async function startTestServer(): Promise<Running> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return { base, close };
}

test("http-server CLI: --version prints version and exits 0", async () => {
  const res = await runCommand("node", [serverScript, "--version"]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), getVersion());
});

test("http-server CLI: --health outputs valid JSON health object", async () => {
  const res = await runCommand("node", [serverScript, "--health"]);
  assert.equal(res.code, 0);
  const health = JSON.parse(res.stdout.trim());
  assert.equal(health.ok, true);
  assert.equal(health.service, "wallet-radar");
  assert.equal(health.transport, "http");
  assert.ok(Array.isArray(health.endpoints));
});

test("http-server bin: bin/http-server supports --version", async () => {
  const res = await runCommand("node", [binScript, "--version"]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), getVersion());
});

test("http-server: rate limiting returns 429 when per-minute limit exceeded", async () => {
  const server = createServer({ rateLimitPerMin: 3 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/`);
      assert.equal(r.status, 200);
    }
    const r4 = await fetch(`${base}/`);
    assert.equal(r4.status, 429);
    const body = (await r4.json()) as { error: string; retryAfterSec: number };
    assert.equal(body.error, "Too Many Requests");
    assert.ok(body.retryAfterSec >= 1);
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("http-server: clientIp resolves proxy headers (audit 1.3 & 1.6)", () => {
  const prevTrust = process.env.RADAR_TRUST_PROXY;
  try {
    const base = { socket: { remoteAddress: "::ffff:127.0.0.1" } } as any;

    // No headers -> socket address without the IPv4-mapped prefix
    assert.equal(clientIp({ ...base, headers: {} }), "127.0.0.1");

    // Without RADAR_TRUST_PROXY=1, proxy headers are ignored (client-spoofable)
    delete process.env.RADAR_TRUST_PROXY;
    assert.equal(
      clientIp({ ...base, headers: { "cf-connecting-ip": "203.0.113.7" } }),
      "127.0.0.1",
    );
    assert.equal(
      clientIp({ ...base, headers: { "x-forwarded-for": "198.51.100.9, 127.0.0.1" } }),
      "127.0.0.1",
    );

    // With RADAR_TRUST_PROXY=1, CF-Connecting-IP is trusted
    process.env.RADAR_TRUST_PROXY = "1";
    assert.equal(
      clientIp({ ...base, headers: { "cf-connecting-ip": "203.0.113.7" } }),
      "203.0.113.7",
    );

    // With RADAR_TRUST_PROXY=1 the first XFF hop is used when CF is absent
    assert.equal(
      clientIp({ ...base, headers: { "x-forwarded-for": "198.51.100.9, 127.0.0.1" } }),
      "198.51.100.9",
    );

    // CF-Connecting-IP still wins over XFF
    assert.equal(
      clientIp({
        ...base,
        headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" },
      }),
      "203.0.113.7",
    );
  } finally {
    if (prevTrust === undefined) delete process.env.RADAR_TRUST_PROXY;
    else process.env.RADAR_TRUST_PROXY = prevTrust;
  }
});

test("http-server: rate limits stay per-client behind a proxy (audit 1.6)", async () => {
  const prevTrust = process.env.RADAR_TRUST_PROXY;
  process.env.RADAR_TRUST_PROXY = "1";
  const server = createServer({ rateLimitPerMin: 2 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const hit = (client: string) =>
      fetch(base, { headers: { "CF-Connecting-IP": client } });

    // Client A exhausts its own 2/min bucket
    assert.equal((await hit("198.51.100.1")).status, 200);
    assert.equal((await hit("198.51.100.1")).status, 200);
    assert.equal((await hit("198.51.100.1")).status, 429);

    // Client B (same proxy socket) is unaffected
    assert.equal((await hit("198.51.100.2")).status, 200);
  } finally {
    if (prevTrust === undefined) delete process.env.RADAR_TRUST_PROXY;
    else process.env.RADAR_TRUST_PROXY = prevTrust;
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("http-server: GET /health returns 200 ok=true", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
  } finally {
    await r.close();
  }
});

test("http-server: GET / returns service info with endpoints", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, "wallet-radar");
    assert.ok(Array.isArray(body.endpoints));
  } finally {
    await r.close();
  }
});

test("http-server: GET on a tool path is health-friendly (200 + descriptor)", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/scan`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tool, "radar_scan");
  } finally {
    await r.close();
  }
});

test("http-server: POST /selftest returns 200 ok=true", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/selftest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.riskScore, "number");
    assert.ok(Array.isArray(body.reasons));
    assert.equal(typeof body.summary, "string");
  } finally {
    await r.close();
  }
});

test("http-server: POST /analyze over a fixture returns riskScore and digest", async () => {
  const r = await startTestServer();
  try {
    const wallet = "DemoWallet11111111111111111111111111111111";
    const txs = [
      { signature: "sigA", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
      { signature: "sigB", timestamp: 1_700_000_120, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    ];
    const res = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, txs }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.txCount, 2);
    assert.equal(typeof body.riskScore, "number");
    assert.ok(Array.isArray(body.anomalies));
    assert.ok(Array.isArray(body.reasons));
    assert.equal(typeof body.summary, "string");
    assert.equal(typeof body.digest, "string");
  } finally {
    await r.close();
  }
});

test("http-server: POST /analyze accepts txs as a JSON string", async () => {
  const r = await startTestServer();
  try {
    const wallet = "DemoWallet11111111111111111111111111111111";
    const txs = [{ signature: "sigA", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] }];
    const res = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, txs: JSON.stringify(txs) }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.txCount, 1);
  } finally {
    await r.close();
  }
});

test("http-server: POST / with tool selector dispatches to selftest", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "selftest" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    await r.close();
  }
});

test("http-server: POST /scan without HELIUS_API_KEY returns 503", async () => {
  const r = await startTestServer();
  try {
    const prev = process.env.HELIUS_API_KEY;
    delete process.env.HELIUS_API_KEY;
    try {
      const res = await fetch(`${r.base}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8" }),
      });
      assert.equal(res.status, 503);
    } finally {
      if (prev === undefined) delete process.env.HELIUS_API_KEY;
      else process.env.HELIUS_API_KEY = prev;
    }
  } finally {
    await r.close();
  }
});

test("http-server: POST /scan with invalid wallet returns 400", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "not-a-wallet" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: malformed JSON body returns 400", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: POST /batch without HELIUS_API_KEY returns 503", async () => {
  const r = await startTestServer();
  try {
    const prev = process.env.HELIUS_API_KEY;
    delete process.env.HELIUS_API_KEY;
    try {
      const res = await fetch(`${r.base}/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets: ["5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8"] }),
      });
      assert.equal(res.status, 503);
    } finally {
      if (prev === undefined) delete process.env.HELIUS_API_KEY;
      else process.env.HELIUS_API_KEY = prev;
    }
  } finally {
    await r.close();
  }
});

test("http-server: POST /batch with empty wallets returns 400", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets: [] }),
    });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: POST /batch with a non-base58 wallet returns 400", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets: ["not-a-wallet"] }),
    });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: POST /batch over 20 wallets returns 400", async () => {
  const r = await startTestServer();
  try {
    const many = Array.from({ length: 21 }, () => "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8");
    const res = await fetch(`${r.base}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets: many }),
    });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: GET on /batch is health-friendly (200 + descriptor)", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/batch`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tool, "radar_batch");
  } finally {
    await r.close();
  }
});

test("http-server: unknown POST route returns 404", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/nope`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 404);
  } finally {
    await r.close();
  }
});

// ---- Monitoring watchlist (store-backed, enabled with RADAR_WATCH=1) ----

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME_MINT = "Meme111111111111111111111111111111111111111";

function makeSwapTx(
  sig: string,
  timestamp: number,
  inMint: string,
  inAmount: number,
  outMint: string,
  outAmount: number,
): EnhancedTx {
  return {
    signature: sig,
    timestamp,
    source: "JUPITER",
    type: "SWAP",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: inMint, rawTokenAmount: { tokenAmount: String(Math.round(inAmount * 1_000_000)), decimals: 6 } }],
      tokenOutputs: [{ mint: outMint, rawTokenAmount: { tokenAmount: String(Math.round(outAmount * 1_000_000)), decimals: 6 } }],
    },
  };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "radar-http-watch-"));
  return { store: new Store(path.join(dir, "radar.db")), dir };
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

interface WatchRunning {
  base: string;
  close: () => Promise<void>;
}

async function startWatchServer(store: Store, extra: Parameters<typeof createServer>[0] = {}): Promise<WatchRunning> {
  const server = createServer({ store, rateLimitPerMin: 0, ...extra });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return { base, close };
}

test("http-server: POST /watch adds a wallet to the watchlist", async () => {
  const { store, dir } = tmpStore();
  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
    const res = await fetch(`${r.base}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; wallet: string; watching: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.wallet, wallet);
    assert.deepEqual(body.watching, [wallet]);
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
  }
});

test("http-server: GET /watch lists watched wallets with seed status and unalerted count", async () => {
  const { store, dir } = tmpStore();
  const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
  store.addWallet(wallet);
  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const res = await fetch(`${r.base}/watch`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { count: number; watching: Array<{ wallet: string; seeded: boolean; unalerted: number }> };
    assert.equal(body.count, 1);
    assert.equal(body.watching[0].wallet, wallet);
    assert.equal(body.watching[0].seeded, false);
    assert.equal(body.watching[0].unalerted, 0);
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
  }
});

test("http-server: POST /unwatch removes a wallet from the watchlist", async () => {
  const { store, dir } = tmpStore();
  const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
  store.addWallet(wallet);
  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const res = await fetch(`${r.base}/unwatch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; watching: string[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.watching, []);
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
  }
});

test("http-server: watch endpoints return 503 when no store is configured", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/watch`);
    assert.equal(res.status, 503);
    const resAlerts = await fetch(`${r.base}/alerts`);
    assert.equal(resAlerts.status, 503);
    const resPoll = await fetch(`${r.base}/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(resPoll.status, 503);
  } finally {
    await r.close();
  }
});

test("http-server: RADAR_API_TOKEN gates mutating endpoints (401 without/with wrong token, 200 with Bearer)", async () => {
  const { store, dir } = tmpStore();
  const prev = process.env.RADAR_API_TOKEN;
  process.env.RADAR_API_TOKEN = "secret-token-123";
  const r = await startWatchServer(store, { apiKey: "key" });
  const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
  try {
    const noAuth = await fetch(`${r.base}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet }) });
    assert.equal(noAuth.status, 401);

    const wrongToken = await fetch(`${r.base}/watch`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" }, body: JSON.stringify({ wallet }) });
    assert.equal(wrongToken.status, 401);

    const ok = await fetch(`${r.base}/watch`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token-123" }, body: JSON.stringify({ wallet }) });
    assert.equal(ok.status, 200);

    const viaHeader = await fetch(`${r.base}/unwatch`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-token": "secret-token-123" }, body: JSON.stringify({ wallet }) });
    assert.equal(viaHeader.status, 200);

    // Read endpoints and read-only POSTs stay open.
    assert.equal((await fetch(`${r.base}/watch`)).status, 200);
    assert.equal((await fetch(`${r.base}/alerts`)).status, 200);
    const selftest = await fetch(`${r.base}/selftest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(selftest.status, 200);
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
    if (prev === undefined) delete process.env.RADAR_API_TOKEN;
    else process.env.RADAR_API_TOKEN = prev;
  }
});

test("http-server: RADAR_CORS_ORIGINS allowlist echoes listed origins and omits ACAO for others", async () => {
  const { store, dir } = tmpStore();
  const prev = process.env.RADAR_CORS_ORIGINS;
  process.env.RADAR_CORS_ORIGINS = "https://agent.example.com,https://other.example.com";
  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const listed = await fetch(`${r.base}/health`, { headers: { Origin: "https://agent.example.com" } });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("access-control-allow-origin"), "https://agent.example.com");
    assert.equal(listed.headers.get("vary"), "Origin");

    const stranger = await fetch(`${r.base}/health`, { headers: { Origin: "https://evil.example.com" } });
    assert.equal(stranger.status, 200);
    assert.equal(stranger.headers.get("access-control-allow-origin"), null);
    assert.equal(stranger.headers.get("vary"), "Origin");

    // Non-browser request (no Origin header) gets no ACAO header in allowlist mode.
    const noOrigin = await fetch(`${r.base}/health`);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
    if (prev === undefined) delete process.env.RADAR_CORS_ORIGINS;
    else process.env.RADAR_CORS_ORIGINS = prev;
  }
});

test("http-server: CORS stays open (*) when RADAR_CORS_ORIGINS is unset", async () => {
  const { store, dir } = tmpStore();
  const prev = process.env.RADAR_CORS_ORIGINS;
  delete process.env.RADAR_CORS_ORIGINS;
  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const res = await fetch(`${r.base}/health`, { headers: { Origin: "https://any.example.com" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
    if (prev === undefined) delete process.env.RADAR_CORS_ORIGINS;
    else process.env.RADAR_CORS_ORIGINS = prev;
  }
});

test("http-server: POST /watch with an invalid wallet returns 400", async () => {
  const { store, dir } = tmpStore();
  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const res = await fetch(`${r.base}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: "nope" }) });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
  }
});

test("http-server: POST /poll re-checks the watchlist, fires the alert sink, and records the anomaly", async () => {
  const { store, dir } = tmpStore();
  const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
  store.addWallet(wallet);

  // Seed the baseline with a modest $100 swap (median $100).
  const seedBatch = [makeSwapTx("seed1", 1_700_000_000, USDC_MINT, 100, MEME_MINT, 1000)];
  await watchOnce(store, "key", {
    fetchSeedHistory: async () => seedBatch,
    fetchPrices: async () => ({ [USDC_MINT]: 1.0, [MEME_MINT]: 0.01 }),
    fetchMintRisk: async () => ({}),
    usePrices: true,
  });
  const base = store.getBaseline(wallet);
  assert.ok(base !== null);
  assert.equal(base.medianSwapAmountUsd, 100);

  // Live fetch (injected) yields a 5x swap -> LARGE_SWAP on the next poll.
  const liveBatch = [makeSwapTx("live1", 1_700_000_100, USDC_MINT, 500, MEME_MINT, 5000)];
  const sent: string[] = [];
  const sink = { sent, async send(text: string) { sent.push(text); } };
  const r = await startWatchServer(store, {
    apiKey: "key",
    fetchTxs: async () => liveBatch,
    fetchPrices: async () => ({ [USDC_MINT]: 1.0, [MEME_MINT]: 0.01 }),
    fetchMintRisk: async () => ({}),
    sink,
  });
  try {
    const res = await fetch(`${r.base}/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { wallets: Array<{ wallet: string; seeded: boolean; anomalyCount: number }> };
    assert.equal(body.wallets.length, 1);
    assert.equal(body.wallets[0].wallet, wallet);
    assert.equal(body.wallets[0].seeded, false);
    assert.equal(body.wallets[0].anomalyCount, 2);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /LARGE_SWAP/);

    // GET /alerts reflects the recorded anomalies.
    const alertsRes = await fetch(`${r.base}/alerts`);
    assert.equal(alertsRes.status, 200);
    const alerts = (await alertsRes.json()) as { count: number; anomalies: Array<{ type: string }> };
    assert.equal(alerts.count, 2);
    assert.ok(alerts.anomalies.some((a) => a.type === "LARGE_SWAP"));
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
  }
});

test("http-server: in-process watch loop runs and stops on server close", async () => {
  const { store, dir } = tmpStore();
  const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
  store.addWallet(wallet);
  let calls = 0;
  const server = createServer({
    store,
    watch: true,
    apiKey: "key",
    pollMs: 10,
    rateLimitPerMin: 0,
    fetchTxs: async () => {
      calls += 1;
      return [];
    },
    fetchMintRisk: async () => ({}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const start = Date.now();
  while (calls === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(calls >= 1, `loop should have polled at least once (calls=${calls})`);

  (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  const afterClose = calls;
  await new Promise((r) => setTimeout(r, 50));
  const afterClose2 = calls;
  assert.equal(afterClose2, afterClose, `loop should stop after close (was ${afterClose}, then ${afterClose2})`);
  store.close();
  cleanup(dir);
});

test("http-server: GET /economics returns the P&L report (200)", async () => {
  const { store, dir } = tmpStore();
  const now = Math.floor(Date.now() / 1000);
  store.recordSettledPayment({ signature: "e1", payer: "P", recipient: "R", amount: 0.005, endpoint: "/scan" }, now);
  store.recordCostEvent({ ts: now, category: "helius", quantity: 1, unitPriceUsd: 0.0005, totalUsd: 0.0005 });
  const server = createServer({ store, rateLimitPerMin: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await fetch(`${base}/economics`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.service, "wallet-radar");
    assert.equal(body.revenue.totalUsdc, 0.005);
    assert.equal(body.cost.totalUsd, 0.0005);
    assert.equal(body.net.selfSustaining, true);
    assert.ok(Array.isArray(body.perDay));
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    store.close();
    cleanup(dir);
  }
});

test("http-server: GET /economics is 503 with no store", async () => {
  const server = createServer({ rateLimitPerMin: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await fetch(`${base}/economics`);
    assert.equal(res.status, 503);
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("http-server: 404 for unknown endpoints", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/non-existent-route`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("unknown GET route"));
  } finally {
    await r.close();
  }
});

test("http-server: POST /analyze with malformed JSON body returns 400 clean error", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not valid json {{{",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("body must be a JSON object"));
  } finally {
    await r.close();
  }
});

test("http-server: POST /simulate input validations (missing balances, negative amount, invalid token)", async () => {
  const r = await startTestServer();
  const validWallet = "11111111111111111111111111111111";
  try {
    // Missing balances
    const res1 = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: validWallet, amountUsd: 100 }),
    });
    assert.equal(res1.status, 400);
    const b1 = (await res1.json()) as { error: string };
    assert.ok(b1.error.includes("body.balances is required"));

    // Negative amountUsd
    const res2 = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: validWallet, amountUsd: -50, balances: { sol: 1, usdc: 10, usdt: 0 } }),
    });
    assert.equal(res2.status, 400);
    const b2 = (await res2.json()) as { error: string };
    assert.ok(b2.error.includes("body.amountUsd must be a positive number"));

    // Invalid token
    const res3 = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: validWallet, amountUsd: 100, token: "btc", balances: { sol: 1, usdc: 10, usdt: 0 } }),
    });
    assert.equal(res3.status, 400);
    const b3 = (await res3.json()) as { error: string };
    assert.ok(b3.error.includes("body.token must be 'usdc', 'usdt', or 'sol'"));
  } finally {
    await r.close();
  }
});

test("http-server: POST /trust error paths (503 without key, 400 with invalid wallet)", async () => {
  const r = await startTestServer();
  try {
    // 1. Invalid wallet -> 400
    const resBadWallet = await fetch(`${r.base}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "invalid_wallet" }),
    });
    assert.equal(resBadWallet.status, 400);
    const bodyBadWallet = (await resBadWallet.json()) as { error: string };
    assert.ok(bodyBadWallet.error.includes("Solana base58 address"));

    // 2. Missing HELIUS_API_KEY -> 503
    const prevKey = process.env.HELIUS_API_KEY;
    delete process.env.HELIUS_API_KEY;
    try {
      const resNoKey = await fetch(`${r.base}/trust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: "11111111111111111111111111111111" }),
      });
      assert.equal(resNoKey.status, 503);
      const bodyNoKey = (await resNoKey.json()) as { error: string };
      assert.ok(bodyNoKey.error.includes("HELIUS_API_KEY is not set"));
    } finally {
      if (prevKey !== undefined) process.env.HELIUS_API_KEY = prevKey;
      else delete process.env.HELIUS_API_KEY;
    }
  } finally {
    await r.close();
  }
});

test("http-server: POST /simulate invalid wallet returns 400", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "bad-wallet-123", amountUsd: 10, balances: { sol: 1, usdc: 10, usdt: 0 } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("Solana base58 address"));
  } finally {
    await r.close();
  }
});

test("http-server: POST /analyze with invalid txs parameter returns 400", async () => {
  const r = await startTestServer();
  try {
    // 1. txs is not an array or string
    const res1 = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "W1", txs: 12345 }),
    });
    assert.equal(res1.status, 400);
    const body1 = (await res1.json()) as { error: string };
    assert.ok(body1.error.includes("body.txs must be an array"));

    // 2. txs is an invalid JSON string
    const res2 = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "W1", txs: "{not json" }),
    });
    assert.equal(res2.status, 400);
    const body2 = (await res2.json()) as { error: string };
    assert.ok(body2.error.includes("body.txs must be a JSON array"));

    // 3. txs is a JSON string of an object, not array
    const res3 = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "W1", txs: "{\"key\": 123}" }),
    });
    assert.equal(res3.status, 400);
    const body3 = (await res3.json()) as { error: string };
    assert.ok(body3.error.includes("body.txs must be a JSON array"));
  } finally {
    await r.close();
  }
});

test("http-server: OPTIONS request returns CORS headers with 204", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/scan`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    await r.close();
  }
});



test("http-server: payload > 1MB returns 413 Payload Too Large", async () => {
  const r = await startTestServer();
  try {
    const hugePayload = "x".repeat(1_050_000);
    const res = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: hugePayload,
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Payload Too Large");
  } finally {
    await r.close();
  }
});

test("http-server: rate limiter exempts /health with query params", async () => {
  const server = createServer({ rateLimitPerMin: 2 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // /health?check=1 should be exempt even if called repeatedly
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/health?check=${i}`);
      assert.equal(res.status, 200);
    }
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("http-server: internal server error returns clean 500 without leaking stack traces", async () => {
  const server = createServer({
    fetchTxs: async () => {
      throw new Error("/var/secret/path/failed to connect to upstream RPC database: internal details");
    },
    apiKey: "test-helius-key",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await fetch(`${base}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8" }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Internal server error");
    assert.ok(!JSON.stringify(body).includes("/var/secret"));
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("http-server: GET /defense/:wallet and POST /defense/:wallet/clear validate base58 wallet", async () => {
  const { store, dir } = tmpStore();
  const server = createServer({ store, rateLimitPerMin: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const resGet = await fetch(`${base}/defense/invalid-wallet-address!`);
    assert.equal(resGet.status, 400);

    const resClear = await fetch(`${base}/defense/invalid-wallet-address!/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(resClear.status, 400);
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    store.close();
    cleanup(dir);
  }
});

test("http-server: POST /simulate validates positive amountUsd, token, and balances", async () => {
  const r = await startTestServer();
  try {
    const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";

    // Negative amountUsd -> 400
    const res1 = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, amountUsd: -10, balances: { usdc: 100 } }),
    });
    assert.equal(res1.status, 400);

    // Invalid token -> 400
    const res2 = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, amountUsd: 10, token: "btc", balances: { usdc: 100 } }),
    });
    assert.equal(res2.status, 400);

    // Invalid balances -> 400
    const res3 = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, amountUsd: 10, balances: { usdc: -5 } }),
    });
    assert.equal(res3.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: POST /trust validates maxRisk and minLiquidityUsd", async () => {
  const r = await startTestServer();
  try {
    const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";

    // maxRisk out of range -> 400
    const res1 = await fetch(`${r.base}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, maxRisk: 150 }),
    });
    assert.equal(res1.status, 400);

    // negative minLiquidityUsd -> 400
    const res2 = await fetch(`${r.base}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, minLiquidityUsd: -1 }),
    });
    assert.equal(res2.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: /scan uses the saved baseline for repeat scans (audit 2.1)", async () => {
  const { store, dir } = tmpStore();
  const wallet = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";
  store.addWallet(wallet);
  let fixture: EnhancedTx[] = [makeSwapTx("s1", 1_700_000_000, USDC_MINT, 100, USDC_MINT, 100)];
  const server = createServer({
    store,
    apiKey: "test-helius-key",
    rateLimitPerMin: 0,
    fetchTxs: async () => fixture,
    fetchPrices: async () => null,
    fetchMintRisk: async () => ({}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;
  const scan = () =>
    fetch(`${base}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });
  try {
    // First scan learns the baseline (JUPITER venue).
    const res1 = await scan();
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as { anomalies: Array<{ type: string }> };
    assert.ok(!body1.anomalies.some((a) => a.type === "NEW_VENUE"));

    // Second scan sees a new venue: NEW_VENUE can only fire when the saved
    // baseline is passed to detectAnomalies (previously hardcoded null).
    fixture = [{ ...makeSwapTx("s2", 1_700_003_600, USDC_MINT, 50, USDC_MINT, 50), source: "RAYDIUM" }];
    const res2 = await scan();
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as { anomalies: Array<{ type: string }> };
    assert.ok(
      body2.anomalies.some((a) => a.type === "NEW_VENUE"),
      "repeat /scan must detect NEW_VENUE against the saved baseline",
    );
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    store.close();
    cleanup(dir);
  }
});

test("audit 1.3: RADAR_AUTH_HEAVY / authHeavy gates /scan, /trust, /simulate, /batch under RADAR_API_TOKEN", async () => {
  const { store, dir } = tmpStore();
  const prevToken = process.env.RADAR_API_TOKEN;
  const prevHeavy = process.env.RADAR_AUTH_HEAVY;
  process.env.RADAR_API_TOKEN = "secret-token-123";
  process.env.RADAR_AUTH_HEAVY = "1";

  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const endpoints = [
      { path: "/scan", method: "POST", body: { wallet: "11111111111111111111111111111111" } },
      { path: "/trust", method: "POST", body: { wallet: "11111111111111111111111111111111" } },
      { path: "/simulate", method: "POST", body: { wallet: "11111111111111111111111111111111", amountUsd: 10 } },
      { path: "/batch", method: "POST", body: { wallets: ["11111111111111111111111111111111"] } },
    ];

    for (const ep of endpoints) {
      // 1. Without token -> 401
      const resUnauth = await fetch(`${r.base}${ep.path}`, {
        method: ep.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ep.body),
      });
      assert.equal(resUnauth.status, 401, `${ep.path} must return 401 when unauthenticated in authHeavy mode`);

      // 2. With invalid token -> 401
      const resBad = await fetch(`${r.base}${ep.path}`, {
        method: ep.method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer wrong-token",
        },
        body: JSON.stringify(ep.body),
      });
      assert.equal(resBad.status, 401, `${ep.path} must reject wrong token`);

      // 3. With valid token -> authorized (not 401)
      const resAuth = await fetch(`${r.base}${ep.path}`, {
        method: ep.method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-token-123",
        },
        body: JSON.stringify(ep.body),
      });
      assert.notEqual(resAuth.status, 401, `${ep.path} must accept valid token`);
    }
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
    if (prevToken === undefined) delete process.env.RADAR_API_TOKEN;
    else process.env.RADAR_API_TOKEN = prevToken;
    if (prevHeavy === undefined) delete process.env.RADAR_AUTH_HEAVY;
    else process.env.RADAR_AUTH_HEAVY = prevHeavy;
  }
});

test("audit 2.5: readBody rejects payload larger than 1MB with 413", async () => {
  const { store, dir } = tmpStore();
  const r = await startWatchServer(store, { apiKey: "key" });
  try {
    const largeBody = "x".repeat(1_000_001);
    const res = await fetch(`${r.base}/selftest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largeBody,
    });
    assert.equal(res.status, 413);
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
  }
});

test("http-server: POST /gate-copy validates targetWallet and requires API key", async () => {
  const r = await startTestServer();
  try {
    // 1. Invalid wallet -> 400
    const resBad = await fetch(`${r.base}/gate-copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetWallet: "invalid_addr" }),
    });
    assert.equal(resBad.status, 400);

    // 2. Valid wallet without HELIUS_API_KEY -> 503
    const resNoKey = await fetch(`${r.base}/gate-copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetWallet: "11111111111111111111111111111111", copyAmountUsd: 50 }),
    });
    assert.equal(resNoKey.status, 503);
  } finally {
    await r.close();
  }
});

test("http-server: POST /analyze rejects transactions missing signature or timestamp (S-1)", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: "DemoWallet11111111111111111111111111111111",
        txs: [
          { foo: "bar" }, // missing signature and timestamp
        ],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("body.txs[0] must be a transaction object with signature (string) and timestamp (number)"));
  } finally {
    await r.close();
  }
});

test("http-server: POST /simulate accepts token 'usdt' without throwing 400 (S-2)", async () => {
  const r = await startTestServer();
  try {
    const validWallet = "11111111111111111111111111111111";
    const res = await fetch(`${r.base}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: validWallet,
        amountUsd: 10,
        token: "usdt",
        balances: { sol: 1, usdc: 10, usdt: 10 },
      }),
    });
    // Should NOT be 400 parameter rejection (returns 503 when live HELIUS key is missing)
    assert.notEqual(res.status, 400);
  } finally {
    await r.close();
  }
});

test("http-server: createRateLimiter protects blocked IPs from eviction by spoofed IP traffic (S-7)", () => {
  const limiter = createRateLimiter(2);
  const abusiveIp = "192.168.1.100";

  // IP consumes allowance and gets rate limited
  assert.equal(limiter.check(abusiveIp).ok, true);
  assert.equal(limiter.check(abusiveIp).ok, true);
  const blockedCheck = limiter.check(abusiveIp);
  assert.equal(blockedCheck.ok, false);

  // An attacker sends requests from lots of random single-request IPs to trigger evictions
  for (let i = 0; i < 50; i++) {
    limiter.check(`10.0.0.${i}`);
  }

  // The abusive IP must REMAIN rate-limited (not evicted!)
  const recheckAbusive = limiter.check(abusiveIp);
  assert.equal(recheckAbusive.ok, false);
});

test("A1: /gate-copy isHeavy auth, RADAR_PROTECT_READS, and RADAR_LIVE_RATE_LIMIT_PER_MIN", async () => {
  const { store, dir } = tmpStore();
  const prevToken = process.env.RADAR_API_TOKEN;
  const prevHeavy = process.env.RADAR_AUTH_HEAVY;
  const prevReads = process.env.RADAR_PROTECT_READS;
  const prevLiveLimit = process.env.RADAR_LIVE_RATE_LIMIT_PER_MIN;

  try {
    process.env.RADAR_API_TOKEN = "secret-token-123";
    process.env.RADAR_AUTH_HEAVY = "1";
    process.env.RADAR_PROTECT_READS = "1";
    delete process.env.RADAR_LIVE_RATE_LIMIT_PER_MIN; // defaults to 30

    const r = await startWatchServer(store, { apiKey: "key", rateLimitPerMin: 100 });
    try {
      // 1. /gate-copy without token gets 401
      const resGateUnauth = await fetch(`${r.base}/gate-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetWallet: "11111111111111111111111111111111" }),
      });
      assert.equal(resGateUnauth.status, 401, "/gate-copy without auth must return 401 when RADAR_AUTH_HEAVY=1");

      // 2. /gate-copy with token is authorized (not 401)
      const resGateAuth = await fetch(`${r.base}/gate-copy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-token-123",
        },
        body: JSON.stringify({ targetWallet: "11111111111111111111111111111111" }),
      });
      assert.notEqual(resGateAuth.status, 401, "/gate-copy with auth must not be 401");

      // 3. GET /watch, /alerts, /defense, /poll without token get 401 under RADAR_PROTECT_READS=1
      for (const p of ["/watch", "/alerts", "/defense", "/poll"]) {
        const resReadUnauth = await fetch(`${r.base}${p}`);
        assert.equal(resReadUnauth.status, 401, `GET ${p} without auth must return 401 when RADAR_PROTECT_READS=1`);

        const resReadAuth = await fetch(`${r.base}${p}`, {
          headers: { "Authorization": "Bearer secret-token-123" },
        });
        assert.notEqual(resReadAuth.status, 401, `GET ${p} with auth must not be 401`);
      }

    } finally {
      await r.close();
    }

    // 4. Rate limiting on live Helius routes (RADAR_LIVE_RATE_LIMIT_PER_MIN = 30 default)
    // Exactly 30 requests should succeed (not 429), 31st must receive 429
    const rLimit = await startWatchServer(store, { apiKey: "key", rateLimitPerMin: 100, liveRateLimitPerMin: 30 });
    try {
      let got429 = false;
      for (let i = 1; i <= 31; i++) {
        const res = await fetch(`${rLimit.base}/gate-copy`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer secret-token-123",
          },
          body: JSON.stringify({ targetWallet: "11111111111111111111111111111111" }),
        });
        if (i <= 30) {
          assert.notEqual(res.status, 429, `Request ${i} should not be 429`);
        } else {
          assert.equal(res.status, 429, `31st request must receive 429`);
          got429 = true;
        }
      }
      assert.equal(got429, true, "31st request should trigger 429");
    } finally {
      await rLimit.close();
    }

    // 5. Without token, behavior is unchanged (no 401)
    delete process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_AUTH_HEAVY;
    delete process.env.RADAR_PROTECT_READS;
    const rNoToken = await startWatchServer(store, { apiKey: "key", rateLimitPerMin: 0, liveRateLimitPerMin: 0 });
    try {
      const res = await fetch(`${rNoToken.base}/gate-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetWallet: "11111111111111111111111111111111" }),
      });
      assert.notEqual(res.status, 401, "Without token, /gate-copy must not return 401");
    } finally {
      await rNoToken.close();
    }
  } finally {
    store.close();
    cleanup(dir);
    if (prevToken !== undefined) process.env.RADAR_API_TOKEN = prevToken; else delete process.env.RADAR_API_TOKEN;
    if (prevHeavy !== undefined) process.env.RADAR_AUTH_HEAVY = prevHeavy; else delete process.env.RADAR_AUTH_HEAVY;
    if (prevReads !== undefined) process.env.RADAR_PROTECT_READS = prevReads; else delete process.env.RADAR_PROTECT_READS;
    if (prevLiveLimit !== undefined) process.env.RADAR_LIVE_RATE_LIMIT_PER_MIN = prevLiveLimit; else delete process.env.RADAR_LIVE_RATE_LIMIT_PER_MIN;
  }
});

test("A4: A2A card and getVersion resolve version dynamically from package.json", async () => {
  const r = await startTestServer();
  try {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const expectedVersion = pkg.version;

    const resA2A = await fetch(`${r.base}/.well-known/agent.json`);
    assert.equal(resA2A.status, 200);
    const card = (await resA2A.json()) as any;
    assert.equal(card.version, expectedVersion, `A2A card version (${card.version}) must match package.json version (${expectedVersion}) and not be hardcoded 0.3.0`);
    assert.notEqual(card.version, "0.3.0");

    const mcpVersion = getVersion();
    assert.equal(mcpVersion, expectedVersion, `MCP getVersion() (${mcpVersion}) must match package.json version (${expectedVersion})`);
  } finally {
    await r.close();
  }
});

test("A5: error messages and method hints for /watch, /unwatch, /poll, /defense/:wallet/clear", async () => {
  const { store, dir } = tmpStore();
  const r = await startWatchServer(store, { apiKey: "key", rateLimitPerMin: 0, liveRateLimitPerMin: 0 });
  try {
    // 1. GET /unwatch -> 405 Method Not Allowed with allowed methods and hint
    const resGetUnwatch = await fetch(`${r.base}/unwatch`);
    assert.equal(resGetUnwatch.status, 405);
    const bodyGetUnwatch = (await resGetUnwatch.json()) as any;
    const textGetUnwatch = JSON.stringify(bodyGetUnwatch);
    assert.ok(textGetUnwatch.includes("POST"), "Allowed methods must include POST");
    assert.ok(textGetUnwatch.includes("use POST /unwatch to remove a wallet"), "Must include hint 'use POST /unwatch to remove a wallet'");

    // 2. DELETE /unwatch -> 405 Method Not Allowed with hint
    const resDelUnwatch = await fetch(`${r.base}/unwatch`, { method: "DELETE" });
    assert.equal(resDelUnwatch.status, 405);
    const bodyDelUnwatch = (await resDelUnwatch.json()) as any;
    assert.ok(JSON.stringify(bodyDelUnwatch).includes("use POST /unwatch to remove a wallet"));

    // 3. GET /poll -> 405 Method Not Allowed with hint
    const resGetPoll = await fetch(`${r.base}/poll`);
    assert.equal(resGetPoll.status, 405);
    const bodyGetPoll = (await resGetPoll.json()) as any;
    assert.ok(JSON.stringify(bodyGetPoll).includes("POST"));

    // 4. GET /defense/:wallet/clear -> 405 Method Not Allowed with hint
    const resGetClear = await fetch(`${r.base}/defense/11111111111111111111111111111111/clear`);
    assert.equal(resGetClear.status, 405);
    const bodyGetClear = (await resGetClear.json()) as any;
    assert.ok(JSON.stringify(bodyGetClear).includes("POST"));

    // 5. DELETE /watch -> 405 Method Not Allowed with hint
    const resDelWatch = await fetch(`${r.base}/watch`, { method: "DELETE" });
    assert.equal(resDelWatch.status, 405);
    const bodyDelWatch = (await resDelWatch.json()) as any;
    const textDelWatch = JSON.stringify(bodyDelWatch);
    assert.ok(textDelWatch.includes("GET") && textDelWatch.includes("POST"), "Allowed methods must include GET, POST");
    assert.ok(textDelWatch.includes("use POST /unwatch to remove a wallet"), "Must include hint 'use POST /unwatch to remove a wallet'");

    // 6. Malformed body on POST /watch -> 400 with expected shape
    const resBadWatch = await fetch(`${r.base}/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: 123 }),
    });
    assert.equal(resBadWatch.status, 400);
    const bodyBadWatch = (await resBadWatch.json()) as any;
    const textBadWatch = JSON.stringify(bodyBadWatch);
    assert.ok(
      textBadWatch.includes('{"wallet":"<base58>","name":"optional"}') ||
      (bodyBadWatch.expected && bodyBadWatch.expected.wallet === "<base58>"),
      `Expected shape {"wallet":"<base58>","name":"optional"} in 400 response: ${textBadWatch}`
    );

    // 7. 404 on /defense/:wallet/clear -> clearly state not escalated
    const res404Clear = await fetch(`${r.base}/defense/11111111111111111111111111111111/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res404Clear.status, 404);
    const body404Clear = (await res404Clear.json()) as any;
    assert.ok(
      body404Clear.error.includes("not been escalated") || body404Clear.error.includes("не эскалировано"),
      `404 response must mention not escalated: ${JSON.stringify(body404Clear)}`
    );
  } finally {
    await r.close();
    store.close();
    cleanup(dir);
  }
});

test("A6(a)+(b): trust, batch, and gate-copy descriptions document token mint check scope", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const endpoints = body.endpoints as Array<{ path: string; description: string }>;

    const trustEp = endpoints.find((e) => e.path === "/trust");
    assert.ok(trustEp, "Endpoint /trust must exist");
    assert.ok(
      trustEp.description.includes("Does not check the token mint; use radar_gate_copy for token checks."),
      "/trust description must state it does not check token mint"
    );

    const batchEp = endpoints.find((e) => e.path === "/batch");
    assert.ok(batchEp, "Endpoint /batch must exist");
    assert.ok(
      batchEp.description.includes("Does not check the token mint; use radar_gate_copy for token checks."),
      "/batch description must state it does not check token mint"
    );

    const gateCopyEp = endpoints.find((e) => e.path === "/gate-copy");
    assert.ok(gateCopyEp, "Endpoint /gate-copy must exist");
    assert.ok(
      gateCopyEp.description.includes("When both an amount and a specific token mint are supplied, additionally checks that mint's freeze authority and top-10-holder concentration (not mint authority) before allowing execution."),
      "/gate-copy description must match PROPOSED-DESCRIPTIONS.md"
    );

    // Also check src/mcp.ts
    const mcpSource = fs.readFileSync(path.resolve(process.cwd(), "src/mcp.ts"), "utf8");
    assert.ok(
      mcpSource.includes("Does not check the token mint; use radar_gate_copy for token checks."),
      "mcp.ts must document token check scope in trust/batch"
    );
    assert.ok(
      mcpSource.includes("When both an amount and a specific token mint are supplied, additionally checks that mint's freeze authority and top-10-holder concentration (not mint authority) before allowing execution."),
      "mcp.ts must document token check scope in radar_gate_copy"
    );
  } finally {
    await r.close();
  }
});






