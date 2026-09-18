import http from "node:http";
import { readScanLedger, ScanLedgerRecord, ZKOracleClient } from "./oracle/index.js";
import { escapeHtml, computeVerdict } from "./htmlreport.js";
import { Store } from "./store.js";
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
  if (timestampSec == null || !Number.isFinite(timestampSec)) return "—";
  const ms = timestampSec > 1e11 ? timestampSec : timestampSec * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function fmtClock(timestampSec?: number | null): string {
  if (timestampSec == null || !Number.isFinite(timestampSec)) return "—";
  const ms = timestampSec > 1e11 ? timestampSec : timestampSec * 1000;
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Map a 0-100 risk score onto the defense ladder (mirrors DEFENSE_THRESHOLDS). */
function riskToState(score: number): DefenseState {
  if (score >= DEFENSE_THRESHOLDS.blocked) return "blocked";
  if (score >= DEFENSE_THRESHOLDS.gated) return "gated";
  if (score >= DEFENSE_THRESHOLDS.alerting) return "alerting";
  return "armed";
}

const STATE_ORDER: readonly DefenseState[] = ["armed", "alerting", "gated", "blocked"];

function fmtLimit(limitUsd: number | null): string {
  if (limitUsd === 0) return "$0.00";
  if (limitUsd == null) return "—";
  return `$${limitUsd.toFixed(2)}`;
}

function shortAddr(w: string): string {
  if (!w) return "—";
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

const CONSOLE_CSS = `
:root{
  --bg:#0a0a0b; --panel:#101013; --ink:#f1f1ee; --ink2:#9c9c97; --ink3:#63635f;
  --line:#26262b; --line2:#3a3a41; --accent:#ffb000; --accent-ink:#1a1400;
  --mono:ui-monospace,"SFMono-Regular","Cascadia Code","JetBrains Mono","Consolas",monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg)}
body{font-family:var(--mono);color:var(--ink);-webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1}
.label{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink2);font-weight:700}
.console{max-width:1440px;margin:0 auto;padding:0 30px 40px}
.top{display:flex;justify-content:space-between;align-items:stretch;border-bottom:3px solid var(--ink);margin-top:26px}
.top .brand{font-size:20px;font-weight:800;letter-spacing:.04em;padding:16px 0}
.top .brand b{color:var(--accent)}
.top .brand .sub{display:block;font-size:9.5px;letter-spacing:.2em;color:var(--ink3);font-weight:600;margin-top:5px}
.top .meta{display:flex;align-items:stretch}
.top .mcell{padding:14px 22px;border-left:2px solid var(--line);display:flex;flex-direction:column;justify-content:center;gap:6px}
.top .mcell .v{font-size:13px;color:var(--ink);font-weight:600}
.top .mcell .live .v{color:var(--accent)}
.cur{display:inline-block;width:8px;height:14px;background:var(--accent);vertical-align:-2px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.readout{display:grid;grid-template-columns:1fr auto;gap:0;border:2px solid var(--line2);margin-top:26px}
.readout .left{padding:26px 30px;border-right:2px solid var(--line2);display:flex;flex-direction:column;gap:14px}
.readout .state-lbl{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--ink2);font-weight:700}
.readout .state{font-size:74px;font-weight:800;letter-spacing:-.01em;line-height:.9;color:var(--accent);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.62}}
.readout .state-cap{font-size:12px;color:var(--ink2);letter-spacing:.04em}
.readout .state-cap b{color:var(--ink)}
.readout .right{display:flex;flex-direction:column}
.readout .right .rcell{padding:18px 26px;border-bottom:2px solid var(--line2);display:flex;flex-direction:column;gap:5px}
.readout .right .rcell:last-child{border-bottom:0}
.readout .right .num{font-size:40px;font-weight:800;line-height:1}
.readout .right .num.warn{color:var(--accent)}
.readout .right .cap{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3)}
.panels{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;margin-top:26px}
.panel{background:var(--panel);border:2px solid var(--line2);padding:16px 16px 18px;display:flex;flex-direction:column;gap:12px}
.panel h3{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink2);font-weight:700;display:flex;justify-content:space-between;align-items:center;padding-bottom:11px;border-bottom:2px solid var(--line)}
.panel h3 .r{color:var(--ink3);letter-spacing:.08em}
.s3{grid-column:span 3}.s4{grid-column:span 4}.s6{grid-column:span 6}.s8{grid-column:span 8}
.kv .row{display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;border-top:1px solid var(--line);gap:14px}
.kv .row:first-child{border-top:0}
.kv .k{font-size:11px;color:var(--ink2);white-space:nowrap}
.kv .v{font-size:13px;font-weight:700;color:var(--ink);text-align:right;word-break:break-all}
.kv .v.on{color:var(--accent)}
.kv .v a{color:var(--ink);text-decoration:none}
.kv .v a:hover{color:var(--accent);text-decoration:underline}
.vladder{display:flex;flex-direction:column;gap:8px}
.vladder .st{display:flex;align-items:center;gap:12px;padding:11px 13px;border:2px solid var(--line)}
.vladder .st .k{font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:var(--ink3)}
.vladder .st .mark{margin-left:auto;width:11px;height:11px;border:2px solid var(--ink3)}
.vladder .st.on{border-color:var(--accent);background:rgba(255,176,0,.08)}
.vladder .st.on .k{color:var(--accent)}
.vladder .st.on .mark{background:var(--accent);border-color:var(--accent)}
.rule-row{display:flex;align-items:center;gap:11px;padding:9px 0;border-top:1px solid var(--line)}
.rule-row:first-child{border-top:0}
.rule-row .sq{width:11px;height:11px;flex:none}
.rule-row .sq.h{background:var(--accent)}
.rule-row .sq.m{background:var(--ink)}
.rule-row .nm{font-size:12.5px;font-weight:700;letter-spacing:.02em}
.ev{display:grid;grid-template-columns:74px 1fr auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
.ev:first-child{border-top:0}
.ev .tm{font-size:11.5px;color:var(--ink2)}
.ev .tx{font-size:12px;color:var(--ink)}
.ev .tx b{color:var(--accent)}
.ev .tag{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--line2);padding:3px 7px;color:var(--ink2);font-weight:700}
.ev .tag.hold{color:var(--accent);border-color:var(--accent)}
.ev .tag.up{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
table{width:100%;border-collapse:collapse}
thead th{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);font-weight:700;text-align:right;padding:0 0 10px;border-bottom:2px solid var(--line)}
thead th:first-child{text-align:left}
tbody td{font-size:12px;padding:10px 0;border-bottom:1px solid var(--line);text-align:right;color:var(--ink2)}
tbody td:first-child{text-align:left;color:var(--ink)}
tbody tr:last-child td{border-bottom:0}
td .rk{font-weight:800;color:var(--ink)}
td .rk.hi{color:var(--accent)}
td .rules{color:var(--ink2)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{font-size:12px;border:1px solid var(--line2);padding:5px 10px;color:var(--ink2);text-decoration:none;letter-spacing:.02em}
.chip:hover{color:var(--ink);border-color:var(--ink2)}
.chip.on{color:var(--accent);border-color:var(--accent)}
.note{font-size:12px;color:var(--ink3);letter-spacing:.02em;line-height:1.5}
.empty{padding:6px 0;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.empty .t{font-size:15px;font-weight:800;letter-spacing:.04em;color:var(--ink)}
.empty .d{font-size:12.5px;color:var(--ink2);line-height:1.6;max-width:680px}
.empty code{color:var(--ink)}
.search{display:flex;flex-direction:column;gap:10px}
.search .row{display:flex;gap:10px}
.search input{flex:1;min-width:0;background:var(--bg);border:2px solid var(--line2);color:var(--ink);font-family:var(--mono);font-size:13px;padding:10px 12px;outline:none}
.search input:focus{border-color:var(--accent)}
.search button{background:var(--accent);color:var(--accent-ink);border:2px solid var(--accent);font-family:var(--mono);font-size:12px;font-weight:800;letter-spacing:.1em;padding:10px 18px;cursor:pointer;text-transform:uppercase}
.search .lbl{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink3);font-weight:700}
footer{margin-top:26px;padding-top:14px;border-top:2px solid var(--line);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer .l{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3)}
footer .l b{color:var(--ink2)}
footer .r{font-size:10.5px;color:var(--ink3)}
@media (max-width:1000px){
  .top{flex-direction:column}
  .top .meta{border-left:0;border-top:2px solid var(--line)}
  .readout{grid-template-columns:1fr}
  .readout .left{border-right:0;border-bottom:2px solid var(--line2)}
  .s3,.s4,.s6,.s8{grid-column:span 12}
}
`;

function renderTop(wallet: string, slot: string | number): string {
  return `
  <div class="top">
    <div class="brand">WALLET<b>_</b>RADAR
      <span class="sub">PRE-COPY TRUST GATE // DETERMINISTIC // NO LLM IN DECISION PATH</span>
    </div>
    <div class="meta">
      <div class="mcell"><span class="label">Wallet</span><span class="v" title="${escapeHtml(wallet)}">${escapeHtml(shortAddr(wallet))}</span></div>
      <div class="mcell"><span class="label">Slot</span><span class="v">${escapeHtml(String(slot))}</span></div>
      <div class="mcell live"><span class="label">Link</span><span class="v"><span id="clock">--:--:--</span> <span class="cur"></span></span></div>
    </div>
  </div>
`;
}

function renderReadout(args: {
  state: DefenseState;
  fromDefense: boolean;
  enforcement: DefenseEnforcement;
  rulesFired: number;
  riskScore: number;
  verdict: string;
  thirdNum: string | number;
  thirdCap: string;
}): string {
  const { state, fromDefense, enforcement, rulesFired, riskScore, verdict, thirdNum, thirdCap } = args;
  const riskClass = riskScore >= DEFENSE_THRESHOLDS.gated ? "warn" : "";
  const verdictCap = verdict ? verdict.toLowerCase() : "no scan data";
  const stateCap = fromDefense
    ? `<b>${escapeHtml(enforcement.verdict.toUpperCase())}</b> · ${rulesFired} rule(s) fired · defense engine`
    : `<b>${escapeHtml(enforcement.verdict.toUpperCase())}</b> · ${rulesFired} rule(s) fired · from latest scan`;
  const stateLbl = fromDefense ? "Active defense state" : "Risk stance";
  return `
  <div class="readout">
    <div class="left">
      <div class="state-lbl">${stateLbl}</div>
      <div class="state">${escapeHtml(state.toUpperCase())}</div>
      <div class="state-cap">${stateCap}</div>
    </div>
    <div class="right">
      <div class="rcell"><span class="num ${riskClass}">${escapeHtml(String(riskScore))}</span><span class="cap">Risk index · ${escapeHtml(verdictCap)}</span></div>
      <div class="rcell"><span class="num">${escapeHtml(fmtLimit(enforcement.limitUsd))}</span><span class="cap">Max payment · ${enforcement.gating ? "gating on" : "gating off"}</span></div>
      <div class="rcell"><span class="num">${escapeHtml(String(thirdNum))}</span><span class="cap">${escapeHtml(thirdCap)}</span></div>
    </div>
  </div>
`;
}

function renderStatesPanel(state: DefenseState, fromDefense: boolean): string {
  const rows = STATE_ORDER.map(
    (s) => `<div class="st ${s === state ? "on" : ""}"><span class="k">${s}</span><span class="mark"></span></div>`,
  ).join("");
  return `
    <div class="panel s4">
      <h3>Defense states <span class="r">${fromDefense ? "live" : "derived"}</span></h3>
      <div class="vladder">${rows}</div>
    </div>
  `;
}

function renderEnforcementPanel(enforcement: DefenseEnforcement, fromDefense: boolean): string {
  return `
    <div class="panel s4">
      <h3>Enforcement <span class="r">${fromDefense ? "live" : "derived"}</span></h3>
      <div class="kv">
        <div class="row"><span class="k">Verdict</span><span class="v ${enforcement.gating ? "on" : ""}">${escapeHtml(enforcement.verdict.toUpperCase())}</span></div>
        <div class="row"><span class="k">Gating</span><span class="v ${enforcement.gating ? "on" : ""}">${enforcement.gating ? "ON" : "OFF"}</span></div>
        <div class="row"><span class="k">Throttle</span><span class="v ${enforcement.verdict === "throttle" ? "on" : ""}">${enforcement.verdict === "throttle" ? "ON" : "OFF"}</span></div>
        <div class="row"><span class="k">Max payment</span><span class="v">${escapeHtml(fmtLimit(enforcement.limitUsd))}</span></div>
      </div>
    </div>
  `;
}

function renderRulesPanel(rules: string[]): string {
  const body = rules.length
    ? rules
        .slice(0, 12)
        .map((r, i) => `<div class="rule-row"><span class="sq ${i === 0 ? "h" : "m"}"></span><span class="nm">${escapeHtml(r)}</span></div>`)
        .join("")
    : `<div class="note">NO_ANOMALIES — no rules fired on the latest scan</div>`;
  return `
    <div class="panel s4">
      <h3>Fired rules <span class="r">${rules.length ? `${rules.length} active` : "none"}</span></h3>
      <div>${body}</div>
    </div>
  `;
}

function renderLedgerPanel(records: ScanLedgerRecord[]): string {
  const rows = records
    .slice(0, 50)
    .map((rec) => {
      const v = rec.verdict || computeVerdict(rec.riskScore);
      const rs = rec.topRules && rec.topRules.length ? rec.topRules.join(", ") : "—";
      return `
        <tr>
          <td>${rec.slot != null ? rec.slot : "—"}</td>
          <td>${escapeHtml(fmtStamp(rec.timestamp))}</td>
          <td><span class="rk ${rec.riskScore >= DEFENSE_THRESHOLDS.gated ? "hi" : ""}">${rec.riskScore}</span></td>
          <td>${escapeHtml(v)}</td>
          <td class="rules">${escapeHtml(rs)}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <div class="panel s8">
      <h3>Scan ledger <span class="r">${records.length} recorded</span></h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Slot</th><th>Time</th><th>Risk</th><th>Verdict</th><th>Rules</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAttestationPanel(latest: ScanLedgerRecord | null): string {
  if (!latest) {
    return `
      <div class="panel s4">
        <h3>Ledger attestation <span class="r">latest</span></h3>
        <div class="note">no attestation committed to the on-chain ledger yet</div>
      </div>
    `;
  }
  const sig = latest.onchainSignature
    ? `<a href="https://explorer.solana.com/tx/${encodeURIComponent(latest.onchainSignature)}" target="_blank" rel="noopener">${escapeHtml(latest.onchainSignature.slice(0, 16))}…</a>`
    : "—";
  const comp = latest.compressedAddress ? `${escapeHtml(latest.compressedAddress.slice(0, 12))}…` : "—";
  return `
    <div class="panel s4">
      <h3>Ledger attestation <span class="r">latest</span></h3>
      <div class="kv">
        <div class="row"><span class="k">Slot</span><span class="v">${latest.slot != null ? latest.slot : "—"}</span></div>
        <div class="row"><span class="k">Attested</span><span class="v">${escapeHtml(formatIso(latest.timestamp))}</span></div>
        <div class="row"><span class="k">Compressed PDA</span><span class="v">${comp}</span></div>
        <div class="row"><span class="k">On-chain tx</span><span class="v">${sig}</span></div>
      </div>
    </div>
  `;
}

function renderTrailPanel(trail: DashboardDefense["trail"]): string {
  const body = trail.length
    ? trail
        .slice(0, 8)
        .map((ev) => {
          const hasTransition = ev.fromState && ev.toState;
          const detail = hasTransition
            ? `${escapeHtml(ev.fromState)} → <b>${escapeHtml(ev.toState)}</b>${ev.risk ? ` (${ev.risk})` : ""}`
            : `<b>${escapeHtml(ev.toState || "armed")}</b> · ${escapeHtml(ev.action)}`;
          const cls = ev.action === "escalate" ? "up" : ev.action === "hold" ? "hold" : "";
          return `<div class="ev"><span class="tm">${fmtClock(ev.ts)}</span><span class="tx">${detail}</span><span class="tag ${cls}">${escapeHtml(ev.action)}</span></div>`;
        })
        .join("")
    : `<div class="note">no defense events recorded for this wallet</div>`;
  return `
    <div class="panel s6">
      <h3>Defense audit trail <span class="r">${trail.length} events</span></h3>
      <div>${body}</div>
    </div>
  `;
}

function renderWatchlistPanel(watchlist: string[], wallet: string): string {
  const body = watchlist.length
    ? `<div class="chips">${watchlist
        .slice(0, 10)
        .map((w) => `<a class="chip ${w === wallet ? "on" : ""}" href="/dashboard?wallet=${encodeURIComponent(w)}">${escapeHtml(shortAddr(w))}</a>`)
        .join("")}</div>`
    : `<div class="note">no wallets in the watchlist yet</div>`;
  return `
    <div class="panel s6">
      <h3>Watched wallets <span class="r">${watchlist.length}</span></h3>
      ${body}
    </div>
  `;
}

function renderSearchPanel(wallet: string, watchlist: string[]): string {
  const chips = watchlist.length
    ? `<div class="chips" style="margin-top:10px">${watchlist
        .slice(0, 10)
        .map((w) => `<a class="chip ${w === wallet ? "on" : ""}" href="/dashboard?wallet=${encodeURIComponent(w)}">${escapeHtml(shortAddr(w))}</a>`)
        .join("")}</div>`
    : "";
  return `
    <div class="panel s8">
      <h3>Inspect target wallet ledger <span class="r">base58</span></h3>
      <form method="GET" action="/dashboard" class="search">
        <span class="lbl">Query the on-chain ZK scan ledger + defense stance for a wallet</span>
        <div class="row">
          <input id="wallet-input" type="text" name="wallet" value="${escapeHtml(wallet)}" placeholder="Solana base58 address (e.g. 8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j)" required />
          <button type="submit">Lookup</button>
        </div>
      </form>
      ${chips}
    </div>
  `;
}

function renderAboutPanel(): string {
  return `
    <div class="panel s4">
      <h3>ZK scan ledger <span class="r">Light Protocol</span></h3>
      <div class="kv">
        <div class="row"><span class="k">Compression</span><span class="v">~400x cost</span></div>
        <div class="row"><span class="k">Receipts</span><span class="v">tamper-evident</span></div>
        <div class="row"><span class="k">Settlement</span><span class="v">x402 pay-per-call</span></div>
        <div class="row"><span class="k">Verification</span><span class="v">agent on-chain</span></div>
      </div>
    </div>
  `;
}

function renderEmptyPanel(wallet: string): string {
  return `
    <div class="panel s12" style="grid-column:span 12">
      <h3>No attestations <span class="r">empty ledger</span></h3>
      <div class="empty">
        <div class="t">No On-Chain Scan Attestations Found</div>
        <div class="d">
          No ZK-compressed scan records have been committed to the on-chain ledger for
          <code>${escapeHtml(wallet)}</code>. Trigger an automated scan via
          <code>radar scan ${escapeHtml(wallet)}</code> (with <code>RADAR_ORACLE=1</code>),
          the x402 <code>POST /scan</code> API, or via one-tap Blink.
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders the self-contained Wallet Radar console (brutalist monochrome HMI).
 * Deterministic for identical input options.
 */
export function renderDashboardHtml(opts: DashboardRenderOptions): string {
  const wallet = opts.wallet?.trim() || "";
  const records = opts.records || [];
  const watchlist = opts.watchlist || [];
  const defense = opts.defense ?? null;
  const generatedAt = opts.generatedAt || Math.floor(Date.now() / 1000);
  const nowStr = formatIso(generatedAt);

  const hasWallet = wallet.length > 0;
  const hasRecords = records.length > 0;
  const latest = hasRecords ? records[0] : null;

  const title = hasWallet
    ? `Wallet Radar — ${shortAddr(wallet)} Console`
    : "Wallet Radar — Console";

  // Resolve the stance to display: the persisted defense stance when present,
  // otherwise derive from the latest scan's risk score.
  const displayState: DefenseState = defense ? defense.state : riskToState(latest?.riskScore ?? 0);
  const fromDefense = defense != null;
  const enforcement: DefenseEnforcement = defense ? defense.enforcement : enforcementFor(displayState);
  const rulesFired = latest?.topRules?.length ?? 0;
  const riskScore = latest?.riskScore ?? defense?.riskAt ?? 0;
  const latestVerdict = latest ? latest.verdict || computeVerdict(latest.riskScore) : "";

  let body: string;
  if (!hasWallet) {
    body = `
    ${renderReadout({ state: "armed", fromDefense: false, enforcement: enforcementFor("armed"), rulesFired: 0, riskScore: 0, verdict: "", thirdNum: watchlist.length, thirdCap: "watched wallets" })}
    <div class="panels">
      ${renderSearchPanel("", watchlist)}
      ${renderAboutPanel()}
    </div>`;
  } else if (!hasRecords && !defense) {
    body = `
    ${renderReadout({ state: "armed", fromDefense: false, enforcement: enforcementFor("armed"), rulesFired: 0, riskScore: 0, verdict: "", thirdNum: 0, thirdCap: "scans on ledger" })}
    <div class="panels">
      ${renderEmptyPanel(wallet)}
      ${renderSearchPanel(wallet, watchlist)}
      ${renderAboutPanel()}
    </div>`;
  } else {
    body = `
    ${renderReadout({
      state: displayState,
      fromDefense,
      enforcement,
      rulesFired,
      riskScore,
      verdict: latestVerdict,
      thirdNum: defense ? defense.actions : records.length,
      thirdCap: defense ? "defense actions" : "scans on ledger",
    })}
    <div class="panels">
      ${renderStatesPanel(displayState, fromDefense)}
      ${renderEnforcementPanel(enforcement, fromDefense)}
      ${renderRulesPanel(latest?.topRules ?? [])}
      ${renderLedgerPanel(records)}
      ${renderAttestationPanel(latest)}
      ${renderTrailPanel(defense?.trail ?? [])}
      ${renderWatchlistPanel(watchlist, wallet)}
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${CONSOLE_CSS}</style>
</head>
<body>
  <div class="console">
    ${renderTop(wallet, latest?.slot ?? "—")}
    ${body}
    <footer>
      <div class="l"><b>DETERMINISTIC GATE</b> · X402 PAY-PER-CALL · ON-CHAIN ZK LEDGER · DEFENSE ENGINE</div>
      <div class="r">wallet-radar // generated ${escapeHtml(nowStr)}</div>
    </footer>
  </div>
  <script>
    function tick(){var d=new Date();var p=function(n){return (n<10?'0':'')+n};var el=document.getElementById('clock');if(el){el.textContent=p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds())+'Z';}}
    tick();setInterval(tick,1000);
  </script>
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

    const wallet = url.searchParams.get("wallet")?.trim() || "";
    let watchlist: string[] = [];
    if (options.store) {
      try {
        watchlist = options.store.listWallets();
      } catch {}
    }

    let records: ScanLedgerRecord[] = [];
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
      "Access-Control-Allow-Origin": "*",
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
      "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
    return true;
  }

  return false;
}
