import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import { createServer } from "../src/http-server.js";
import { getVersion } from "../src/mcp-server.js";

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

test("http-server: unknown POST route returns 404", async () => {
  const r = await startTestServer();
  try {
    const res = await fetch(`${r.base}/nope`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 404);
  } finally {
    await r.close();
  }
});
