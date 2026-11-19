# interlinked-quality-gates: lint debt adoption

Reference for [SKILL.md](../SKILL.md). Read it before `interlinked lint import` on a legacy repo.

## Lint debt adoption

Existing lint debt has its own adoption flow: `interlinked lint import` previews
recognized configs; `lint import --write --baseline` enables the imported check
and seeds `.interlinked/lint-baseline.json` from a complete analyzer batch.
`lint check --update-baseline` may seed previously unadopted scopes; existing
allowances only shrink. Complete ordinary checks and PostToolUse batches retire
resolved allowances automatically. Missing tools, malformed output, timeouts,
or changed config never count as fixes and never update the baseline.

Native analyzers and declared SARIF adapters participate in the same ratchet.
Named ESLint profiles are discovered automatically as audit candidates.
Use repeatable `lint import --eslint-config <file>` for named configs; optional
`--eslint-scope <directory>` chooses their working scope. Re-import retains those
selections and refreshes digests without requiring the flags again. A selected
config that disappeared must be restored; it is never silently unenforced.

The baseline is a multiset of fingerprints keyed by tool/scope/config/targets/flags, file, rule,
message and trimmed source line. It tolerates line movement and counts duplicate
occurrences; identical-line relocation/replacement is ambiguous, so do not treat
matching as an AST identity proof. Added/increased allowances within adopted scopes
and deleting scope history are covered by the shared baseline integrity guard.
First adoption of another scope retains all existing scope history. The reader
uses recorded trusted bytes while a detected loosening awaits restoration. Keep original
lint configs/dependencies; conversion preserves their analyzer semantics.
Default entries keep their original `tool:scope` keys. Explicit/invocation profiles
use separate identities, so multiple configs in one scope cannot share allowances.
Use **interlinked-verify** for the command contract and review-list limitations.

PostToolUse and ordinary verify measure hook profiles; `lint check` and
`verify --all-checks` also measure audit profiles. Skipping an audit profile in a
hook never retires its debt. `lint import --cadence hook|audit` changes scheduling
without changing baseline identity. Re-import retains saved cadence. SARIF analysis
failures, error notifications and stale/out-of-project locations cannot retire debt.
