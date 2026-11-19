# interlinked-verify: test discrimination

Reference for [SKILL.md](../SKILL.md). Read it after a fix, or when a test-discrimination advisory fires.

## Reviewing test discrimination

After a fix, run `interlinked tests fail-before-fix` (optionally `--session <id>`).
This Git/Vitest workflow replays logged edits from HEAD and must reproduce current bytes
before reconstructing pre-session product code. It runs changed tests live and in a
Git-visible temporary copy with linked `node_modules`, plus their old counterparts.
No changed test files produces `no-tests` (exit 0), without a discrimination verdict.
If a selected file has no executed case on either side, or a product file cannot be
reconstructed, the report is unavailable. Whole-run interruption yields no usable rows;
a reported test timeout, product crash or load failure is inconclusive. The presence
check is per file and does not prove that every expected case executed. Only a test's
own failing check demonstrates discrimination. The temporary copy confines supervisor
edits and rejects symlink write targets; arbitrary test code is not OS-sandboxed.

Exit 0 means evidence reported, 2 means unavailable/no session, and `--strict` exits 1
when a new test whose subject changed passes on the old code. Such a test may deliberately
preserve existing behavior; review its purpose before changing it. A negative case must
also isolate its clause: remove the one exemption it names and
the case must fail (a case that another exemption already keeps quiet pins nothing).
To measure that, record the removal as a requirement fault (`clause:<module>:k<n>`) in
`.interlinked/requirement-faults.json`, run `interlinked tests faults run`, then read
`interlinked tests faults clauses`. Write faults without reading the tests they target.

The fault corpus is `{ "version": 1, "faults": [...] }`. Each fault contains `id`,
`requirement: {id, text?, source?}`, confined `path`, exactly-once `find`, `replace`,
`rationale`, nonempty `tests`, and `origin: authored | edit-log | revision`. The Vitest
runner applies one fault at a time to a Git-visible copy. A kill requires a passing
live control and a failing own check under the fault; missing baseline evidence is
inconclusive. `--corpus`, `--ids` and `--timeout` narrow the run. The reported fraction
is killed / (killed + survived); invalid and inconclusive faults are reported separately.
The command is advisory: a surviving fault does not itself set a failure exit code.

`test-runs/faults/latest.json` and `outcomes.json` retain historical results under
`.interlinked/`. Clause joins use `clause:<module>:k<n>`; unmeasured clauses remain
unmeasured. These outcomes lack current source-digest authentication: rerun after code,
tests, clauses or fault recipes change. A perfect fraction covers only recorded faults.

## Test-discrimination advisories in verify

`interlinked verify --all-checks --details` includes fourteen advisory test-discrimination
and isolation checks; default verify omits them. They remain PostToolUse warnings.
Review each finding against the observable contract before editing the test.

- `mock_return_echo`: check whether forwarding the configured value is the contract.
  Negated/throwing evidence is not an echo; coarse values count only with one
  discovered mock target. Literal overlap is a heuristic, not dataflow proof.
- `duplicate_test_body`: compare inputs and setup. Setup comparison includes hooks
  declared after tests and preserves whitespace inside literals.
- `vacuous_loop_assertion`: pin non-emptiness or use a positive assertion count.
  Mapped-array equality pins are recognized; `expect.assertions(0)` is not a guard.
- `spy_without_restore`: use applicable restore hooks, `mockRestore`, `using`, or
  runner `restoreMocks`. Discovery reads default Vitest/Jest configs and literal
  setup paths at the nearest package root; custom config loading is unresolved.
  Fresh objects and array literals owned by a test are exempt. Shared arrays
  still need cleanup; review ownership before adding restoration solely to clear a warning.
- `export_existence_smoke_test`: only imported export presence/type evidence;
  these cases are excluded from `wildcard_in_observable`. Export availability may
  be an intentional compatibility contract.
- `commented_out_assertion`: a real disabled assertion inside an active test;
  prose mentions and code-as-string fixtures are excluded.

In the Interlinked CLI source checkout, reproduce the census with
`npx tsx scripts/scan-test-discrimination.ts [corpus-root] [check-id ...]`.
It reads current contents of tracked JS/TS tests and prints counts plus locations
as JSON. Per-file finding caps apply; zero findings and builder-reviewed samples
do not establish independent precision. AST detectors and duplicate-body setup
comparison require optional TypeScript; its absence yields no detector findings,
not verification.
