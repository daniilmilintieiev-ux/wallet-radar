import http from "node:http";
import { readScanLedger, ScanLedgerRecord, ZKOracleClient } from "./oracle/index.js";
import { escapeHtml, computeVerdict } from "./htmlreport.js";
import { Store } from "./store.js";

export interface DashboardRenderOptions {
  wallet?: string;
  records?: ScanLedgerRecord[];
  watchlist?: string[];
  generatedAt?: number;
  rpcUrl?: string;
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

function formatRelative(timestampSec?: number | null, nowSec = Math.floor(Date.now() / 1000)): string {
  if (timestampSec == null || !Number.isFinite(timestampSec)) return "";
  const diffSec = nowSec - timestampSec;
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
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

function scoreColorClass(score: number): string {
  if (score <= 30) return "score-safe";
  if (score <= 60) return "score-warn";
  return "score-danger";
}

function renderWatchlistChips(watchlist?: string[], currentWallet?: string): string {
  if (!watchlist || watchlist.length === 0) return "";
  const chips = watchlist.slice(0, 8).map((w) => {
    const isSelected = w === currentWallet;
    const short = `${w.slice(0, 4)}...${w.slice(-4)}`;
    return `<a href="/dashboard?wallet=${encodeURIComponent(w)}" class="chip ${isSelected ? "chip-active" : ""}">${escapeHtml(short)}</a>`;
  }).join(" ");

  return `
    <div class="watchlist-chips">
      <span class="chips-label">Watched Wallets:</span>
      ${chips}
    </div>
  `;
}

/**
 * Renders the self-contained Dashboard HTML page.
 * Deterministic for identical input options.
 */
export function renderDashboardHtml(opts: DashboardRenderOptions): string {
  const wallet = opts.wallet?.trim() || "";
  const records = opts.records || [];
  const watchlist = opts.watchlist || [];
  const generatedAt = opts.generatedAt || Math.floor(Date.now() / 1000);
  const nowStr = formatIso(generatedAt);

  const hasWallet = wallet.length > 0;
  const hasRecords = records.length > 0;
  const latest = hasRecords ? records[0] : null;

  const title = hasWallet
    ? `Wallet Radar — ${wallet.slice(0, 4)}...${wallet.slice(-4)} Ledger`
    : "Wallet Radar — ZK Scan Ledger Dashboard";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg-page: #0d1117;
      --bg-card: #161b22;
      --bg-card-alt: #21262d;
      --border: #30363d;
      --border-muted: #21262d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --text-heading: #f0f6fc;
      --accent: #58a6ff;
      --accent-glow: rgba(88, 166, 255, 0.15);
      --safe: #3fb950;
      --safe-bg: rgba(63, 185, 80, 0.15);
      --safe-border: #238636;
      --warn: #d29922;
      --warn-bg: rgba(210, 153, 34, 0.15);
      --warn-border: #9e6a03;
      --danger: #f85149;
      --danger-bg: rgba(248, 81, 73, 0.15);
      --danger-border: #da3633;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-page);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 14px;
      line-height: 1.6;
      padding: 24px;
    }

    .container { max-width: 1120px; margin: 0 auto; }

    /* Header */
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-heading);
      letter-spacing: -0.5px;
    }
    .brand-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--accent-glow);
      color: var(--accent);
      border: 1px solid var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .meta-nav { display: flex; gap: 16px; font-size: 12px; }
    .meta-nav a { color: var(--text-muted); text-decoration: none; }
    .meta-nav a:hover { color: var(--accent); }

    /* Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-heading);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Search Bar */
    .search-form { display: flex; flex-direction: column; gap: 8px; }
    .search-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; }
    .input-group { display: flex; gap: 10px; }
    .input-text {
      flex: 1;
      background: var(--bg-page);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-family: inherit;
      font-size: 14px;
      padding: 10px 14px;
      outline: none;
    }
    .input-text:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
    .btn {
      background: var(--bg-card-alt);
      border: 1px solid var(--border);
      color: var(--text-heading);
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 18px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .btn:hover { background: var(--border); }
    .btn-primary {
      background: #1f6feb;
      border-color: #388bfd;
      color: #ffffff;
    }
    .btn-primary:hover { background: #388bfd; }

    /* Chips */
    .watchlist-chips { margin-top: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
    .chips-label { color: var(--text-muted); }
    .chip {
      background: var(--bg-page);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 3px 10px;
      border-radius: 12px;
      text-decoration: none;
      font-size: 12px;
    }
    .chip:hover { border-color: var(--accent); color: var(--accent); }
    .chip-active { border-color: var(--accent); background: var(--accent-glow); color: var(--accent); font-weight: 600; }

    /* Hero Section */
    .hero-grid {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 20px;
      align-items: center;
    }
    @media (max-width: 720px) { .hero-grid { grid-template-columns: 1fr; } }

    .hero-verdict {
      background: var(--bg-page);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      text-align: center;
    }
    .verdict-badge {
      display: inline-block;
      font-size: 18px;
      font-weight: 800;
      padding: 6px 16px;
      border-radius: 6px;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .badge-safe { background: var(--safe-bg); border: 1px solid var(--safe-border); color: var(--safe); }
    .badge-warn { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn); }
    .badge-danger { background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger); }

    .score-value {
      font-size: 38px;
      font-weight: 900;
      line-height: 1.1;
      margin-bottom: 4px;
    }
    .score-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
    .score-safe { color: var(--safe); }
    .score-warn { color: var(--warn); }
    .score-danger { color: var(--danger); }

    .hero-details { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px; }
    @media (max-width: 500px) { .hero-details { grid-template-columns: 1fr; } }
    .detail-item { background: var(--bg-page); border: 1px solid var(--border-muted); border-radius: 6px; padding: 10px 12px; }
    .detail-label { color: var(--text-muted); font-size: 11px; margin-bottom: 2px; text-transform: uppercase; }
    .detail-val { color: var(--text-heading); word-break: break-all; font-weight: 500; }
    .detail-val a { color: var(--accent); text-decoration: none; }
    .detail-val a:hover { text-decoration: underline; }

    /* Rules tags */
    .rules-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .rule-tag {
      background: var(--bg-card-alt);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--warn);
    }

    /* History Table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
    th {
      background: var(--bg-card-alt);
      color: var(--text-muted);
      font-weight: 600;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      font-size: 11px;
    }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border-muted); vertical-align: middle; }
    tr:hover td { background: var(--bg-card-alt); }
    .mono-link { color: var(--accent); text-decoration: none; }
    .mono-link:hover { text-decoration: underline; }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
    }
    .empty-icon { font-size: 32px; margin-bottom: 12px; }
    .empty-title { font-size: 16px; color: var(--text-heading); font-weight: 600; margin-bottom: 6px; }
    .empty-desc { max-width: 500px; margin: 0 auto 16px auto; font-size: 13px; }

    /* Footer */
    .footer {
      text-align: center;
      padding-top: 24px;
      margin-top: 24px;
      border-top: 1px solid var(--border-muted);
      color: var(--text-muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="brand">
        <span class="brand-title">WALLET RADAR</span>
        <span class="brand-badge">ZK Scan Ledger</span>
      </div>
      <nav class="meta-nav">
        <a href="/dashboard">Dashboard</a>
        <a href="/health">Health</a>
        <a href="/actions.json">Blink Rules</a>
        <a href="https://github.com/sendaifun/wallet-radar" target="_blank" rel="noopener">GitHub</a>
      </nav>
    </header>

    <!-- Search / Target Card -->
    <div class="card">
      <form method="GET" action="/dashboard" class="search-form">
        <label for="wallet-input" class="search-label">Inspect Target Wallet Ledger</label>
        <div class="input-group">
          <input
            id="wallet-input"
            class="input-text"
            type="text"
            name="wallet"
            value="${escapeHtml(wallet)}"
            placeholder="Enter Solana base58 address (e.g. 8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j)"
            required
          />
          <button type="submit" class="btn btn-primary">Lookup Ledger</button>
        </div>
      </form>
      ${renderWatchlistChips(watchlist, wallet)}
    </div>

    ${hasWallet ? renderWalletView(wallet, records, latest) : renderWelcomeView(watchlist)}

    <footer class="footer">
      <div>Wallet Radar &middot; On-chain ZK scan ledger powered by Light Protocol stateless compression.</div>
      <div style="margin-top: 4px; opacity: 0.7;">Generated at ${escapeHtml(nowStr)} &middot; History is the only receipt.</div>
    </footer>
  </div>
</body>
</html>`;
}

function renderWalletView(wallet: string, records: ScanLedgerRecord[], latest: ScanLedgerRecord | null): string {
  if (!latest || records.length === 0) {
    return `
      <div class="card">
        <div class="empty-state">
          <div class="empty-icon">&#128269;</div>
          <div class="empty-title">No On-Chain Scan Attestations Found</div>
          <div class="empty-desc">
            No ZK-compressed scan records have been committed to the on-chain ledger for
            <br /><code>${escapeHtml(wallet)}</code>.
          </div>
          <p style="font-size: 12px; color: var(--text-muted);">
            Trigger an automated scan via <code>radar scan ${escapeHtml(wallet)}</code> (with <code>RADAR_ORACLE=1</code>),
            the x402 <code>POST /scan</code> API, or via one-tap Blink.
          </p>
        </div>
      </div>
    `;
  }

  const latestVerdict = latest.verdict || computeVerdict(latest.riskScore);
  const badgeCls = verdictBadgeClass(latestVerdict);
  const scoreCls = scoreColorClass(latest.riskScore);
  const topRules = latest.topRules && latest.topRules.length > 0 ? latest.topRules : ["NO_ANOMALIES"];
  const relTime = formatRelative(latest.timestamp);
  const isoTime = formatIso(latest.timestamp);

  const heroHtml = `
    <div class="card">
      <div class="card-title">
        <span>Latest Oracle Attestation</span>
        <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">${escapeHtml(relTime)}</span>
      </div>
      <div class="hero-grid">
        <div class="hero-verdict">
          <div class="verdict-badge ${badgeCls}">${escapeHtml(latestVerdict)}</div>
          <div class="score-value ${scoreCls}">${latest.riskScore}</div>
          <div class="score-label">Risk Score / 100</div>
        </div>
        <div class="hero-details">
          <div class="detail-item">
            <div class="detail-label">Audited Wallet</div>
            <div class="detail-val"><code>${escapeHtml(wallet)}</code></div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Attestation Time</div>
            <div class="detail-val">${escapeHtml(isoTime)}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">On-chain Signature</div>
            <div class="detail-val">
              ${
                latest.onchainSignature
                  ? `<a href="https://explorer.solana.com/tx/${encodeURIComponent(latest.onchainSignature)}" target="_blank" rel="noopener"><code>${escapeHtml(latest.onchainSignature.slice(0, 16))}...</code></a>`
                  : `<span style="color: var(--text-muted)">pending</span>`
              }
            </div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Compressed PDA / Slot</div>
            <div class="detail-val">
              <code>${latest.compressedAddress ? escapeHtml(latest.compressedAddress.slice(0, 12)) + "..." : "n/a"}</code>
              ${latest.slot ? `(slot ${latest.slot})` : ""}
            </div>
          </div>
          <div class="detail-item" style="grid-column: 1 / -1;">
            <div class="detail-label">Top Fired Anomaly Rules</div>
            <div class="rules-list">
              ${topRules.map((r) => `<span class="rule-tag">${escapeHtml(r)}</span>`).join(" ")}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // History Table rows
  const rows = records.map((rec) => {
    const v = rec.verdict || computeVerdict(rec.riskScore);
    const bCls = verdictBadgeClass(v);
    const sCls = scoreColorClass(rec.riskScore);
    const rulesStr = rec.topRules && rec.topRules.length > 0 ? rec.topRules.join(", ") : "—";
    const sigHtml = rec.onchainSignature
      ? `<a href="https://explorer.solana.com/tx/${encodeURIComponent(rec.onchainSignature)}" target="_blank" rel="noopener" class="mono-link">${escapeHtml(rec.onchainSignature.slice(0, 12))}...</a>`
      : `<span style="color: var(--text-muted);">—</span>`;

    return `
      <tr>
        <td>${escapeHtml(formatIso(rec.timestamp))}</td>
        <td><code>${rec.slot ?? "—"}</code></td>
        <td class="${sCls}" style="font-weight: 700;">${rec.riskScore}</td>
        <td><span class="verdict-badge ${bCls}" style="font-size: 11px; padding: 2px 8px; margin: 0;">${escapeHtml(v)}</span></td>
        <td><span style="font-size: 11px;">${escapeHtml(rulesStr)}</span></td>
        <td>${sigHtml}</td>
      </tr>
    `;
  }).join("");

  const historyHtml = `
    <div class="card">
      <div class="card-title">
        <span>Attestation Timeline (${records.length} scans recorded)</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp (UTC)</th>
              <th>Slot</th>
              <th>Score</th>
              <th>Verdict</th>
              <th>Anomaly Rules Fired</th>
              <th>On-chain Tx Sig</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;

  return heroHtml + historyHtml;
}

function renderWelcomeView(watchlist: string[]): string {
  const sampleWallet = watchlist.length > 0 ? watchlist[0] : "DemoTargetWallet1111111111111111111111111";
  return `
    <div class="card">
      <div class="card-title">ZK Scan Ledger Overview</div>
      <div style="font-size: 13px; color: var(--text); line-height: 1.7;">
        <p style="margin-bottom: 12px;">
          Wallet Radar commits cryptographic risk scan attestations to Solana state trees using <strong>Light Protocol ZK compression</strong>.
          Every scan attestation contains the target wallet, risk score (0-100), verdict badge, evaluation timestamp, and top anomaly rules.
        </p>
        <ul style="margin-left: 20px; margin-bottom: 16px; color: var(--text-muted);">
          <li><strong>~400x Cost Reduction</strong>: State compression records attestations for ~0.000005 SOL (rent-free state).</li>
          <li><strong>Tamper-Evident Receipts</strong>: Attestation hashes are verifiable against Solana state root merkle proofs.</li>
          <li><strong>Autonomous Agent Verification</strong>: AI agents and smart contracts verify counterparty risk on-chain before trade settlement.</li>
        </ul>
        <p>
          To inspect a wallet's on-chain history, enter a public key in the search field above, or click:
          <a href="/dashboard?wallet=${encodeURIComponent(sampleWallet)}" class="mono-link"><code>${escapeHtml(sampleWallet)}</code></a>.
        </p>
      </div>
    </div>
  `;
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
  } = {},
): Promise<string> {
  const records = wallet ? await readScanLedger(wallet, {
    client: opts.client,
    rpcUrl: opts.rpcUrl,
    limit: opts.limit ?? 20,
  }) : [];

  return renderDashboardHtml({
    wallet,
    records,
    watchlist: opts.watchlist,
    rpcUrl: opts.rpcUrl,
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

    const html = renderDashboardHtml({
      wallet,
      records,
      watchlist,
      rpcUrl: options.rpcUrl,
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
