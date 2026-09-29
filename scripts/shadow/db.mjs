#!/usr/bin/env node
// Database initialization and operations for the Wallet Radar Shadow Collector.
// Uses Node 22+ built-in node:sqlite (DatabaseSync) -- zero native external dependencies.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DB_PATH = path.resolve("shadow/shadow.db");
// Stage 7H task 2: request_counters used to be keyed by date alone, shared between
// collect.mjs and outcomes.mjs -- one script hitting its ceiling blocked the other
// (concretely: the outcomes run at 03:00 UTC could find the ceiling already exhausted
// by the day's collection cycles and never compute a single outcome). Now keyed by
// (date, script) with separate ceilings; DAILY_REQUEST_CEILING is no longer read anywhere.
export const DEFAULT_DAILY_CEILING_COLLECT = 1500;
export const DEFAULT_DAILY_CEILING_OUTCOMES = 1500;

/**
 * Initializes and opens the SQLite database.
 * Creates parent directory and schema if not present.
 */
export function openDb(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);
  initSchema(db);
  return db;
}

/**
 * Creates required tables and indexes.
 */
export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shadow_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      pair TEXT NOT NULL,
      t INTEGER NOT NULL,
      liquidity_usd REAL,
      mint_authority TEXT,
      freeze_authority TEXT,
      token_program TEXT,
      token_2022_extensions TEXT,
      strat TEXT NOT NULL,
      buyer TEXT,
      buyer_tx_signature TEXT,
      http_status INTEGER,
      copy_amount_usd REAL,
      mint_risk_fetched TEXT,
      mint_metadata_fetched TEXT,
      verdict_unconfirmed_mint_check TEXT,
      radar_token_check_missing TEXT,
      radar_verdict TEXT,
      radar_error TEXT,
      radar_code_version TEXT,
      recorded_at TEXT NOT NULL,
      outcome TEXT,
      outcome_computed_at TEXT,
      outcome_details TEXT,
      UNIQUE(pair, mint)
    );

    CREATE TABLE IF NOT EXISTS request_counters (
      date TEXT NOT NULL,
      script TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, script)
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      script TEXT NOT NULL,
      action TEXT NOT NULL,
      error_message TEXT NOT NULL,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS skip_counters (
      date TEXT NOT NULL,
      reason TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, reason)
    );

    CREATE TABLE IF NOT EXISTS pool_candidates (
      cycle_ts INTEGER NOT NULL,
      pool TEXT NOT NULL,
      mint TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (cycle_ts, pool)
    );

    CREATE INDEX IF NOT EXISTS idx_trades_t ON shadow_trades(t);
    CREATE INDEX IF NOT EXISTS idx_trades_outcome ON shadow_trades(outcome);
    CREATE INDEX IF NOT EXISTS idx_trades_strat ON shadow_trades(strat);
  `);
}

/**
 * Returns today's ISO date string (YYYY-MM-DD) in UTC.
 */
export function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Checks if the daily request ceiling has been reached, per (date, script) --
 * stage 7H task 2: collect.mjs and outcomes.mjs each pass their own `script` name
 * ("collect" / "outcomes") so one script's usage never blocks the other's.
 */
export function checkDailyCeiling(db, ceiling, script) {
  const dateStr = getTodayDateString();
  const row = db.prepare("SELECT request_count FROM request_counters WHERE date = ? AND script = ?").get(dateStr, script);
  const current = row ? row.request_count : 0;
  return {
    allowed: current < ceiling,
    current,
    ceiling,
    date: dateStr,
    script,
  };
}

/**
 * Increments today's request counter for the given script (see checkDailyCeiling).
 */
export function incrementRequestCounter(db, count = 1, script) {
  const dateStr = getTodayDateString();
  const stmt = db.prepare(`
    INSERT INTO request_counters (date, script, request_count)
    VALUES (?, ?, ?)
    ON CONFLICT(date, script) DO UPDATE SET request_count = request_count + excluded.request_count
  `);
  stmt.run(dateStr, script, count);
}

/**
 * Increments today's (or dateStr's) skip counter for a rejection reason
 * (TOKEN_TOO_OLD, NO_BUYER, POOL_TOO_OLD, RADAR_ERROR, PROCESSING_ERROR, ...).
 * Stage 7F task 3 -- collect.mjs's per-cycle in-memory counters are lost when the
 * process exits; this makes them queryable by analyze.mjs across the whole run.
 */
export function incrementSkipCounter(db, reason, count = 1, dateStr = getTodayDateString()) {
  const stmt = db.prepare(`
    INSERT INTO skip_counters (date, reason, count)
    VALUES (?, ?, ?)
    ON CONFLICT(date, reason) DO UPDATE SET count = count + excluded.count
  `);
  stmt.run(dateStr, reason, count);
}

/** Reads all skip_counters rows, optionally filtered to date >= sinceDate. */
export function getSkipCounters(db, sinceDate = null) {
  if (sinceDate) {
    return db.prepare("SELECT date, reason, count FROM skip_counters WHERE date >= ? ORDER BY date, reason").all(sinceDate);
  }
  return db.prepare("SELECT date, reason, count FROM skip_counters ORDER BY date, reason").all();
}

/**
 * Records one seen pool candidate for a cycle -- task 3 stage 7H. Called for EVERY
 * candidate fetchFreshPools returns, whether or not it was budget-selected for actual
 * processing, so analyze.mjs can later see the full discovery volume, not just what got
 * processed. Purely a local write -- costs no external request. `selected` is set once,
 * at record time (the caller already knows selection status by then, no separate update
 * pass needed).
 */
export function recordPoolCandidate(db, { cycleTs, pool, mint, seenAt, selected }) {
  const stmt = db.prepare(`
    INSERT INTO pool_candidates (cycle_ts, pool, mint, seen_at, selected)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cycle_ts, pool) DO UPDATE SET selected = excluded.selected
  `);
  stmt.run(cycleTs, pool, mint, seenAt, selected ? 1 : 0);
}

/** Reads all pool_candidates rows, optionally filtered to cycle_ts >= sinceCycleTs. */
export function getPoolCandidates(db, sinceCycleTs = null) {
  if (sinceCycleTs) {
    return db.prepare("SELECT cycle_ts, pool, mint, seen_at, selected FROM pool_candidates WHERE cycle_ts >= ? ORDER BY seen_at").all(sinceCycleTs);
  }
  return db.prepare("SELECT cycle_ts, pool, mint, seen_at, selected FROM pool_candidates ORDER BY seen_at").all();
}

/**
 * Logs an error to the error_logs table.
 */
export function logError(db, script, action, error, details = null) {
  const timestamp = new Date().toISOString();
  const errorMessage = typeof error === "string" ? error : (error?.message || String(error));
  const detailsStr = details ? (typeof details === "string" ? details : JSON.stringify(details)) : null;

  try {
    const stmt = db.prepare(`
      INSERT INTO error_logs (timestamp, script, action, error_message, details)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(timestamp, script, action, errorMessage, detailsStr);
  } catch (err) {
    console.error(`[DB LOG FAILURE] ${timestamp} ${script} - ${action}: ${errorMessage}`, err);
  }
}

/**
 * Inserts a new prospectively observed trade.
 * Verdict is stored immediately, outcome fields remain NULL.
 */
export function insertTrade(db, trade) {
  const stmt = db.prepare(`
    INSERT INTO shadow_trades (
      mint, pair, t, liquidity_usd, mint_authority, freeze_authority,
      token_program, token_2022_extensions, strat, buyer, buyer_tx_signature,
      http_status, copy_amount_usd, mint_risk_fetched, mint_metadata_fetched,
      verdict_unconfirmed_mint_check, radar_token_check_missing,
      radar_verdict, radar_error, radar_code_version, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Both booleans below are stored as TEXT "true"/"false" for the same reason as
  // mint_risk_fetched: SQLite's TEXT-affinity casting on a bound REAL/INTEGER
  // parameter would round-trip 1/0 as "1.0"/"0.0", not a clean boolean string.
  return stmt.run(
    trade.mint,
    trade.pair,
    trade.t,
    trade.liquidity_usd ?? null,
    trade.mint_authority ?? null,
    trade.freeze_authority ?? null,
    trade.token_program ?? null,
    trade.token_2022_extensions ? JSON.stringify(trade.token_2022_extensions) : null,
    trade.strat,
    trade.buyer ?? null,
    trade.buyer_tx_signature ?? null,
    trade.http_status ?? null,
    trade.copy_amount_usd ?? null,
    // mint_risk_fetched is a 3-state TEXT field: "true" | "false" | "NOT_DETERMINABLE" (never a
    // numeric 0/1 -- SQLite's TEXT affinity casting on a bound REAL parameter produces "1.0"/"0.0",
    // which is not a boolean-safe round trip).
    typeof trade.mint_risk_fetched === "boolean" ? String(trade.mint_risk_fetched) : (trade.mint_risk_fetched ?? null),
    typeof trade.mint_metadata_fetched === "boolean" ? String(trade.mint_metadata_fetched) : (trade.mint_metadata_fetched ?? null),
    typeof trade.verdict_unconfirmed_mint_check === "boolean" ? String(trade.verdict_unconfirmed_mint_check) : (trade.verdict_unconfirmed_mint_check ?? null),
    // true | false | "NOT_DETERMINABLE" | "NOT_APPLICABLE" | null (task 3 stage 7E,
    // four-state task 2 stage 7F) -- same TEXT-boolean convention.
    typeof trade.radar_token_check_missing === "boolean" ? String(trade.radar_token_check_missing) : (trade.radar_token_check_missing ?? null),
    trade.radar_verdict ? (typeof trade.radar_verdict === "string" ? trade.radar_verdict : JSON.stringify(trade.radar_verdict)) : null,
    trade.radar_error ? (typeof trade.radar_error === "string" ? trade.radar_error : JSON.stringify(trade.radar_error)) : null,
    trade.radar_code_version ?? null,
    trade.recorded_at ?? new Date().toISOString()
  );
}

/**
 * Selects pending trades older than minAgeDays that have outcome IS NULL.
 * Crucial: Does NOT select radar_verdict (integrity rule: outcomes worker does not read verdicts).
 */
export function getPendingTrades(db, minAgeDays = 3) {
  const minAgeSeconds = Math.round(minAgeDays * 86400);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoffTime = nowSeconds - minAgeSeconds;

  const stmt = db.prepare(`
    SELECT id, mint, pair, t, liquidity_usd, buyer, strat, recorded_at
    FROM shadow_trades
    WHERE outcome IS NULL AND t <= ?
    ORDER BY t ASC
  `);

  return stmt.all(cutoffTime);
}

/**
 * Updates a trade with its computed outcome.
 * Irreversible: only updates if outcome IS NULL.
 */
export function updateTradeOutcome(db, id, outcome, outcomeDetails) {
  const stmt = db.prepare(`
    UPDATE shadow_trades
    SET outcome = ?,
        outcome_computed_at = datetime('now'),
        outcome_details = ?
    WHERE id = ? AND outcome IS NULL
  `);

  const detailsStr = outcomeDetails ? (typeof outcomeDetails === "string" ? outcomeDetails : JSON.stringify(outcomeDetails)) : null;
  return stmt.run(outcome, detailsStr, id);
}
