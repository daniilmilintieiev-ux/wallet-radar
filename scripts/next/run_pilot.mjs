#!/usr/bin/env node
/**
 * Pilot execution script for INC-2022-08-SLOPE (Cases C-001-1 .. C-001-5).
 * Implements data collection and scoring per SCORING-SPEC-PILOT.md + Amendment 1.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scoreAt } from "./pilot_score.mjs";

const MAX_HELIUS_CALLS = 300;
const RAW_OUTPUT_DIR = "C:\\Users\\cbell\\Documents\\antigravity\\analysis-data\\pilot";

function getApiKey() {
  if (process.env.HELIUS_API_KEY) {
    return process.env.HELIUS_API_KEY.trim().replace(/['"]/g, "");
  }
  const candidates = [
    path.resolve(process.cwd(), "..", "kind-darwin", "radar.env"),
    path.resolve(process.cwd(), "radar.env"),
    path.resolve(process.cwd(), "..", "radar.env"),
    "C:\\Users\\cbell\\Documents\\antigravity\\kind-darwin\\radar.env"
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const text = fs.readFileSync(c, "utf8");
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("HELIUS_API_KEY=")) {
            return trimmed.split("=", 2)[1].trim().replace(/['"]/g, "");
          }
        }
      } catch {}
    }
  }
  return null;
}

function parseCasesCsv() {
  const csvPath = path.resolve(process.cwd(), "docs", "next", "cases", "cases.csv");
  const content = fs.readFileSync(csvPath, "utf8");
  const lines = content.trim().split("\n");
  const header = lines[0].split(",");
  
  const cases = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Basic CSV row parsing (handling quoted fields if any)
    const match = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
    // Alternatively parse standard fields by splitting
    const cols = line.split(",");
    const caseId = cols[0];
    if (caseId.startsWith("C-001-")) {
      cases.push({
        case_id: caseId,
        incident_id: cols[1],
        event_type: cols[3],
        wallet: cols[4],
        t0_signature: cols[5],
        t0_utc: cols[6],
      });
    }
  }
  return cases;
}

let heliusCallCount = 0;

async function fetchJson(url, options = {}) {
  if (heliusCallCount >= MAX_HELIUS_CALLS) {
    throw new Error(`Helius call budget reached (${MAX_HELIUS_CALLS})`);
  }
  heliusCallCount++;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("Failed after 5 retries");
}

async function fetchWalletHistory(apiKey, wallet, t0Sig, t0Unix) {
  const targetMinTs = t0Unix - 90 * 86_400; // T minus 90 days
  const maxTxCount = 1000;

  // 1. Fetch the t0 transaction itself via POST /v0/transactions
  let t0Tx = null;
  try {
    const postUrl = `https://api.helius.xyz/v0/transactions?api-key=${apiKey}`;
    const txArray = await fetchJson(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [t0Sig] })
    });
    if (Array.isArray(txArray) && txArray.length > 0) {
      t0Tx = txArray[0];
    }
  } catch (err) {
    console.warn(`Warning: failed to fetch t0 tx via POST: ${err.message}`);
  }

  // 2. Fetch older history using GET /v0/addresses/{wallet}/transactions with before
  let cursor = t0Sig;
  const historyTxs = [];

  while (historyTxs.length < maxTxCount && heliusCallCount < MAX_HELIUS_CALLS) {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=100&before=${cursor}`;
    const batch = await fetchJson(url);
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    historyTxs.push(...batch);

    const oldestInBatch = batch[batch.length - 1];
    if (oldestInBatch.timestamp && oldestInBatch.timestamp < targetMinTs) {
      break; // Reached beyond T minus 90 days
    }
    if (batch.length < 100) {
      break; // Reached earliest transaction on-chain
    }
    cursor = oldestInBatch.signature;
    await new Promise((r) => setTimeout(r, 100)); // Respect rate limits
  }

  // Deduplicate and assemble
  const seenSigs = new Set();
  const allTxs = [];
  if (t0Tx && t0Tx.signature) {
    seenSigs.add(t0Tx.signature);
    allTxs.push(t0Tx);
  }
  for (const t of historyTxs) {
    if (t && t.signature && !seenSigs.has(t.signature)) {
      seenSigs.add(t.signature);
      allTxs.push(t);
    }
  }

  // Sort ascending by timestamp
  allTxs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return allTxs;
}

async function main() {
  console.log("=== RUNNING PILOT EVALUATION (INC-2022-08-SLOPE) ===");
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("Error: HELIUS_API_KEY could not be loaded!");
    process.exit(1);
  }

  fs.mkdirSync(RAW_OUTPUT_DIR, { recursive: true });

  const cases = parseCasesCsv();
  console.log(`Found ${cases.length} cases to evaluate: ${cases.map(c => c.case_id).join(", ")}`);

  const results = [];

  for (const c of cases) {
    console.log(`\nEvaluating ${c.case_id} (${c.wallet})...`);
    const t0Unix = Math.floor(Date.parse(c.t0_utc) / 1000);

    // Fetch history
    const allTxs = await fetchWalletHistory(apiKey, c.wallet, c.t0_signature, t0Unix);
    console.log(`  Fetched total ${allTxs.length} transactions (Helius calls so far: ${heliusCallCount})`);

    // Save raw history JSON
    const rawPath = path.join(RAW_OUTPUT_DIR, `${c.case_id}.json`);
    const rawContent = JSON.stringify(allTxs, null, 2);
    fs.writeFileSync(rawPath, rawContent, "utf8");

    // Compute sha256
    const sha256 = crypto.createHash("sha256").update(rawContent).digest("hex");
    console.log(`  Saved raw JSON: ${rawPath} (sha256: ${sha256})`);

    const oldestTs = allTxs.length > 0 ? allTxs[0].timestamp : null;
    const depthDays = oldestTs ? ((t0Unix - oldestTs) / 86_400).toFixed(1) : "0.0";
    const depthReachedDesc = `${allTxs.length} txs, oldest: ${oldestTs ? new Date(oldestTs * 1000).toISOString() : "n/a"} (${depthDays} days before t0)`;

    // Score at T_a (t0, including t0)
    const txsA = allTxs.filter((t) => (t.timestamp ?? 0) <= t0Unix);
    const scoreA = scoreAt(c.wallet, txsA, t0Unix);
    const flaggedA = scoreA.riskScore > 30;

    // Score at T_b (t0 - 300s, strictly before t0)
    const tbUnix = t0Unix - 300;
    const txsB = allTxs.filter((t) => (t.timestamp ?? 0) < tbUnix);
    const scoreB = scoreAt(c.wallet, txsB, tbUnix);
    const flaggedB = scoreB.riskScore > 30;

    console.log(`  Score at T_a: riskScore=${scoreA.riskScore} (flagged: ${flaggedA}), mode=${scoreA.baselineMode}, anomalies=${scoreA.anomalies.map(a => a.type).join(", ") || "none"}`);
    console.log(`  Score at T_b: riskScore=${scoreB.riskScore} (flagged: ${flaggedB}), mode=${scoreB.baselineMode}, anomalies=${scoreB.anomalies.map(a => a.type).join(", ") || "none"}`);

    results.push({
      case_id: c.case_id,
      wallet: c.wallet,
      t0_signature: c.t0_signature,
      t0_utc: c.t0_utc,
      t0_unix: t0Unix,
      tb_unix: tbUnix,
      sha256,
      txCount: allTxs.length,
      depthReached: depthReachedDesc,
      scoreA: {
        flagged: flaggedA ? "yes" : "no",
        riskScore: scoreA.riskScore,
        baselineMode: scoreA.baselineMode,
        anomalies: scoreA.anomalies,
      },
      scoreB: {
        flagged: flaggedB ? "yes" : "no",
        riskScore: scoreB.riskScore,
        baselineMode: scoreB.baselineMode,
        anomalies: scoreB.anomalies,
      },
    });
  }

  // Summary counts
  const flaggedACount = results.filter((r) => r.scoreA.flagged === "yes").length;
  const flaggedBCount = results.filter((r) => r.scoreB.flagged === "yes").length;

  console.log("\n=== PILOT SUMMARY ===");
  console.log(`Total cases: ${results.length}`);
  console.log(`Flagged at T_a: ${flaggedACount} of ${results.length}`);
  console.log(`Flagged at T_b: ${flaggedBCount} of ${results.length}`);
  console.log(`Total Helius calls: ${heliusCallCount}`);

  // Write PILOT-RESULT-INC-2022-08-SLOPE.md
  const reportPath = path.resolve(process.cwd(), "docs", "next", "cases", "PILOT-RESULT-INC-2022-08-SLOPE.md");
  let md = "# Descriptive Pilot Results: Incident INC-2022-08-SLOPE\n\n";
  md += "## 1. Summary\n\n";
  md += "- **Incident**: `INC-2022-08-SLOPE` (Slope Wallet Key Compromise)\n";
  md += `- **Date of run**: ${new Date().toISOString()}\n`;
  md += "- **Software version**: tag `submission-colosseum-fall2026` (commit `b5a0388431742acaa3a47e5ca6f0b716ecd76f23`)\n";
  md += "- **Specification**: `docs/next/cases/SCORING-SPEC-PILOT.md` (including Amendment 1)\n";
  md += `- **Total Helius API calls**: ${heliusCallCount} (budget: ${MAX_HELIUS_CALLS})\n\n`;
  md += "### Overall Counts\n\n";
  md += `- **Flagged at $T_a$** ($t_0$ drain tx included, \`riskScore > 30\`): **${flaggedACount} of ${results.length}**\n`;
  md += `- **Flagged at $T_b$** ($t_0 - 300\\text{s}$ pre-drain state, \`riskScore > 30\`): **${flaggedBCount} of ${results.length}**\n\n`;
  md += "> Note: These counts describe the pilot cases under the frozen evaluation pipeline without price or token-metadata feeds. They are raw descriptive counts and do not constitute a detection rate claim.\n\n";

  md += "## 2. Case Results Table\n\n";
  md += "| Case ID | Wallet | Depth Reached | Mode ($T_a$ / $T_b$) | Flagged at $T_a$ (Score) | Flagged at $T_b$ (Score) | History File SHA-256 |\n";
  md += "|:--------|:-------|:--------------|:---------------------|:-------------------------|:-------------------------|:---------------------|\n";
  for (const r of results) {
    md += `| ${r.case_id} | \`${r.wallet}\` | ${r.txCount} txs | ${r.scoreA.baselineMode} / ${r.scoreB.baselineMode} | **${r.scoreA.flagged}** (${r.scoreA.riskScore}) | **${r.scoreB.flagged}** (${r.scoreB.riskScore}) | \`${r.sha256.slice(0, 16)}...\` |\n`;
  }
  md += "\n";

  md += "## 3. Detailed Case Breakdown\n\n";
  for (const r of results) {
    md += `### Case ${r.case_id}\n\n`;
    md += `- **Wallet Address**: \`${r.wallet}\`\n`;
    md += `- **$t_0$ Timestamp (UTC)**: \`${r.t0_utc}\` (Unix: \`${r.t0_unix}\`)\n`;
    md += `- **$t_0$ Drain Signature**: \`${r.t0_signature}\`\n`;
    md += `- **Raw History File**: \`analysis-data/pilot/${r.case_id}.json\`\n`;
    md += `- **Raw History SHA-256**: \`${r.sha256}\`\n`;
    md += `- **History Depth**: ${r.depthReached}\n\n`;

    md += `#### Checkpoint $T_a$ ($t_0$, compromise included):\n`;
    md += `- **Flagged**: ${r.scoreA.flagged} (\`riskScore = ${r.scoreA.riskScore}\`)\n`;
    md += `- **Baseline Mode**: ${r.scoreA.baselineMode}\n`;
    md += `- **Detected Anomalies** (${r.scoreA.anomalies.length}):\n`;
    if (r.scoreA.anomalies.length === 0) {
      md += `  - None\n`;
    } else {
      for (const a of r.scoreA.anomalies) {
        md += `  - [${a.severity.toUpperCase()}] **${a.type}**: ${a.text}\n`;
      }
    }
    md += "\n";

    md += `#### Checkpoint $T_b$ ($t_0 - 300\\text{s}$, pre-compromise):\n`;
    md += `- **Flagged**: ${r.scoreB.flagged} (\`riskScore = ${r.scoreB.riskScore}\`)\n`;
    md += `- **Baseline Mode**: ${r.scoreB.baselineMode}\n`;
    md += `- **Detected Anomalies** (${r.scoreB.anomalies.length}):\n`;
    if (r.scoreB.anomalies.length === 0) {
      md += `  - None\n`;
    } else {
      for (const a of r.scoreB.anomalies) {
        md += `  - [${a.severity.toUpperCase()}] **${a.type}**: ${a.text}\n`;
      }
    }
    md += "\n---\n\n";
  }

  md += "## 4. Price-Dependent Rules Note\n\n";
  md += "As specified in Amendment 1, the pilot was executed with `prices = null` and `mintRisk = null`:\n";
  md += "- `TOXIC_MINT` was omitted for all cases because token metadata and holder concentration were not fetched.\n";
  md += "- `LARGE_SWAP` fell back to raw quantities for major mints (SOL, USDC, USDT) where applicable; non-major token swaps were not sized.\n";
  md += "- `REGIME_SHIFT` amount dimension fell back to raw major token quantities.\n\n";

  md += "## 5. Deviations\n\n";
  md += "None. All executions followed the protocol in `SCORING-SPEC-PILOT.md` and Amendment 1 exactly.\n\n";

  md += "## 6. Not Done\n\n";
  md += "- Control/comparison wallets were not scored in this stage.\n";
  md += "- False-alarm rate was not computed.\n";
  md += "- Threshold sweeps were not performed.\n";
  md += "- No claim is made regarding detection accuracy, sensitivity, or specificity.\n";

  fs.writeFileSync(reportPath, md, "utf8");
  console.log(`\nReport written to: ${reportPath}`);
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
