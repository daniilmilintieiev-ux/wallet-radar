import { Anomaly, Baseline, PnlSummary, Severity } from "./types.js";

export interface BaselineSummary {
  txCount?: number;
  knownVenues?: string[];
  knownPrograms?: string[];
  medianSwapAmount?: number;
  medianSwapAmountUsd?: number | null;
  lastSeenAt?: number | null;
  pnl?: PnlSummary | null;
}

export interface HtmlReportData {
  wallet: string;
  riskScore: number;
  verdict?: string;
  generatedAt?: number | string;
  window?: {
    sinceSec?: number | null;
    untilSec?: number | null;
  };
  baseline?: Baseline | BaselineSummary | null;
  anomalies: Anomaly[];
}

export function computeVerdict(riskScore: number): string {
  if (riskScore <= 0) return "SAFE";
  if (riskScore <= 30) return "LOW RISK";
  if (riskScore <= 60) return "SUSPICIOUS";
  return "HIGH RISK";
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toIso(secOrMs?: number | null): string {
  if (secOrMs == null || !Number.isFinite(secOrMs)) return "n/a";
  const ms = secOrMs > 1e11 ? secOrMs : secOrMs * 1000;
  return new Date(ms).toISOString();
}

function fmtUsd(amount?: number | null): string {
  if (amount == null || !Number.isFinite(amount)) return "n/a";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatEvidence(evidence?: Record<string, unknown> | null): string {
  if (!evidence || Object.keys(evidence).length === 0) return "{}";
  const sortedKeys = Object.keys(evidence).sort();
  return JSON.stringify(evidence, sortedKeys, 2);
}

function verdictBadgeClass(verdict: string): string {
  const upper = verdict.toUpperCase();
  if (upper.includes("SAFE") || upper === "LOW" || upper.includes("LOW RISK")) {
    return "badge-safe";
  }
  if (upper.includes("SUSPICIOUS") || upper.includes("HOLD") || upper.includes("MEDIUM") || upper.includes("WARN")) {
    return "badge-warn";
  }
  return "badge-danger";
}

function severityBadgeClass(severity: Severity | string): string {
  switch (String(severity).toLowerCase()) {
    case "high":
      return "badge-danger";
    case "medium":
      return "badge-warn";
    case "low":
    default:
      return "badge-safe";
  }
}

export function renderHtmlReport(data: HtmlReportData): string {
  const verdict = data.verdict ?? computeVerdict(data.riskScore);
  const verdictClass = verdictBadgeClass(verdict);
  const generatedAtStr =
    data.generatedAt != null
      ? typeof data.generatedAt === "number"
        ? toIso(data.generatedAt)
        : String(data.generatedAt)
      : new Date().toISOString();

  let windowText = "all available history";
  if (data.window && (data.window.sinceSec != null || data.window.untilSec != null)) {
    const sinceStr = data.window.sinceSec != null ? toIso(data.window.sinceSec) : "start";
    const untilStr = data.window.untilSec != null ? toIso(data.window.untilSec) : "now";
    windowText = `${sinceStr} .. ${untilStr}`;
  }

  const b = data.baseline;
  const venues = b?.knownVenues ? [...b.knownVenues].sort() : [];
  const venuesStr = venues.length > 0 ? `${venues.join(", ")} (${venues.length})` : "none";
  const programs = b?.knownPrograms ? [...b.knownPrograms].sort() : [];
  const programsStr = programs.length > 0 ? `${programs.length} program(s)` : "none";

  const medianUsdStr = b?.medianSwapAmountUsd != null ? fmtUsd(b.medianSwapAmountUsd) : "n/a";
  const medianRawStr = b?.medianSwapAmount != null ? String(b.medianSwapAmount) : "n/a";
  const lastSeenStr = b?.lastSeenAt != null ? toIso(b.lastSeenAt) : "n/a";

  const pnlRealizedStr =
    b?.pnl?.realizedUsd != null
      ? `${b.pnl.realizedUsd >= 0 ? "+" : ""}$${b.pnl.realizedUsd.toFixed(2)}`
      : "n/a";
  const winRateStr =
    b?.pnl?.winRate != null
      ? `${(b.pnl.winRate * 100).toFixed(1)}% (${b.pnl.roundTrips} round-trip${b.pnl.roundTrips === 1 ? "" : "s"})`
      : b?.pnl?.roundTrips
      ? `n/a (${b.pnl.roundTrips} round-trip${b.pnl.roundTrips === 1 ? "" : "s"})`
      : "n/a";

  const sortedAnomalies = [...data.anomalies];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wallet-radar history: ${escapeHtml(data.wallet)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --text-bright: #f0f6fc;
      --accent: #58a6ff;
      --code-bg: #090d13;
      --badge-safe-bg: #0e4429;
      --badge-safe-text: #3fb950;
      --badge-safe-border: #238636;
      --badge-warn-bg: #4d2d00;
      --badge-warn-text: #d29922;
      --badge-warn-border: #9e6a03;
      --badge-danger-bg: #490202;
      --badge-danger-text: #f85149;
      --badge-danger-border: #da3633;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 13px;
      line-height: 1.5;
      padding: 24px;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .brand {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--accent);
      margin-bottom: 6px;
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-bright);
      margin-bottom: 12px;
      word-break: break-all;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .overview-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 4px;
    }
    .overview-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .overview-value {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-bright);
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-safe {
      background: var(--badge-safe-bg);
      color: var(--badge-safe-text);
      border: 1px solid var(--badge-safe-border);
    }
    .badge-warn {
      background: var(--badge-warn-bg);
      color: var(--badge-warn-text);
      border: 1px solid var(--badge-warn-border);
    }
    .badge-danger {
      background: var(--badge-danger-bg);
      color: var(--badge-danger-text);
      border: 1px solid var(--badge-danger-border);
    }
    section {
      margin-bottom: 28px;
    }
    h2 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-bright);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      border-left: 3px solid var(--accent);
      padding-left: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    th, td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      background: #21262d;
      color: var(--text-bright);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .param-name {
      width: 260px;
      color: var(--text-muted);
      font-weight: 500;
    }
    .evidence {
      background: var(--code-bg);
      padding: 8px;
      border-radius: 3px;
      border: 1px solid var(--border);
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text-bright);
    }
    .empty-state {
      padding: 24px;
      text-align: center;
      color: var(--text-muted);
      font-style: italic;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    footer {
      margin-top: 32px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">wallet-radar &middot; history report</div>
      <h1>${escapeHtml(data.wallet)}</h1>
      <div class="overview-grid">
        <div class="overview-card">
          <div class="overview-label">Risk Score</div>
          <div class="overview-value">${data.riskScore} / 100</div>
        </div>
        <div class="overview-card">
          <div class="overview-label">Verdict</div>
          <div class="overview-value"><span class="badge ${verdictClass}">${escapeHtml(verdict)}</span></div>
        </div>
        <div class="overview-card">
          <div class="overview-label">Evaluation Window</div>
          <div class="overview-value" style="font-size: 12px; font-weight: normal; word-break: break-all;">${escapeHtml(windowText)}</div>
        </div>
        <div class="overview-card">
          <div class="overview-label">Anomalies Detected</div>
          <div class="overview-value">${data.anomalies.length}</div>
        </div>
      </div>
    </header>

    <section>
      <h2>Baseline Summary</h2>
      <table>
        <tbody>
          <tr>
            <td class="param-name">Transaction Count</td>
            <td>${b ? (b.txCount ?? 0) : "n/a"}</td>
          </tr>
          <tr>
            <td class="param-name">Known Venues</td>
            <td>${escapeHtml(venuesStr)}</td>
          </tr>
          <tr>
            <td class="param-name">Known Programs</td>
            <td>${escapeHtml(programsStr)}</td>
          </tr>
          <tr>
            <td class="param-name">Median Swap Amount (USD)</td>
            <td>${escapeHtml(medianUsdStr)}</td>
          </tr>
          <tr>
            <td class="param-name">Median Swap Amount (Raw)</td>
            <td>${escapeHtml(medianRawStr)}</td>
          </tr>
          <tr>
            <td class="param-name">Last Activity</td>
            <td>${escapeHtml(lastSeenStr)}</td>
          </tr>
          <tr>
            <td class="param-name">Realized PnL (FIFO lite)</td>
            <td>${escapeHtml(pnlRealizedStr)}</td>
          </tr>
          <tr>
            <td class="param-name">Win Rate / Round Trips</td>
            <td>${escapeHtml(winRateStr)}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Detected Anomalies (${data.anomalies.length})</h2>
      ${
        sortedAnomalies.length === 0
          ? `<div class="empty-state">No anomalies detected in the evaluation window.</div>`
          : `<table>
        <thead>
          <tr>
            <th>Rule ID</th>
            <th>Severity</th>
            <th>Timestamp</th>
            <th>Summary</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          ${sortedAnomalies
            .map(
              (a) => `<tr>
            <td><code>${escapeHtml(a.type)}</code></td>
            <td><span class="badge ${severityBadgeClass(a.severity)}">${escapeHtml(a.severity.toUpperCase())}</span></td>
            <td>${escapeHtml(toIso(a.timestamp))}</td>
            <td>${escapeHtml(a.text)}</td>
            <td><pre class="evidence">${escapeHtml(formatEvidence(a.evidence))}</pre></td>
          </tr>`,
            )
            .join("\n          ")}
        </tbody>
      </table>`
      }
    </section>

    <footer>
      <div>wallet-radar &middot; deterministic Solana behavioral analysis</div>
      <div>Generated: ${escapeHtml(generatedAtStr)}</div>
    </footer>
  </div>
</body>
</html>
`;
}

export function formatHistoryText(data: HtmlReportData): string {
  const verdict = data.verdict ?? computeVerdict(data.riskScore);
  const lines: string[] = [];
  lines.push(`wallet-radar history: ${data.wallet}`);
  lines.push(`verdict:    ${verdict} (risk score ${data.riskScore}/100)`);

  if (data.window) {
    const since = data.window.sinceSec != null ? toIso(data.window.sinceSec) : "start";
    const until = data.window.untilSec != null ? toIso(data.window.untilSec) : "now";
    lines.push(`window:     ${since} .. ${until}`);
  }

  const b = data.baseline;
  if (b) {
    const medUsd = b.medianSwapAmountUsd != null ? fmtUsd(b.medianSwapAmountUsd) : `${b.medianSwapAmount ?? 0} (raw)`;
    const venues = [...(b.knownVenues ?? [])].sort().join(", ") || "none";
    const lastSeen = b.lastSeenAt != null ? toIso(b.lastSeenAt) : "n/a";
    lines.push(`baseline:   ${b.txCount ?? 0} txs (median swap: ${medUsd}, venues: [${venues}], last seen: ${lastSeen})`);
    if (b.pnl) {
      const pnlUsd = b.pnl.realizedUsd != null ? `${b.pnl.realizedUsd >= 0 ? "+" : ""}$${b.pnl.realizedUsd.toFixed(2)}` : "n/a";
      const winRate = b.pnl.winRate != null ? `${(b.pnl.winRate * 100).toFixed(1)}%` : "n/a";
      lines.push(`pnl:        realized ${pnlUsd}, win rate ${winRate} (${b.pnl.roundTrips} round-trips)`);
    }
  }

  lines.push(`anomalies:  ${data.anomalies.length} detected`);
  for (const a of data.anomalies) {
    lines.push(`- [${a.severity.toUpperCase()}] ${a.type}: ${a.text}`);
  }
  return lines.join("\n");
}
