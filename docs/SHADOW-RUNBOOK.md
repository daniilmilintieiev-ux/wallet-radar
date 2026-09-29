# Wallet Radar — Теневой сборщик (Shadow Collector Runbook)

## 1. Архитектура и назначение

Теневой проспективный сборщик (`scripts/shadow/collect.mjs` и `scripts/shadow/outcomes.mjs`) реализует протокол независимой оценки фаервола по [docs/TESTER-SPEC.md](TESTER-SPEC.md) (v2.1) и [docs/SHADOW-COLLECTOR.md](SHADOW-COLLECTOR.md).

### Ключевые принципы:
1. **Разделение сбора и разметки:**
   - `collect.mjs` фиксирует сделку в момент `t` (новые пары DexScreener на Solana, возраст $\le 14$ дней, DEX Raydium/PumpSwap) и запрашивает вердикт `POST /gate-copy` до наступления исхода.
   - `outcomes.mjs` — независимый фоновый процесс, запускается раз в сутки для записей старше 3 дней. **Не вызывает радар и не читает сохранённые вердикты.**
2. **Невосстановимость (Append-Only):**
   - Вердикт радара записывается при обнаружении сделки.
   - Исход вычисляется один раз по объективным ончейн-фактам (замороженный ATA, падение ликвидности $\ge 90\%$, миграция, `ISSUER_CONTROLLED`) и не перезаписывается.
3. **Безопасность и квоты:**
   - Суточный потолок внешних запросов (`DAILY_REQUEST_CEILING = 1500`).
   - Ретраи с экспоненциальным бэкоффом при HTTP 429.
   - Ключ `HELIUS_API_KEY` берётся только из окружения и никогда не логируется.

---

## 2. Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `HELIUS_API_KEY` | *(нет)* | API-ключ Helius RPC. Значение никогда не выводится в консоль/логи. |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Fallback RPC URL, если `HELIUS_API_KEY` не задан. |
| `RADAR_URL` | `http://localhost:7690` | URL локального HTTP-сервера Wallet Radar для вызова `POST /gate-copy`. |
| `SHADOW_DB_PATH` | `shadow/shadow.db` | Путь к файлу базы данных SQLite (добавлен в `.gitignore`). |
| `POLL_INTERVAL_MINUTES` | `15` | Интервал между прогонами сборщика (в минутах) при постоянной работе. |
| `DAILY_REQUEST_CEILING` | `1500` | Максимальное количество внешних запросов (RPC + DexScreener) в сутки. |

---

## 3. Путь к базе данных и схема

База данных SQLite размещается по пути `shadow/shadow.db` (каталог создаётся автоматически).

### Основные таблицы:
- `shadow_trades`: записи сделок, состояние mint, страты (A/B), покупатель, полный JSON-ответ `POST /gate-copy`, коммит радара, исход и метка времени исхода.
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
  SUM(CASE WHEN buyer = 'NO_BUYER' THEN 1 ELSE 0 END) AS no_buyer_count
FROM shadow_trades;
```

### 5.2. Распределение по стратам (Stratum A vs B)

```sql
SELECT 
  strat,
  COUNT(*) AS count,
  ROUND(AVG(liquidity_usd), 2) AS avg_liquidity_usd,
  SUM(CASE WHEN buyer != 'NO_BUYER' THEN 1 ELSE 0 END) AS with_buyer
FROM shadow_trades
GROUP BY strat;
```

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
WHERE outcome IS NOT NULL
GROUP BY radar_action, outcome
ORDER BY radar_action, count DESC;
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
