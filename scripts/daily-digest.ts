#!/usr/bin/env node
/**
 * Wallet Radar — Daily 7:00 AM Summary Runner
 * 
 * Aggregates all monitoring data over the last 24 hours:
 * - Watched wallets activity and anomalies
 * - Pillar 3 Defense Postures (Armed / Gated / Blocked)
 * - Unit economics (x402 settled USDC vs Helius API cost)
 * 
 * Formats a clean, high-impact HTML message and delivers it to Telegram.
 * 
 * Usage:
 *   node dist/scripts/daily-digest.js          # Send to Telegram (if configured)
 *   node dist/scripts/daily-digest.js --preview# Print formatted HTML without sending
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { buildDailyDigestData, formatDailyDigestHtml, sendDailyDigest } from "../src/daily-digest.js";

function loadEnv(): void {
  const candidates = [
    process.env.RADAR_ENV,
    resolve(process.cwd(), "radar.env"),
    resolve(process.cwd(), ".env"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const fileContent = readFileSync(candidate, "utf8");
        for (const line of fileContent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            if (!(key in process.env)) {
              process.env[key] = val;
            }
          }
        }
      } catch {}
      break;
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  const isPreview = process.argv.includes("--preview");
  const dbPath = process.env.RADAR_DB ?? join(homedir(), ".wallet-radar", "radar.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  const store = new Store(dbPath);

  try {
    const data = buildDailyDigestData(store, { windowHours: 24 });
    const html = formatDailyDigestHtml(data);

    if (isPreview) {
      console.log("\n--- TELEGRAM HTML PREVIEW ---");
      console.log(html);
      console.log("-----------------------------\n");
      return;
    }

    console.log(`[daily-digest] Generating 24h summary for ${data.totalWatched} wallets...`);
    const res = await sendDailyDigest(store, { windowHours: 24, markAlerted: true });

    if (res.ok) {
      console.log(`[daily-digest] ✔ ${res.message}`);
    } else {
      console.error(`[daily-digest] ⚠ ${res.message}`);
      console.log("\nPreview of unsent digest:\n", html);
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error("[daily-digest fatal error]:", err);
  process.exit(1);
});
