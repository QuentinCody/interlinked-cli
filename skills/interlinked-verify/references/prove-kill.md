# interlinked-verify: kill-proof receipts and check evidence

Reference for [SKILL.md](../SKILL.md). Read it with `tests prove-kill` or `tests kill-proofs --verify`.

## Receipt versions, paired examples and check-evidence stores

New proofs use receipt version 2, which binds the expanded target-helper closure.
Version 1 receipts remain readable history but are stale and must be re-proven;
do not upgrade their version by hand. Parameterized families combine evidence per
expanded case name across fresh receipts. Every duplicate of a name must be killed
within one qualifying receipt; complementary duplicate outcomes cannot certify it.

Both versions require a nonnegative safe integer for the baseline case count.
Baseline and mutant-run durations accept finite nonnegative milliseconds, including fractional values.

Use paired examples that distinguish a real violation from similar valid code. In
`test_legitimacy`, import-shaped text inside multiline fixture strings is not a real
private import; an actual import after that fixture still reports its own line.
Mutation-directed receipts must be standalone comments, and a specific rationale may
mention “contract” without being a generic placeholder. Shared behavioral examples can
drive both a detector unit test and a real hook/daemon e2e test: assert the finding and
location in the unit lane, and delivery, severity and transport ownership in the e2e lane.
Neither lane's passing result substitutes for the other. Keep examples and expected
outcomes separate from implementation-derived values so other language adapters can
exercise the same requirement through their own public boundaries.

Check-evidence stores must preserve complete result lists. A corpus record with
missing, non-array, or non-string `hits`, or an adversarial review with malformed
`findings`, is rejected and leaves its obligation unsatisfied. Re-run the scan or
review to replace that record; do not replace unknown results with `[]`. An explicit
empty list from a completed run remains valid evidence of no findings. Corpus
satisfaction also requires a positive integer `files_scanned`; an empty scan or
missing/invalid scan count cannot satisfy the obligation.
