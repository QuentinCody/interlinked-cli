# Kill-proof census: `src/harness/project-e2e/`, `src/harness/structure/`, `src/harness/trajectory/`

Run 2026-11-05 in a cloud session (branch `cloud/census-e2e-structure`, base `origin/mutation-proof`),
Node v22.23.4, vitest 4.1.11, linux-x64. Every fault is an explicit `--file/--find/--replace`, run from
source: `npx tsx src/index.ts tests prove-kill … --test <companion> --json`. Format follows
`kill-proof-census-harness.md`; the modules there (including `trajectory/session-rework`) were skipped.

Selection: 40 distinct modules (13 under `project-e2e/`, 15 under `structure/`, 12 under `trajectory/`),
each ≤ 400 lines, with a companion `<module>.test.ts` and no existing `.mutation-kill.test.ts`. "Pure or
near-pure" was applied as: no network, no child processes, no `fs` writes on the mutated path. Three
modules carry an `fs` READ or a write in a sibling function the fault never reaches (`ledger.ts` has the
`appendE2eTxn` writer beside the pure reducer the task names; `reconcile.ts` reads the ledger;
`browser-stage.ts` reads `package.json` and imports the proxy, while the mutated `structuredCase` is pure).
Excluded for impurity: `policy-base`, `cohort`, `evaluate`, `generation`, `stability`, `receipt`,
`scheduler`, `target`, `attempts`, `requests`, `fingerprint-archive`; for size: `policy.ts`, `types.ts`,
`ltl/eval.ts`, `obligation-inventory.ts`. One fault per module, authored after reading the module and
grepping the companion for the behaviour (a prediction that it escapes), never after running it; every
fault FLIPS A VERDICT or an emitted value (a reason code, a gate rank, a determinism tag, a refusal).

## Census

| | Count |
|---|---|
| survived | **38/40** |
| killed | 1/40 (#19 `env-key-companions`: the companion's "across docs, tests, and examples" case holds an untouched TEST companion) |
| inconclusive | 1/40 (#37 `ltl/rules`: see below) |
| unavailable | 0 |
| strict equivalents among survivors | 0 → survivor rate stays 38/40 (95%) |

#37 is a real detection the proof rule cannot credit: the fast-check property `P5: parity holds on random
recorded-shaped traces` fails under the mutant (`Error: Property failed after 37 tests`), but fast-check
throws that error from `node_modules`, so `fail-before-fix/classify.ts:30 failedByOwnCheck` sees a frame
outside the test file and reports `inconclusive`. A property-based test that detects a fault is therefore
never a `killed` case under the current rule. Counting it as detected gives 37 survivors of 39 decided.

Equivalence review (each survivor was checked for an input that separates the two sides):
- No strict equivalent. #26 `structure-formatter` (`> 0` → `>= 0`) prints a `required follow-ups:` header
  with no items — observable, cosmetic. #15 `artifact-graph` (companion dedupe dropped) lists a companion
  twice when two edges reach it. #17 `bounded-walk` (`return !budget.truncated` → `true`) is observable
  only AFTER a deadline trip: the next extractor sharing the budget in `runAllExtractors` keeps walking
  until the next 512-entry clock check — the shared-budget defence the module exists for.
- While reviewing #14 `adoption.ts:59` I found a dead branch: `if (!hasConfigFile && declaredCount === 0)
  return 0.0` is unreachable in effect, because the fall-through `clamp(0 / extractedCount)` is also 0.
  Any mutation of that condition is equivalent; the census fault was placed on the `declaredCount` filter
  instead and survives (an `inferred` node counts as declared).

Companion-scope caveat: #04 `qualify.ts` (`seen.status >= 500` → `> 500`) survives `qualify.test.ts` but
`qualify.mutation.test.ts` (an existing, non-companion mutation suite) kills it — receipt
`9097687cc308910b`, case "browser boundary the required operation must be answered below 500: 499 counts,
500 does not". The census measures companion tests, as specified, so #04 is counted as a survivor and was
NOT given a new file.

## Per-module table (companion test)

| # | Module | Line | Fault | Verdict | Exit | Killed/cases | Receipt | Wall ms |
|---|---|---|---|---|---|---|---|---|
| 01 | `harness/project-e2e/policy-stability.ts` | 18 | runs cap boundary: 5 refused | survived | 1 | 0/2 | `bbae84e03602a467` | 9143 |
| 02 | `harness/project-e2e/policy-primitives.ts` | 37 | interior .. segment no longer refused | survived | 1 | 0/2 | `3167d45364727921` | 11555 |
| 03 | `harness/project-e2e/policy-suites.ts` | 42 | service env placeholder check dropped | survived | 1 | 0/3 | `d24725d6e197fcea` | 9119 |
| 04 | `harness/project-e2e/qualify.ts` | 165 | a 500 answer establishes the browser boundary | survived | 1 | 0/16 | `2b9fd46da8137a67` | 9599 |
| 05 | `harness/project-e2e/reconcile.ts` | 83 | already-pending obligation dropped from affected (C6) | survived | 1 | 0/12 | `ccee059df157a58e` | 9485 |
| 06 | `harness/project-e2e/ledger.ts` | 69 | cohort verdict for another generation applied | survived | 1 | 0/9 | `3f3c517e8d88ec94` | 9938 |
| 07 | `harness/project-e2e/expectations.ts` | 51 | edited-without-re-proposal check (R6) dropped | survived | 1 | 0/11 | `664bc1c946cff4f6` | 9919 |
| 08 | `harness/project-e2e/stop-summary.ts` | 43 | every -> some: mixed set becomes a handoff | survived | 1 | 0/5 | `0bd1653415e5bc36` | 8742 |
| 09 | `harness/project-e2e/structured-report.ts` | 90 | lowercase doctype accepted | survived | 1 | 0/10 | `ea1476a1cd8957dd` | 9554 |
| 10 | `harness/project-e2e/playwright-report.ts` | 61 | empty projectName yields a ' []' id suffix | survived | 1 | 0/5 | `6f61e837e9e20213` | 9129 |
| 11 | `harness/project-e2e/quality-feedback.ts` | 16 | Go test files never inspected | survived | 1 | 0/5 | `95ae9f2b2b673300` | 9250 |
| 12 | `harness/project-e2e/policy-diff.ts` | 20 | warn/advisory -> off no longer a weakening | survived | 1 | 0/8 | `f61a51cea888332d` | 10043 |
| 13 | `harness/project-e2e/browser-stage.ts` | 37 | skipped native case passes | survived | 1 | 0/8 | `155180b4b5d13c8b` | 10011 |
| 14 | `harness/structure/adoption.ts` | 55 | inferred nodes counted as declared | survived | 1 | 0/14 | `b915d3e3a7314d0e` | 9076 |
| 15 | `harness/structure/artifact-graph.ts` | 126 | companion dedupe dropped | survived | 1 | 0/24 | `bca6758bcbd5dd25` | 9497 |
| 16 | `harness/structure/baseline.ts` | 71 | dedupe key ignores determinism | survived | 1 | 0/7 | `7110a1644f51a116` | 8826 |
| 17 | `harness/structure/extractors/bounded-walk.ts` | 81 | walk resumes after a deadline trip | survived | 1 | 0/22 | `ba05147d2255683f` | 23428 |
| 18 | `harness/structure/rules/config-key-companions.ts` | 38 | inferred finding tagged fully_deterministic | survived | 1 | 0/4 | `71f754dc4b98847a` | 14547 |
| 19 | `harness/structure/rules/env-key-companions.ts` | 24 | test companions ignored | killed | 0 | 1/8 | `8b54b594ceaf9b96` | 12997 |
| 20 | `harness/structure/rules/layer-boundary.ts` | 57 | proven finding tagged heuristic | survived | 1 | 0/5 | `4f0f33a62003a37a` | 9065 |
| 21 | `harness/structure/rules/package-boundary.ts` | 51 | affected file names the importer | survived | 1 | 0/5 | `eff5eb6f97bd5b3a` | 9306 |
| 22 | `harness/structure/rules/public-symbol-companions.ts` | 24 | test companions ignored | survived | 1 | 0/6 | `166bcbd47dc9a5d3` | 8872 |
| 23 | `harness/structure/rules/index.ts` | 86 | heuristic findings sorted first | survived | 1 | 0/12 | `95542954f7d08889` | 9626 |
| 24 | `harness/structure/schema-validator-helpers.ts` | 47 | mixed array passes isStringArray | survived | 1 | 0/43 | `2edea9f33577f063` | 9091 |
| 25 | `harness/structure/schema-validator-artifacts-layers.ts` | 40 | 160-char reason refused | survived | 1 | 0/9 | `698eb639cf34f45b` | 9330 |
| 26 | `harness/structure/structure-formatter.ts` | 47 | empty follow-ups header printed | survived | 1 | 0/5 | `550b12b396be8d37` | 8945 |
| 27 | `harness/structure/structure-loader.ts` | 50 | malformed structure.json reported implicit | survived | 1 | 0/12 | `4c154aa6f7b7ed26` | 9720 |
| 28 | `harness/structure/rules/public-symbol-test-case.ts` | 139 | foo_x counts as a reference to foo | survived | 1 | 0/11 | `34736d747b879ab4` | 9056 |
| 29 | `harness/trajectory/index.ts` | 87 | LTL shadow verdicts dropped | survived | 1 | 0/7 | `ecdb957f9ecafabb` | 9853 |
| 30 | `harness/trajectory/ltl/read-set.ts` | 17 | third nesting level not recorded | survived | 1 | 0/6 | `88b25d7748e367da` | 9302 |
| 31 | `harness/trajectory/ltl/shadow.ts` | 34 | negated atom rendered positive | survived | 1 | 0/6 | `26e32e560b9b5650` | 9382 |
| 32 | `harness/trajectory/rehydrate.ts` | 36 | empty path seeds a read | survived | 1 | 0/6 | `19c0534bc5d4cc5c` | 9961 |
| 33 | `harness/trajectory/retrieval-cost.ts` | 41 | NotebookRead charged as an edit | survived | 1 | 0/11 | `9330bbe8873cdfe2` | 8810 |
| 34 | `harness/trajectory/rules-obligations.ts` | 75 | stop inventory severity lowered | survived | 1 | 0/17 | `a8a948028f109020` | 9356 |
| 35 | `harness/trajectory/ltl/formula.ts` | 113 | bound 1 means unbounded | survived | 1 | 0/9 | `213cfc894cd8a45e` | 8749 |
| 36 | `harness/trajectory/ltl/residual.ts` | 159 | refuted safety obligation reads true under weak leaning | survived | 1 | 0/7 | `bf623b5b8af3fc3e` | 8957 |
| 37 | `harness/trajectory/ltl/rules.ts` | 54 | searches no longer orient the session | inconclusive | 2 | 0/11 | `299c1e776fd08d98` | 7881 |
| 38 | `harness/trajectory/rules-verification.ts` | 70 | 24-edit streak threshold dropped | survived | 1 | 0/43 | `152da1391b61c85a` | 9527 |
| 39 | `harness/trajectory/state.ts` | 92 | serving event clears grew-disabled_rules evidence | survived | 1 | 0/63 | `e872c74caf44d842` | 9344 |
| 40 | `harness/trajectory/rules-security.ts` | 150 | post-commit hook backdoor not caught on git commit | survived | 1 | 0/72 | `88b3b62c091ee88f` | 9859 |

## The 10 new mutation-kill files (most consequential survivors)

Chosen for consequence: a path-confinement escape (#02), two false passes in the e2e evidence chain
(#06 a stale cohort attached to a newer generation, #13 a skipped native case recorded as passed), an
acceptance of an expectation edited in place (#07), XML entity machinery admitted by letter case (#09),
a gate turned OFF no longer a policy weakening (#12), a malformed `structure.json` reported as "no
structure.json" (#27), a refuted safety obligation reading true at Stop (#36), and two security evasions
(#39 a served event wiping the grown-`disabled_rules` record, #40 a `post-commit` hook backdoor not
blocked by `git commit`). Every case is preceded by `// test-contract:`. All 18 cases pass on unmutated
code (`npx vitest run <10 files>`: `Test Files 10 passed (10)`, `Tests 18 passed (18)`, 1.15 s), and
`npm run typecheck` exits 0.

| Fault | New test file | Verdict | Exit | Killed cases | Receipt | Baseline ms | Mutant ms | Wall ms |
|---|---|---|---|---|---|---|---|---|
| 02 | `harness/project-e2e/policy-primitives.mutation-kill.test.ts` | killed | 0 | 1/2: "relativePath — a parent segment anywhere in the path escapes confinement refuses a path whose interior segment climbs out of the project" | `8deb7e85d996b336` | 761 | 784 | 10171 |
| 06 | `harness/project-e2e/ledger.mutation-kill.test.ts` | killed | 0 | 1/2: "reduceE2eLedger — cohort rows bind to their own generation does not attach a cohort verdict recorded for an older generation to the current obligation" | `f6e2ccd7fd8eb420` | 900 | 791 | 9183 |
| 07 | `harness/project-e2e/expectations.mutation-kill.test.ts` | killed | 0 | 1/1: "acceptExpectation — a record edited without re-proposal refuses to accept a proposed record whose statement was edited in place, even against the recomputed revision" | `c6123e8e11e3a4f7` | 935 | 1004 | 13341 |
| 09 | `harness/project-e2e/structured-report.mutation-kill.test.ts` | killed | 0 | 2/2: "parseJUnitXml — entity machinery is refused in any letter case refuses a lowercase <!doctype> declaration with an internal entity subset"; "parseJUnitXml — entity machinery is refused in any letter case refuses a mixed-case <!DocType> declaration" | `05503e6569c4d7cc` | 784 | 913 | 14750 |
| 12 | `harness/project-e2e/policy-diff.mutation-kill.test.ts` | killed | 0 | 2/2: "comparePolicies — turning a gate OFF is a weakening from every lower level too reports gate-loosened when a warn commit gate becomes off"; "comparePolicies — turning a gate OFF is a weakening from every lower level too reports gate-loosened when the default warn stop gate is turned off" | `6c1c4c6ac09863dd` | 1010 | 1034 | 12532 |
| 13 | `harness/project-e2e/browser-stage.mutation-kill.test.ts` | killed | 0 | 1/2: "structuredCase — a skipped or todo native case is never a pass maps a skipped report case to an unavailable receipt case that says so" | `4284e69e3df02102` | 872 | 862 | 9677 |
| 27 | `harness/structure/structure-loader.mutation-kill.test.ts` | killed | 0 | 1/1: "loadStructureConfig — a present but unreadable structure.json is not implicit minimal mode reports implicit=false with a parse error when structure.json is malformed JSON" | `c96eea0f6c5cf085` | 874 | 830 | 9539 |
| 36 | `harness/trajectory/ltl/residual.mutation-kill.test.ts` | killed | 0 | 2/2: "endOfResidual — the weak leaning only lifts UNKNOWN safety obligations keeps a refuted always false under the weak leaning"; "endOfResidual — the weak leaning only lifts UNKNOWN safety obligations keeps a refuted release false under the weak leaning" | `b1c9ee029a7cc80a` | 781 | 714 | 9401 |
| 39 | `harness/trajectory/state.mutation-kill.test.ts` | killed | 0 | 1/2: "applyEvent — a serving daemon disproves an outage, never a weakened policy keeps the grew-disabled_rules record after an event the daemon served" | `ba5d9d32a51c115c` | 968 | 847 | 9578 |
| 40 | `harness/trajectory/rules-security.mutation-kill.test.ts` | killed | 0 | 1/2: "sec_git_hook_backdoor — every hook a git commit fires is in the commit group blocks a git commit after a post-commit hook was given an egress sink" | `5185d20f055a6f59` | 1037 | 861 | 9824 |


10/10 killed. Where a second case does not kill the fault (#02, #06, #13, #39, #40) it pins the other side
of the same boundary on purpose and is reported per case as `survived`.

## Timing (51 proofs: 40 census + 10 new-test + 1 scope check)

End-to-end wall time per `prove-kill` invocation over the 50 census + new-test runs: **min 7881 ms,
median 9497 ms, max 23428 ms**, total 505.8 s. Inside vitest each run takes 0.6–1.1 s except #17
`bounded-walk` (3.6 s baseline, 9.5 s under the mutant: its filesystem-walk integration cases), which is
also the wall-time outlier (23.4 s). #18 (14.5 s wall, 0.8 s inside vitest) has no identified cause. No
other process ran during the census or the re-proofs; `npm run typecheck` ran only afterwards.

## Product defects / observations

1. `src/harness/fail-before-fix/classify.ts:30` (`failedByOwnCheck`, shared by `tests prove-kill`): a
   fast-check property failure is thrown from `node_modules/fast-check`, so the first frame is never the
   test file and a genuine detection (#37, `ltl/rules.test.ts` P5) is `inconclusive`. Property-based tests
   cannot earn a kill today. Not fixed here (out of scope); the rule should recognise fast-check's
   `Property failed after N tests` error (or any error whose cause chain reaches the test file) as the
   test's own check.
2. `src/harness/structure/adoption.ts:59`: dead condition, see the equivalence review. Not a behavioural
   bug; it hides a mutation and should be removed or made to mean something.

## Three worst gaps

1. `trajectory/state.ts` (#39): nothing pinned that `harnessServing` clears only an OUTAGE claim. Under the
   mutant the first served event erases the `grew disabled_rules` record, so
   `sec_harness_disable_then_guarded_op` can never fire on the exact weakening it was written for. 63
   companion cases, none with a served event.
2. `trajectory/ltl/residual.ts` (#36): the weak leaning is meant to pass only UNKNOWN safety obligations;
   the companion pins unknown → true and false → false through `implies`, but never a refuted `always` /
   `release` body under `weak`, so a violated safety property reads "true" at Stop — a silent pass in the
   one place the module's header says there must never be one.
3. `project-e2e/policy-diff.ts` (#12): the only gate transition pinned is `require → warn`; `off` ranking
   equal to `warn` makes every `warn → off` / `advisory → off` transition (including the default Stop
   reminder being silenced) invisible to `check --base`, the §13 weakening gate.
