import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { readScanLedger, ScanLedgerRecord, ZKOracleClient } from "./oracle/index.js";
import { escapeHtml, computeVerdict } from "./htmlreport.js";
import { Store } from "./store.js";
import { corsHeaders, isValidBase58 } from "./config.js";
import { enforcementFor, DEFENSE_THRESHOLDS, DefenseState, DefenseEnforcement } from "./defense.js";
import { FONT_FACES_CSS, DISPLAY_FONT_STACK, MONO_FONT_STACK } from "./dashboard-fonts.js";
import { renderRadar, RadarAnomaly } from "./dashboard-radar.js";

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
  baseVerdict?: string;
  liquidityUsd?: number | null;
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

function shortAddr(w: string): string {
  if (!w) return "—";
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-6)}` : w;
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

interface DevnetLogSample {
  signature: string;
  explorerUrl: string;
  logMessages: string[];
}

function loadDevnetLogSample(): DevnetLogSample {
  const fallback: DevnetLogSample = {
    signature: "3TYaAkc3QRRqGC4ppMJ3pei9HfkznQwvtGuDmedwp54SY9x2CAeu3usvfLUW1n6YR9qxVxdEKtXjU3QJw96mt5aj",
    explorerUrl: "https://explorer.solana.com/tx/3TYaAkc3QRRqGC4ppMJ3pei9HfkznQwvtGuDmedwp54SY9x2CAeu3usvfLUW1n6YR9qxVxdEKtXjU3QJw96mt5aj?cluster=devnet",
    logMessages: [
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [1]",
      "Program log: Instruction: TransferChecked",
      "Program wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV invoke [2]",
      "Program log: Instruction: Execute",
      "Program log: RadarHook: evaluating destination 3JnUsJKmpgjDNpWJxaNkAfkD6EuEByEgBMguQVMe4pni (score: 70, verdict: 3, timestamp: 1790246360)",
      "Program log: RadarHook: REJECTED - destination flagged with HIGH RISK verdict",
      "Program log: AnchorError occurred. Error Code: CounterpartyFlagged. Error Number: 6001. Error Message: Destination wallet is flagged with HIGH RISK verdict on-chain.",
      "Program wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV consumed 35249 of 176441 compute units",
      "Program wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV failed: custom program error: 0x1771",
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 58808 of 200000 compute units",
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1771",
    ],
  };

  try {
    const filePath = path.resolve(process.cwd(), "assets/devnet-log-sample.json");
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        signature: data.signature || fallback.signature,
        explorerUrl: data.explorerUrl || fallback.explorerUrl,
        logMessages: Array.isArray(data.logMessages) ? data.logMessages : fallback.logMessages,
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
  result: any;
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
    const filePath = path.resolve(process.cwd(), "docs/dashboard/test-status.json");
    if (fs.existsSync(filePath)) {
      return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
    }
  } catch {}

  return fallback;
}

function loadReplayData(): any {
  try {
    const filePath = path.resolve(process.cwd(), "docs/dashboard/replay-8XeK5m.json");
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch {}
  return null;
}

function formatDescriptionWithCopy(desc: string): string {
  const escaped = escapeHtml(desc);
  // Match Solana base58 address tokens (32-44 chars)
  return escaped.replace(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g, (_match, addr) => {
    const label = `${addr.slice(0, 6)}…${addr.slice(-6)}`;
    return `<button type="button" class="copy-btn mono" data-copy="${addr}" title="${addr}">${label}</button>`;
  });
}

function formatEvidenceShort(evidence: any): string {
  if (!evidence || typeof evidence !== "object") return "";
  const parts: string[] = [];
  if (evidence.daysSilent != null) parts.push(`days silent: ${evidence.daysSilent}`);
  if (evidence.venue) parts.push(`venue: ${evidence.venue}`);
  if (evidence.usd != null) parts.push(`amount: $${evidence.usd}`);
  if (evidence.program) parts.push(`program: ${evidence.program}`);
  if (evidence.counterparty) parts.push(`counterparty: ${evidence.counterparty}`);
  if (evidence.interactions != null) parts.push(`interactions: ${evidence.interactions}`);
  if (Array.isArray(evidence.reasons) && evidence.reasons.length > 0) parts.push(evidence.reasons.join(", "));
  if (parts.length > 0) return parts.join("; ");
  return Object.entries(evidence)
    .filter(([k, v]) => v != null && typeof v !== "object" && k !== "sig")
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

function escapeText(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAnomalyText(desc: string): string {
  let escaped = escapeText(desc);
  // Wrap Solana base58 addresses (32-44 characters) in mono
  escaped = escaped.replace(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g, '<span class="mono">$1</span>');
  // Wrap identifiers like OKX_DEX_ROUTER (uppercase with underscores) in mono
  escaped = escaped.replace(/\b([A-Z0-9]+_[A-Z0-9_]+)\b/g, '<span class="mono">$1</span>');
  return escaped;
}

const DASHBOARD_CSS = `
${FONT_FACES_CSS}

:root {
  --display: ${DISPLAY_FONT_STACK};
  --mono: ${MONO_FONT_STACK};
  --bg: #0a0a0b;
  --bg-zone: #131316;
  --panel: #101013;
  --ink: #f1f1ee;
  --ink2: #9c9c97;
  --ink3: #63635f;
  --accent: #ffb000;
  --hair: #1f1f23;
  --ok: #3fb950;
  --bad: #f85149;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border-radius: 0;
}

body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--display);
  font-size: 15px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.mono {
  font-family: var(--mono) !important;
}

/* 1. Top bar (56px) */
.top-bar {
  height: 56px;
  border-bottom: 1px solid var(--hair);
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
}
.top-bar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}
.top-bar-title {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: .02em;
  color: var(--ink);
  text-decoration: none;
}
.top-bar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pill {
  font-size: 13px;
  font-weight: 600;
  padding: 3px 8px;
  border: 1px solid var(--hair);
  color: var(--ink2);
  background: transparent;
}
.pill-static {
  color: var(--ink3);
  border-color: var(--hair);
}
.pill-ok {
  color: var(--ok);
  border-color: rgba(63, 185, 80, .4);
}
.pill-bad {
  color: var(--bad);
  border-color: rgba(248, 81, 73, .4);
}

/* Page container */
.container {
  max-width: 1360px;
  width: 100%;
  margin: 0 auto;
  padding: 32px 24px 64px 24px;
  flex: 1;
}

/* Replay banner */
.replay-banner {
  border: 1px solid var(--accent);
  background: rgba(255, 176, 0, .06);
  padding: 12px 16px;
  margin-bottom: 24px;
}
.replay-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent);
}
.replay-note {
  font-size: 13px;
  color: var(--ink2);
  margin-top: 2px;
}

/* Search bar & watchlist */
.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.search-input {
  flex: 1;
  min-width: 280px;
  background: var(--panel);
  border: 1px solid var(--hair);
  color: var(--ink);
  font-size: 13px;
  padding: 8px 12px;
}
.search-input:focus {
  outline: none;
  border-color: var(--accent);
}
.search-btn {
  background: var(--panel);
  border: 1px solid var(--hair);
  color: var(--ink);
  font-family: var(--display);
  font-size: 14px;
  font-weight: 700;
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
  margin-bottom: 28px;
}
.chip {
  font-size: 13px;
  font-weight: 600;
  padding: 4px 10px;
  border: 1px solid var(--hair);
  color: var(--ink2);
  text-decoration: none;
}
.chip:hover {
  border-color: var(--accent);
  color: var(--ink);
}
.chip.active {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 176, 0, .07);
}

/* 2. Hero (2 columns 7/5) */
.hero-grid {
  display: grid;
  grid-template-columns: 7fr 5fr;
  gap: 40px;
  align-items: center;
  margin-bottom: 48px;
}

/* Radar */
.radar-column {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.radar-wrapper {
  position: relative;
  width: 100%;
  max-width: 560px;
  aspect-ratio: 1 / 1;
}
.radar-svg {
  display: block;
  width: 100%;
  height: 100%;
}
.radar-sweep {
  position: absolute;
  top: calc(50% - 46.875%);
  left: calc(50% - 46.875%);
  width: 93.75%;
  height: 93.75%;
  border-radius: 50%;
  pointer-events: none;
  background: conic-gradient(from 0deg at 50% 50%, rgba(255, 176, 0, .35) 0deg, rgba(255, 176, 0, 0) 60deg, transparent 60deg);
  animation: radar-sweep-turn 2.4s linear 1 forwards;
}
@keyframes radar-sweep-turn {
  0% { transform: rotate(0deg); opacity: 1; }
  99% { transform: rotate(360deg); opacity: 1; }
  100% { transform: rotate(360deg); opacity: 0; }
}

:focus-visible {
  outline: 1px solid var(--accent) !important;
  outline-offset: 2px;
}
.radar-dot:focus-visible,
.anomaly-row:focus-visible {
  outline: 1px solid var(--accent) !important;
  outline-offset: 2px;
}

.radar-dot {
  opacity: 0;
  cursor: pointer;
  animation: dot-reveal 0.15s ease-out forwards;
}
@keyframes dot-reveal {
  to { opacity: 1; }
}
.radar-dot.anomaly-active circle {
  stroke: var(--accent) !important;
  stroke-width: 2.5px !important;
}
.radar-dot.anomaly-active {
  filter: drop-shadow(0 0 6px var(--accent));
}

@media (prefers-reduced-motion: reduce) {
  .radar-sweep {
    display: none !important;
  }
  .radar-dot {
    opacity: 1 !important;
    animation: none !important;
  }
}

.radar-caption {
  margin-top: 14px;
  font-size: 13px;
  color: var(--ink3);
  text-align: center;
  max-width: 520px;
}

/* Hero Right: Risk Number & Scale */
.hero-risk-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.hero-risk-header {
  display: flex;
  align-items: baseline;
  gap: 24px;
  flex-wrap: wrap;
}
.risk-value {
  font-size: 200px;
  font-weight: 800;
  line-height: .85;
  color: var(--accent);
  text-shadow: 0 0 24px rgba(255, 176, 0, .25);
  font-variant-numeric: tabular-nums;
}
.risk-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.risk-verdict {
  font-size: 40px;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: .02em;
}
.verdict-sub {
  font-size: 12px;
  color: var(--ink3);
  margin-top: 2px;
  margin-bottom: 2px;
}
.risk-sub {
  font-size: 15px;
  color: var(--ink2);
}

/* Scale */
.risk-scale-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.risk-scale-bar {
  position: relative;
  display: grid;
  grid-template-columns: 30fr 20fr 25fr 25fr;
  height: 28px;
  border: 1px solid var(--hair);
  background: var(--bg);
}
.scale-segment {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink3);
  border-right: 1px solid var(--hair);
}
.scale-segment:last-child {
  border-right: none;
}
.scale-segment.active {
  background: rgba(255, 176, 0, .06);
  color: var(--accent);
}
.risk-marker {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: var(--accent);
}
.scale-thresholds {
  position: relative;
  height: 16px;
  font-size: 11px;
  color: var(--ink3);
}
.scale-thresholds span {
  position: absolute;
  transform: translateX(-50%);
}

.metric-strip {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.metric-box {
  border: 1px solid var(--hair);
  background: var(--panel);
  padding: 10px 14px;
  min-width: 140px;
}
.metric-box-lbl {
  font-size: 12px;
  color: var(--ink3);
}
.metric-box-val {
  font-size: 22px;
  font-weight: 700;
  color: var(--ink);
  margin-top: 2px;
}

/* Empty Hero */
.empty-hero-box {
  border: 1px solid var(--hair);
  background: var(--panel);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.empty-line1 {
  font-size: 24px;
  font-weight: 700;
  color: var(--ink);
}
.empty-line2 {
  font-size: 15px;
  color: var(--ink2);
}
.empty-line3 {
  font-size: 15px;
  margin-top: 4px;
}
.empty-line3 a {
  color: var(--accent);
  text-decoration: underline;
}

/* 3. Decision in Three Layers */
.section-block {
  margin-bottom: 44px;
}
.section-header {
  font-size: 18px;
  font-weight: 700;
  color: var(--ink2);
  margin-bottom: 12px;
}
.layers-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.layer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--panel);
  border: 1px solid var(--hair);
  padding: 10px 18px;
  position: relative;
}
.layer-row.has-status {
  border-left-width: 4px;
}
.layer-row.status-ok {
  border-left-color: var(--ok);
}
.layer-row.status-bad {
  border-left-color: var(--bad);
}
.layer-row.status-accent {
  border-left-color: var(--accent);
}
.layer-name {
  font-size: 15px;
  color: var(--ink2);
}
.layer-val {
  font-size: 28px;
  font-weight: 700;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.layer-val.na {
  color: var(--ink3);
  font-size: 16px;
  font-weight: 600;
}
.layers-note {
  margin-top: 10px;
  font-size: 14px;
  color: var(--ink3);
}
.token-check-line {
  margin-top: 6px;
  font-size: 14px;
  color: var(--ink2);
}

/* 4. Anomaly list (stripes, not table) */
.anomaly-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.anomaly-row {
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--panel);
  border: 1px solid var(--hair);
  padding: 12px 16px;
  cursor: pointer;
  outline: none;
}
.anomaly-row:hover,
.anomaly-row:focus,
.anomaly-row.anomaly-active {
  background: rgba(255, 176, 0, .06);
  border-color: var(--accent);
}
.anomaly-time {
  font-size: 13px;
  color: var(--ink2);
  min-width: 145px;
  flex-shrink: 0;
}
.anomaly-type {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
  min-width: 170px;
  flex-shrink: 0;
}
.anomaly-sev {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 90px;
  flex-shrink: 0;
}
.sev-meter {
  display: flex;
  gap: 3px;
}
.sev-bar {
  width: 10px;
  height: 10px;
  border: 1px solid var(--hair);
  background: transparent;
}
.sev-bar.filled {
  background: var(--accent);
  border-color: var(--accent);
}
.badge-bad {
  font-size: 11px;
  font-weight: 600;
  color: var(--bad);
  border: 1px solid var(--bad);
  padding: 1px 4px;
}
.anomaly-desc {
  font-size: 14px;
  color: var(--ink2);
  flex: 1;
  word-break: break-word;
}
.copy-btn {
  background: transparent;
  border: 1px solid var(--hair);
  color: var(--ink2);
  padding: 2px 6px;
  cursor: pointer;
  font-size: 12px;
}
.copy-btn:hover,
.copy-btn:focus {
  border-color: var(--accent);
  color: var(--ink);
  outline: none;
}

/* Ledger table for on-chain records */
.ledger-tbl {
  width: 100%;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--hair);
}
.ledger-tbl th,
.ledger-tbl td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--hair);
  text-align: left;
  font-size: 13px;
}
.ledger-tbl th {
  color: var(--ink3);
  font-weight: 600;
}

/* 5. Transponder Log (devnet) */
.log-box {
  background: var(--panel);
  border: 1px solid var(--hair);
  padding: 16px;
  overflow-x: auto;
}
.log-stack {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.log-line {
  font-size: 13px;
  color: var(--ink2);
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line-bad {
  color: var(--bad);
  border-left: 2px solid var(--bad);
  padding-left: 8px;
}
.log-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 14px;
}
.log-caption {
  font-size: 13px;
  color: var(--ink3);
}
.tx-link {
  font-size: 13px;
  color: var(--accent);
  text-decoration: underline;
}

/* 6. Independent Test */
.test-panel {
  background: var(--panel);
  border: 1px solid var(--hair);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.timeline-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.timeline-bar {
  position: relative;
  display: flex;
  height: 24px;
  border: 1px solid var(--hair);
  background: var(--bg);
}
.timeline-seg-collect {
  width: 63.7%;
  background: rgba(255, 176, 0, .5);
}
.timeline-seg-mature {
  width: 36.3%;
  background: repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(99, 99, 95, .25) 5px, rgba(99, 99, 95, .25) 10px);
}
.timeline-now-marker {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: var(--ink);
}
.timeline-labels {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--ink3);
}
.test-result-box {
  border: 1px dashed var(--hair);
  padding: 16px;
  font-size: 14px;
  color: var(--ink2);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.test-result-box a {
  color: var(--accent);
  text-decoration: underline;
}

/* 7. Footer */
footer {
  border-top: 1px solid var(--hair);
  background: var(--bg);
  padding: 24px 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.footer-note {
  font-size: 14px;
  color: var(--ink2);
}
footer a {
  color: var(--ink2);
  text-decoration: underline;
  font-size: 14px;
}
footer a:hover {
  color: var(--ink);
}

/* Responsiveness down to 390px */
@media (max-width: 900px) {
  .hero-grid {
    grid-template-columns: 1fr;
    gap: 36px;
  }
  .risk-value {
    font-size: 140px;
  }
}
@media (max-width: 600px) {
  .top-bar {
    padding: 0 16px;
    height: auto;
    min-height: 56px;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .top-bar-title {
    font-size: 22px;
  }
  .container {
    padding: 20px 16px 48px 16px;
  }
  .risk-value {
    font-size: 120px;
  }
  .radar-wrapper {
    max-width: 340px;
  }
  .anomaly-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .anomaly-time {
    min-width: unset;
  }
  .anomaly-type {
    min-width: unset;
  }
  .anomaly-desc {
    width: 100%;
  }
  .layer-val {
    font-size: 22px;
  }
  footer {
    padding: 16px;
  }
}
`;

export function renderDashboardHtml(opts: DashboardRenderOptions): string {
  const wallet = opts.wallet || "";
  const records = opts.records || [];
  const latestRecord = records.length > 0 ? records[0] : null;
  const watchlist = opts.watchlist || [];
  const replayData = opts.replayData || (opts.demo === "replay" ? loadReplayData() : null);
  const version = opts.version || getPackageVersion();

  let hasData = false;
  let riskScore = 0;
  let verdict = "SAFE";
  let anomalies: RadarAnomaly[] = [];
  let windowInfo: { sinceSec?: number; untilSec?: number } | undefined;
  let medianSwapUsd: number | null = null;
  let liquidityUsd: number | null = opts.liquidityUsd ?? null;
  let recordedAtUtc = "";
  let isHistoricReplay = false;

  let emptyLine1 = "No wallet selected.";
  let emptyLine2 = "Open /dashboard?wallet=<address> to read its scan history.";
  if (wallet && wallet.trim().length > 0) {
    if (!isValidBase58(wallet)) {
      emptyLine1 = "This does not look like a Solana address (32 bytes, base58).";
      emptyLine2 = "Enter a valid 32-44 character base58 address, or view the demo replay.";
    } else {
      emptyLine1 = "No scan records for this wallet.";
      emptyLine2 = "Run a scan, or open /dashboard?demo=replay to see a recorded example.";
    }
  }

  // 1. Data ingestion (from replay or live record)
  if (opts.demo === "replay" && replayData) {
    hasData = true;
    isHistoricReplay = true;
    riskScore = replayData.riskScore ?? 0;
    verdict = computeVerdict(riskScore);
    recordedAtUtc = replayData.recordedAtUtc || "2026-10-01T20:29:39Z";
    windowInfo = replayData.window;
    medianSwapUsd = replayData.baseline?.medianSwapAmountUsd ?? null;

    if (Array.isArray(replayData.anomalies)) {
      anomalies = replayData.anomalies.map((a: any, idx: number) => {
        const text = a.text || a.description || formatEvidenceShort(a.evidence) || `${a.type} detected in window`;
        return {
          id: `anomaly-${idx}`,
          type: a.type || "ANOMALY",
          severity: a.severity || "medium",
          score: a.evidence?.score,
          timestamp: a.timestamp,
          description: text,
        };
      });
    }
  } else if (latestRecord) {
    hasData = true;
    riskScore = latestRecord.riskScore ?? 0;
    verdict = latestRecord.verdict || computeVerdict(riskScore);

    const rules = latestRecord.topRules || [];
    anomalies = rules.map((r, idx) => ({
      id: `anomaly-${idx}`,
      type: r,
      severity: r.includes("LARGE") || r.includes("DORMANT") ? "high" : "medium",
      timestamp: latestRecord.timestamp,
      description: `${r} detected at slot ${latestRecord.slot}`,
    }));
  }

  const verdictSubtitle = isHistoricReplay
    ? "scan verdict (recorded replay)"
    : "scan verdict";

  // 2. Radar rendering
  const radarResult = renderRadar({
    anomalies,
    window: windowInfo,
    hasData,
  });

  // 3. Service status pill
  let servicePill = `<span class="pill pill-static">service: n/a (static)</span>`;
  if (opts.demo !== "replay" && opts.serviceStatus) {
    if (opts.serviceStatus === "ok") {
      servicePill = `<span class="pill pill-ok">service: ok</span>`;
    } else {
      servicePill = `<span class="pill pill-bad">service: unreachable</span>`;
    }
  }

  // 4. Three Decision Layers (base / agent / defense)
  // Data honesty rule: NEVER derive values from risk score!
  let baseVerdictVal = "n/a (not in replay data)";
  let baseVerdictClass = "na";
  let baseVerdictRowClass = "";
  if (opts.baseVerdict) {
    baseVerdictVal = opts.baseVerdict;
    baseVerdictClass = "";
    baseVerdictRowClass = "has-status " + (opts.baseVerdict === "safe" ? "status-ok" : opts.baseVerdict === "hold" ? "status-bad" : "status-accent");
  }

  let agentVerdictVal = "n/a (not in replay data)";
  let agentVerdictClass = "na";
  let agentVerdictRowClass = "";
  if (opts.defense?.enforcement?.verdict) {
    agentVerdictVal = opts.defense.enforcement.verdict;
    agentVerdictClass = "";
    agentVerdictRowClass = "has-status " + (opts.defense.enforcement.verdict === "allow" ? "status-ok" : opts.defense.enforcement.verdict === "block" ? "status-bad" : "status-accent");
  }

  let defenseStateVal = "n/a (not in replay data)";
  let defenseStateClass = "na";
  let defenseStateRowClass = "";
  if (opts.defense?.state) {
    defenseStateVal = opts.defense.state;
    defenseStateClass = "";
    defenseStateRowClass = "has-status " + (opts.defense.state === "armed" ? "status-ok" : opts.defense.state === "blocked" ? "status-bad" : "status-accent");
  }

  const tokenCheckLine = opts.tokenCheck
    ? `token check: ${escapeHtml(opts.tokenCheck)}`
    : `token check: not reported by this data source`;

  // 5. Devnet Log Sample
  const devnetLog = loadDevnetLogSample();
  const testStatus = loadTestStatus();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wallet Radar</title>
  <style>
${DASHBOARD_CSS}
  </style>
</head>
<body>
  <!-- 1. Top bar (56px) -->
  <header class="top-bar">
    <div class="top-bar-left">
      <a href="/dashboard" class="top-bar-title" data-app="WALLET RADAR">Wallet Radar</a>
    </div>
    <div class="top-bar-right">
      <span class="pill mono">${escapeHtml(version)}</span>
      <span class="pill">hook: devnet</span>
      ${servicePill}
    </div>
  </header>

  <main class="container">
    ${
      isHistoricReplay
        ? `<!-- Replay notice banner -->
    <div class="replay-banner" data-badge="RECORDED REPLAY">
      <div class="replay-title">Recorded replay, historical window, recorded ${escapeHtml(recordedAtUtc)}</div>
      <div class="replay-note">historical replay, not a confirmed incident</div>
    </div>`
        : ""
    }

    <!-- Search bar -->
    <form class="search-bar" action="/dashboard" method="GET">
      <input
        type="text"
        name="wallet"
        class="search-input mono wallet-input"
        placeholder="Enter Solana wallet address (e.g. 8XeK5m...)"
        value="${escapeHtml(wallet)}"
        spellcheck="false"
      />
      <button type="submit" class="search-btn">Inspect</button>
      <a href="/dashboard?demo=replay" class="chip ${opts.demo === "replay" ? "active" : ""}">Demo Replay</a>
    </form>

    ${
      watchlist.length > 0
        ? `<div class="watchlist-nav">
      ${watchlist
        .map((w) => {
          const isActive = w === wallet;
          return `<a href="/dashboard?wallet=${escapeHtml(w)}" class="chip mono ${isActive ? "active on" : ""}" title="${escapeHtml(w)}">${escapeHtml(shortAddr(w))}</a>`;
        })
        .join("\n      ")}
    </div>`
        : ""
    }

    <!-- 2. Hero (two columns 7/5) -->
    <section class="hero-grid">
      <!-- Left: Radar -->
      <div class="radar-column">
        <div class="radar-wrapper">
          ${radarResult.sweepHtml}
          ${radarResult.svg}
        </div>
        <div class="radar-caption">${escapeHtml(radarResult.caption)}</div>
      </div>

      <!-- Right: Risk & Scale -->
      <div>
        ${
          hasData
            ? `<div class="hero-risk-panel">
          <div class="hero-risk-header">
            <div class="risk-value">${riskScore}</div>
            <div class="risk-meta">
              <div class="risk-verdict">${escapeHtml(verdict)}</div>
              <div class="verdict-sub">${escapeHtml(verdictSubtitle)}</div>
              <div class="risk-sub">behavioral risk, 0 to 100</div>
            </div>
          </div>

          <div class="risk-scale-container">
            <div class="risk-scale-bar">
              <div class="scale-segment segment-armed ${riskScore < 30 ? "active" : ""}" data-zone="ARMED">armed 0-29</div>
              <div class="scale-segment segment-alerting ${riskScore >= 30 && riskScore < 50 ? "active" : ""}" data-zone="ALERTING">alerting 30-49</div>
              <div class="scale-segment segment-gated ${riskScore >= 50 && riskScore < 75 ? "active" : ""}" data-zone="GATED">gated 50-74</div>
              <div class="scale-segment segment-blocked ${riskScore >= 75 ? "active" : ""}" data-zone="BLOCKED">blocked 75-100</div>
              <div class="risk-marker" style="left: ${Math.max(0, Math.min(100, riskScore))}%;"></div>
            </div>
            <div class="scale-thresholds">
              <span style="left: 30%;">30</span>
              <span style="left: 50%;">50</span>
              <span style="left: 75%;">75</span>
            </div>
          </div>

          <div class="metric-strip">
            ${
              medianSwapUsd != null
                ? `<div class="metric-box">
              <div class="metric-box-lbl">Median swap</div>
              <div class="metric-box-val mono">$${medianSwapUsd.toFixed(2)}</div>
            </div>`
                : ""
            }
            ${
              liquidityUsd != null
                ? `<div class="metric-box">
              <div class="metric-box-lbl">Liquidity</div>
              <div class="metric-box-val mono">$${liquidityUsd.toFixed(2)}</div>
            </div>`
                : ""
            }
          </div>
        </div>`
            : `<!-- Empty State -->
        <div class="empty-hero-box">
          <div class="empty-line1">${emptyLine1}</div>
          <div class="empty-line2">${emptyLine2}</div>
          <div class="empty-line3">
            <a href="/dashboard?demo=replay" class="acc">View recorded replay (8XeK5m...)</a>
          </div>
        </div>`
        }
      </div>
    </section>

    <!-- 3. Decision in Three Layers -->
    <section class="section-block">
      <div class="section-header">Decision in three layers</div>
      <div class="layers-stack">
        <div class="layer-row ${baseVerdictRowClass}">
          <div class="layer-name">Base verdict</div>
          <div class="layer-val ${baseVerdictClass}">${escapeHtml(baseVerdictVal)}</div>
        </div>
        <div class="layer-row ${agentVerdictRowClass}">
          <div class="layer-name">Agent verdict</div>
          <div class="layer-val ${agentVerdictClass}">${escapeHtml(agentVerdictVal)}</div>
        </div>
        <div class="layer-row ${defenseStateRowClass}">
          <div class="layer-name">Defense state</div>
          <div class="layer-val ${defenseStateClass}">${escapeHtml(defenseStateVal)}</div>
        </div>
      </div>
      <div class="layers-note">Three separate systems; they can disagree.</div>
      <div class="token-check-line">${tokenCheckLine}</div>
    </section>

    ${
      anomalies.length > 0
        ? `<!-- 4. Anomaly list (stripes, not table) -->
    <section class="section-block">
      <div class="section-header">Anomalies (${anomalies.length})</div>
      <div class="anomaly-stack">
        ${anomalies
          .map((a) => {
            const sev = (a.severity || "medium").toLowerCase();
            const sevBars = sev === "high" ? 3 : sev === "medium" ? 2 : 1;
            const displayType = a.type.replace(/_/g, " ");
            return `<div class="anomaly-row" data-anomaly-id="${escapeHtml(a.id)}" data-anomaly-text="${escapeText(a.description || a.type)}" tabindex="0">
          <div class="anomaly-time mono">${escapeHtml(fmtStamp(a.timestamp))}</div>
          <div class="anomaly-type" title="${escapeHtml(a.type)}">${escapeHtml(displayType)}</div>
          <div class="anomaly-sev">
            <div class="sev-meter" title="Severity: ${escapeHtml(sev)}">
              <span class="sev-bar ${sevBars >= 1 ? "filled" : ""}"></span>
              <span class="sev-bar ${sevBars >= 2 ? "filled" : ""}"></span>
              <span class="sev-bar ${sevBars >= 3 ? "filled" : ""}"></span>
            </div>
            ${sev === "high" ? `<span class="badge-bad">high</span>` : ""}
          </div>
          <div class="anomaly-desc">${formatAnomalyText(a.description || a.type)}</div>
        </div>`;
          })
          .join("\n        ")}
      </div>
    </section>`
        : ""
    }

    ${
      records.length > 0
        ? `<!-- Scan Ledger Table for On-Chain Records -->
    <section class="section-block">
      <div class="section-header">Scan ledger (${records.length} recorded)</div>
      <table class="ledger-tbl">
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
          ${records
            .map(
              (r) => `<tr>
            <td class="mono" style="color: var(--ink2);">${escapeHtml(formatIso(r.timestamp).slice(0, 19))}</td>
            <td class="mono">${escapeHtml(String(r.slot ?? "—"))}</td>
            <td class="mono" style="font-weight: 700; color: var(--accent);">${r.riskScore}</td>
            <td>${escapeHtml(r.verdict || computeVerdict(r.riskScore))}</td>
            <td class="mono" style="color: var(--ink3); font-size: 12px;"><code class="mono">${escapeHtml(r.compressedAddress ? r.compressedAddress.slice(0, 12) + "..." : "—")}</code></td>
            <td class="mono" style="color: var(--ink3); font-size: 12px;"><code class="mono">${escapeHtml(r.onchainSignature ? r.onchainSignature.slice(0, 16) + "..." : "—")}</code></td>
          </tr>`,
            )
            .join("\n          ")}
        </tbody>
      </table>
    </section>`
        : ""
    }

    <!-- 5. Transponder log (devnet) -->
    <section class="section-block">
      <div class="section-header">Transponder log (devnet)</div>
      <div class="log-box">
        <div class="log-stack">
          ${devnetLog.logMessages
            .map((msg) => {
              const isBad = msg.includes("REJECTED") || msg.includes("CounterpartyFlagged") || msg.includes("failed");
              return `<div class="log-line mono ${isBad ? "log-line-bad" : ""}">${escapeHtml(msg)}</div>`;
            })
            .join("\n          ")}
        </div>
        <div class="log-footer">
          <div class="log-caption">The hook enforces a verdict written by the operator; this is not a detection claim.</div>
          <a href="${escapeHtml(devnetLog.explorerUrl)}" target="_blank" rel="noopener" class="tx-link mono">${escapeHtml(shortAddr(devnetLog.signature))}</a>
        </div>
      </div>
    </section>

    <!-- 6. Independent Test -->
    <section class="section-block">
      <div class="section-header">Independent test</div>
      <div class="test-panel">
        <div class="timeline-wrap">
          <div class="timeline-bar">
            <div class="timeline-seg-collect" title="Collection (to 2026-10-06 18:00 UTC)"></div>
            <div class="timeline-seg-mature" title="Maturation (to 2026-10-10 UTC)"></div>
            <div class="timeline-now-marker" style="left: 15%;" title="Now: 2026-10-01"></div>
          </div>
          <div class="timeline-labels">
            <span>Start: 2026-09-30 09:11 UTC</span>
            <span>Stop collection: 2026-10-06 18:00 UTC</span>
            <span>Final: 2026-10-10 09:00 UTC</span>
          </div>
        </div>

        <div class="test-result-box">
          <div>Result is published as computed, including 'insufficient data'.</div>
          <a href="${escapeHtml(testStatus.protocolUrl)}" target="_blank" rel="noopener">PREREGISTRATION.md</a>
        </div>
      </div>
    </section>
  </main>

  <!-- 7. Footer -->
  <footer>
    <div class="footer-note">Behavioral signals, not accuracy claims.</div>
    <a href="https://github.com/daniilmilintieiev-ux/wallet-radar/blob/main/docs/KNOWN-ISSUES.md" target="_blank" rel="noopener">docs/KNOWN-ISSUES.md</a>
  </footer>

  <script>
    // Synchronize hover / focus / tap between radar dots and anomaly list
    function clearActive() {
      document.querySelectorAll('.anomaly-active').forEach(function(n) {
        n.classList.remove('anomaly-active');
      });
    }

    document.querySelectorAll('[data-anomaly-id]').forEach(function(el) {
      var id = el.getAttribute('data-anomaly-id');
      if (!id) return;
      function activate() {
        clearActive();
        document.querySelectorAll('[data-anomaly-id="' + id + '"]').forEach(function(n) {
          n.classList.add('anomaly-active');
        });
      }
      function deactivate() {
        clearActive();
      }
      el.addEventListener('mouseenter', activate);
      el.addEventListener('mouseleave', deactivate);
      el.addEventListener('focus', activate);
      el.addEventListener('blur', deactivate);
      el.addEventListener('touchstart', function() {
        activate();
      }, { passive: true });
    });

    // Escape key clears highlights
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        clearActive();
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      }
    });

    // Copy button helper for addresses
    document.querySelectorAll('.copy-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var text = btn.getAttribute('data-copy') || '';
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).catch(function() {});
        }
        var orig = btn.innerText;
        btn.innerText = 'copied';
        setTimeout(function() { btn.innerText = orig; }, 1500);
      });
    });
  </script>
</body>
</html>`;
}

/**
 * Fetches scan ledger records from the ZK oracle and returns rendered HTML.
 */
export async function fetchAndRenderDashboard(
  wallet: string,
  options: { rpcUrl?: string; client?: ZKOracleClient } = {},
): Promise<string> {
  const records = await readScanLedger(wallet, {
    client: options.client,
    rpcUrl: options.rpcUrl,
    limit: 50,
  });

  return renderDashboardHtml({
    wallet,
    records,
    rpcUrl: options.rpcUrl,
  });
}

/**
 * Formats scan ledger records into a plain text CLI table.
 */
export function formatLedgerTerminalTable(records: ScanLedgerRecord[]): string {
  if (!records || records.length === 0) {
    return "No on-chain scan ledger records found.";
  }

  const lines: string[] = [];
  lines.push("TIMESTAMP (UTC)      SLOT      SCORE  VERDICT     TOP RULES            SIGNATURE");
  lines.push("--------------------------------------------------------------------------------------------------");
  for (const r of records) {
    const time = formatIso(r.timestamp).slice(0, 19);
    const slot = String(r.slot ?? "—").padStart(9);
    const score = String(r.riskScore).padStart(3);
    const verdict = (r.verdict || computeVerdict(r.riskScore)).padEnd(11);
    const rules = (r.topRules && r.topRules.length > 0 ? r.topRules.join(",") : "—").slice(0, 19).padEnd(20);
    const sig = r.onchainSignature ? `${r.onchainSignature.slice(0, 18)}...` : "—";
    lines.push(`${time}  ${slot} ${score}    ${verdict} ${rules} ${sig}`);
  }
  lines.push("--------------------------------------------------------------------------------------------------");

  return lines.join("\n");
}

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

    const payload = JSON.stringify(
      {
        wallet,
        latest: records.length > 0 ? records[0] : null,
        history: records,
        count: records.length,
      },
      null,
      2,
    );

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req.headers.origin as string | undefined),
    });
    res.end(payload);
    return true;
  }

  return false;
}
