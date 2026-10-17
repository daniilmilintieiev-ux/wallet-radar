# Detection target (draft v0)

Status: draft, written on 2026-10-17 in branch `next` before any new data is collected. Nothing here changes the submitted version (tag `submission-colosseum-fall2026`) or the preregistered test.

## 1. The question

Before an agent copies a trade from, or sends money to, a wallet W: using only W's on-chain history up to a stated check time, can a behavioral check tell, better than chance, whether W is about to act against its counterparties?

## 2. What "act against its counterparties" means (target A)

Target A is a break in a wallet's behavior that is followed, within H days (default H = 3), by a loss to the people who copied it or paid it. Two event types are candidates (the author decides, see section 10):

- A1. Takeover: a quiet or ordinary wallet starts moving funds in a way the owner did not intend (drainer or key compromise) and counterparties lose money through it, documented by an independent source.
- A2. Dump on followers: a wallet that is publicly copied sells or moves out a position that followers just bought, within minutes or hours, documented by an independent source.

Out of scope for this target: token-level collapse that does not depend on who bought the token (target B, section 8), and ordinary market losses.

## 3. Positive cases (events)

A case is accepted only if all of the following hold:

1. An independent public source (post-mortem, incident report or on-chain investigator write-up) describes the event. The radar's own output is never a source.
2. The wallet address and the signature of the first harmful transaction (t0) are public and checkable on chain.
3. At least 20 transactions of the wallet exist before t0, so that a baseline can exist; otherwise the case is recorded as "no baseline" and analyzed separately.
4. The event type is one of those chosen in section 10 and the description names the loss to counterparties.

For every case the file records: address, t0, event type, source link, source date, who recorded it and when.

## 4. Comparison cases (non-events)

Ordinary wallets from the same period and activity level as the positives:

- sampled at random from wallets with at least one swap in the 30 days before the sampled time, matched to the positives by history-length bucket and wallet age;
- no known incident in the following H days, checked against the same public sources and on chain (no drain pattern);
- the sampling seed and the sampling script are recorded before sampling.

Target: at least 200 comparison cases.

## 5. Rules that protect the result

1. Labels are collected and frozen before the radar is run on any case.
2. The check time is t0 minus 5 minutes for a positive case, and a random time inside the matched window for a comparison case. History after the check time is never given to the radar. Cases where the harmful act is the first sign of a break are recorded as "no pre-signal".
3. Cases found while looking at radar output are not added.
4. The decision rule (what counts as success) is written into a new preregistration section before any case is scored.
5. All cases, sources and scoring output are published, including the cases that make the radar look bad.

## 6. Sample size planning (calculated in advance)

- Sensitivity: for a 95% Wilson interval with half-width at most 0.15 around 0.5, about 43 positive cases are needed (1.96^2 x 0.25 / 0.15^2 = 42.7). With fewer than 30 positives no claim is made.
- Specificity: for a half-width at most 0.05 around 0.9, about 139 comparison cases (1.96^2 x 0.09 / 0.05^2 = 138.3). The plan is 200 or more.
- If fewer than 30 positives are found in the available time, the study is reported as a case series, not as a test.

## 7. What this does not claim

- Results would apply only to the kinds of wallets and events sampled; they would not transfer to other chains, to bots and snipers, or to token-level risk.
- Documented incidents are biased toward large and public events. This is recorded as a limitation in the result.

## 8. Target B (token collapse), deferred

Token-level outcomes (a frozen buyer account, or a liquidity drop of 90% or more within 3 days) can be labeled automatically, which is what the first test did. They depend mostly on token properties, not on the buyer's behavior. A token module would be evaluated separately, with its own preregistration.

## 9. Why the first test could not answer this question

The first test sampled first buyers of new pools. The radar flagged all 167 resolved cases, so there was no passed group to compare (see docs/RESULT.md and docs/DESIGN-REVIEW.md). The design above samples comparison cases deliberately and fixes the check time in advance.

## 10. Open decisions for the author (to be answered before the next step)

1. Which event types are in scope: A1, A2 or both.
2. The horizon H: keep 3 days or choose another.
3. Which public sources are acceptable as independent.
4. How many hours per week go into collecting cases, and the date by which the study must end.
