Translation of the Russian original docs/SHADOW-RUNBOOK.md. The Russian text is authoritative and was fixed before data collection began (see git history). In case of any difference, the original prevails.

# Wallet Radar — Shadow Collector Runbook

## 0. Runtime Environment Requirements

**Minimum Node.js version: 22.13.0.** Verified against official Node.js documentation ([nodejs.org/docs/latest-v22.x/api/sqlite.html](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)): module `node:sqlite` was added in **v22.5.0** behind the `--experimental-sqlite` flag; starting with **v22.13.0** the flag is no longer required (`SQLite is no longer behind --experimental-sqlite but still experimental`). Module stability in v22.13.0 is **1.1 (Active development)**, API may change in future versions — do not give backward compatibility guarantees for schema between minor Node upgrades without reverification. Collector scripts do not pass the `--experimental-sqlite` flag anywhere — accordingly, on Node < 22.13.0 `import { DatabaseSync } from "node:sqlite"` will fail with an error; on Node 22.5.0–22.12.x execution with flag would be required (unsupported by current npm scripts).

---

## 1. Architecture and Purpose

The shadow prospective collector (`scripts/shadow/collect.mjs` and `scripts/shadow/outcomes.mjs`) implements the firewall independent evaluation protocol per [docs/TESTER-SPEC.md](TESTER-SPEC.md) (v2.1) and [docs/SHADOW-COLLECTOR.md](SHADOW-COLLECTOR.md).

### Key Principles (corrected in stage 7B):
1. **Separation of collection and labeling:**
   - `collect.mjs` records a trade at time `t` = **blockTime of the buy transaction** (not pool creation time). Source of new pools is **GeckoTerminal `new_pools`** (not DexScreener search, see `docs/SHADOW-COLLECTOR.md` for comparison and live check of rate limits/latency); pool freshness filter is the constant `POOL_MAX_AGE_MINUTES = 15` (pool must be no older than this threshold **at collection time**, not outcome evaluation time). Token age itself is checked separately: `TOKEN_MAX_AGE_DAYS = 14` — minimum `pairCreatedAt` across ALL pairs of the mint on DexScreener; if older — record is not created, counter `TOKEN_TOO_OLD`.
   - Buyer is not pool creator: first transaction AFTER pool creation transaction where token recipient is verified as System-owned, non-executable account (`getAccountInfo`), not PDA, not pool creation transaction fee payer. Buy signature is recorded in `buyer_tx_signature`.
   - Radar verdict is requested immediately (`POST /gate-copy` with `mint`+`mintRisk`, fixed `copyAmountUsd = COPY_AMOUNT_USD = 10`). HTTP response status is stored in `http_status`; non-200 response is `RADAR_ERROR`, **not considered a verdict** (`radar_verdict` remains `NULL`, error in `radar_error`). 5 consecutive `RADAR_ERROR` responses trigger emergency stop of collector with non-zero exit code.
   - `outcomes.mjs` is an independent background process running once daily for records older than the **unified horizon `OUTCOME_HORIZON_DAYS = 3`** (identical for criteria (a) and (b), `docs/TESTER-SPEC.md` v2.1 §8). **Does not call radar and does not read stored verdicts** (SQL query `getPendingTrades` deliberately omits `radar_verdict`).
2. **Append-Only and Error Handling:**
   - Radar verdict is recorded upon trade detection, never overwritten.
   - Outcome is computed once from objective on-chain facts. **Any API/network error during outcome computation leaves `outcome = NULL`** (record remains "pending" and will be re-evaluated on next run) — outcome is never set to `DANGEROUS` due to a network error (this was a real bug in an earlier revision — DexScreener query failure was treated as 100% liquidity drop).
   - Disappearance of pair from DexScreener at time `t+N` is a separate class `PAIR_MISSING`, neither `DANGEROUS` nor `SAFE`. In reports (§5.7 below), computed with **two bounds**: lower (pair disappeared = non-dangerous, excluded from FN numerator) and upper (pair disappeared = dangerous, included in FN numerator) — publish both, never pick one arbitrarily.
   - Successor pool in migration counts only if its `pairCreatedAt` is STRICTLY LATER than `t` of the buy — a pool existing BEFORE the buy is not a "successor", even with high liquidity.
3. **Security and Quotas:**
   - Daily external request ceiling is tracked separately for `collect.mjs` and `outcomes.mjs` (`DAILY_REQUEST_CEILING_COLLECT = 1500`, `DAILY_REQUEST_CEILING_OUTCOMES = 1500`, stage 7H task 2; shared key `(date)` previously allowed collector to block outcome evaluations at 03:00 UTC — now key is `(date, script)`, `DAILY_REQUEST_CEILING` is not read anywhere).
   - Retries with exponential backoff on HTTP 429.
   - Key `HELIUS_API_KEY` is taken only from environment and never logged; collector does not read `radar.env`.
   - `--force-all` (resets minimum record age in `outcomes.mjs`) is permitted **only** alongside `--db=<path>` pointing to a database SEPARATE from production — otherwise collector refuses to start (non-zero exit code).

---

## 2. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HELIUS_API_KEY` | *(none)* | Helius RPC API key. Value is never printed to console/logs. |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Fallback RPC URL if `HELIUS_API_KEY` is unset. |
| `RADAR_URL` | `http://localhost:7690` | Local Wallet Radar HTTP server URL for calling `POST /gate-copy`. |
| `SHADOW_DB_PATH` | `shadow/shadow.db` | Path to SQLite database file (added to `.gitignore`). |
| `POLL_INTERVAL_MINUTES` | `15` | Interval between collector runs (in minutes) during continuous operation. |
| `DAILY_REQUEST_CEILING_COLLECT` | `1500` | Maximum number of external requests for `collect.mjs` (RPC + GeckoTerminal + DexScreener) per day. |
| `DAILY_REQUEST_CEILING_OUTCOMES` | `1500` | Maximum number of external requests for `outcomes.mjs` per day — separate counter, not shared with collector (stage 7H). |

### 2.1. Configuration Constants (in code, not env variables)

| Constant | File | Value | Purpose |
|---|---|---|---|
| `POOL_MAX_AGE_MINUTES` | `collect.mjs` | `15` | Pool must be no older than this threshold **at collection time** (task 1). |
| `TOKEN_MAX_AGE_DAYS` | `collect.mjs` | `14` | Minimum `pairCreatedAt` across all pairs of the mint on DexScreener must not exceed this threshold (task 2). |
| `COPY_AMOUNT_USD` | `collect.mjs` | `10` | Fixed amount passed to `POST /gate-copy` as `copyAmountUsd`; recorded into each row of `shadow_trades.copy_amount_usd` verbatim (task 4). |
| `MAX_CONSECUTIVE_RADAR_ERRORS` | `collect.mjs` | `5` | After this many consecutive `RADAR_ERROR` responses, collector halts with non-zero exit code. |
| `OUTCOME_HORIZON_DAYS` | `outcomes.mjs` | `3` | Unified horizon `N` for criteria (a) and (b) (`TESTER-SPEC.md` v2.1 §8). |
| `BUYER_CANDIDATE_SCAN_LIMIT` | `collect.mjs` | `20` | How many transactions after pool creation to try when searching for buyer before giving up (`NO_BUYER`). |

---

## 3. Database Path and Schema

SQLite database is located at `shadow/shadow.db` (directory created automatically).

### Main Tables:
- `shadow_trades`: trade record — `mint`, `pair`, `t` (blockTime of buy transaction), mint state, stratum (A/B), `buyer` (or `NULL` if unresolved), `buyer_tx_signature` (buy transaction signature, task 3), `http_status` (`/gate-copy` response code), `copy_amount_usd`, `mint_risk_fetched` (`"true"` / `"false"` / `"NOT_DETERMINABLE"`, task 4), `radar_verdict` (JSON, `NULL` on `RADAR_ERROR`), `radar_error` (JSON, populated only on error), radar commit, outcome (`outcome`, including `PAIR_MISSING`, `ISSUER_CONTROLLED`, `"migration, not outcome"`, `"unrecoverable (...)"`), and outcome timestamp. `outcome` remains `NULL` until `t + OUTCOME_HORIZON_DAYS` arrives **and** outcome computation finishes without API/network error (see §1, task 5a).
- `request_counters`: daily request counters (`date`, `request_count`) for daily limit tracking.
- `error_logs`: structured error log with call stack.

---

## 4. Orange Pi Deployment (systemd)

For autonomous operation on the Orange Pi microcomputer, two systemd services are created:
1. Continuous trade collection service `wallet-radar-shadow-collect.service`.
2. Daily outcome evaluation timer and service `wallet-radar-shadow-outcomes.timer`.

### 4.1. Collector Service (`/etc/systemd/system/wallet-radar-shadow-collect.service`)

```ini
[Unit]
Description=Wallet Radar Shadow Collector Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=orangepi
WorkingDirectory=/home/orangepi/wallet-radar
Environment=NODE_ENV=production
Environment=RADAR_URL=http://127.0.0.1:7690
Environment=SHADOW_DB_PATH=/home/orangepi/wallet-radar/shadow/shadow.db
Environment=DAILY_REQUEST_CEILING_COLLECT=1500
Environment=POLL_INTERVAL_MINUTES=15
# RPC key is provided in an environment file with restricted permissions (chmod 600)
EnvironmentFile=-/etc/default/wallet-radar-shadow
ExecStart=/usr/bin/node scripts/shadow/collect.mjs --interval=15
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 4.2. Outcomes Evaluation Service (`/etc/systemd/system/wallet-radar-shadow-outcomes.service`)

```ini
[Unit]
Description=Wallet Radar Shadow Outcomes Evaluator
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=orangepi
WorkingDirectory=/home/orangepi/wallet-radar
Environment=NODE_ENV=production
Environment=SHADOW_DB_PATH=/home/orangepi/wallet-radar/shadow/shadow.db
Environment=DAILY_REQUEST_CEILING_OUTCOMES=1500
EnvironmentFile=-/etc/default/wallet-radar-shadow
ExecStart=/usr/bin/node scripts/shadow/outcomes.mjs --min-age-days=3
StandardOutput=journal
StandardError=journal
```

### 4.3. Outcomes Evaluation Timer (`/etc/systemd/system/wallet-radar-shadow-outcomes.timer`)

```ini
[Unit]
Description=Run Wallet Radar Outcomes Evaluator Daily at 01:00 UTC

[Timer]
OnCalendar=*-*-* 01:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

### 4.4. Activation and Startup

```bash
# Create secure environment file with key (if needed)
sudo bash -c 'echo "HELIUS_API_KEY=your_key_here" > /etc/default/wallet-radar-shadow'
sudo chmod 600 /etc/default/wallet-radar-shadow

# Reload systemd and enable services
sudo systemctl daemon-reload
sudo systemctl enable --now wallet-radar-shadow-collect.service
sudo systemctl enable --now wallet-radar-shadow-outcomes.timer

# Check status
systemctl status wallet-radar-shadow-collect.service
systemctl list-timers wallet-radar-shadow-outcomes.timer
```

### 4.5. Pre-launch Check on Orange Pi (preflight, stage 7C)

Before EVERY (re)start of services on Orange Pi, execute in order. Do not skip any step silently — if preflight shows `FAIL`, do not enable units until the cause is resolved.

```bash
# 1. Update code to latest branch state
cd /home/orangepi/wallet-radar
git pull

# 2. Check Node version (minimum 22.13.0 for node:sqlite, see section 0)
node -v

# 3. Set key in CURRENT shell environment (never print/log value)
export HELIUS_API_KEY="..."

# 4. Run preflight -- it checks everything needed to start units,
#    and does not crash on missing network (prints FAIL instead of crashing)
node scripts/shadow/preflight.mjs
echo "exit code: $?"
```

`scripts/shadow/preflight.mjs` checks (PASS/FAIL with reason for each item, non-zero exit code on any FAIL):
1. Node version + importability of `node:sqlite`;
2. whether `HELIUS_API_KEY` is set (yes/no only, without value);
3. RPC availability via key and via public node (`getSlot`, response time);
4. `GET {RADAR_URL}/health` — HTTP 200 and `env.heliusConfigured=true`;
5. test `POST {RADAR_URL}/gate-copy` — HTTP 200 (not 503);
6. new pools source (GeckoTerminal `new_pools`, choice of task 1 stage 7B) responds and serves pools younger than `POOL_MAX_AGE_MINUTES`;
7. directory `shadow/` is writable, >= 500 MB free space;
8. system clock drift against external server `Date` header <= 5 seconds.

**Only if preflight exited with code `0` (all items `PASS`)**, proceed to starting units — order matters:

```bash
# 5. Reload unit files (if .service/.timer changed)
sudo systemctl daemon-reload

# 6. First the collector -- it is the sole source of records in shadow_trades
sudo systemctl enable --now wallet-radar-shadow-collect.service
systemctl status wallet-radar-shadow-collect.service --no-pager

# 7. Only after collector is confirmed running (status: active,
#    "[COLLECT] Cycle completed" visible in journalctl), enable outcomes timer.
#    Starting outcomes earlier is meaningless: getPendingTrades selects records
#    no younger than t + OUTCOME_HORIZON_DAYS (3 days), which physically do not exist yet.
sudo systemctl enable --now wallet-radar-shadow-outcomes.timer
systemctl list-timers wallet-radar-shadow-outcomes.timer --no-pager

# 8. Check logs of both services
journalctl -u wallet-radar-shadow-collect.service -n 50 --no-pager
journalctl -u wallet-radar-shadow-outcomes.service -n 50 --no-pager
```

If preflight failed on item 4/5 (`heliusConfigured=false` / `gate-copy` returned non-200) — this indicates `HELIUS_API_KEY` is invisible to the radar process itself (`http-server.ts`), not only to the collector; check `EnvironmentFile=-/etc/default/wallet-radar-shadow` on the RADAR UNIT (not collector) and restart it before enabling collector units.

---

## 5. SQL Queries for Monitoring and Reports

To inspect database state, use the `sqlite3 shadow/shadow.db` utility or a Node script.

### 5.1. General Record Counts and Outcome Status

```sql
SELECT 
  COUNT(*) AS total_trades,
  SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS pending_outcomes,
  SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS resolved_outcomes,
  SUM(CASE WHEN buyer IS NULL THEN 1 ELSE 0 END) AS no_buyer_count,
  SUM(CASE WHEN http_status IS NOT NULL AND http_status != 200 THEN 1 ELSE 0 END) AS radar_error_count
FROM shadow_trades;
```

### 5.2. Distribution by Strata (Stratum A vs B) -- DO NOT sum together (TESTER-SPEC.md v2.1 §1)

```sql
SELECT 
  strat,
  COUNT(*) AS count,
  ROUND(AVG(liquidity_usd), 2) AS avg_liquidity_usd,
  SUM(CASE WHEN buyer IS NOT NULL THEN 1 ELSE 0 END) AS with_buyer,
  SUM(CASE WHEN buyer IS NULL THEN 1 ELSE 0 END) AS without_buyer,
  SUM(CASE WHEN http_status IS NOT NULL AND http_status != 200 THEN 1 ELSE 0 END) AS radar_error
FROM shadow_trades
GROUP BY strat;
```

**Important (task 8):** stratum B without resolved buyer (`without_buyer`) and records with `RADAR_ERROR` (`radar_error`) are reported as **separate lines** in any metrics report — entering neither numerator nor denominator of FN/FP rate for any stratum, as a genuine radar verdict was never obtained for them.

### 5.3. Outcomes Breakdown

```sql
SELECT 
  COALESCE(outcome, 'PENDING (<3 days)') AS outcome_category,
  COUNT(*) AS trade_count,
  ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM shadow_trades), 2) AS pct
FROM shadow_trades
GROUP BY outcome_category
ORDER BY trade_count DESC;
```

### 5.4. Radar Verdicts vs Objective Outcomes (Confusion Matrix)

```sql
SELECT 
  json_extract(radar_verdict, '$.action') AS radar_action,
  outcome,
  COUNT(*) AS count
FROM shadow_trades
WHERE outcome IS NOT NULL AND radar_verdict IS NOT NULL  -- excludes RADAR_ERROR rows (radar_verdict is NULL for those)
GROUP BY radar_action, outcome
ORDER BY radar_action, count DESC;
```

### 5.4a. `PAIR_MISSING` — Two Bounds (task 5b/8, do not pick one arbitrarily)

`PAIR_MISSING` is neither `DANGEROUS` nor `SAFE`; when publishing FN rate / FP rate, report both estimates:

```sql
-- Lower bound: PAIR_MISSING treated as non-dangerous outcome (optimistic).
SELECT strat,
  SUM(CASE WHEN outcome = 'DANGEROUS' THEN 1 ELSE 0 END) AS dangerous_lower,
  SUM(CASE WHEN outcome IN ('DANGEROUS','PAIR_MISSING') THEN 1 ELSE 0 END) AS dangerous_upper,
  SUM(CASE WHEN outcome = 'PAIR_MISSING' THEN 1 ELSE 0 END) AS pair_missing_count
FROM shadow_trades
WHERE outcome IS NOT NULL AND radar_verdict IS NOT NULL
GROUP BY strat;
-- dangerous_lower = lower bound of DANGEROUS numerator; dangerous_upper = upper bound
-- (PAIR_MISSING treated as dangerous, pessimistic). Publish both, not one.
```

### 5.5. Daily Quota Monitoring (Request Counters)

```sql
SELECT 
  date,
  request_count,
  1500 - request_count AS remaining_quota
FROM request_counters
ORDER BY date DESC
LIMIT 7;
```

### 5.6. Recent Error Log

```sql
SELECT 
  timestamp,
  script,
  action,
  error_message,
  details
FROM error_logs
ORDER BY id DESC
LIMIT 10;
```
