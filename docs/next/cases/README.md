# Case list rules

1. One row per event. event_type is A1 or A2 (see ../DETECTION-TARGET.md).
2. status is candidate, accepted, allegation or rejected. A case is accepted only if an independent public source names the wallet and t0 and t0 can be checked on chain. A candidate with only secondary sources is never promoted to accepted.
3. Allegations that the source itself says cannot be established from on-chain data are recorded as allegation and are not positives.
4. reported_loss_usd_as_stated copies the figure given by the source; it is not recomputed.
5. The radar is not run on any case until the list is frozen (date in DETECTION-TARGET.md section 10). Cases found after the freeze are not added.
6. The radar's own output is never a source.
7. Every rejected case keeps its row with the reason.

Pilot results (docs/next/cases/PILOT-RESULT-INC-2022-08-SLOPE.md) are descriptive counts of five sampled wallets. They are not a test and are not used to tune any rule.
