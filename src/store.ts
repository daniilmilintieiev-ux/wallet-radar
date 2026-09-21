import { DatabaseSync } from "node:sqlite";
import { Anomaly, Baseline, MintRiskInfo, SettledPayment } from "./types.js";
import type { DefenseState, DefenseStateInfo } from "./defense.js";

/**
 * SQLite persistence for the watch loop (node:sqlite, zero deps).
 * Stores the watchlist, per-wallet baselines, seen tx signatures
 * (dedupe + first-seed logic) and the anomaly history.
 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS wallets (
        address TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL,
        baseline_json TEXT
      );
      CREATE TABLE IF NOT EXISTS seen_txs (
        wallet TEXT NOT NULL,
        sig TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (wallet, sig)
      );
      CREATE TABLE IF NOT EXISTS anomalies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        tx_ts INTEGER,
        evidence_json TEXT NOT NULL,
        text TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        alerted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wallet_backoff (
        address TEXT PRIMARY KEY,
        backoff_until INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS wallet_pacing (
        address TEXT PRIMARY KEY,
        quiet_streak INTEGER NOT NULL DEFAULT 0,
        next_poll_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settled_payments (
        signature TEXT PRIMARY KEY,
        payer TEXT NOT NULL,
        recipient TEXT NOT NULL,
        amount REAL NOT NULL,
        endpoint TEXT NOT NULL,
        settled_at INTEGER NOT NULL,
        wallet TEXT
      );
      CREATE TABLE IF NOT EXISTS mint_cache (
        mint TEXT PRIMARY KEY,
        mint_authority TEXT,
        freeze_authority TEXT,
        top10_pct REAL,
        fetched_at INTEGER NOT NULL,
        ttl_sec INTEGER NOT NULL DEFAULT 14400
      );
      CREATE TABLE IF NOT EXISTS cost_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        category TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit_price_usd REAL NOT NULL,
        total_usd REAL NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cost_events_ts ON cost_events(ts);
      CREATE INDEX IF NOT EXISTS idx_settled_payments_settled_at ON settled_payments(settled_at);
      CREATE TABLE IF NOT EXISTS defense_states (
        address TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        risk_at INTEGER NOT NULL DEFAULT 0,
        set_at INTEGER NOT NULL,
        quiet_streak INTEGER NOT NULL DEFAULT 0,
        actions INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS defense_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        ts INTEGER NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        action TEXT NOT NULL,
        risk INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_defense_events_wallet_ts ON defense_events(wallet, ts);
    `);
    // Migration: add top10_pct to mint_cache for databases created before it existed.
    const mintCols = this.db.prepare("PRAGMA table_info(mint_cache)").all() as Array<{ name: string }>;
    if (!mintCols.some((c) => c.name === "top10_pct")) {
      this.db.exec("ALTER TABLE mint_cache ADD COLUMN top10_pct REAL");
    }
    // Migration: add wallet to settled_payments for databases created before it existed.
    const payCols = this.db.prepare("PRAGMA table_info(settled_payments)").all() as Array<{ name: string }>;
    if (!payCols.some((c) => c.name === "wallet")) {
      this.db.exec("ALTER TABLE settled_payments ADD COLUMN wallet TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_settled_payments_wallet ON settled_payments(wallet)");
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const res = fn();
      this.db.exec("COMMIT");
      return res;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  addWallet(address: string, nowSec: number = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare("INSERT OR IGNORE INTO wallets (address, added_at, baseline_json) VALUES (?, ?, NULL)")
      .run(address, nowSec);
  }

  removeWallet(address: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM wallets WHERE address = ?").run(address);
      this.db.prepare("DELETE FROM seen_txs WHERE wallet = ?").run(address);
      this.db.prepare("DELETE FROM wallet_backoff WHERE address = ?").run(address);
      this.db.prepare("DELETE FROM wallet_pacing WHERE address = ?").run(address);
      this.db.prepare("DELETE FROM defense_states WHERE address = ?").run(address);
      this.db.prepare("DELETE FROM defense_events WHERE wallet = ?").run(address);
    });
  }

  listWallets(): string[] {
    return this.db.prepare("SELECT address FROM wallets ORDER BY added_at").all().map((r) => r.address as string);
  }

  hasWallet(address: string): boolean {
    return this.db.prepare("SELECT 1 FROM wallets WHERE address = ?").get(address) !== undefined;
  }

  getBaseline(address: string): Baseline | null {
    const row = this.db.prepare("SELECT baseline_json FROM wallets WHERE address = ?").get(address) as
      | { baseline_json: string | null }
      | undefined;
    if (!row || !row.baseline_json) return null;
    return JSON.parse(row.baseline_json) as Baseline;
  }

  saveBaseline(baseline: Baseline): void {
    this.db
      .prepare("UPDATE wallets SET baseline_json = ? WHERE address = ?")
      .run(JSON.stringify(baseline), baseline.walletAddress);
  }

  /** True when every sig was already processed for this wallet. */
  allSeen(wallet: string, sigs: string[]): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM seen_txs WHERE wallet = ? AND sig = ?");
    return sigs.every((sig) => stmt.get(wallet, sig) !== undefined);
  }

  markSeen(wallet: string, sigs: Array<{ sig: string; ts: number }>, keep = 1000): void {
    this.transaction(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO seen_txs (wallet, sig, ts) VALUES (?, ?, ?)");
      for (const { sig, ts } of sigs) insert.run(wallet, sig, ts);
      // Trim the oldest rows so the table stays bounded.
      this.db
        .prepare(
          `DELETE FROM seen_txs WHERE wallet = ? AND sig NOT IN (
             SELECT sig FROM seen_txs WHERE wallet = ? ORDER BY ts DESC, sig DESC LIMIT ?
           )`,
        )
        .run(wallet, wallet, keep);
    });
  }

  recordAnomalies(anomalies: Anomaly[], nowSec: number = Math.floor(Date.now() / 1000)): number {
    return this.transaction(() => {
      const insert = this.db.prepare(
        "INSERT INTO anomalies (wallet, type, severity, tx_ts, evidence_json, text, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      let n = 0;
      for (const a of anomalies) {
        insert.run(a.wallet, a.type, a.severity, a.timestamp, JSON.stringify(a.evidence), a.text, nowSec);
        n += 1;
      }
      return n;
    });
  }

  recentAnomalies(wallet: string | null, limit = 20): Anomaly[] {
    const rows = wallet
      ? this.db.prepare("SELECT * FROM anomalies WHERE wallet = ? ORDER BY detected_at DESC, id DESC LIMIT ?").all(wallet, limit)
      : this.db.prepare("SELECT * FROM anomalies ORDER BY detected_at DESC, id DESC LIMIT ?").all(limit);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      type: r.type as Anomaly["type"],
      wallet: r.wallet as string,
      severity: r.severity as Anomaly["severity"],
      timestamp: (r.tx_ts as number) ?? 0,
      evidence: JSON.parse(r.evidence_json as string) as Record<string, unknown>,
      text: r.text as string,
    }));
  }

  unalertedCount(wallet: string | null): number {
    const row = wallet
      ? this.db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE wallet = ? AND alerted = 0").get(wallet)
      : this.db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE alerted = 0").get();
    return Number((row as { n: number }).n);
  }

  markAllAlerted(wallet: string | null): void {
    if (wallet) {
      this.db.prepare("UPDATE anomalies SET alerted = 1 WHERE wallet = ? AND alerted = 0").run(wallet);
    } else {
      this.db.prepare("UPDATE anomalies SET alerted = 1 WHERE alerted = 0").run();
    }
  }

  getBackoff(address: string): { backoffUntil: number; attempt: number } | null {
    const row = this.db
      .prepare("SELECT backoff_until, attempt FROM wallet_backoff WHERE address = ?")
      .get(address) as { backoff_until: number; attempt: number } | undefined;
    if (!row) return null;
    return { backoffUntil: Number(row.backoff_until), attempt: Number(row.attempt) };
  }

  isBackingOff(address: string, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
    const b = this.getBackoff(address);
    if (!b) return false;
    return nowSec < b.backoffUntil;
  }

  recordBackoff(
    address: string,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): { backoffUntil: number; attempt: number } {
    const prev = this.getBackoff(address);
    const attempt = prev ? prev.attempt + 1 : 1;
    const delaySec = calculateBackoffDelay(attempt);
    const backoffUntil = nowSec + delaySec;
    this.db
      .prepare(
        "INSERT INTO wallet_backoff (address, backoff_until, attempt) VALUES (?, ?, ?) " +
          "ON CONFLICT(address) DO UPDATE SET backoff_until = excluded.backoff_until, attempt = excluded.attempt",
      )
      .run(address, backoffUntil, attempt);
    return { backoffUntil, attempt };
  }

  clearBackoff(address: string): void {
    this.db.prepare("DELETE FROM wallet_backoff WHERE address = ?").run(address);
  }

  getPacing(address: string): WalletPacing | null {
    const row = this.db
      .prepare("SELECT quiet_streak, next_poll_at FROM wallet_pacing WHERE address = ?")
      .get(address) as { quiet_streak: number; next_poll_at: number } | undefined;
    if (!row) return null;
    return { quietStreak: Number(row.quiet_streak), nextPollAt: Number(row.next_poll_at) };
  }

  recordPacing(address: string, quietStreak: number, nextPollAt: number): void {
    this.db
      .prepare(
        "INSERT INTO wallet_pacing (address, quiet_streak, next_poll_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(address) DO UPDATE SET quiet_streak = excluded.quiet_streak, next_poll_at = excluded.next_poll_at",
      )
      .run(address, quietStreak, nextPollAt);
  }

  clearPacing(address: string): void {
    this.db.prepare("DELETE FROM wallet_pacing WHERE address = ?").run(address);
  }

  hasSettledPayment(signature: string): boolean {
    return this.db.prepare("SELECT 1 FROM settled_payments WHERE signature = ?").get(signature) !== undefined;
  }

  recordSettledPayment(
    payment: { signature: string; payer: string; recipient: string; amount: number; endpoint: string; wallet?: string },
    settledAt: number = Math.floor(Date.now() / 1000),
  ): boolean {
    try {
      this.db
        .prepare(
          "INSERT INTO settled_payments (signature, payer, recipient, amount, endpoint, settled_at, wallet) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(payment.signature, payment.payer, payment.recipient, payment.amount, payment.endpoint, settledAt, payment.wallet ?? null);
      return true;
    } catch (err: unknown) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "ERR_SQLITE_ERROR" || String(err).includes("UNIQUE")) {
        return false;
      }
      throw err;
    }
  }

  getSettledPayment(signature: string): SettledPayment | null {
    const row = this.db
      .prepare("SELECT signature, payer, recipient, amount, endpoint, settled_at, wallet FROM settled_payments WHERE signature = ?")
      .get(signature) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      signature: row.signature as string,
      payer: row.payer as string,
      recipient: row.recipient as string,
      amount: Number(row.amount),
      endpoint: row.endpoint as string,
      settledAt: Number(row.settled_at),
      wallet: (row.wallet as string) ?? null,
    };
  }

  getLatestSettledPaymentForWallet(wallet: string): SettledPayment | null {
    const row = this.db
      .prepare(
        "SELECT signature, payer, recipient, amount, endpoint, settled_at, wallet FROM settled_payments WHERE wallet = ? OR payer = ? ORDER BY settled_at DESC LIMIT 1",
      )
      .get(wallet, wallet) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      signature: row.signature as string,
      payer: row.payer as string,
      recipient: row.recipient as string,
      amount: Number(row.amount),
      endpoint: row.endpoint as string,
      settledAt: Number(row.settled_at),
      wallet: (row.wallet as string) ?? null,
    };
  }

  getMintMetadata(mint: string, nowSec: number = Math.floor(Date.now() / 1000)): MintRiskInfo | null {
    const row = this.db
      .prepare(
        "SELECT mint, mint_authority, freeze_authority, top10_pct, fetched_at, ttl_sec FROM mint_cache WHERE mint = ?",
      )
       .get(mint) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (nowSec > Number(row.fetched_at) + Number(row.ttl_sec)) {
      return null;
    }
    return {
      mint: row.mint as string,
      mintAuthority: row.mint_authority !== null ? (row.mint_authority as string) : null,
      freezeAuthority: row.freeze_authority !== null ? (row.freeze_authority as string) : null,
      top10Pct: row.top10_pct !== null && row.top10_pct !== undefined ? Number(row.top10_pct) : null,
    };
  }

  saveMintMetadata(
    meta: MintRiskInfo,
    nowSec: number = Math.floor(Date.now() / 1000),
    ttlSec: number = 14400,
  ): void {
    this.db
      .prepare(
        `INSERT INTO mint_cache (mint, mint_authority, freeze_authority, top10_pct, fetched_at, ttl_sec)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(mint) DO UPDATE SET
            mint_authority = excluded.mint_authority,
            freeze_authority = excluded.freeze_authority,
            top10_pct = excluded.top10_pct,
            fetched_at = excluded.fetched_at,
            ttl_sec = excluded.ttl_sec`,
      )
      .run(
        meta.mint,
        meta.mintAuthority,
        meta.freezeAuthority,
        meta.top10Pct ?? null,
        nowSec,
        ttlSec,
      );
  }

  cleanExpiredMintCache(nowSec: number = Math.floor(Date.now() / 1000)): number {
    const res = this.db.prepare("DELETE FROM mint_cache WHERE ? > fetched_at + ttl_sec").run(nowSec);
    return Number(res.changes);
  }

  /**
   * Record a unit-economics cost event (tracked API spend). `ts` is unix seconds.
   */
  recordCostEvent(evt: {
    ts?: number;
    category: "helius" | "llm" | "compute";
    quantity: number;
    unitPriceUsd: number;
    totalUsd?: number;
    detail?: string;
  }): void {
    const ts = evt.ts ?? Math.floor(Date.now() / 1000);
    const totalUsd = evt.totalUsd ?? Math.round(evt.quantity * evt.unitPriceUsd * 1e6) / 1e6;
    this.db
      .prepare(
        "INSERT INTO cost_events (ts, category, quantity, unit_price_usd, total_usd, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(ts, evt.category, evt.quantity, evt.unitPriceUsd, totalUsd, evt.detail ?? null);
  }

  getCostSummary(): { totalUsd: number; byCategory: Record<string, number>; events: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(total_usd), 0) AS total FROM cost_events")
      .get() as { c: number; total: number };
    const byCat = this.db
      .prepare("SELECT category, COALESCE(SUM(total_usd), 0) AS total FROM cost_events GROUP BY category")
      .all() as Array<{ category: string; total: number }>;
    const byCategory: Record<string, number> = {};
    for (const r of byCat) byCategory[r.category] = Math.round(r.total * 1e6) / 1e6;
    return { totalUsd: Math.round(row.total * 1e6) / 1e6, byCategory, events: row.c };
  }

  getRevenueSummary(): {
    totalUsdc: number;
    payments: number;
    byEndpoint: Record<string, { count: number; amountUsdc: number }>;
  } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total FROM settled_payments")
      .get() as { c: number; total: number };
    const byEp = this.db
      .prepare(
        "SELECT endpoint, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total FROM settled_payments GROUP BY endpoint",
      )
      .all() as Array<{ endpoint: string; c: number; total: number }>;
    const byEndpoint: Record<string, { count: number; amountUsdc: number }> = {};
    for (const r of byEp) byEndpoint[r.endpoint] = { count: r.c, amountUsdc: Math.round(r.total * 1e6) / 1e6 };
    return { totalUsdc: Math.round(row.total * 1e6) / 1e6, payments: row.c, byEndpoint };
  }

  getRevenuePerDay(days: number): Array<{ day: string; revenueUsdc: number; payments: number }> {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db
      .prepare(
        "SELECT date(settled_at, 'unixepoch') AS day, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total " +
          "FROM settled_payments WHERE settled_at >= ? GROUP BY day ORDER BY day ASC",
      )
      .all(since) as Array<{ day: string; c: number; total: number }>;
    return rows.map((r) => ({ day: r.day, revenueUsdc: Math.round(r.total * 1e6) / 1e6, payments: r.c }));
  }

  getCostPerDay(days: number): Array<{ day: string; costUsd: number; events: number }> {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db
      .prepare(
        "SELECT date(ts, 'unixepoch') AS day, COUNT(*) AS c, COALESCE(SUM(total_usd), 0) AS total " +
          "FROM cost_events WHERE ts >= ? GROUP BY day ORDER BY day ASC",
      )
      .all(since) as Array<{ day: string; c: number; total: number }>;
    return rows.map((r) => ({ day: r.day, costUsd: Math.round(r.total * 1e6) / 1e6, events: r.c }));
  }

  getDefenseState(address: string): DefenseStateInfo | null {
    const row = this.db
      .prepare("SELECT state, risk_at, set_at, quiet_streak, actions FROM defense_states WHERE address = ?")
      .get(address) as
      | { state: string; risk_at: number; set_at: number; quiet_streak: number; actions: number }
      | undefined;
    if (!row) return null;
    return {
      state: row.state as DefenseState,
      riskAt: Number(row.risk_at),
      setAt: Number(row.set_at),
      quietStreak: Number(row.quiet_streak),
      actions: Number(row.actions),
    };
  }

  setDefenseState(address: string, info: DefenseStateInfo): void {
    this.db
      .prepare(
        "INSERT INTO defense_states (address, state, risk_at, set_at, quiet_streak, actions) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(address) DO UPDATE SET state = excluded.state, risk_at = excluded.risk_at, " +
          "set_at = excluded.set_at, quiet_streak = excluded.quiet_streak, actions = excluded.actions",
      )
      .run(address, info.state, info.riskAt, info.setAt, info.quietStreak, info.actions);
  }

  recordDefenseEvent(evt: DefenseEvent): void {
    this.db
      .prepare(
        "INSERT INTO defense_events (wallet, ts, from_state, to_state, action, risk, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(evt.wallet, evt.ts, evt.fromState, evt.toState, evt.action, evt.risk, evt.reason);
  }

  recentDefenseEvents(wallet: string, limit = 20): DefenseEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM defense_events WHERE wallet = ? ORDER BY ts DESC, id DESC LIMIT ?")
      .all(wallet, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      wallet: r.wallet as string,
      ts: Number(r.ts),
      fromState: r.from_state as string,
      toState: r.to_state as string,
      action: r.action as string,
      risk: Number(r.risk),
      reason: r.reason as string,
    }));
  }

  listDefenseStates(): Array<{ wallet: string; state: DefenseStateInfo }> {
    const rows = this.db
      .prepare(
        "SELECT address, state, risk_at, set_at, quiet_streak, actions FROM defense_states ORDER BY set_at DESC",
      )
      .all() as Array<{
      address: string;
      state: string;
      risk_at: number;
      set_at: number;
      quiet_streak: number;
      actions: number;
    }>;
    return rows.map((r) => ({
      wallet: r.address,
      state: {
        state: r.state as DefenseState,
        riskAt: Number(r.risk_at),
        setAt: Number(r.set_at),
        quietStreak: Number(r.quiet_streak),
        actions: Number(r.actions),
      },
    }));
  }
}

export interface DefenseEvent {
  wallet: string;
  ts: number;
  fromState: string;
  toState: string;
  action: string;
  risk: number;
  reason: string;
}

export interface WalletPacing {
  quietStreak: number;
  nextPollAt: number;
}

/**
 * Exponential schedule: 5min (300s), 15min (900s), 45min (2700s), capped at 4h (14400s).
 */
export function calculateBackoffDelay(attempt: number): number {
  if (attempt <= 1) return 5 * 60;
  if (attempt === 2) return 15 * 60;
  if (attempt === 3) return 45 * 60;
  const maxDelay = 4 * 3600; // 4h cap
  return Math.min(maxDelay, 45 * 60 * Math.pow(3, attempt - 3));
}

