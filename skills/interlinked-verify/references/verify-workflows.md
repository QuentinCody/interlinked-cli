# Verification workflows

### Verify writes observed outside tool gates

`interlinked harness coverage status --json` shows all pending exact file identities,
watcher readiness and bounded recent check/review receipts with explicit history counts. Run
`interlinked harness coverage verify --json` to check the pending versions through
the daemon's configured PostToolUse checks; `--no-wait` starts the job and returns.
Polling status reports progress. A completed job can still contain findings or
unmeasured versions. Missing files, excluded paths, deferred checks and concurrent
changes do not gain a clean verdict. Receipts enumerate the checks actually run;
they do not certify PreToolUse enforcement or approve a baseline rewrite.

For an explicitly reviewed absence or other manual disposition, use
`harness coverage acknowledge <id> <generation> <identity> <evidence>` with the
current status values and a concrete review record. This records manual review,
not a test pass. Stale identities/generations are refused. If a mutation's response
is lost, inspect status before retrying. Never blanket-acknowledge pending entries
to silence the warning. Policy acceptance is a separate explicit action.
- **Verify-after-edit:** make edits → `interlinked verify` → fix `[proven]` findings first, then
  triage `[heuristic]`. Read the output; don't rely on `$?`.
- **Pre-flight a risky change:** build a changeset → `interlinked verify-changeset --file cs.json
  --json` → fix until `ok:true` → submit as `write --batch` (or real edits, exporter-first).
- **Cross-file rename:** author all files → one `write --batch` with `{writes:[exporter,
  …importers]}` → single gate pass, no transient tsc error.
- **One-off script:** `interlinked scratch init` (once) → write under `scratch/<date>-<slug>/`.
- **Mutation-directed test review:** add a per-case `test-contract` receipt → run
  `interlinked verify --all-checks --details` → resolve `test_legitimacy` together with the
  existing assertion/mock/hermeticity findings → formally remeasure the source file. A killed
  mutant is necessary evidence for that campaign, not proof that the test protects a real contract.
