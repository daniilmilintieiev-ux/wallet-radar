import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { readScanLedger, ScanLedgerRecord, ZKOracleClient } from "./oracle/index.js";
import { escapeHtml, computeVerdict } from "./htmlreport.js";
import { Store } from "./store.js";
import { corsHeaders } from "./config.js";
import { enforcementFor, DEFENSE_THRESHOLDS, DefenseState, DefenseEnforcement } from "./defense.js";

/**
 * Defense context surfaced to the dashboard for a single wallet: the persisted
 * stance, its implied enforcement, and the recent auditable transition trail.
 * Optional — when absent the dashboard derives a "stance" from the latest scan.
 */
export interface DashboardDefense {
  state: DefenseState;
  riskAt: number;
  setAt: number;
  quietStreak: number;
  actions: number;
  enforcement: DefenseEnforcement;
  trail: Array<{ ts: number; fromState: string; toState: string; action: string; risk: number; reason: string }>;
}

export interface DashboardRenderOptions {
  wallet?: string;
  records?: ScanLedgerRecord[];
  watchlist?: string[];
  generatedAt?: number;
  rpcUrl?: string;
  defense?: DashboardDefense | null;
  demo?: string;
  replayData?: any;
  serviceStatus?: string;
  version?: string;
  tokenCheck?: string;
}

export interface DashboardHttpOptions {
  store?: Store;
  rpcUrl?: string;
  oracleClient?: ZKOracleClient;
}

function formatIso(timestampSec?: number | null): string {
  if (timestampSec == null || !Number.isFinite(timestampSec)) return "n/a";
  const ms = timestampSec > 1e11 ? timestampSec : timestampSec * 1000;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtStamp(timestampSec?: number | null): string {
  if (timestampSec == null || !Number.isFinite(timestampSec)) return "n/a";
  const ms = timestampSec > 1e11 ? timestampSec : timestampSec * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

function riskToState(score: number): DefenseState {
  if (score >= DEFENSE_THRESHOLDS.blocked) return "blocked";
  if (score >= DEFENSE_THRESHOLDS.gated) return "gated";
  if (score >= DEFENSE_THRESHOLDS.alerting) return "alerting";
  return "armed";
}

const STATE_ORDER: readonly DefenseState[] = ["armed", "alerting", "gated", "blocked"];

function shortAddr(w: string): string {
  if (!w) return "—";
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return `v${pkg.version}`;
    }
  } catch {}
  return "v1.0.0";
}

interface DevnetProof {
  program: string;
  signature: string;
  logPhrase: string;
  errorCode: string;
  explorerUrl: string;
  disclaimer: string;
}

function loadDevnetProof(): DevnetProof {
  const fallback: DevnetProof = {
    program: "wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV",
    signature: "3TYaAkc3QRRqGC4ppMJ3pei9HfkznQwvtGuDmedwp54SY9x2CAeu3usvfLUW1n6YR9qxVxdEKtXjU3QJw96mt5aj",
    logPhrase: "destination flagged with HIGH RISK",
    errorCode: "6001",
    explorerUrl: "https://explorer.solana.com/tx/3TYaAkc3QRRqGC4ppMJ3pei9HfkznQwvtGuDmedwp54SY9x2CAeu3usvfLUW1n6YR9qxVxdEKtXjU3QJw96mt5aj?cluster=devnet",
    disclaimer: "enforces a verdict written by the operator; this is not a detection claim",
  };
  try {
    const p = path.resolve(process.cwd(), "assets/devnet-log-sample.json");
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        program: fallback.program,
        signature: data.signature || fallback.signature,
        logPhrase: fallback.logPhrase,
        errorCode: fallback.errorCode,
        explorerUrl: data.explorerUrl || fallback.explorerUrl,
        disclaimer: fallback.disclaimer,
      };
    }
  } catch {}
  return fallback;
}

interface TestStatus {
  status: string;
  collectionStartUtc: string;
  collectionStopUtc: string;
  finalComputationUtc: string;
  protocolUrl: string;
  result: string | null;
}

function loadTestStatus(): TestStatus {
  const fallback: TestStatus = {
    status: "collecting",
    collectionStartUtc: "2026-09-30T09:11:05Z",
    collectionStopUtc: "2026-10-06T18:00:00Z",
    finalComputationUtc: "2026-10-10T09:00:00Z",
    protocolUrl: "https://github.com/daniilmilintieiev-ux/wallet-radar/blob/main/docs/PREREGISTRATION.md",
    result: null,
  };
  try {
    const p = path.resolve(process.cwd(), "docs/dashboard/test-status.json");
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch {}
  return fallback;
}

function loadReplayData(): any {
  try {
    const p = path.resolve(process.cwd(), "docs/dashboard/replay-8XeK5m.json");
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch {}
  return null;
}

const DASHBOARD_CSS = `
:root {
  --bg: #0a0a0b;
  --panel: #101013;
  --ink: #f1f1ee;
  --ink2: #9c9c97;
  --ink3: #63635f;
  --accent: #ffb000;
  --hair: #1f1f23;
  --ok: #3fb950;
  --bad: #f85149;
  --mono: ui-monospace, "SFMono-Regular", "Cascadia Code", "JetBrains Mono", "Consolas", monospace;
}
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border-radius: 0;
}
html, body {
  background: var(--bg);
  color: var(--ink);
  color-scheme: dark;
  font-family: var(--mono);
  font-feature-settings: "tnum" 1;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
a {
  color: inherit;
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
a.acc, .acc {
  color: var(--accent);
}
a.dim, .dim {
  color: var(--ink3);
}
:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
.wrap {
  max-width: 900px;
  margin: 0 auto;
  padding: 0 20px 48px;
  overflow-x: hidden;
}
header {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--hair);
  margin-bottom: 24px;
  padding: 12px 0;
  flex-wrap: wrap;
  gap: 12px;
}
.brand {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: .08em;
}
.header-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  display: inline-block;
  font-size: 12px;
  letter-spacing: .12em;
  padding: 6px 12px;
  border: 1px solid var(--hair);
  color: var(--ink2);
  text-transform: uppercase;
  background: transparent;
}
.chip.active, .chip.acc, .chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 176, 0, .07);
}
.chip.ok {
  color: var(--ok);
}
.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  align-items: center;
  flex-wrap: wrap;
}
.search-input {
  flex: 1;
  min-width: 240px;
  background: var(--panel);
  border: 1px solid var(--hair);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 13px;
  padding: 8px 12px;
}
.search-btn {
  background: var(--panel);
  border: 1px solid var(--hair);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: .1em;
  text-transform: uppercase;
  padding: 8px 16px;
  cursor: pointer;
}
.search-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.watchlist-nav {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.sec-title {
  font-size: 12px;
  letter-spacing: .14em;
  color: var(--ink3);
  text-transform: uppercase;
  margin-bottom: 12px;
}
.hero-block {
  margin-bottom: 32px;
}
.replay-banner {
  border: 1px solid var(--accent);
  background: rgba(255, 176, 0, .06);
  padding: 12px 16px;
  margin-bottom: 20px;
}
.replay-title {
  font-size: 12px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 700;
}
.replay-note {
  font-size: 13px;
  color: var(--ink2);
  margin-top: 4px;
}
.hero-row {
  display: flex;
  gap: 32px;
  align-items: baseline;
  flex-wrap: wrap;
}
.hero-score {
  font-size: 120px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -.02em;
  color: var(--ink);
}
@media (max-width: 700px) {
  .hero-score {
    font-size: 72px;
  }
}
.hero-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hero-verdict {
  font-size: 26px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--ink);
}
.hero-sub {
  font-size: 13px;
  letter-spacing: .04em;
  color: var(--ink3);
}
.hero-wallet {
  font-size: 13px;
  letter-spacing: .04em;
  color: var(--ink2);
  margin-top: 4px;
  word-break: break-all;
}
.scale-container {
  margin-top: 24px;
  position: relative;
}
.scale-track {
  height: 3px;
  width: 100%;
  background: var(--hair);
  position: relative;
}
.scale-fill {
  height: 3px;
  background: var(--accent);
  width: 0%;
  animation: barGrow 700ms ease-out forwards;
}
@keyframes barGrow {
  from { width: 0%; }
  to { width: var(--fill-width, 0%); }
}
@media (prefers-reduced-motion: reduce) {
  .scale-fill {
    animation: none;
    width: var(--fill-width, 0%);
  }
}
.scale-marks {
  position: relative;
  width: 100%;
  height: 32px;
  margin-top: 8px;
}
.scale-tick {
  position: absolute;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.tick-line {
  width: 1px;
  height: 6px;
  background: var(--hair);
  margin-bottom: 4px;
}
.tick-lbl {
  font-size: 12px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink3);
}
.empty-hero {
  border: 1px solid var(--hair);
  background: var(--panel);
  padding: 32px 28px;
  margin-bottom: 32px;
}
.empty-line1 {
  font-size: 18px;
  font-weight: 700;
  color: var(--ink);
  margin-bottom: 8px;
}
.empty-line2 {
  font-size: 14px;
  color: var(--ink2);
  margin-bottom: 16px;
}
.empty-line3 {
  font-size: 13px;
}
.empty-sub {
  margin-top: 14px;
  font-size: 12px;
  color: var(--ink3);
  letter-spacing: .04em;
}
.metrics-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--hair);
  background: var(--panel);
  margin-bottom: 32px;
}
@media (max-width: 700px) {
  .metrics-strip {
    grid-template-columns: 1fr 1fr;
  }
}
.metric-cell {
  padding: 18px 20px;
  border-right: 1px solid var(--hair);
}
.metric-cell:last-child {
  border-right: none;
}
@media (max-width: 700px) {
  .metric-cell:nth-child(2) {
    border-right: none;
  }
  .metric-cell:nth-child(1), .metric-cell:nth-child(2) {
    border-bottom: 1px solid var(--hair);
  }
}
.metric-label {
  font-size: 12px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ink3);
  margin-bottom: 8px;
}
.metric-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1;
}
.two-cols {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 24px;
  margin-bottom: 32px;
}
@media (max-width: 760px) {
  .two-cols {
    grid-template-columns: 1fr;
  }
}
.panel {
  border: 1px solid var(--hair);
  background: var(--panel);
  padding: 22px 24px;
}
.tbl-anomalies {
  width: 100%;
  border-collapse: collapse;
}
.tbl-anomalies th {
  text-align: left;
  font-size: 12px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink3);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--hair);
}
.tbl-anomalies td {
  padding: 10px 0;
  border-bottom: 1px solid var(--hair);
  font-size: 14px;
  vertical-align: top;
}
.tbl-anomalies tr:last-child td {
  border-bottom: none;
}
.sev-high {
  color: var(--bad);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 12px;
  letter-spacing: .1em;
}
.sev-medium {
  color: var(--accent);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 12px;
  letter-spacing: .1em;
}
.sev-low {
  color: var(--ink2);
  text-transform: uppercase;
  font-size: 12px;
  letter-spacing: .1em;
}
.ladder-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ladder-step {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 12px;
  border: 1px solid var(--hair);
  font-size: 13px;
  color: var(--ink3);
  text-transform: uppercase;
  letter-spacing: .12em;
}
.ladder-step.active {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 176, 0, .06);
}
.now-badge {
  font-size: 10px;
  letter-spacing: .14em;
  color: var(--accent);
  font-weight: 700;
}
.three-layers {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--hair);
  background: var(--panel);
  margin-bottom: 8px;
}
@media (max-width: 700px) {
  .three-layers {
    grid-template-columns: 1fr;
  }
}
.layer-cell {
  padding: 16px 18px;
  border-right: 1px solid var(--hair);
}
.layer-cell:last-child {
  border-right: none;
}
@media (max-width: 700px) {
  .layer-cell {
    border-right: none;
    border-bottom: 1px solid var(--hair);
  }
  .layer-cell:last-child {
    border-bottom: none;
  }
}
.layer-lbl {
  font-size: 12px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ink3);
  margin-bottom: 6px;
}
.layer-val {
  font-size: 17px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--ink);
}
.layers-note {
  font-size: 12px;
  letter-spacing: .04em;
  color: var(--ink3);
  margin-bottom: 28px;
}
.token-strip {
  border: 1px solid var(--hair);
  background: var(--panel);
  padding: 14px 20px;
  font-size: 13px;
  letter-spacing: .06em;
  color: var(--ink2);
  margin-bottom: 32px;
}
.block-section {
  border: 1px solid var(--hair);
  background: var(--panel);
  padding: 22px 24px;
  margin-bottom: 32px;
}
.block-header {
  font-size: 12px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--ink3);
  margin-bottom: 14px;
}
.block-kv {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 8px 0;
  border-bottom: 1px solid var(--hair);
  font-size: 14px;
}
.block-kv:last-child {
  border-bottom: none;
}
.block-k {
  color: var(--ink3);
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.block-v {
  color: var(--ink);
  font-size: 14px;
  text-align: right;
  word-break: break-all;
}
.block-sub {
  font-size: 13px;
  color: var(--ink3);
  margin-top: 14px;
  letter-spacing: .04em;
}
footer {
  border-top: 1px solid var(--hair);
  padding-top: 18px;
  font-size: 12px;
  letter-spacing: .04em;
  color: var(--ink3);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
`;

/**
 * Redesigned renderDashboardHtml: matches the weekly report aesthetic of w2_update.html.
 */
export function renderDashboardHtml(opts: DashboardRenderOptions): string {
  const version = opts.version || getPackageVersion();
  const serviceStatus = opts.serviceStatus || "ok";
  const devnetProof = loadDevnetProof();
  const testStatus = loadTestStatus();

  let wallet = opts.wallet || "";
  const isReplayMode = opts.demo === "replay" || opts.wallet === "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j";
  let replayData = opts.replayData || (opts.demo === "replay" ? loadReplayData() : null);

  let hasData = false;
  let riskScore = 0;
  let verdictText = "n/a";
  let txCountDisplay = "n/a";
  let anomaliesCountDisplay = "n/a";
  let liquidityDisplay = "n/a";
  let freshnessDisplay = "n/a";
  let anomaliesList: Array<{ type: string; severity: string; text: string }> = [];
  let baseVerdict = "n/a";
  let agentVerdict = "n/a";
  let defenseState: DefenseState = "armed";
  let recordedAtUtc = "";
  let isHistoricReplay = false;
  let defenseAuditTrail: Array<{ ts: number; fromState: string; toState: string; action: string; risk: number; reason: string }> = [];
  let defenseActionsCount = 0;

  if (opts.demo === "replay" && replayData) {
    hasData = true;
    isHistoricReplay = true;
    wallet = replayData.wallet || "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j";
    riskScore = replayData.riskScore ?? 100;
    verdictText = riskScore >= 75 ? "BLOCKED" : riskScore >= 50 ? "GATED" : riskScore >= 30 ? "ALERTING" : "ARMED";
    txCountDisplay = Number(replayData.historyTxCount || 1307).toLocaleString("en-US");
    anomaliesCountDisplay = String(replayData.anomalies?.length || 8);
    liquidityDisplay = replayData.baseline?.medianSwapAmountUsd != null
      ? `$${replayData.baseline.medianSwapAmountUsd.toFixed(2)}`
      : "n/a";
    freshnessDisplay = replayData.window?.untilSec ? fmtStamp(replayData.window.untilSec) : "2026-08-31 08:00 UTC";
    anomaliesList = (replayData.anomalies || []).map((a: any) => ({
      type: a.type || "ANOMALY",
      severity: a.severity || "high",
      text: a.text || (a.evidence ? JSON.stringify(a.evidence) : "Detected anomaly"),
    }));
    baseVerdict = "hold";
    agentVerdict = "block";
    defenseState = "blocked";
    recordedAtUtc = replayData.recordedAtUtc || "2026-10-01T20:29:39Z";
  } else if (opts.records && opts.records.length > 0) {
    hasData = true;
    const latest = opts.records[0];
    wallet = wallet || latest.wallet;
    riskScore = latest.riskScore ?? 0;
    verdictText = latest.verdict || computeVerdict(riskScore);
    txCountDisplay = latest.txSignatures && latest.txSignatures.length > 0
      ? String(latest.txSignatures.length)
      : String(opts.records.length);
    anomaliesCountDisplay = String(latest.topRules?.length || 0);
    liquidityDisplay = "n/a";
    freshnessDisplay = fmtStamp(latest.timestamp);
    anomaliesList = (latest.topRules || []).map((r: string) => ({
      type: r,
      severity: r === "DORMANT_ACTIVE" || r === "LARGE_SWAP" ? "high" : "medium",
      text: `Rule ${r} triggered on-chain`,
    }));
    baseVerdict = riskScore >= 30 ? "hold" : "safe";
    if (opts.defense) {
      defenseState = opts.defense.state;
      agentVerdict = opts.defense.enforcement?.verdict || "n/a";
      defenseAuditTrail = opts.defense.trail || [];
      defenseActionsCount = opts.defense.actions || 0;
    } else {
      defenseState = riskToState(riskScore);
      agentVerdict = defenseState === "blocked" ? "block" : defenseState === "gated" ? "throttle" : "allow";
    }
    if (wallet === "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j") {
      isHistoricReplay = true;
      recordedAtUtc = "2026-10-01T20:29:39Z";
    }
  }

  const tokenCheckValue = opts.tokenCheck
    ? `token check: ${escapeHtml(opts.tokenCheck)}`
    : "token check: not reported by this data source";

  const safeFillWidth = Math.max(0, Math.min(100, riskScore));

  const watchlistHtml = (opts.watchlist || [])
    .map((w) => {
      const active = w === wallet ? " on active" : "";
      return `<a href="/dashboard?wallet=${escapeHtml(w)}" class="chip${active}">${escapeHtml(shortAddr(w))}</a>`;
    })
    .join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Wallet Radar — Scan Ledger Dashboard</title>
  <style>
${DASHBOARD_CSS}
  </style>
</head>
<body>
  <div class="wrap">
    <!-- 1. Header -->
    <header>
      <div class="brand">WALLET RADAR</div>
      <div class="header-chips">
        <span class="chip">${escapeHtml(version)}</span>
        <span class="chip">hook: devnet</span>
        <span class="chip ${serviceStatus === "ok" ? "ok" : ""}">${escapeHtml(`service: ${serviceStatus}`)}</span>
      </div>
    </header>

    <!-- Target Wallet Search & Watchlist -->
    <form action="/dashboard" method="GET" class="search-bar">
      <input id="wallet-input" type="text" name="wallet" value="${escapeHtml(wallet)}" placeholder="Solana base58 address..." class="search-input" />
      <button type="submit" class="search-btn">Inspect</button>
    </form>
    ${opts.watchlist && opts.watchlist.length > 0 ? `<div class="watchlist-nav">${watchlistHtml}</div>` : ""}

    <!-- 2. Hero Block -->
    ${
      !hasData
        ? `<!-- Empty State -->
    <div class="empty-hero">
      <div class="empty-line1">No wallet selected.</div>
      <div class="empty-line2">Open /dashboard?wallet=<address> to read its scan history.</div>
      <div class="empty-line3">
        <a href="/dashboard?demo=replay" class="acc">View recorded replay (8XeK5m...)</a>
      </div>
      <div class="empty-sub">
        Inspect target wallet ledger | ZK scan ledger (~400x cost vs uncompressed on-chain accounts)
        ${wallet ? `| No On-Chain Scan Attestations Found for <code>${escapeHtml(wallet)}</code>. Run <code>radar scan ${escapeHtml(wallet)}</code> to record a scan.` : ""}
      </div>
    </div>`
        : `<!-- Populated Hero -->
    <div class="hero-block">
      ${
        isHistoricReplay
          ? `<div class="replay-banner">
        <div class="replay-title">RECORDED REPLAY, historical window, recorded ${escapeHtml(recordedAtUtc || "2026-10-01T20:29:39Z")}</div>
        <div class="replay-note">historical replay, not a confirmed incident</div>
      </div>`
          : ""
      }
      <div class="hero-row">
        <div class="hero-score">${riskScore}</div>
        <div class="hero-meta">
          <div class="hero-verdict">${escapeHtml(verdictText)}</div>
          <div class="hero-sub">behavioral risk, 0-100</div>
          <div class="hero-wallet">${escapeHtml(wallet)}</div>
        </div>
      </div>

      <!-- Horizontal Scale 0-100 -->
      <div class="scale-container" style="--fill-width: ${safeFillWidth}%;">
        <div class="scale-track">
          <div class="scale-fill"></div>
        </div>
        <div class="scale-marks">
          <div class="scale-tick" style="left: 30%;">
            <div class="tick-line"></div>
            <div class="tick-lbl">alerting</div>
          </div>
          <div class="scale-tick" style="left: 50%;">
            <div class="tick-line"></div>
            <div class="tick-lbl">gated</div>
          </div>
          <div class="scale-tick" style="left: 75%;">
            <div class="tick-line"></div>
            <div class="tick-lbl">blocked</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. Metrics Strip -->
    <div class="metrics-strip">
      <div class="metric-cell">
        <div class="metric-label">Transactions Analysed</div>
        <div class="metric-value">${escapeHtml(txCountDisplay)}</div>
      </div>
      <div class="metric-cell">
        <div class="metric-label">Anomalies</div>
        <div class="metric-value">${escapeHtml(anomaliesCountDisplay)}</div>
      </div>
      <div class="metric-cell">
        <div class="metric-label">Liquidity</div>
        <div class="metric-value">${escapeHtml(liquidityDisplay)}</div>
      </div>
      <div class="metric-cell">
        <div class="metric-label">Data Freshness</div>
        <div class="metric-value" style="font-size: 16px; margin-top: 8px;">${escapeHtml(freshnessDisplay)}</div>
      </div>
    </div>

    <!-- 4. Two Columns: Anomalies Table & Defense Ladder -->
    <div class="two-cols">
      <div class="panel">
        <div class="sec-title">Anomalies (${anomaliesList.length})</div>
        ${
          anomaliesList.length === 0
            ? `<div style="color: var(--ink3); font-size: 14px;">No anomalies detected.</div>`
            : `<table class="tbl-anomalies">
          <thead>
            <tr>
              <th>Type</th>
              <th>Severity</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            ${anomaliesList
              .map(
                (a) => `<tr>
              <td style="font-weight: 600;">${escapeHtml(a.type)}</td>
              <td><span class="sev-${escapeHtml(a.severity)}">${escapeHtml(a.severity)}</span></td>
              <td style="color: var(--ink2);">${escapeHtml(a.text)}</td>
            </tr>`,
              )
              .join("\n            ")}
          </tbody>
        </table>`
        }
      </div>

      <div class="panel">
        <div class="sec-title">Defense Ladder</div>
        <div class="ladder-list">
          ${STATE_ORDER.map((st) => {
            const isActive = st === defenseState;
            const threshold = st === "blocked" ? ">= 75" : st === "gated" ? ">= 50" : st === "alerting" ? ">= 30" : "< 30";
            return `<div class="ladder-step ${isActive ? "active" : ""}">
            <span>${escapeHtml(st)} <span style="color: var(--ink3); font-size: 11px;">(${threshold})</span></span>
            ${isActive ? `<span class="now-badge">NOW</span>` : ""}
          </div>`;
          }).join("\n          ")}
        </div>
        ${
          opts.defense
            ? `<div style="margin-top: 16px; font-size: 12px; color: var(--ink3);">
          <div>Active defense state: <b>${escapeHtml(defenseState)}</b></div>
          <div>Enforcement: <b>${escapeHtml((agentVerdict || "").toUpperCase())}</b></div>
          <div>${defenseActionsCount} defense actions recorded</div>
          ${
            defenseAuditTrail.length > 0
              ? `<div style="margin-top: 8px;"><b>Defense audit trail</b>: ${defenseAuditTrail.map((t) => `${escapeHtml(t.fromState)}->${escapeHtml(t.toState)} (${escapeHtml(t.action)})`).join(", ")}</div>`
              : ""
          }
        </div>`
            : ""
        }
      </div>
    </div>

    <!-- 5. Three Layers of One Response -->
    <div class="sec-title">Three Decision Layers</div>
    <div class="three-layers">
      <div class="layer-cell">
        <div class="layer-lbl">Base Verdict</div>
        <div class="layer-val">${escapeHtml(baseVerdict)}</div>
      </div>
      <div class="layer-cell">
        <div class="layer-lbl">Agent Verdict</div>
        <div class="layer-val">${escapeHtml((agentVerdict || "n/a").toUpperCase())}</div>
      </div>
      <div class="layer-cell">
        <div class="layer-lbl">Defense State</div>
        <div class="layer-val">&gt;${escapeHtml(defenseState.toUpperCase())}&lt;</div>
      </div>
    </div>
    <div class="layers-note">Three separate systems; they can disagree.</div>

    <!-- 6. Token Check Strip -->
    <div class="token-strip">
      ${escapeHtml(tokenCheckValue)}
    </div>`
    }

    ${
      opts.records && opts.records.length > 0
        ? `<!-- Scan Ledger Table for On-Chain Records -->
    <div class="block-section">
      <div class="block-header">Scan ledger (${opts.records.length} recorded)</div>
      <table class="tbl-anomalies">
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Slot</th>
            <th>Score</th>
            <th>Verdict</th>
            <th>Compressed PDA</th>
            <th>Signature</th>
          </tr>
        </thead>
        <tbody>
          ${opts.records
            .map(
              (r) => `<tr>
            <td style="color: var(--ink2);">${escapeHtml(formatIso(r.timestamp).slice(0, 19))}</td>
            <td>${escapeHtml(String(r.slot ?? "—"))}</td>
            <td style="font-weight: 700;">${r.riskScore}</td>
            <td>${escapeHtml(r.verdict || computeVerdict(r.riskScore))}</td>
            <td style="color: var(--ink3); font-size: 12px;"><code>${escapeHtml(r.compressedAddress ? r.compressedAddress.slice(0, 12) + "..." : "—")}</code></td>
            <td style="color: var(--ink3); font-size: 12px;"><code>${escapeHtml(r.onchainSignature ? r.onchainSignature.slice(0, 16) + "..." : "—")}</code></td>
          </tr>`,
            )
            .join("\n          ")}
        </tbody>
      </table>
    </div>`
        : ""
    }

    <!-- 7. On-chain proof (devnet) -->
    <div class="block-section">
      <div class="block-header">On-Chain Proof (devnet)</div>
      <div class="block-kv">
        <span class="block-k">Program</span>
        <span class="block-v"><code>${escapeHtml(devnetProof.program)}</code></span>
      </div>
      <div class="block-kv">
        <span class="block-k">Tx Signature (Error 6001)</span>
        <span class="block-v"><code>${escapeHtml(devnetProof.signature)}</code></span>
      </div>
      <div class="block-kv">
        <span class="block-k">Log Phrase</span>
        <span class="block-v" style="color: var(--bad);">${escapeHtml(devnetProof.logPhrase)}</span>
      </div>
      <div class="block-kv">
        <span class="block-k">Solana Explorer</span>
        <span class="block-v">
          <a href="${escapeHtml(devnetProof.explorerUrl)}" target="_blank" rel="noopener" class="acc">View on Solana Explorer (devnet)</a>
        </span>
      </div>
      <div class="block-sub">${escapeHtml(devnetProof.disclaimer)}</div>
    </div>

    <!-- 8. Independent Test -->
    <div class="block-section">
      <div class="block-header">Independent Test</div>
      <div class="block-kv">
        <span class="block-k">Status</span>
        <span class="block-v">${escapeHtml(testStatus.status)}</span>
      </div>
      <div class="block-kv">
        <span class="block-k">Collection Window</span>
        <span class="block-v">${escapeHtml(testStatus.collectionStartUtc)} .. ${escapeHtml(testStatus.collectionStopUtc)}</span>
      </div>
      <div class="block-kv">
        <span class="block-k">Final Computation</span>
        <span class="block-v">${escapeHtml(testStatus.finalComputationUtc)}</span>
      </div>
      <div class="block-kv">
        <span class="block-k">Preregistration Protocol</span>
        <span class="block-v">
          <a href="${escapeHtml(testStatus.protocolUrl)}" target="_blank" rel="noopener" class="acc">docs/PREREGISTRATION.md on GitHub</a>
        </span>
      </div>
      <div class="block-kv">
        <span class="block-k">Test Result</span>
        <span class="block-v" style="color: var(--ink2);">
          ${testStatus.result === null ? "Result will be published as computed, including 'insufficient data'." : escapeHtml(String(testStatus.result))}
        </span>
      </div>
    </div>

    <!-- 9. Footer -->
    <footer>
      <span>Behavioral signals, not accuracy claims. <a href="https://github.com/daniilmilintieiev-ux/wallet-radar/blob/main/docs/KNOWN-ISSUES.md" class="dim">Known limitations</a></span>
      <span class="dim">Generated ${new Date().toISOString().slice(0, 10)}</span>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Fetches scan records from the on-chain ledger and renders the HTML dashboard.
 */
export async function fetchAndRenderDashboard(
  wallet: string,
  opts: {
    rpcUrl?: string;
    client?: ZKOracleClient;
    limit?: number;
    watchlist?: string[];
    defense?: DashboardDefense | null;
  } = {},
): Promise<string> {
  const records = wallet
    ? await readScanLedger(wallet, {
        client: opts.client,
        rpcUrl: opts.rpcUrl,
        limit: opts.limit ?? 20,
      })
    : [];

  return renderDashboardHtml({
    wallet,
    records,
    watchlist: opts.watchlist,
    rpcUrl: opts.rpcUrl,
    defense: opts.defense ?? null,
  });
}

/**
 * Formats scan ledger records into a clean monospace terminal table.
 */
export function formatLedgerTerminalTable(records: ScanLedgerRecord[]): string {
  if (records.length === 0) {
    return "No on-chain scan ledger records found.";
  }

  const lines: string[] = [];
  lines.push("--------------------------------------------------------------------------------------------------");
  lines.push("TIMESTAMP (UTC)      SLOT       SCORE  VERDICT     RULES FIRED          TX SIGNATURE");
  lines.push("--------------------------------------------------------------------------------------------------");

  for (const r of records) {
    const time = formatIso(r.timestamp).slice(0, 19);
    const slot = String(r.slot ?? "—").padEnd(10);
    const score = String(r.riskScore).padStart(3);
    const verdict = (r.verdict || computeVerdict(r.riskScore)).padEnd(11);
    const rules = (r.topRules && r.topRules.length > 0 ? r.topRules.join(",") : "—").slice(0, 19).padEnd(20);
    const sig = r.onchainSignature ? `${r.onchainSignature.slice(0, 18)}...` : "—";
    lines.push(`${time}  ${slot} ${score}    ${verdict} ${rules} ${sig}`);
  }
  lines.push("--------------------------------------------------------------------------------------------------");

  return lines.join("\n");
}

/**
 * Builds a DashboardDefense from the Store for a wallet (null when no stance).
 */
function readDefense(store: Store | undefined, wallet: string): DashboardDefense | null {
  if (!store || !wallet) return null;
  try {
    const info = store.getDefenseState(wallet);
    if (!info) return null;
    const trail = store.recentDefenseEvents(wallet, 8);
    return {
      state: info.state,
      riskAt: info.riskAt,
      setAt: info.setAt,
      quietStreak: info.quietStreak,
      actions: info.actions,
      enforcement: enforcementFor(info.state),
      trail,
    };
  } catch {
    return null;
  }
}

/**
 * Handles incoming HTTP requests for `/dashboard` and `/api/ledger`.
 * Returns `true` if handled, `false` otherwise.
 */
export async function handleDashboardHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: DashboardHttpOptions = {},
): Promise<boolean> {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() || "GET";

  // 1. /dashboard HTML view
  if (pathname === "/dashboard") {
    if (method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return true;
    }

    const demo = url.searchParams.get("demo")?.trim() || "";
    const wallet = url.searchParams.get("wallet")?.trim() || "";
    let watchlist: string[] = [];
    if (options.store) {
      try {
        watchlist = options.store.listWallets();
      } catch {}
    }

    let records: ScanLedgerRecord[] = [];
    if (demo === "replay") {
      const replayData = loadReplayData();
      const html = renderDashboardHtml({
        wallet: replayData?.wallet || "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j",
        demo: "replay",
        replayData,
        watchlist,
      });
      const bodyBuf = Buffer.from(html, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": bodyBuf.length,
        ...corsHeaders(req.headers.origin as string | undefined),
      });
      res.end(bodyBuf);
      return true;
    }

    if (wallet) {
      records = await readScanLedger(wallet, {
        client: options.oracleClient,
        rpcUrl: options.rpcUrl,
        limit: 50,
      });
    }

    const defense = readDefense(options.store, wallet);

    const html = renderDashboardHtml({
      wallet,
      records,
      watchlist,
      rpcUrl: options.rpcUrl,
      defense,
    });

    const bodyBuf = Buffer.from(html, "utf-8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": bodyBuf.length,
      ...corsHeaders(req.headers.origin as string | undefined),
    });
    res.end(bodyBuf);
    return true;
  }

  // 2. /api/ledger JSON view
  if (pathname === "/api/ledger") {
    if (method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return true;
    }

    const wallet = url.searchParams.get("wallet")?.trim();
    if (!wallet) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required query parameter: wallet" }));
      return true;
    }

    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 20)) : 20;

    const records = await readScanLedger(wallet, {
      client: options.oracleClient,
      rpcUrl: options.rpcUrl,
      limit,
    });

    const payload = JSON.stringify({
      wallet,
      latest: records.length > 0 ? records[0] : null,
      history: records,
      count: records.length,
    }, null, 2);

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req.headers.origin as string | undefined),
    });
    res.end(payload);
    return true;
  }

  return false;
}
