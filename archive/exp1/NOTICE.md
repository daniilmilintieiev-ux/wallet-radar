# NOTICE: Experiment 1 artifacts are invalid — archived, not a reference

The files in this directory (`large-wallets.json`, `simulation-results.json`)
belong to Experiment 1, frozen at git tag `exp1-invalid`. The tag name states
the conclusion: **this experiment is invalid.** It is kept here only as a
historical archive — frozen, unmodified, available for anyone who wants to
inspect exactly what was done and why it doesn't hold up.

## Why it's invalid

- **Labels were overwritten by the radar's own verdicts.** The ground-truth
  labels in this dataset were not sourced independently; they were
  regenerated from the detector's own output (`scripts/calibrate-ground-truth.ts`),
  so comparing the detector against these labels measures the detector
  against itself, not against an external truth.
- **Token/mint state was captured at the moment the script was run, not at
  the date of the historical trade being evaluated.** `freezeAuthority`,
  `mintAuthority`, and `top10Pct` reflect whatever the mint's state was when
  the data was fetched — which can differ arbitrarily from what it was on the
  actual transaction date. `mint.ts` and `history-machine.ts` had (and have)
  no mechanism for historical, point-in-time snapshots; a single snapshot was
  applied to every step of the simulation regardless of date.
- The dataset lives outside git (`benchmarks/` is gitignored in the branch
  this was produced on) — there is no edit history for the labels.
- `simulation-results.json` is not pinned to any specific commit.

## What this means for any address labeled in this data

Some entries in `large-wallets.json` carry a label such as `scam_exploit`.
**This label is not confirmed and is not a finding.** It is an artifact of
the invalid labeling process described above, not an independently sourced
or verified claim. An address appearing with this label in this archive is
**not** an assertion that the wallet's owner committed, participated in, or
is otherwise connected to fraud, theft, or any other wrongdoing. Treat every
label in these files as unverified until shown otherwise by an independent,
cited source.

## Do not use these files as ground truth

Do not use `large-wallets.json` or `simulation-results.json` as a reference,
a benchmark, or an input to any new experiment. Any accuracy, precision, or
recall figures previously derived from this dataset (including published
claims of "100% accuracy," "zero false-positive," or similar) have been
**retracted** and are not supported by this data. See the root
[README.md](../../README.md) ("Status of independent evaluation") and
[docs/PREREGISTRATION.md](../../docs/PREREGISTRATION.md) for the current,
honest status of independent evaluation and the preregistered protocol for
the live run that superseded this experiment.
