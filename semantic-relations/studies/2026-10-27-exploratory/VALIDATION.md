# Implementation validation

Validation ran in `/Users/quentincody/interlinked-cli`, the actual source checkout. The
chat's plan-only workspace at `Documents/ChatGPT/interlinked-cli` is not the code checkout.
Existing unrelated worktree changes were preserved. No commit, PR or deployment was made.

| Check | Result |
| --- | --- |
| Focused graph, decision-metrics and relation registrar tests | 52 files, 217 tests passed after accounting and opaque-fixture-ID fixes |
| Full repository suite, `npm test -- --maxWorkers=2` | 2,950 files passed, 5 failed, 2 skipped; 65,815 tests passed, 10 failed, 4 expected failures, 13 skipped |
| Production build | Passed |
| Stable TypeScript check, source and landing | Passed |
| Generated CLI/docs checks | Passed; existing 57-day-old landing `data_as_of` warning remains |
| Three affected source skills | Validator passed for interlinked, interlinked-quality-gates, interlinked-semantic-index |
| Whitespace/diff check | Passed |
| Executable mechanism fixtures | All 16 passed |
| Before/after behavioral controls | All 4 passed |
| H isolation canary | Passed with empty tool/MCP inventory; outside-packet secret not disclosed |

The full suite is **not green**. Remaining failures are in these existing areas:

- `src/harness/background-job.integration.test.ts`: worker heap expectation.
- `src/harness/project-compiler-gate.test.ts`: symlink alias cleanup (`EISDIR`).
- `src/harness/project-compiler-lock.test.ts`: symlink alias cleanup (`EISDIR`).
- `src/harness/test-execution.integration.test.ts`: four configured worker-heap cases.
- `src/harness/evaluator/staged-snapshot.integration.test.ts`: three symlink repoint cases (`EEXIST`).

These files are outside the semantic-relations changes; some belong to other in-progress
work in this checkout. No clean-baseline run was performed, so this document does not claim
to have proven every failure pre-existing. Two integration findings uncovered earlier in
this task were fixed: public CLI flag coverage and append-writer boundary inventory. The
final full run has no semantic-relations failure. The final accounting/fixture changes
were subsequently covered by the focused passing suite rather than another full rerun.

The paired workflow was tested through plan creation, freeze, assessment of both revisions,
comparison and artifact validation. Coverage includes bounded historical ancestry, missing
candidate selectors, complete group identity, packet/source tampering, failed after-side
results, model/contract identity, budgets/canary accounting, cache reuse before admission,
whole-snapshot invalidation, legacy record reads, exact interval boundaries and packaged
source-closure resolution. This establishes mechanics, not model judgment accuracy.

The final packaged CLI successfully loaded the contract catalog and created a new freeze
from the neutral-fixture bundle. A read-only cross-check confirmed identical J/H request
objects for all 428 paired A, B, original-fixture and targeted cases. All 444 retained H
assessment envelopes in those runs plus the neutral-fixture control pass the final strict
cost/token validation. An independent Astra review verified the accounting and fixture-ID
fixes with no remaining findings in that review's scope.
The final artifact sweep validated all 25 input bundles and 23 result bundles, including
the neutral controls and repeated C measurements, without model calls.

Local detailed logs are retained in `scratch/semantic-relations-implementation/`:
`final-full-test.log`, `final-focused-neutral.log` and `final-build-neutral.log`.
