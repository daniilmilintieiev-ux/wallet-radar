# Detection target (draft v0.2)

Status: draft v0.2, 2026-10-14 (clusters, prices, sources)
Changes from v0.1: incident is the unit of analysis; historical-price limitation; news articles are pointers only.
Nothing here changes the submitted version (tag `submission-colosseum-fall2026`) or the preregistered test.

## 1. The question

Before an agent copies a trade from, or sends money to, a wallet W: using only W's on-chain history up to a stated check time, can a behavioral check tell, better than chance, whether W is about to act against its counterparties?

## 2. Events in scope

The submitted tool is a behavior-break detector. Two kinds of documented events are in scope; each is evaluated separately.

- A1. Takeover: a wallet is drained or taken over by someone other than its owner, documented by an independent source with a public victim address and a public first harmful transaction (t0). The owner or a custodian is the victim. Use case: continuous watch and alert.
- A2. Dump on followers: a wallet that others copy or follow sells or moves a position within hours of its followers buying, documented by an independent source. The followers are the victims. Use case: pre-trade gate.

Out of scope: token-level collapse independent of who bought (target B, section 8) and ordinary market losses.

## 3. Positive cases (events)

A case is accepted only if all of the following hold:

1. An independent public source (post-mortem, incident report or on-chain investigator write-up) describes the event. The radar's own output is never a source.
2. The wallet address and the signature of the first harmful transaction (t0) are public and checkable on chain.
3. At least 20 transactions of the wallet exist before t0, so that a baseline can exist; otherwise the case is recorded as "no baseline" and analyzed separately.
4. The event type is one of those chosen in section 10 and the description names the loss to counterparties.
5. Incidents and clusters. One cause with many victim wallets (for example a key leak in wallet software) is one incident. At most 5 wallets per incident are sampled, chosen by a seeded random draw whose seed and script are recorded before sampling. Results are reported per wallet and per incident (an incident counts as flagged at t0 if at least one sampled wallet is flagged). Sample-size planning in section 6 counts independent incidents, not wallets.

For every case the file records: address, t0, event type, source link, source date, who recorded it and when.

## 4. Comparison cases (non-events)

Ordinary wallets from the same period and activity level as the positives:

- sampled at random from wallets with at least one swap in the 30 days before the sampled time, matched to the positives by history-length bucket and wallet age;
- no known incident in the following H days, checked against the same public sources and on chain (no drain pattern);
- the sampling seed and the sampling script are recorded before sampling.

Target: at least 200 comparison cases.

## 5. Rules that protect the result

1. Labels are collected and frozen before the radar is run on any case.
2. Check time. A1: the radar is run twice: on the history up to and including t0 (the first harmful transaction), which measures whether it flags the break at the moment it happens, and on the history up to t0 minus 5 minutes, which measures whether any earlier signal exists; a case where t0 is the first transaction after a long silence is recorded as 'no pre-signal expected'. A2: the check time is the moment the followers' buys begin, as documented by the source, never later. Comparison wallets: a random time inside the matched window. History after the check time is never given to the radar.
3. Cases found while looking at radar output are not added.
4. The decision rule (what counts as success) is written into a new preregistration section before any case is scored.
5. All cases, sources and scoring output are published, including the cases that make the radar look bad.

## 6. Sample size planning (calculated in advance)

- Sensitivity: for a 95% Wilson interval with half-width at most 0.15 around 0.5, about 43 positive cases are needed (1.96^2 x 0.25 / 0.15^2 = 42.7). With fewer than 30 positives no claim is made.
- Specificity: for a half-width at most 0.05 around 0.9, about 139 comparison cases (1.96^2 x 0.09 / 0.05^2 = 138.3). The plan is 200 or more.
- If fewer than 30 positives are found in the available time, the study is reported as a case series, not as a test.
- The sensitivity estimate above applies to independent incidents; wallets from one incident are correlated and are not counted as independent positives.

## 6b. Measures (fixed before scoring)

- Flag at t0 (A1): the share of cases the radar flags with the first harmful transaction included, with a 95% Wilson interval.
- Loss after the flag (A1, descriptive): the share of the documented loss that occurred after the flag time, computed from public transaction data.
- Earlier signal (A1, descriptive): the share of cases flagged at t0 minus 5 minutes.
- False-alarm rate: the share of comparison wallets flagged at the same decision threshold, with a 95% Wilson interval.
- Decision threshold: fixed in the preregistration before any case is scored; no threshold is chosen from the data.
- Reporting: A1 and A2 are reported separately; fewer than 30 positives in a type means a case series, not a test.

## 7. What this does not claim

- Results would apply only to the kinds of wallets and events sampled; they would not transfer to other chains, to bots and snipers, or to token-level risk.
- Documented incidents are biased toward large and public events. This is recorded as a limitation in the result.
- Historical valuation: the radar normalizes amounts to USD. For old events, historical prices may be missing or approximate. The price source and its date are recorded per case, and cases where a rule depends on prices (for example the large-swap rule) are marked.

## 8. Target B (token collapse), deferred

Token-level outcomes (a frozen buyer account, or a liquidity drop of 90% or more within 3 days) can be labeled automatically, which is what the first test did. They depend mostly on token properties, not on the buyer's behavior. A token module would be evaluated separately, with its own preregistration.

## 9. Why the first test could not answer this question

The first test sampled first buyers of new pools. The radar flagged all 167 resolved cases, so there was no passed group to compare (see docs/RESULT.md and docs/DESIGN-REVIEW.md). The design above samples comparison cases deliberately and fixes the check time in advance.

## 10. Open decisions for the author (to be answered before the next step)

Defaults proposed on 2026-10-14 (to be confirmed by the author):
1. Types: A1 first, A2 only if enough confirmed cases exist.
2. Horizon H = 3 days for comparison wallets only.
3. Sources: see docs/next/cases/SOURCES.md.
4. Time: 1-2 hours per day; the list of cases is frozen by 2026-10-28.
