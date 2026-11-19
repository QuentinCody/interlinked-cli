# interlinked-harness: opt-in TypeScript history at Stop

Reference for [SKILL.md](../SKILL.md). Read it before you enable `session_tsc_history`.

## Opt-in TypeScript history at Stop

`verification_stop_checks.session_tsc_history` defaults to `false`. Setting it
to `true` appends advisory context only when the existing unverified-code Stop
warning already fires. It reads up to the final 8 MiB of this repository's
`.interlinked/check-results.jsonl`, using only the same session's executed
TypeScript outcomes strictly before Stop and within the preceding hour.
At least three valid runs and `(finding runs + 1) / (runs + 2) >= 0.5` are
required; the latest valid run must still report a finding. Counted outcomes
must carry a nonempty invocation ID; repeated IDs count only once. Missing, skipped,
deferred, timeout and process/resource failure evidence does not count as a
clean run. A later no-reported-findings result suppresses the addendum.

This is a reported-finding history hint, not proof of full compile failure or
success, not a per-edit risk score, and never a hard block. It does not change
the TypeScript scheduler. Partial or unavailable log history can suppress the
hint. Continue to use actual verification evidence for the final outcome.
