import { DatabaseSync } from "node:sqlite";
import { Anomaly, Baseline } from "./types.js";

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
    `);
  }

  close(): void {
    this.db.close();
  }

  addWallet(address: string, nowSec: number = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare("INSERT OR IGNORE INTO wallets (address, added_at, baseline_json) VALUES (?, ?, NULL)")
      .run(address, nowSec);
  }

  removeWallet(address: string): void {
    this.db.prepare("DELETE FROM wallets WHERE address = ?").run(address);
    this.db.prepare("DELETE FROM seen_txs WHERE wallet = ?").run(address);
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
  }

  recordAnomalies(anomalies: Anomaly[], nowSec: number = Math.floor(Date.now() / 1000)): number {
    const insert = this.db.prepare(
      "INSERT INTO anomalies (wallet, type, severity, tx_ts, evidence_json, text, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    let n = 0;
    for (const a of anomalies) {
      insert.run(a.wallet, a.type, a.severity, a.timestamp, JSON.stringify(a.evidence), a.text, nowSec);
      n += 1;
    }
    return n;
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
}
