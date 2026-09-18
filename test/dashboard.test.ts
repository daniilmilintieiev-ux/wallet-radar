import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import {
  renderDashboardHtml,
  fetchAndRenderDashboard,
  formatLedgerTerminalTable,
  handleDashboardHttpRequest,
} from "../src/dashboard.js";
import {
  ScanLedgerRecord,
  MockZKOracleClient,
} from "../src/oracle/index.js";
import { createServer } from "../src/http-server.js";
import { createX402Server } from "../src/x402server.js";
import { Store } from "../src/store.js";

function tmpDb(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-dashboard-test-"));
  const dbPath = path.join(dir, "test.db");
  const store = new Store(dbPath);
  return { store, dir };
}

function startServer(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const close = () =>
        new Promise<void>((res) => {
          server.close(() => res());
        });
      resolve({ port: addr.port, close });
    });
  });
}

describe("Web Dashboard & ZK Scan Ledger (src/dashboard.ts)", () => {
  const testWalletKeypair = Keypair.generate();
  const testWallet = testWalletKeypair.publicKey.toBase58();

  const mockRecords: ScanLedgerRecord[] = [
    {
      wallet: testWallet,
      riskScore: 85,
      verdict: "HIGH RISK",
      timestamp: 1726300000,
      slot: 300010000,
      compressedAddress: "CompAddr11111111111111111111111111111111111",
      onchainSignature: "4uQeVj5tqViQh7yGeGceZrVw8YArTX8BR39aBg7tTVocqzLSmCgjW8DkwVnTej1aF5X3Yw9H8z6wXj8rQ7B1M3k",
      topRules: ["DORMANT_ACTIVE", "LARGE_SWAP"],
      txSignatures: ["txSig1", "txSig2"],
    },
    {
      wallet: testWallet,
      riskScore: 20,
      verdict: "SAFE",
      timestamp: 1726200000,
      slot: 300000000,
      compressedAddress: "CompAddr11111111111111111111111111111111111",
      onchainSignature: "2vReVj5tqViQh7yGeGceZrVw8YArTX8BR39aBg7tTVocqzLSmCgjW8DkwVnTej1aF5X3Yw9H8z6wXj8rQ7B1M3k",
      topRules: [],
      txSignatures: ["txSig0"],
    },
  ];

  test("renderDashboardHtml: renders welcome view when no wallet specified", () => {
    const html = renderDashboardHtml({
      watchlist: ["Target1111111111111111111111111111111111111"],
      generatedAt: 1726300500,
    });

    assert.ok(html.includes("Wallet Radar"));
    assert.ok(html.includes("Inspect target wallet ledger"));
    assert.ok(html.includes("ZK scan ledger"));
    assert.ok(html.includes("~400x cost"));
    assert.ok(html.includes("wallet-input"));
    assert.ok(html.includes("Targ")); // watchlist chip short-addr
  });

  test("renderDashboardHtml: renders empty state when wallet has no scan records", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: [],
      generatedAt: 1726300500,
    });

    assert.ok(html.includes("No On-Chain Scan Attestations Found"));
    assert.ok(html.includes(testWallet));
    assert.ok(html.includes("radar scan"));
  });

  test("renderDashboardHtml: renders hero verdict and timeline table for populated records", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: mockRecords,
      watchlist: [testWallet, "OtherWallet111111111111111111111111111111111"],
      generatedAt: 1726300500,
    });

    // Check top bar + wallet
    assert.ok(html.includes(testWallet));
    assert.ok(html.includes("Wallet Radar"));

    // Check readout + scan ledger
    assert.ok(html.includes("85")); // score
    assert.ok(html.includes("HIGH RISK")); // ledger verdict
    assert.ok(html.includes("DORMANT_ACTIVE"));
    assert.ok(html.includes("LARGE_SWAP"));
    assert.ok(html.includes("CompAddr1111")); // compressed PDA preview
    assert.ok(html.includes("300010000")); // slot
    assert.ok(html.includes("4uQeVj5tqViQh7yG")); // onchain sig preview

    // Check scan-ledger table
    assert.ok(html.includes("Scan ledger"));
    assert.ok(html.includes("2 recorded"));
    assert.ok(html.includes("SAFE"));
    assert.ok(html.includes("20"));

    // Check watchlist chip active state
    assert.ok(html.includes('class="chip on"'));
  });

  test("renderDashboardHtml: renders defense stance, enforcement, and audit trail", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: [mockRecords[0]],
      generatedAt: 1726300500,
      defense: {
        state: "gated",
        riskAt: 55,
        setAt: 1726299000,
        quietStreak: 0,
        actions: 3,
        enforcement: { verdict: "throttle", limitUsd: null, gating: true },
        trail: [
          { ts: 1726299000, fromState: "alerting", toState: "gated", action: "escalate", risk: 55, reason: "risk 55" },
          { ts: 1726298000, fromState: "armed", toState: "alerting", action: "escalate", risk: 34, reason: "risk 34" },
        ],
      },
    });

    // Defense state big readout + ladder
    assert.ok(html.includes(">GATED<"));
    assert.ok(html.includes("Active defense state"));
    assert.ok(html.includes("gated"));

    // Enforcement implied by the stance
    assert.ok(html.includes("THROTTLE"));
    assert.ok(html.includes("Gating"));

    // Audit trail
    assert.ok(html.includes("Defense audit trail"));
    assert.ok(html.includes("alerting"));
    assert.ok(html.includes("escalate"));

    // Defense action count in readout
    assert.ok(html.includes("defense actions"));
  });

  test("renderDashboardHtml: deterministic output for identical options", () => {
    const opts = {
      wallet: testWallet,
      records: mockRecords,
      generatedAt: 1726300500,
    };
    const html1 = renderDashboardHtml(opts);
    const html2 = renderDashboardHtml(opts);
    assert.equal(html1, html2);
  });

  test("formatLedgerTerminalTable: formats empty and populated record lists", () => {
    const emptyOutput = formatLedgerTerminalTable([]);
    assert.equal(emptyOutput, "No on-chain scan ledger records found.");

    const tableOutput = formatLedgerTerminalTable(mockRecords);
    assert.ok(tableOutput.includes("TIMESTAMP (UTC)"));
    assert.ok(tableOutput.includes("SLOT"));
    assert.ok(tableOutput.includes("SCORE"));
    assert.ok(tableOutput.includes("VERDICT"));
    assert.ok(tableOutput.includes("85"));
    assert.ok(tableOutput.includes("HIGH RISK"));
    assert.ok(tableOutput.includes("20"));
    assert.ok(tableOutput.includes("SAFE"));
  });

  test("fetchAndRenderDashboard: fetches from oracle client and returns HTML", async () => {
    const oracleClient = new MockZKOracleClient();
    for (const r of mockRecords) {
      await oracleClient.commit(r);
    }

    const html = await fetchAndRenderDashboard(testWallet, { client: oracleClient });
    assert.ok(html.includes(testWallet));
    assert.ok(html.includes("Scan ledger"));
    assert.ok(html.includes("85"));
  });

  test("handleDashboardHttpRequest: GET /dashboard returns HTML view", async () => {
    const oracleClient = new MockZKOracleClient();
    await oracleClient.commit(mockRecords[0]);

    const req = {
      method: "GET",
      url: `/dashboard?wallet=${testWallet}`,
      headers: { host: "127.0.0.1:8080" },
    } as unknown as http.IncomingMessage;

    let statusCode = 0;
    let headers: Record<string, string | number> = {};
    let body = "";

    const res = {
      writeHead(code: number, h: Record<string, string | number>) {
        statusCode = code;
        headers = h;
        return this;
      },
      end(chunk?: string | Buffer) {
        if (chunk) body = chunk.toString();
      },
    } as unknown as http.ServerResponse;

    const handled = await handleDashboardHttpRequest(req, res, { oracleClient });
    assert.equal(handled, true);
    assert.equal(statusCode, 200);
    assert.equal(headers["Content-Type"], "text/html; charset=utf-8");
    assert.ok(body.includes(testWallet));
    assert.ok(body.includes("85"));
  });

  test("handleDashboardHttpRequest: GET /api/ledger returns JSON scan records", async () => {
    const oracleClient = new MockZKOracleClient();
    await oracleClient.commit(mockRecords[0]);
    await oracleClient.commit(mockRecords[1]);

    const req = {
      method: "GET",
      url: `/api/ledger?wallet=${testWallet}&limit=10`,
      headers: { host: "127.0.0.1:8080" },
    } as unknown as http.IncomingMessage;

    let statusCode = 0;
    let body = "";

    const res = {
      writeHead(code: number) {
        statusCode = code;
        return this;
      },
      end(chunk?: string | Buffer) {
        if (chunk) body = chunk.toString();
      },
    } as unknown as http.ServerResponse;

    const handled = await handleDashboardHttpRequest(req, res, { oracleClient });
    assert.equal(handled, true);
    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.wallet, testWallet);
    assert.equal(parsed.count, 2);
    assert.equal(parsed.latest.riskScore, 85);
    assert.equal(parsed.history.length, 2);
  });

  test("handleDashboardHttpRequest: error handling for missing wallet or wrong methods", async () => {
    // 1. /api/ledger without wallet
    const reqMissing = {
      method: "GET",
      url: "/api/ledger",
      headers: { host: "127.0.0.1:8080" },
    } as unknown as http.IncomingMessage;

    let codeMissing = 0;
    const resMissing = {
      writeHead(code: number) {
        codeMissing = code;
        return this;
      },
      end() {},
    } as unknown as http.ServerResponse;

    await handleDashboardHttpRequest(reqMissing, resMissing);
    assert.equal(codeMissing, 400);

    // 2. POST /dashboard
    const reqPost = {
      method: "POST",
      url: "/dashboard",
      headers: { host: "127.0.0.1:8080" },
    } as unknown as http.IncomingMessage;

    let codePost = 0;
    const resPost = {
      writeHead(code: number) {
        codePost = code;
        return this;
      },
      end() {},
    } as unknown as http.ServerResponse;

    await handleDashboardHttpRequest(reqPost, resPost);
    assert.equal(codePost, 405);

    // 3. Unhandled path
    const reqOther = {
      method: "GET",
      url: "/other",
      headers: { host: "127.0.0.1:8080" },
    } as unknown as http.IncomingMessage;
    const resOther = {} as http.ServerResponse;
    const handledOther = await handleDashboardHttpRequest(reqOther, resOther);
    assert.equal(handledOther, false);
  });

  test("http-server live integration: /dashboard and /api/ledger endpoints", async () => {
    const { store, dir } = tmpDb();
    store.addWallet(testWallet);
    const oracleClient = new MockZKOracleClient();
    await oracleClient.commit(mockRecords[0]);

    const server = createServer({
      store,
      oracleClient,
    });
    const { port, close } = await startServer(server);

    try {
      // 1. GET /dashboard
      const dashRes = await fetch(`http://127.0.0.1:${port}/dashboard?wallet=${testWallet}`);
      assert.equal(dashRes.status, 200);
      assert.ok(dashRes.headers.get("content-type")?.includes("text/html"));
      const dashHtml = await dashRes.text();
      assert.ok(dashHtml.includes(testWallet));
      assert.ok(dashHtml.includes("Scan ledger"));

      // 2. GET /api/ledger
      const ledgerRes = await fetch(`http://127.0.0.1:${port}/api/ledger?wallet=${testWallet}`);
      assert.equal(ledgerRes.status, 200);
      const ledgerData = await ledgerRes.json();
      assert.equal(ledgerData.wallet, testWallet);
      assert.equal(ledgerData.count, 1);
      assert.equal(ledgerData.latest.riskScore, 85);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("x402-server live integration: /dashboard and /api/ledger endpoints", async () => {
    const { store, dir } = tmpDb();
    store.addWallet(testWallet);
    const oracleClient = new MockZKOracleClient();
    await oracleClient.commit(mockRecords[0]);

    const server = createX402Server({
      store,
      oracleClient,
      paymentVerifier: async () => ({ valid: true }),
    });
    const { port, close } = await startServer(server);

    try {
      // 1. GET /dashboard
      const dashRes = await fetch(`http://127.0.0.1:${port}/dashboard?wallet=${testWallet}`);
      assert.equal(dashRes.status, 200);
      const dashHtml = await dashRes.text();
      assert.ok(dashHtml.includes(testWallet));
      assert.ok(dashHtml.includes("HIGH RISK"));

      // 2. GET /api/ledger
      const ledgerRes = await fetch(`http://127.0.0.1:${port}/api/ledger?wallet=${testWallet}`);
      assert.equal(ledgerRes.status, 200);
      const ledgerData = await ledgerRes.json();
      assert.equal(ledgerData.wallet, testWallet);
      assert.equal(ledgerData.count, 1);

      // 3. GET /health lists /dashboard and /api/ledger
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(healthRes.status, 200);
      const healthData = await healthRes.json();
      assert.ok(healthData.endpoints["/dashboard"]);
      assert.ok(healthData.endpoints["/api/ledger"]);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cliScript = path.join(rootDir, "dist/src/cli.js");

  function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile("node", [cliScript, ...args], { cwd: rootDir, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
        });
      });
    });
  }

  test("CLI radar ledger <wallet> --json: outputs valid JSON structure", async () => {
    const res = await runCli(["ledger", testWallet, "--json"]);
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.wallet, testWallet);
    assert.ok(Array.isArray(parsed.history));
  });

  test("CLI radar ledger <wallet>: outputs terminal table header", async () => {
    const res = await runCli(["ledger", testWallet]);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes("wallet-radar ZK scan ledger:"));
    assert.ok(res.stdout.includes("No on-chain scan ledger records found.") || res.stdout.includes("TIMESTAMP (UTC)"));
  });

  test("CLI radar ledger <wallet> --export: exports HTML dashboard to file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-cli-ledger-"));
    const outFile = path.join(tmpDir, "ledger-report.html");
    try {
      const res = await runCli(["ledger", testWallet, "--export", outFile]);
      assert.equal(res.code, 0);
      assert.ok(fs.existsSync(outFile));
      const htmlContent = fs.readFileSync(outFile, "utf-8");
      assert.ok(htmlContent.includes("Wallet Radar"));
      assert.ok(htmlContent.includes(testWallet));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI radar dashboard --export: exports overview HTML dashboard", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-cli-dash-"));
    const outFile = path.join(tmpDir, "dashboard-overview.html");
    try {
      const res = await runCli(["dashboard", "--export", outFile]);
      assert.equal(res.code, 0);
      assert.ok(fs.existsSync(outFile));
      const htmlContent = fs.readFileSync(outFile, "utf-8");
      assert.ok(htmlContent.includes("Wallet Radar"));
      assert.ok(htmlContent.includes("ZK scan ledger"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
