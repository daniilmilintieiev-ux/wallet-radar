# `radar trust <wallet> | --watchlist` — spec

**Статус: v1 — verdict + watchlist shortlist готовы, сеть (RPC/Jupiter) — best-effort, всё покрыто тестами (70/70).**

## Зачем

Wallet Radar сегодня отвечает «что изменилось в кошельке». `radar trust` добавляет
вопрос, который агент задаёт перед сделкой: **«можно ли доверять этому контрагенту
прямо сейчас?»** — pre-flight check для x402-платежей и любых agent-to-agent
платежей. Агент получает один детерминированный вердикт и может действовать по нему
без LLM.

## Формула вердикта

```
verdict = f(behavioral risk, payment capacity)
```

1. **Behavioral risk** — risk score (0-100) по правилам v1 за окно (по умолчанию 7 дней):
   - если wallet в watchlist — аномалии из store за окно;
   - если нет — one-shot: история → in-memory baseline → правила (семантика `scan`).
2. **Payment capacity** — ликвидность в USD: `USDC + USDT` (1:1) + `SOL × Jupiter price`.
   Stablecoins считаются точно даже если ценовой фид не доступен; SOL без цены
   не считается (флаг `solPriced: false`), вердикт не ломается.
3. **Verdict**:
   | verdict | условие |
   | --- | --- |
   | `safe` | riskScore <= maxRisk И liquidityUsd >= minLiquidityUsd |
   | `hold` | данные есть, но хотя бы один порог не пройден |
   | `unknown` | нет данных для оценки (нет истории для risk; RPC-ошибка балансов) |

Пороги по умолчанию: `maxRisk = 30`, `minLiquidityUsd = 50`. Флаги:
`--max-risk N`, `--min-liquidity N`, `--window-days N`, `--json`.

## Философия (последовательно с проектом)

- **Детерминированно, без LLM в verdict-пути.** Любой агент может воспроизвести
  вердикт по тем же входным данным (risk score + балансы + пороги).
- **Структурированный evidence.** JSON содержит точные числа (riskScore, балансы,
  liquidityUsd, reasons[]) — человек и агент читают одно и то же.
- **Conservative по неопределённости.** Нет данных → `unknown`, а не `safe`.
  Ложный `safe` дороже ложного `hold`.
- **Best-effort сеть.** Падение ценового фида не делает чек failed: stablecoins
  считаются точно, SOL помечается `solPriced: false`.

## Формат вывода

```json
{
  "wallet": "…",
  "verdict": "hold",
  "riskScore": 75,
  "anomalyCount": 3,
  "anomalies": [ … ],
  "balances": { "sol": 0.041, "usdc": 0, "usdt": 12.4 },
  "solPriced": true,
  "liquidityUsd": 16.5,
  "reasons": [
    "risk score 75 > max 30",
    "liquidity $16.50 < min $50.00"
  ],
  "windowDays": 7,
  "generatedAt": 1756900000
}
```

Человеческая строка (stdout без `--json`):
`wallet-radar: <wallet> — HOLD — risk 75/100, liquidity $16.50 (risk 75 > 30; liquidity $16.50 < $50.00)`

## Данные и источники

| данные | источник | fallback |
| --- | --- | --- |
| история/аномалии | Helius Enhanced Transactions + store | one-shot (как `scan`) |
| SOL-баланс | JSON-RPC `getBalance` (`RADAR_RPC_URL` или Helius RPC) | `unknown` |
| USDC/USDT | JSON-RPC `getTokenAccountsByOwner` (jsonParsed, uiAmount) | `unknown` |
| цена SOL | Jupiter Price API (keyless lite-api) | `solPriced: false` |

## Мульти-кошелёк: `radar trust --watchlist` → shortlist (v1)

`trust --watchlist` прогоняет тот же pre-flight check по **всему watchlist**
и собирает ранжированный shortlist — ответ на вопрос агента «кого из этих
кошельков я могу оплатить прямо сейчас, и в каком порядке?».

```
wallet-radar: trust shortlist — 3 wallet(s): 1 safe, 1 hold, 1 unknown
SAFE (ranked by risk, then liquidity):
  1. <walletA> — risk 8/100, liquidity $1,204.55
HOLD:
  1. <walletB> — risk 75/100, liquidity $16.50 (risk score 75 > max 30; ...)
UNKNOWN:
  1. <walletC> — risk n/a, liquidity n/a (balance data unavailable)
```

- Ранжирование детерминированное и **чистое** над per-wallet результатами
  (`buildShortlist`): сначала verdict (safe→hold→unknown), внутри — risk
  score по возрастанию, затем liquidity по убыванию. Любой агент
  воспроизводит тот же shortlist из тех же результатов.
- `--json` отдаёт `{ shortlist, results }`: shortlist — ранжированные
  группы, results — полные per-wallet evidence.
- Ошибка одного кошелька не роняет батч: он попадает в `unknown`
  с причиной `check failed: …`.
- Проверка последовательная (короткий список, pre-flight — секунды);
  конкурентности специально не добавлено.

## Ограничения (честно)

- Ликвидность — только SOL + 2 стейбла; остальные активы не считаются
  (консервативно: оцениваем меньше, чем есть).
- Risk-окно — 7 дней; длинные хвосты аномалий старше окна не влияют на вердикт.
- One-shot семантика: baseline строится из того же окна, что и правила,
  поэтому «свой» крупный своп в окне не триггерит LARGE_SWAP на себя.
- `trust` — моментальный срез; непрерывный trust-score в watch loop — следующий шаг.
- Нет кэша балансов: каждый вызов — 3 RPC + 1 цена. Для pre-flight это OK (секунды).

## Roadmap (следующие шаги)

- [x] Watchlist shortlist: `radar trust --watchlist` (v1, этот релиз).
- Trust-score в watch loop: вердикт обновляется на каждом poll, alert при смене safe→hold.
- Webhook: `POST {verdict, evidence}` в callback агента.
- Пороги по классам сделок (`--profile micropayment|standard|large`).
- Хвост: risk-score из всего окна наблюдения, а не 7 дней.
