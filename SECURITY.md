# Security

Wallet Radar is a deterministic Solana wallet trust-gate. This page describes
how to report a vulnerability, our disclosure process, and how we handle data.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability you have not yet had a chance to coordinate on.

- **Preferred:** open a private report via
  [GitHub Security Advisories](https://github.com/daniilmilintieiev-ux/wallet-radar/security/advisories/new).
- **Alternative:** email the maintainer at `@cbell` (Telegram) or
  `daniilmilintieiev-ux` (GitHub).

When reporting, please include:

- A short description of the issue and its impact.
- The affected component (CLI, MCP server, HTTP service, x402 service, baseline,
  pricing).
- Reproduction steps, a proof-of-concept, or the affected code path.
- The version or commit where you observed it (if known).

## Disclosure process

1. **Acknowledge** — we aim to confirm receipt within **48 hours**.
2. **Triage & fix** — we work on a fix and share a rough timeline; for a
   security-relevant issue we target a patch within a reasonable window
   (typically a few days for early-access).
3. **Coordinate release** — we let you know before a fix is released and, when
   it makes sense, credit you in the changelog/advisory (opt-out anytime).

We keep vulnerability reports and any PoC material private until a fix is
available, unless you prefer otherwise.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `1.0.0` (latest `main`, per `package.json`) | Yes |

We support the latest published `1.0.0` release on the `main` branch. We do
not actively backport fixes to older, unreferenced commits.

## Data handling & privacy

Wallet Radar is designed to be read-only and custody-free:

- **Read-only on-chain access.** All wallet data is fetched from public Solana
  data via the Helius Enhanced Transactions API (read-only). Wallet Radar does
  **not** hold your private key, does **not** take custody of funds, and does
  **not** sign or submit transactions on your behalf.
- **No custody of x402 payments.** In the x402 pay-per-call service, payment
  verification is read-only: it reads the submitted transaction and the
  recipient's USDC token-account balance before/after. The operator wallet is a
  passive receiver; the service never approves or moves a customer's funds.
- **Local cache.** Scan results and baselines are cached in a local SQLite
  database (Node's built-in `node:sqlite`) on the host running the service.
  This is operational state, not a data store shared across customers.
- **What we collect.** To run a check we need a Solana wallet address (a public
  on-chain identifier) and, for live checks, your Helius API key (kept in the
  service environment and used only to fetch that wallet's public history).
- **What we do not do.** We do not sell or share wallet data, and we do not use
  an LLM in the verdict path — the `safe`/`hold`/`unknown` decision and risk
  score are deterministic and recomputable from the same evidence.

## Key material (oracle payer)

When `RADAR_ORACLE=1` is enabled, the service pays the tx fees for on-chain
attestation commits from a dedicated **payer** wallet. How the payer secret is
provided changes its exposure:

| Method | Configuration | When to use |
|--------|---------------|-------------|
| Keypair **file** (JSON array of 64 bytes, `solana-keygen` format) | `RADAR_ORACLE_KEYPAIR=/path/to/payer.json` | **Recommended.** The secret lives on disk with file permissions and never appears in the process environment, shell history, or `systemctl` output. |
| Base58 secret in env | `RADAR_ORACLE_PAYER=<base58>` | **Prototype convenience.** The secret is readable from the process environment (`/proc/<pid>/environ` on Linux) and is inherited by child processes. |
| KMS / HSM-backed signer | — | **Production.** The raw 64 bytes never exist on the host; a signer service produces signatures on demand. It plugs in where `loadPayerFromEnv()` returns the keypair. |

Notes:

- Use a **low-balance dedicated payer** — attestation fees are a few hundred
  lamports per commit. Never a wallet that also holds other value.
- The payer only signs the attestation commits; it is never the x402 payment
  recipient.
- `RADAR_ORACLE_KEYPAIR` takes precedence over `RADAR_ORACLE_PAYER`; an
  unreadable or malformed file falls back to the env var with a warning.

## x402 payment replay protection

Paid endpoints (`POST /scan`, `POST /analyze`) accept x402 USDC payments. A
payment signature may be redeemed exactly once. Two layers enforce this:

1. **In-process (fast path).** `inFlightPayments` — an in-memory `Set` of
   signatures currently being verified/settled. Stops two *concurrent*
   requests in the same process from settling the same signature.
2. **Durable (source of truth).** The SQLite `settled_payments` table has
   `signature TEXT PRIMARY KEY`. Every verified payment is recorded there
   atomically before the endpoint is served, and every incoming payment is
   checked against it first. This survives restarts.

**Known window (prototype trade-off).** The in-memory entry is added *before*
verification; the durable row is written *after* verification. If the process
crashes between those two points, the payment is confirmed on-chain but absent
from the database, and after a restart the same signature could be redeemed
again (the endpoint runs a second time for the same payment). Impact is
bounded: it requires a crash inside that window **and** a client deliberately
re-presenting the same payment signature. Production mitigation: write a
`pending` row before verification and reconcile `pending` rows against the
chain after restart (or verify only after a durable pre-record).

## x402 anti-frontrunning & caller proof protection

Public Solana transactions are visible in the mempool and on-chain blocks. To prevent third parties from eavesdropping on a client's payment transaction and submitting it to claim free scans, Wallet Radar enforces two complementary cryptographic bindings (audits 1.1, 1.3, revision 9, revision 11):

1. **Cryptographic caller proof (`X-Payment-Proof`).** The caller signs an Ed25519 signature over `RadarScan:<targetWallet>:<timestamp>` (or `RadarScan:<targetWallet>`) with their payer private key. The server validates that the signature matches `X-Payment-Payer` and falls within the freshness window (`maxAgeSec`, default 300s).
2. **On-chain memo binding (`RadarScan:<targetWallet>`).** Alternatively, the payment transaction includes an SPL Memo instruction formatted as `RadarScan:<targetWallet>`. The server verifies that the memo target matches the requested scan target. Unbound transactions without a matching memo or proof signature are rejected.
3. **Payer on-chain signer verification.** The server inspects `accountKeys` in the transaction message to verify that `X-Payment-Payer` is an actual signer of the transaction (`signer === true`), rejecting transactions with missing or empty accountKeys (Revision 11 WR-CRIT-01).
4. **Dynamic token decimals.** Token amounts are parsed dynamically according to mint decimals (6 for USDC, 9 for SOL) to prevent decimal scaling bypasses.

## On-chain Token-22 Transfer Hook & ZK Oracle security

The smart contract components have undergone 11 successive revisions of internal security review:

- **Mint authority authentication.** Both `initialize` and `initialize_extra_account_meta_list` cryptographically unpack mint account data (`COption<Pubkey>`) and verify that the signer is the genuine `mint_authority` or designated hook config authority, preventing unauthorized configuration hijacking.
- **Two-sided counterparty gating.** Transfer Hook evaluates risk records for both the sender (`source`) and recipient (`destination`) accounts via Token-22 CPI remaining accounts, preventing compromised entities from sending or receiving tokens.
- **Account ownership validation (`InvalidAccountOwner = 6011`).** The `close_scan_record` instruction explicitly validates `record_info.owner == &crate::ID` prior to memory deallocation (`realloc(0, false)`) and lamport reclamation, preventing Solana VM `IllegalOwner` panics.
- **Cross-mint isolation.** Scan records are deterministically derived using `seeds = [b"radar_record", mint.key().as_ref(), wallet.as_ref()]`, ensuring attestations cannot be replayed across different token mints.
- **Update Extra Account Meta List.** Implemented Anchor discriminator `2c7d8de261b3a660` for `update_extra_account_meta_list` and expanded account capacity to eliminate byte truncation and instruction panics (Revision 11).
- **Strict Signer Halting.** Oracle signing pipeline strictly halts on missing or misconfigured keypairs, preventing silent downgrade to unsigned attestations (Revision 11 WR-CRIT-02).
- **Fast-fail oracle indexer polling.** Oracle polling in `commit` catches unsupported RPC methods immediately, preventing 15-second hangs on standard Solana RPCs and falling back directly to verifiable SPL Memo attestations.

## Autonomous Active Defense & sync

When Active Defense is enabled (`src/defense.ts`):
- Wallets dynamically transition across security stances (`armed` → `alerting` → `gated` → `blocked`).
- In `http-server.ts`, `applyDefense` executes *before* on-chain ZK oracle commitments (`commitScan`) and transfer hook publication, ensuring that hardened risk scores (up to 100/100) and restrictive verdicts are immutably anchored in the ledger and transfer hook.

## HTTP service hardening

- **Authentication (fail-closed for mutating routes).** Without `RADAR_API_TOKEN`,
  the mutating endpoints (`POST /watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear`)
  answer 403 Forbidden (unless `RADAR_ALLOW_UNAUTH_MUTATIONS=1` is set); when a token
  is set, they require `Authorization: Bearer <token>` (or an `x-api-token` header);
  comparison is timing-safe. Read endpoints stay open.
  Endpoints `/scan`, `/trust`, `/batch`, `/simulate`, `/gate-copy`, and `/analyze`
  remain open by default (subject to per-IP rate limits).
  With `RADAR_API_TOKEN` configured, `RADAR_AUTH_HEAVY=1` (or `RADAR_REQUIRE_AUTH=1`)
  gates the heavy POST routes (`/batch`, `/scan`, `/trust`, `/simulate`, `/gate-copy`),
  and `RADAR_PROTECT_READS=1` gates the protected GET routes (`/watch`, `/alerts`,
  `/defense`, `/defense/:wallet`, `/poll`).
  Operator-signed on-chain writes from `POST /scan` (hook bridge PDA and oracle memo)
  require a valid token by default (disabled for anonymous callers unless
  `RADAR_ALLOW_ANON_ONCHAIN_WRITES=1` is set).
- **CORS.** Open by default (`Access-Control-Allow-Origin: *` — responses
  contain data about wallets the caller chose). `RADAR_CORS_ORIGINS` restricts
  which browser origins may read responses cross-origin.
- **Rate limiting.** Per-IP limit (`RADAR_RATE_LIMIT_PER_MIN`, default
  120/min); Helius-incurring live routes are capped at `RADAR_LIVE_RATE_LIMIT_PER_MIN`
  (default 30/min); `/health` and `/metrics` are exempt.
- **Input validation.** Wallet parameters are strict-base58-validated at every
  API surface (the `0/O/I/l` lookalikes are rejected); JSON bodies are capped
  at ~1 MB (413 above that); Helius responses are runtime-validated (zod,
  permissive) — malformed items degrade with a warning instead of being cast
  blindly into the pipeline.

## Threat-model notes

- The verdict path (risk score + liquidity → verdict) is deterministic and
  unit-tested; there is no LLM and no network call that can silently change the
  decision.
- The LLM digest (optional) is a presentation layer only: on any failure or
  timeout it degrades to a deterministic template and never blocks or alters the
  verdict.
- Price normalization falls back to major-only sizing when the price feed is
  unavailable, so a single dependency outage does not fail a scan.

## Operational boundaries & verdict semantics

- **Deterministic Policy Compliance (`safe`):** A `safe` verdict indicates that within the evaluated historical window (the recent transaction batch and learned baseline profile), no configured anomaly rules or policy limits were triggered, and liquid capital met minimum requirements ($L \ge \$50$). It is an automated policy compliance check against known behavioral patterns, not a formal impossibility proof of novel or unobserved zero-day exploit techniques.
- **Evaluation Depth & Sampling:** Live scans analyze up to 50–100 most recent transactions. Baselines require a minimum of 5 transactions before scoring behavioral drift, and `OFF_HOURS` requires at least 20 baseline transactions to establish a representative 24-hour UTC activity histogram.
- **Timeout & Failure Boundaries:** RPC and Helius network queries are bounded by strict AbortSignal timeouts (10 seconds). In the event of an upstream network failure or incomplete historical data, the system conservatively falls back to `unknown` / `hold`, never blindly assuming safety.
- **Adversarial Resilience:** Comprehensive attack vectors, simulation edge cases, and exploit scenario results are documented in [ADVERSARIAL-TESTING.md](ADVERSARIAL-TESTING.md).

### Deployment security environment variables (see `docs/DEPLOY-CHECKLIST.md`)

- `RADAR_API_TOKEN`: Shared bearer token gating mutating routes (`POST /watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear`) and unlocking heavy/read/on-chain write gates.
- `RADAR_ALLOW_UNAUTH_MUTATIONS=1`: Explicit opt-in allowing mutating routes to run without a token (default is 403).
- `RADAR_ALLOW_ANON_ONCHAIN_WRITES=1`: Explicit opt-in allowing anonymous callers of `POST /scan` to trigger operator-signed on-chain writes (default requires valid token).
- `RADAR_REQUIRE_AUTH=1` / `RADAR_AUTH_HEAVY=1`: Gates heavy routes (`POST /batch`, `/scan`, `/trust`, `/simulate`, `/gate-copy`).
- `RADAR_PROTECT_READS=1`: Gates protected read routes (`GET /watch`, `/alerts`, `/defense`, `/defense/:wallet`, `/poll`).
- `RADAR_TRUST_PROXY=1`: Trust `CF-Connecting-IP` / `X-Forwarded-For` from reverse proxies for rate limiting.
- `RADAR_LIVE_RATE_LIMIT_PER_MIN`: Rate limit for Helius live-query endpoints (default 30/min).
- `RADAR_RATE_LIMIT_PER_MIN`: General rate limit per IP (default 120/min).

If you spot something in the code that does not match the above, please report
it privately.
