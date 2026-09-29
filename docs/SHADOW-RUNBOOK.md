# Wallet Radar — Теневой сборщик (Shadow Collector Runbook)

## 0. Требования к среде выполнения

**Минимальная версия Node.js: 22.13.0.** Проверено по официальной документации Node.js ([nodejs.org/docs/latest-v22.x/api/sqlite.html](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)): модуль `node:sqlite` добавлен в **v22.5.0** за флагом `--experimental-sqlite`; начиная с **v22.13.0** флаг больше не требуется (`SQLite is no longer behind --experimental-sqlite but still experimental`). Стабильность модуля на v22.13.0 — **1.1 (Active development)**, API может измениться в будущих версиях — не давать гарантий обратной совместимости схемы между минорными апгрейдами Node без повторной проверки. Скрипты сборщика не передают флаг `--experimental-sqlite` нигде — соответственно, на Node < 22.13.0 `import { DatabaseSync } from "node:sqlite"` завершится ошибкой; на Node 22.5.0–22.12.x потребовался бы запуск с флагом (не поддерживается текущими npm-скриптами).

---

## 1. Архитектура и назначение

Теневой проспективный сборщик (`scripts/shadow/collect.mjs` и `scripts/shadow/outcomes.mjs`) реализует протокол независимой оценки фаервола по [docs/TESTER-SPEC.md](TESTER-SPEC.md) (v2.1) и [docs/SHADOW-COLLECTOR.md](SHADOW-COLLECTOR.md).

### Ключевые принципы (исправлено в stage 7B):
1. **Разделение сбора и разметки:**
   - `collect.mjs` фиксирует сделку в момент `t` = **blockTime транзакции покупки** (не время создания пула). Источник новых пулов — **GeckoTerminal `new_pools`** (не поиск DexScreener, см. `docs/SHADOW-COLLECTOR.md` за сравнением и реальной проверкой лимитов/задержки), фильтр по свежести пула — константа `POOL_MAX_AGE_MINUTES = 15` (пул должен быть не старше этого порога **на момент сбора**, не на момент проверки исхода). Отдельно проверяется возраст самого токена: `TOKEN_MAX_AGE_DAYS = 14` — минимальный `pairCreatedAt` среди ВСЕХ пар mint'а на DexScreener; если старше — запись не создаётся, счётчик `TOKEN_TOO_OLD`.
   - Покупатель — не создатель пула: первая транзакция ПОСЛЕ транзакции создания пула, где получатель токена верифицирован как System-owned, non-executable аккаунт (`getAccountInfo`), не PDA, не fee payer транзакции создания пула. Подпись покупки сохраняется в `buyer_tx_signature`.
   - Вердикт радара запрашивается сразу (`POST /gate-copy` с `mint`+`mintRisk`, фиксированная `copyAmountUsd = COPY_AMOUNT_USD = 10`). HTTP-статус ответа сохраняется в `http_status`; ответ, отличный от 200, — `RADAR_ERROR`, **не считается вердиктом** (`radar_verdict` остаётся `NULL`, ошибка — в `radar_error`). 5 подряд `RADAR_ERROR` — аварийная остановка сборщика с ненулевым кодом выхода.
   - `outcomes.mjs` — независимый фоновый процесс, запускается раз в сутки для записей старше **единого горизонта `OUTCOME_HORIZON_DAYS = 3`** (одинаково для критериев (a) и (b), `docs/TESTER-SPEC.md` v2.1 §8). **Не вызывает радар и не читает сохранённые вердикты** (SQL-запрос `getPendingTrades` намеренно не выбирает `radar_verdict`).
2. **Невосстановимость (Append-Only) и обработка ошибок:**
   - Вердикт радара записывается при обнаружении сделки, не переписывается.
   - Исход вычисляется один раз по объективным ончейн-фактам. **Любая ошибка API/сети при расчёте исхода оставляет `outcome = NULL`** (запись остаётся «pending» и будет пересчитана на следующем прогоне) — исход никогда не выставляется в `DANGEROUS` из-за сетевой ошибки (это была реальная ошибка в дособранной версии — падение запроса к DexScreener трактовалось как 100%-е падение ликвидности).
   - Пропажа пары из DexScreener на момент `t+N` — отдельный класс `PAIR_MISSING`, не `DANGEROUS` и не `SAFE`. В отчётах (§5.7 ниже) считается **двумя границами**: нижней (пара пропала = не опасно, исключить из числителя FN) и верхней (пара пропала = опасно, включить в числитель FN) — публиковать обе, не выбирать одну произвольно.
   - Пул-преемник при миграции засчитывается только если его `pairCreatedAt` СТРОГО ПОЗЖЕ `t` покупки — пул, существовавший ДО покупки, не «преемник», даже при высокой ликвидности.
3. **Безопасность и квоты:**
   - Суточный потолок внешних запросов (`DAILY_REQUEST_CEILING = 1500`).
   - Ретраи с экспоненциальным бэкоффом при HTTP 429.
   - Ключ `HELIUS_API_KEY` берётся только из окружения и никогда не логируется; `radar.env` сборщик не читает.
   - `--force-all` (обнуляет минимальный возраст записи в `outcomes.mjs`) разрешён **только** вместе с `--db=<путь>`, указывающим на ОТДЕЛЬНУЮ от продовой базу — иначе сборщик отказывается запускаться (ненулевой код выхода).

---

## 2. Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `HELIUS_API_KEY` | *(нет)* | API-ключ Helius RPC. Значение никогда не выводится в консоль/логи. |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Fallback RPC URL, если `HELIUS_API_KEY` не задан. |
| `RADAR_URL` | `http://localhost:7690` | URL локального HTTP-сервера Wallet Radar для вызова `POST /gate-copy`. |
| `SHADOW_DB_PATH` | `shadow/shadow.db` | Путь к файлу базы данных SQLite (добавлен в `.gitignore`). |
| `POLL_INTERVAL_MINUTES` | `15` | Интервал между прогонами сборщика (в минутах) при постоянной работе. |
| `DAILY_REQUEST_CEILING` | `1500` | Максимальное количество внешних запросов (RPC + GeckoTerminal + DexScreener) в сутки. |

### 2.1. Константы конфигурации (в коде, не env-переменные)

| Константа | Файл | Значение | Назначение |
|---|---|---|---|
| `POOL_MAX_AGE_MINUTES` | `collect.mjs` | `15` | Пул должен быть не старше этого порога **на момент сбора** (task 1). |
| `TOKEN_MAX_AGE_DAYS` | `collect.mjs` | `14` | Минимальный `pairCreatedAt` среди всех пар mint'а на DexScreener не должен быть старше этого порога (task 2). |
| `COPY_AMOUNT_USD` | `collect.mjs` | `10` | Фиксированная сумма, передаваемая в `POST /gate-copy` как `copyAmountUsd`; записывается в каждую строку `shadow_trades.copy_amount_usd` дословно (task 4). |
| `MAX_CONSECUTIVE_RADAR_ERRORS` | `collect.mjs` | `5` | После стольких подряд идущих `RADAR_ERROR`-ответов сборщик останавливается с ненулевым кодом выхода. |
| `OUTCOME_HORIZON_DAYS` | `outcomes.mjs` | `3` | Единый горизонт `N` для критериев (a) и (b) (`TESTER-SPEC.md` v2.1 §8). |
| `BUYER_CANDIDATE_SCAN_LIMIT` | `collect.mjs` | `20` | Сколько транзакций после создания пула пробовать при поиске покупателя, прежде чем сдаться (`NO_BUYER`). |

---

## 3. Путь к базе данных и схема

База данных SQLite размещается по пути `shadow/shadow.db` (каталог создаётся автоматически).

### Основные таблицы:
- `shadow_trades`: запись сделки — `mint`, `pair`, `t` (blockTime транзакции покупки), состояние mint, страт (A/B), `buyer` (или `NULL`, если не резолвится), `buyer_tx_signature` (подпись транзакции покупки, task 3), `http_status` (код ответа `/gate-copy`), `copy_amount_usd`, `mint_risk_fetched` (`"true"` / `"false"` / `"NOT_DETERMINABLE"`, task 4), `radar_verdict` (JSON, `NULL` при `RADAR_ERROR`), `radar_error` (JSON, заполнен только при ошибке), коммит радара, исход (`outcome`, включая `PAIR_MISSING`, `ISSUER_CONTROLLED`, `"миграция, не исход"`, `"невосстановимо (...)"`) и метка времени исхода. `outcome` остаётся `NULL`, пока не наступит `t + OUTCOME_HORIZON_DAYS` **и** расчёт исхода не завершится без ошибки API/сети (см. §1, task 5a).
- `request_counters`: суточные счётчики запросов (`date`, `request_count`) для контроля дневного лимита.
- `error_logs`: структурированный журнал ошибок со стеком вызовов.

---

## 4. Развёртывание на Orange Pi (systemd)

Для автономной работы на микрокомпьютере Orange Pi создаются два systemd-сервиса:
1. Постоянный сервис сбора сделок `wallet-radar-shadow-collect.service`.
2. Ежедневный таймер и сервис расчёта исходов `wallet-radar-shadow-outcomes.timer`.

### 4.1. Сервис сборщика (`/etc/systemd/system/wallet-radar-shadow-collect.service`)

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
Environment=DAILY_REQUEST_CEILING=1500
Environment=POLL_INTERVAL_MINUTES=15
# Ключ RPC задаётся в файле окружения с ограниченными правами (chmod 600)
EnvironmentFile=-/etc/default/wallet-radar-shadow
ExecStart=/usr/bin/node scripts/shadow/collect.mjs --interval=15
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 4.2. Сервис расчёта исходов (`/etc/systemd/system/wallet-radar-shadow-outcomes.service`)

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
EnvironmentFile=-/etc/default/wallet-radar-shadow
ExecStart=/usr/bin/node scripts/shadow/outcomes.mjs --min-age-days=3
StandardOutput=journal
StandardError=journal
```

### 4.3. Таймер расчёта исходов (`/etc/systemd/system/wallet-radar-shadow-outcomes.timer`)

```ini
[Unit]
Description=Run Wallet Radar Outcomes Evaluator Daily at 01:00 UTC

[Timer]
OnCalendar=*-*-* 01:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

### 4.4. Активация и запуск

```bash
# Создать защищённый файл с ключом (при необходимости)
sudo bash -c 'echo "HELIUS_API_KEY=your_key_here" > /etc/default/wallet-radar-shadow'
sudo chmod 600 /etc/default/wallet-radar-shadow

# Перезагрузить systemd и включить сервисы
sudo systemctl daemon-reload
sudo systemctl enable --now wallet-radar-shadow-collect.service
sudo systemctl enable --now wallet-radar-shadow-outcomes.timer

# Проверить статус
systemctl status wallet-radar-shadow-collect.service
systemctl list-timers wallet-radar-shadow-outcomes.timer
```

---

## 5. SQL-запросы для мониторинга и отчётов

Для просмотра состояния базы данных используйте утилиту `sqlite3 shadow/shadow.db` или Node-скрипт.

### 5.1. Общие счётчики записей и статус исходов

```sql
SELECT 
  COUNT(*) AS total_trades,
  SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS pending_outcomes,
  SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS resolved_outcomes,
  SUM(CASE WHEN buyer IS NULL THEN 1 ELSE 0 END) AS no_buyer_count,
  SUM(CASE WHEN http_status IS NOT NULL AND http_status != 200 THEN 1 ELSE 0 END) AS radar_error_count
FROM shadow_trades;
```

### 5.2. Распределение по стратам (Stratum A vs B) -- НЕ суммировать друг с другом (TESTER-SPEC.md v2.1 §1)

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

**Важно (task 8):** страт B без резолвленного покупателя (`without_buyer`) и записи с `RADAR_ERROR` (`radar_error`) отчитываются **отдельными строками** в любом отчёте по метрикам — не входят ни в числитель, ни в знаменатель FN/FP-rate ни для одного страта, поскольку по ним никогда не было получено настоящего вердикта радара.

### 5.3. Распределение исходов (Outcomes Breakdown)

```sql
SELECT 
  COALESCE(outcome, 'PENDING (<3 days)') AS outcome_category,
  COUNT(*) AS trade_count,
  ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM shadow_trades), 2) AS pct
FROM shadow_trades
GROUP BY outcome_category
ORDER BY trade_count DESC;
```

### 5.4. Сверка вердиктов радара с объективными исходами (Confusion Matrix)

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

### 5.4a. `PAIR_MISSING` — две границы (task 5b/8, не выбирать одну произвольно)

`PAIR_MISSING` — не `DANGEROUS` и не `SAFE`; при публикации FN-rate/FP-rate приводить обе оценки:

```sql
-- Нижняя граница: PAIR_MISSING трактуется как НЕ опасный исход (оптимистично).
SELECT strat,
  SUM(CASE WHEN outcome = 'DANGEROUS' THEN 1 ELSE 0 END) AS dangerous_lower,
  SUM(CASE WHEN outcome IN ('DANGEROUS','PAIR_MISSING') THEN 1 ELSE 0 END) AS dangerous_upper,
  SUM(CASE WHEN outcome = 'PAIR_MISSING' THEN 1 ELSE 0 END) AS pair_missing_count
FROM shadow_trades
WHERE outcome IS NOT NULL AND radar_verdict IS NOT NULL
GROUP BY strat;
-- dangerous_lower = нижняя граница числителя DANGEROUS; dangerous_upper = верхняя граница
-- (PAIR_MISSING трактуется как опасный, пессимистично). Публиковать обе, не одну.
```

### 5.5. Мониторинг расхода суточных квот (Request Counters)

```sql
SELECT 
  date,
  request_count,
  1500 - request_count AS remaining_quota
FROM request_counters
ORDER BY date DESC
LIMIT 7;
```

### 5.6. Журнал недавних ошибок

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
