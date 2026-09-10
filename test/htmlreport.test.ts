import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderHtmlReport,
  formatHistoryText,
  computeVerdict,
  escapeHtml,
  HtmlReportData,
} from "../src/htmlreport.js";
import { Store } from "../src/store.js";
import { Anomaly, Baseline } from "../src/types.js";

const DEMO_WALLET = "DemoWallet11111111111111111111111111111111";

const STUB_ANOMALIES: Anomaly[] = [
  {
    type: "DORMANT_ACTIVE",
    wallet: DEMO_WALLET,
    severity: "high",
    timestamp: 1_725_000_000,
    text: "active after 120 days of inactivity",
    evidence: { daysSilent: 120, lastSeenAt: 1_714_632_000, signature: "sigDormant111" },
  },
  {
    type: "LARGE_SWAP",
    wallet: DEMO_WALLET,
    severity: "high",
    timestamp: 1_725_000_100,
    text: "swap $25,000 > 5x median ($1,250)",
    evidence: { amountUsd: 25000, medianUsd: 1250, multiplier: 5, signature: "sigLarge222" },
  },
  {
    type: "TOXIC_MINT",
    wallet: DEMO_WALLET,
    severity: "medium",
    timestamp: 1_725_000_200,
    text: "mint ToxicMint333 has active mint authority",
    evidence: {
      mint: "ToxicMint33333333333333333333333333333333",
      hasMintAuthority: true,
      hasFreezeAuthority: false,
      signature: "sigToxic333",
    },
  },
];

const STUB_BASELINE: Baseline = {
  walletAddress: DEMO_WALLET,
  updatedAt: 1_725_000_300,
  txCount: 88,
  knownVenues: ["RAYDIUM", "JUPITER"],
  knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ComputeBudget111111111111111111111111111111"],
  medianSwapAmount: 14.5,
  medianSwapAmountUsd: 1250,
  medianTps: 0.2,
  activeHours: [12, 13, 14],
  lastSeenAt: 1_725_000_200,
  pnl: {
    realizedUsd: 1420.5,
    winRate: 0.667,
    roundTrips: 6,
  },
};

test("computeVerdict assigns correct tiers based on risk score", () => {
  assert.equal(computeVerdict(0), "SAFE");
  assert.equal(computeVerdict(15), "LOW RISK");
  assert.equal(computeVerdict(30), "LOW RISK");
  assert.equal(computeVerdict(45), "SUSPICIOUS");
  assert.equal(computeVerdict(60), "SUSPICIOUS");
  assert.equal(computeVerdict(75), "HIGH RISK");
  assert.equal(computeVerdict(100), "HIGH RISK");
});

test("escapeHtml safely escapes special HTML characters", () => {
  assert.equal(escapeHtml(`<b>"hello" & 'world'</b>`), "&lt;b&gt;&quot;hello&quot; &amp; &#39;world&#39;&lt;/b&gt;");
});

test("renderHtmlReport renders self-contained HTML with all required fields", () => {
  const data: HtmlReportData = {
    wallet: DEMO_WALLET,
    riskScore: 75,
    verdict: "HIGH RISK",
    generatedAt: "2026-09-07T05:00:00.000Z",
    window: {
      sinceSec: 1_724_000_000,
      untilSec: 1_725_000_200,
    },
    baseline: STUB_BASELINE,
    anomalies: STUB_ANOMALIES,
  };

  const html = renderHtmlReport(data);

  // Self-contained constraints
  assert.ok(html.startsWith("<!DOCTYPE html>"), "must start with DOCTYPE html");
  assert.ok(html.includes("<html lang=\"en\">"), "must include html lang tag");
  assert.ok(html.includes("<style>"), "must include inline style block");
  assert.ok(!html.includes("<script"), "must not include any script tag");
  assert.ok(!html.includes("<link rel=\"stylesheet\""), "must not link external CSS");
  assert.ok(!html.includes("@import"), "must not import external stylesheets or fonts");
  assert.ok(!html.includes("<img"), "must not include external images");

  // Wallet address & header
  assert.ok(html.includes(DEMO_WALLET), "must contain wallet address");
  assert.ok(html.includes("75 / 100"), "must contain risk score");
  assert.ok(html.includes("HIGH RISK"), "must contain verdict");
  assert.ok(html.includes("badge-danger"), "must style high risk with danger badge");

  // Evaluation window
  assert.ok(html.includes("2024-08-18T16:53:20.000Z .. 2024-08-30T06:43:20.000Z"), "must show formatted evaluation window");

  // Baseline metrics
  assert.ok(html.includes("88"), "must contain tx count");
  assert.ok(html.includes("JUPITER, RAYDIUM (2)"), "must contain sorted venues with count");
  assert.ok(html.includes("2 program(s)"), "must contain known programs count");
  assert.ok(html.includes("$1,250.00"), "must contain formatted median swap USD");
  assert.ok(html.includes("14.5"), "must contain raw median swap amount");
  assert.ok(html.includes("+$1420.50"), "must contain formatted realized PnL");
  assert.ok(html.includes("66.7% (6 round-trips)"), "must contain win rate and round-trips");
  assert.ok(html.includes("2024-08-30T06:43:20.000Z"), "must contain last activity ISO timestamp");

  // Anomaly list
  assert.ok(html.includes("DORMANT_ACTIVE"), "must contain DORMANT_ACTIVE rule id");
  assert.ok(html.includes("LARGE_SWAP"), "must contain LARGE_SWAP rule id");
  assert.ok(html.includes("TOXIC_MINT"), "must contain TOXIC_MINT rule id");
  assert.ok(html.includes("active after 120 days of inactivity"), "must contain anomaly summary text");
  assert.ok(html.includes("sigDormant111"), "must contain evidence signatures");
  assert.ok(html.includes("ToxicMint33333333333333333333333333333333"), "must contain evidence mint address");
  assert.ok(html.includes("hasMintAuthority"), "must contain structured evidence keys");

  // Footer
  assert.ok(html.includes("wallet-radar &middot; deterministic Solana behavioral analysis"), "must include factual footer");
  assert.ok(html.includes("Generated: 2026-09-07T05:00:00.000Z"), "must show generated timestamp");
});

test("renderHtmlReport produces deterministic output for identical input", () => {
  const data: HtmlReportData = {
    wallet: DEMO_WALLET,
    riskScore: 75,
    verdict: "HIGH RISK",
    generatedAt: "2026-09-07T05:00:00.000Z",
    window: {
      sinceSec: 1_724_000_000,
      untilSec: 1_725_000_200,
    },
    baseline: STUB_BASELINE,
    anomalies: STUB_ANOMALIES,
  };

  const html1 = renderHtmlReport(data);
  const html2 = renderHtmlReport(data);
  assert.equal(html1, html2, "repeated render calls with identical inputs must be byte-for-byte identical");
});

test("renderHtmlReport handles empty/safe wallet cleanly", () => {
  const data: HtmlReportData = {
    wallet: "SafeWallet11111111111111111111111111111111",
    riskScore: 0,
    generatedAt: "2026-09-07T05:00:00.000Z",
    baseline: null,
    anomalies: [],
  };

  const html = renderHtmlReport(data);
  assert.ok(html.includes("SafeWallet11111111111111111111111111111111"));
  assert.ok(html.includes("0 / 100"));
  assert.ok(html.includes("SAFE"));
  assert.ok(html.includes("badge-safe"));
  assert.ok(html.includes("No anomalies detected in the evaluation window"));
  assert.ok(html.includes("n/a"));
});

test("formatHistoryText produces clean monospace text summary", () => {
  const data: HtmlReportData = {
    wallet: DEMO_WALLET,
    riskScore: 75,
    generatedAt: "2026-09-07T05:00:00.000Z",
    window: {
      sinceSec: 1_724_000_000,
      untilSec: 1_725_000_200,
    },
    baseline: STUB_BASELINE,
    anomalies: STUB_ANOMALIES,
  };

  const text = formatHistoryText(data);
  assert.ok(text.includes(`wallet-radar history: ${DEMO_WALLET}`));
  assert.ok(text.includes("verdict:    HIGH RISK (risk score 75/100)"));
  assert.ok(text.includes("baseline:   88 txs"));
  assert.ok(text.includes("pnl:        realized +$1420.50, win rate 66.7% (6 round-trips)"));
  assert.ok(text.includes("anomalies:  3 detected"));
  assert.ok(text.includes("- [HIGH] DORMANT_ACTIVE: active after 120 days of inactivity"));
});

test("CLI: radar history outputs terminal text, --export - writes HTML to stdout, and --export <file> writes to file", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "radar-history-test-"));
  const dbPath = join(tmpDir, "test.db");
  const exportPath = join(tmpDir, "report.html");

  try {
    const store = new Store(dbPath);
    store.addWallet(DEMO_WALLET);
    store.saveBaseline(STUB_BASELINE);
    store.recordAnomalies(STUB_ANOMALIES, 1_725_000_200);
    store.close();

    const cliPath = join(process.cwd(), "dist", "src", "cli.js");

    // 1. Text output (no --export flag)
    const textOut = execFileSync(process.execPath, [cliPath, "history", DEMO_WALLET], {
      env: { ...process.env, RADAR_DB: dbPath },
      encoding: "utf8",
    });
    assert.ok(textOut.includes(`wallet-radar history: ${DEMO_WALLET}`));
    assert.ok(textOut.includes("HIGH RISK"));
    assert.ok(textOut.includes("DORMANT_ACTIVE"));

    // 2. Export to stdout with --export -
    const htmlOut = execFileSync(process.execPath, [cliPath, "history", DEMO_WALLET, "--export", "-"], {
      env: { ...process.env, RADAR_DB: dbPath },
      encoding: "utf8",
    });
    assert.ok(htmlOut.startsWith("<!DOCTYPE html>"));
    assert.ok(htmlOut.includes(DEMO_WALLET));
    assert.ok(htmlOut.includes("HIGH RISK"));
    assert.ok(htmlOut.includes("DORMANT_ACTIVE"));
    assert.ok(!htmlOut.includes("<script"));

    // 3. Export to file with --export <file>
    const fileOut = execFileSync(process.execPath, [cliPath, "history", DEMO_WALLET, "--export", exportPath], {
      env: { ...process.env, RADAR_DB: dbPath },
      encoding: "utf8",
    });
    assert.ok(fileOut.includes(`exported HTML report to ${exportPath}`));
    const savedHtml = readFileSync(exportPath, "utf8");
    assert.ok(savedHtml.startsWith("<!DOCTYPE html>"));
    assert.ok(savedHtml.includes(DEMO_WALLET));
    assert.ok(savedHtml.includes("JUPITER, RAYDIUM"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
