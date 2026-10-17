# Sampling Protocol: Incident INC-2022-08-SLOPE

## 1. Goal

Establish a verifiable, reproducible sample of up to 5 compromised wallets from incident `INC-2022-08-SLOPE` (Slope Wallet key leak, August 2022). The selected wallets represent real victim accounts with confirmed unauthorized drain transactions and sufficient on-chain history prior to the compromise.

## 2. Sources

This sampling relies on primary and security-firm incident documentation:
- **Solana Foundation Incident Update**: [https://solana.com/news/8-2-2022-application-wallet-incident](https://solana.com/news/8-2-2022-application-wallet-incident) (confirms private key compromise transmitted to Sentry logging service, ~9,231 wallets affected, ~$4.1M loss).
- **SlowMist Security Analysis (Part 2)**: [https://slowmist.medium.com/analysis-of-a-large-scale-attack-on-solana-part-2-ee105d907c12](https://slowmist.medium.com/analysis-of-a-large-scale-attack-on-solana-part-2-ee105d907c12) (contains published tables "Sentry Slope Victims" and "Solana Hackers Wallet").

## 3. Data Scope & Limitations

The published SlowMist dataset contains 1,326 unique Solana victim addresses whose private keys/seed phrases were recovered from Slope Sentry logs, rather than the entire population of ~9,231 affected wallets. Sampling is strictly conducted over these 1,326 documented victim addresses.

### Attacker Addresses
Four hacker consolidation and drain addresses documented in the SlowMist investigation:
1. `GeEccGJ9BEzVbVor1njkBCCiqXJbXVeDHaXDCrBDbmuy`
2. `5WwBYgQG6BdErM2nNNyUmQXfcUnB68b6kesxBywh1J3n`
3. `CEzN7mqP9xoxn2HdyW6fjEJ73t7qaX9Rp2zyS6hb3iEu`
4. `Htp9MGP8Tig923ZFY7Qf2zzbMUmYneFRAhSp7vSg4wxV`

## 4. Reproducible Sampling Order

The candidate list is ordered deterministically prior to any on-chain inspection:
- Source: 1,326 distinct Solana `Victim Address` values from `Slope Sentry Victim - Stolen Transaction - Sheet1.csv`.
- Lexicographical sort ascending.
- Deterministic permutation using Python `random.Random(20261014).shuffle`.
- **Random Seed**: `20261014`
- **Shuffled List SHA-256**: `fa68a581ddb146b02f275f14887c7b1ceb946e291306b450c6f613a7dcac3cf1`

For each victim, $t_0$ is defined from the hacker transaction journal (`_Hacker's wallet - Solana Merge Transaction - Sheet1.csv`):
- For each victim signature `Tx Hash`, lookup `BlockTime Unix`.
- Victim's $t_0$ is the minimum `BlockTime Unix` across its drain transactions. In case of tie, pick the lexicographically smaller signature.

## 5. Acceptance Criteria

Candidates are evaluated sequentially in the shuffled order.
Verification stops when **5 accepted wallets** are found, or when **150 candidates** have been evaluated.

Each candidate must satisfy all four criteria:
- **Criterion (a) - Valid $t_0$ Drain Transaction**:
  The transaction signature for $t_0$ exists on-chain, was executed successfully (`err == null`), its `blockTime` matches the journal timestamp within a tolerance of $\pm 2$ seconds, and lies within the incident window `2022-08-02T22:37:00Z` to `2022-08-06T03:00:00Z`.
- **Criterion (b) - Signer Verification**:
  The victim address is verified as a transaction signer (`isSigner == true`).
- **Criterion (c) - Attacker Recipient**:
  The transaction transfers funds to at least one of the four attacker addresses: either direct SOL transfer (`postBalances > preBalances` for an attacker address) or an SPL token transfer whose destination token account is owned by one of the attacker addresses (`postTokenBalances` owner in attacker set).
- **Criterion (d) - Sufficient Baseline Activity**:
  Prior to $t_0$, the victim wallet has $\ge 20$ successful transactions (queried via `getSignaturesForAddress` with `before = t0_signature`, limit 100).

### Cluster Limit
Per `DETECTION-TARGET.md` Section 3 item 5, a single incident cluster may contribute at most **5 accepted wallets** to the labeled dataset.

All evaluated candidates are recorded in the sampling verification log with their position and outcome. Rejected candidate addresses are kept private and not logged.

## 6. Not Done

- The Wallet Radar detection engine was **not** run on any of these wallets.
- This sampling rule set and list is frozen on **2026-10-28**.
