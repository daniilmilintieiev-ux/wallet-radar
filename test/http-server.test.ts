import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import { createServer, clientIp } from "../src/http-server.js";
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
    assert.ok(b3.error.includes("body.token must be 'usdc' or 'sol'"));
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


