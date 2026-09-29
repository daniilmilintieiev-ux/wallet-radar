// Shared core for scripts/audit/blocked-table.mjs and
// scripts/audit/mint-group-impact.mjs (stage 3B/3C, see CLAUDE.md).
//
// For every BLOCKED wallet in benchmarks/simulation-results.json, re-derives
// which mint (if any) caused TOXIC_MINT at the exact blocking transaction,
// evaluated against the CURRENT benchmarks/mint-cache.json. Read-only, no
// network calls, does not touch src/.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  extractSwap,
  TOP10_CONCENTRATION_PCT,
  TOP10_HIGH_PCT,
  MAJOR_MINTS,
} from "../../../dist/src/analyzer.js";
import { KNOWN_SAFE_MINTS } from "../../../dist/src/mint.js";

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function findLine(sourcePath, needle) {
  const lines = readFileSync(sourcePath, "utf-8").split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  return idx === -1 ? "НЕ ОПРЕДЕЛЕНО" : idx + 1;
}

export function classifyMint(mintCache, mint) {
  const meta = mintCache[mint];
  if (!meta) return { flagged: false, meta: null };
  const hasFreeze = Boolean(meta.freezeAuthority);
  const hasMint = Boolean(meta.mintAuthority);
  const top10 = typeof meta.top10Pct === "number" ? meta.top10Pct : null;
  const concentrated = top10 != null && top10 >= TOP10_CONCENTRATION_PCT;
  const veryConcentrated = top10 != null && top10 >= TOP10_HIGH_PCT;
  const isPump = Boolean(meta.isPumpFun || mint.toLowerCase().endsWith("pump"));
  const flagged = hasFreeze || hasMint || concentrated;
  let bucket = "нет";
  if (flagged) {
    if (hasFreeze) bucket = "freezeAuthority";
    else if (concentrated) bucket = "top10Pct";
    else if (hasMint) bucket = "mintAuthority";
  }
  return { meta, hasFreeze, hasMint, top10, concentrated, veryConcentrated, isPump, flagged, bucket };
}

/** @returns {{rows: object[], mintCache: object, sim: object, consts: object}} */
export function computeRows(root) {
  const ANALYZER_SRC = path.join(root, "src/analyzer.ts");
  const consts = {
    LINE_GATE: findLine(ANALYZER_SRC, "if (hasFreeze || hasMint || concentrated)"),
    LINE_TOP10_CONST: findLine(ANALYZER_SRC, "export const TOP10_CONCENTRATION_PCT"),
    LINE_HIGH_CONST: findLine(ANALYZER_SRC, "export const TOP10_HIGH_PCT"),
    LINE_SEVERITY: findLine(ANALYZER_SRC, "const severity: Severity = hasFreeze || veryConcentrated"),
    TOP10_CONCENTRATION_PCT,
    TOP10_HIGH_PCT,
  };

  const simPath = path.join(root, "benchmarks/simulation-results.json");
  const mintCachePath = path.join(root, "benchmarks/mint-cache.json");
  const historyCacheDir = path.join(root, "benchmarks/history-cache");

  const sim = readJson(simPath);
  const mintCache = readJson(mintCachePath);
  const blocked = sim.results.filter((r) => r.finalVerdict === "BLOCKED");

  const rows = [];
  for (const r of blocked) {
    const row = {
      address: r.address,
      category: r.category,
      triggerEvent: r.triggerEvent,
      blockedAtStep: r.blockedAtStep,
      totalTxs: r.totalTxs,
      hasToxicMintInTrigger: (r.triggerEvent || "").includes("TOXIC_MINT"),
      mint: null,
      freezeAuthority: null,
      mintAuthority: null,
      top10Pct: null,
      isPump: null,
      bucket: null,
      condition: null,
      note: "",
    };

    if (!row.hasToxicMintInTrigger) {
      row.bucket = "без токенных правил";
      row.condition = "—";
      rows.push(row);
      continue;
    }

    const cacheFile = path.join(historyCacheDir, `${r.address}.json`);
    if (!existsSync(cacheFile) || r.blockedAtStep == null) {
      row.bucket = "НЕ ОПРЕДЕЛЕНО";
      row.note = "нет закэшированной истории транзакций или blockedAtStep отсутствует";
      rows.push(row);
      continue;
    }

    const rawTxs = readJson(cacheFile);
    const sortedTxs = [...rawTxs].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const currentTx = sortedTxs[r.blockedAtStep - 1];
    if (!currentTx) {
      row.bucket = "НЕ ОПРЕДЕЛЕНО";
      row.note = `blockedAtStep=${r.blockedAtStep} вне диапазона закэшированной истории (${sortedTxs.length} tx)`;
      rows.push(row);
      continue;
    }

    const swap = extractSwap(currentTx, r.address);
    if (!swap) {
      row.bucket = "НЕ ОПРЕДЕЛЕНО";
      row.note = "в транзакции на шаге блокировки нет свопа (extractSwap = null), хотя TOXIC_MINT есть в triggerEvent";
      rows.push(row);
      continue;
    }

    const candidates = [swap.tokenIn.mint, swap.tokenOut.mint].filter(
      (m) => m && !MAJOR_MINTS.includes(m) && !KNOWN_SAFE_MINTS.has(m),
    );

    const flaggedCandidates = candidates
      .map((m) => ({ mint: m, ...classifyMint(mintCache, m) }))
      .filter((c) => c.flagged);

    if (flaggedCandidates.length === 0) {
      row.bucket = "НЕ ОПРЕДЕЛЕНО";
      row.note = `ни один mint свопа на шаге блокировки (${candidates.join(", ") || "нет кандидатов"}) не проходит текущее условие TOXIC_MINT по mint-cache.json`;
      rows.push(row);
      continue;
    }

    const matched = flaggedCandidates[0];
    row.mint = matched.mint;
    row.freezeAuthority = matched.meta.freezeAuthority;
    row.mintAuthority = matched.meta.mintAuthority;
    row.top10Pct = matched.top10;
    row.isPump = matched.isPump;
    row.bucket = matched.bucket;
    row.condition =
      matched.bucket === "freezeAuthority"
        ? `hasFreeze (analyzer.ts:${consts.LINE_GATE})`
        : matched.bucket === "top10Pct"
          ? `top10Pct(${matched.top10}) >= TOP10_CONCENTRATION_PCT(${TOP10_CONCENTRATION_PCT}) [analyzer.ts:${consts.LINE_TOP10_CONST}], gate analyzer.ts:${consts.LINE_GATE}`
          : matched.bucket === "mintAuthority"
            ? `hasMint без freeze/concentration (analyzer.ts:${consts.LINE_GATE})`
            : "НЕ ОПРЕДЕЛЕНО";
    if (flaggedCandidates.length > 1) {
      row.note = `оба mint'а свопа флагованы; показан первый (${matched.mint}); второй: ${flaggedCandidates[1].mint}`;
    }
    rows.push(row);
  }

  return { rows, mintCache, sim, consts };
}
