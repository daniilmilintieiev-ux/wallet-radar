#!/usr/bin/env node
// Database initialization and operations for the Wallet Radar Shadow Collector.
// Uses Node 22+ built-in node:sqlite (DatabaseSync) -- zero native external dependencies.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DB_PATH = path.resolve("shadow/shadow.db");
export const DEFAULT_DAILY_CEILING = 1500;

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
      date TEXT PRIMARY KEY,
      request_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      script TEXT NOT NULL,
      action TEXT NOT NULL,
      error_message TEXT NOT NULL,
      details TEXT
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
 * Checks if the daily request ceiling has been reached.
 */
export function checkDailyCeiling(db, ceiling = DEFAULT_DAILY_CEILING) {
  const dateStr = getTodayDateString();
  const row = db.prepare("SELECT request_count FROM request_counters WHERE date = ?").get(dateStr);
  const current = row ? row.request_count : 0;
  return {
    allowed: current < ceiling,
    current,
    ceiling,
    date: dateStr,
  };
}

/**
 * Increments today's request counter.
 */
export function incrementRequestCounter(db, count = 1) {
  const dateStr = getTodayDateString();
  db.exec(`
    INSERT INTO request_counters (date, request_count)
    VALUES ('${dateStr}', ${count})
    ON CONFLICT(date) DO UPDATE SET request_count = request_count + ${count};
  `);
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
      verdict_unconfirmed_mint_check,
      radar_verdict, radar_error, radar_code_version, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
