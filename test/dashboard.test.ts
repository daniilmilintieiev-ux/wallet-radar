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
    assert.ok(html.includes("wallet-input"));
    assert.ok(html.includes("Targ")); // watchlist chip short-addr
    assert.ok(html.includes("No wallet selected."));
    assert.ok(html.includes("Open /dashboard?wallet=<address> to read its scan history."));
    assert.ok(html.includes("View recorded replay"));
  });

  test("renderDashboardHtml: renders empty state when wallet has no scan records", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: [],
      generatedAt: 1726300500,
    });

    assert.ok(html.includes("No wallet selected."));
    assert.ok(html.includes(testWallet));
    assert.ok(html.includes("Open /dashboard?wallet=<address> to read its scan history."));
    assert.ok(html.includes("View recorded replay"));
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

    // Check decision layers
    assert.ok(html.includes("Decision in three layers"));
    assert.ok(html.includes("Base verdict"));

    // Check watchlist chip active state
    assert.ok(html.includes('class="chip mono active on"'));
  });

  test("renderDashboardHtml: renders defense stance, enforcement, and 3 layers", () => {
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

    // Defense state and enforcement in 3 layers
    assert.ok(html.includes("Decision in three layers"));
    assert.ok(html.includes("gated"));
    assert.ok(html.includes("throttle"));
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

  test("handleDashboardHttpRequest: GET /dashboard?demo=replay serves recorded replay", async () => {
    const req = {
      method: "GET",
      url: `/dashboard?demo=replay`,
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

    const handled = await handleDashboardHttpRequest(req, res);
    assert.equal(handled, true);
    assert.equal(statusCode, 200);
    assert.ok(body.includes("8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j"));
    assert.ok(body.includes("RECORDED REPLAY"));
    assert.ok(body.includes("historical replay, not a confirmed incident"));
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
      assert.ok(dashHtml.includes("85"));

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

  const testFileDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = fs.existsSync(path.join(testFileDir, "../package.json"))
    ? path.resolve(testFileDir, "..")
    : path.resolve(testFileDir, "../..");
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
      assert.ok(htmlContent.includes("WALLET RADAR"));
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
      assert.ok(htmlContent.includes("WALLET RADAR"));
      assert.ok(htmlContent.includes("No wallet selected."));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // (a) External links check
  test("(a) HTML contains no external links to fonts or scripts (only explorer, GitHub, docs)", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: mockRecords,
    });
    // Check no external font/script links
    assert.ok(!html.includes("<link rel=\"stylesheet\" href=\"http"));
    assert.ok(!html.includes("<script src=\"http"));

    // Find all https:// URLs
    const urls = html.match(/https:\/\/[^"'\s<>]+/g) || [];
    for (const u of urls) {
      const isAllowed =
        u.startsWith("https://explorer.solana.com/") ||
        u.startsWith("https://github.com/") ||
        u.includes("/docs/");
      assert.ok(isAllowed, `URL not in allowed list (explorer, github, docs): ${u}`);
    }
  });

  // (b) Honesty check: no promotional words (accuracy, catches, protected)
  test("(b) HTML contains no promotional words: catches, protected, or accuracy claims", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: mockRecords,
    });
    assert.ok(!html.toLowerCase().includes("catches"), "HTML should not contain 'catches'");
    assert.ok(!html.toLowerCase().includes("protected"), "HTML should not contain 'protected'");
    // Ensure 'accuracy' is only ever present in the disclaimer 'not accuracy claims'
    const withoutDisclaimer = html.replace(/not accuracy claims/gi, "");
    assert.ok(!withoutDisclaimer.toLowerCase().includes("accuracy"), "HTML should not make accuracy claims");
  });

  // (c) Color tokens, zero border-radius, no box-shadow, no gradient
  // (c) Color tokens, zero border-radius except 50%, no box-shadow, text-shadow only on hero number
  test("(c) All required design color tokens present, no box-shadow, text-shadow only on hero, border-radius only 0 or 50%", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: mockRecords,
    });
    // Required tokens from w2_update.html palette
    const requiredTokens = [
      "--bg",
      "--panel",
      "--ink",
      "--ink2",
      "--ink3",
      "--accent",
      "--hair",
      "--ok",
      "--bad",
      "#0a0a0b",
      "#101013",
      "#f1f1ee",
      "#9c9c97",
      "#63635f",
      "#ffb000",
      "#1f1f23",
      "#3fb950",
      "#f85149",
      "rgba(255, 176, 0, .06)",
      "rgba(255, 176, 0, .07)",
    ];
    for (const tok of requiredTokens) {
      assert.ok(html.includes(tok), `Required token missing: ${tok}`);
    }

    // No box-shadow anywhere
    assert.ok(!/box-shadow/i.test(html), "HTML must not contain box-shadow");

    // Text-shadow only on hero risk number
    const textShadowMatches = html.match(/text-shadow\s*:[^;]+;/gi) || [];
    assert.equal(textShadowMatches.length, 1, "text-shadow should appear only on hero risk number");
    assert.ok(textShadowMatches[0].includes("rgba(255, 176, 0, .25)"));

    // No border-radius except 0, 0px, 0%, or 50%
    const radiusMatches = html.match(/border-radius\s*:\s*([^;]+)/gi) || [];
    for (const rm of radiusMatches) {
      const val = rm.split(":")[1].trim();
      assert.ok(/^0(px|%)?$|^50%$/.test(val), `border-radius must be 0 or 50%, got: ${rm}`);
    }
  });

  // (d) Empty state contains the three specified lines
  test("(d) Empty state contains the 3 exact specified lines", () => {
    const html = renderDashboardHtml({});
    assert.ok(html.includes("No wallet selected."));
    assert.ok(html.includes("Open /dashboard?wallet=<address> to read its scan history."));
    assert.ok(html.includes("View recorded replay"));
  });

  // (e) Recorded replay has note "historical replay, not a confirmed incident"
  test("(e) Recorded replay has note 'historical replay, not a confirmed incident'", () => {
    const html = renderDashboardHtml({ demo: "replay" });
    assert.ok(html.includes("historical replay, not a confirmed incident"));
    assert.ok(html.includes("Recorded replay, historical window"));
  });

  // (f) Independent test block with null result does not display result numbers
  test("(f) Independent test block with null result does not display any result numbers", () => {
    const html = renderDashboardHtml({ wallet: testWallet, records: mockRecords });
    assert.ok(html.includes("Result is published as computed, including 'insufficient data'."));
    assert.ok(!html.includes("Result: 100"));
    assert.ok(!html.includes("Result: 9"));
    assert.ok(!html.includes("Score: 100"));
  });

  // (g) No '>' or '<' in values of 3 layers
  test("(g) No '>' or '<' in rendered 3 layers values", () => {
    const html = renderDashboardHtml({
      wallet: testWallet,
      records: mockRecords,
      defense: {
        state: "gated",
        riskAt: 55,
        setAt: 1726299000,
        quietStreak: 0,
        actions: 1,
        enforcement: { verdict: "throttle", limitUsd: null, gating: true },
        trail: [],
      },
      baseVerdict: "hold",
    });
    const layerVals = html.match(/<div class="layer-val[^"]*">([^<]+)<\/div>/g) || [];
    assert.ok(layerVals.length >= 3);
    for (const lv of layerVals) {
      assert.ok(!lv.includes("&gt;"), `Layer value must not contain &gt;: ${lv}`);
      assert.ok(!lv.includes("&lt;"), `Layer value must not contain &lt;: ${lv}`);
    }
  });

  // (h) Mono font class used only for addresses, hashes, signatures, timestamps, and logs
  test("(h) mono font class used only for addresses, hashes, signatures, timestamps, and logs", () => {
    const html = renderDashboardHtml({ demo: "replay" });
    assert.ok(!html.includes('class="top-bar-title mono"'));
    assert.ok(!html.includes('class="section-header mono"'));
    assert.ok(!html.includes('class="radar-caption mono"'));
    assert.ok(!html.includes('class="risk-verdict mono"'));
  });

  // (i) Replay Base/Agent/Defense are 'n/a (not in replay data)' and Liquidity tile absent
  test("(i) For replay, Base/Agent/Defense are 'n/a (not in replay data)' and Liquidity tile is absent without data", () => {
    const html = renderDashboardHtml({ demo: "replay" });
    assert.ok(html.includes("n/a (not in replay data)"));
    assert.ok(!html.includes("<div class=\"metric-box-lbl\">Liquidity</div>"));
    assert.ok(html.includes("Median swap"));
    assert.ok(html.includes("$844.10"));
  });

  // (j) Static preview contains 'n/a (static)'
  test("(j) Static preview contains 'n/a (static)' in service status", () => {
    const html = renderDashboardHtml({ demo: "replay" });
    assert.ok(html.includes("n/a (static)"));
  });

  // (k) Number of radar dots equals number of anomalies in replay data
  test("(k) Number of radar dots equals the number of anomalies in replay data", () => {
    const html = renderDashboardHtml({ demo: "replay" });
    const dots = html.match(/class="[^"]*\bradar-dot\b/g) || [];
    assert.equal(dots.length, 8, "Expected 8 radar dots for 8 anomalies in replay");
  });

  // (l) For two anomalies with identical timestamp, their angles differ
  test("(l) For two anomalies with identical timestamp, radar angles differ", () => {
    const html = renderDashboardHtml({ demo: "replay" });
    // Find all animation-delay values on radar-dot elements
    const delays = (html.match(/class="radar-dot[^"]*"[^>]*style="animation-delay:\s*([0-9.]+)s/g) || []).map((m) => {
      const match = m.match(/animation-delay:\s*([0-9.]+)s/);
      return match ? parseFloat(match[1]) : 0;
    });
    assert.ok(delays.length >= 2, "Expected at least 2 radar dots with animation delays");
    // Anomalies 0 and 1 have the exact same timestamp (1788163072)
    assert.notEqual(delays[0], delays[1], "Delays (and angles) for identical timestamps must differ");
    assert.ok(Math.abs(delays[0] - delays[1]) > 0.005, "Difference between delays must reflect degree offset");
  });
});
