# Branch `next`

Work after the Colosseum submission. `main` is the submitted version (tag `submission-colosseum-fall2026`) and is not changed until the jury decision (expected mid-to-late November 2026).

Rules for this branch:
- The preregistered test, its protocol and its result (docs/PREREGISTRATION*.md, docs/RESULT.md, tags shadow-v3, outcomes-v1, analysis-v1, sensitivity-v1) are not edited here.
- The deployed services on the board keep running build 2dc3e37 until the jury decision.
- Work is documented before it is run: any new test is preregistered before data is collected.

Planned order:
1. One page: what exactly do we detect (wallet behavior break, or token collapse).
2. Labeled cases: documented incidents with independent sources and a comparison set of ordinary wallets.
3. Fixes for the known weaknesses (docs/DESIGN-REVIEW.md, docs/KNOWN-ISSUES.md).
4. A new preregistered test with sample size calculated in advance.

Current step: collecting candidate incidents (docs/next/cases/). Next: find primary sources and public victim addresses for C-001 and C-002.
Sampling INC-2022-08-SLOPE: rules fixed in docs/next/cases/SAMPLING-INC-2022-08-SLOPE.md before any on-chain check.
