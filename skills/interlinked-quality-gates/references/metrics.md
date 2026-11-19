# interlinked-quality-gates: metrics, scoring and evidence workflows

Reference for [SKILL.md](../SKILL.md). Read it for `interlinked metrics` subcommands, scoring, evidence runs and the coverage index.

### Within-repository ranks and commit-risk nudges

Complexity rows and file mass now include `pct`; coupling pairs and rework rows include
`percentile`. Ranks are the rounded percentage of the measured population strictly below
the value, so ties share a rank. They are computed before the displayed top-N slice; coupling
uses pairs surviving its filters, and rework ranks all files with measured old-side lines.
These are within-repository comparisons, not cross-project quality grades.

`metrics complexity` additionally reports hotspots as file cyclomatic mass times changed
lines in the `--churn-days` window. First-parent history is bounded to 2,000 commits and
commits touching more than 30 files are excluded from churn. Directory spread measures
line-count Gini among direct children, with at least three files. These reports are advisory;
an empty hotspot section can mean no usable history rather than no risk.

`metrics jit` reports size, diffusion, history, experience and purpose contributions to a
static versioned score. It is ordinal, never a defect probability. Calibration uses the
repository's recent first-parent history (up to 365 days / 2,000 commits); no population
means an unranked result. A missing commit, empty staged diff or unavailable Git causes
the command to exit nonzero. The commit-time `[interlinked:jit][heuristic]` nudge inspects
the current staged diff and warns at p90 or above. It never blocks and remains silent when
measurement is unavailable. For `git commit -a` or commands that construct the index later,
the staged snapshot is advisory context, not a measurement of the eventual commit.

The commit-time session checks read the files this SESSION edited, not the commit. Since
2026-10-05 three of them — `prod_delta_no_test_delta`, `tpp_leapfrog`,
`reintroduces_removed_code`, whose `file` is the file they judged — are narrowed to the files the
commit captures (`evaluator/commit-file-set.ts`). The scope is used only when git alone makes it
certain: the WHOLE command is one `git commit` (the index) or `git commit -a` (plus tracked edits)
with only message/author/quiet/no-verify-style flags, in the session directory. Any other command
in the same line (`git add`, `git apply --cached`, `cd`), an environment or `git -c` override, a
pathspec, `--amend`, `-p` or a heredoc leaves the scope unknown, and every finding is reported
session-wide. The capped
`reintroduces_removed_code` detector gets the committed files as its INPUT, so unstaged files
cannot use up its result limit. Every other commit-time check is reported session-wide as before,
because its `file` can be an example or a cycle's source rather than the evidence. Errors are
never narrowed.

A second warn-only commit-time backstop, `[interlinked:commit-shippability]`, checks that the
commit would work in a clean checkout. It warns when a staged `.ts/.tsx/.js/.mjs/.cjs/.mts`
file imports a relative file that exists on disk but is untracked or gitignored, and when a
`.github/workflows/*.yml|yaml` `run:` line names a `scripts|src|bin|tools` path that is
ignored, untracked or missing. The workflow scan uses a documented regex, not a YAML parser,
and runs only when the commit stages a workflow or a file under those directories. It inspects
at most 200 staged files and reports any git failure as one `NOT CHECKED` line. It never blocks.

A third warn-only backstop, `[interlinked:commit-coverage]`, echoes the pre-push per-file
coverage ratchet at commit time. A passed coverage run writes `coverage/sources.json` in its run
directory: the sha256 of each file it measured, with its percentages. At `git commit` the gate
hashes each staged product code file (the line-cap scope, at most 50). If a recent run measured
exactly those bytes below `.interlinked/coverage-baseline.json`, the gate names the file and the
metrics. Staged bytes that no run measured get one `NOT MEASURED` line with the command that
measures them (`interlinked tests run --all --coverage`). A match binds the source bytes only,
not the staged tests, so the pre-push ratchet stays the gate. It never blocks.

### Function-token inventory

`interlinked metrics --top 10` shows the stable function bands, percentile summaries, the ten
largest functions, and the ten files with the largest summed function-token counts. `--json`
always includes every measured function and file under `functionTokenMetrics`; `--full` prints
that exhaustive inventory for humans. The default scope is exactly the hard cap's hand-written
product-source scope. `--include-tests` adds test/spec functions as advisory measurements — it
does not make the hard cap apply to tests. Unsupported adapters and unreadable tracked sources
appear under `notMeasured`; they are never reported as zero. Normal output previews up to five
of those gaps with their reasons, while `--full` and `--json` show the complete list. Hand-written
product files with an unrecognized code extension are reported as unsupported instead of silently
disappearing; generated, vendored, declaration, documentation/configuration, markup/data,
dependency/build/binary, scratch, and tool-state paths remain outside the product scope. The
function-token census uses its own broad tracked/unignored discovery pass, so hidden product
source and large source files omitted by the ordinary verify walk are still classified.

Per-file `summedFunctionTokens` is the sum of function measurements, not a unique lexical count
for the whole file. Nested implementations intentionally count once in their own row and again
inside the enclosing function's span, and imports/types/top-level statements outside functions
are absent. Use `maxFunctionTokens` to judge the cap and the summed value to understand the
nested-inclusive function payload carried by a file.

### Model-free scoring and evidence workflows

`interlinked metrics diagnostics` is a separate read-only `interlinked-iterative-js-ts-v1`
profile: union of existing trivial-helper pattern lines and all exact-clone body lines over
token-bearing product SLOC, plus CC × sqrt(innermost-owned function SLOC) mass above CC 10.
JSON retains overlap, redundant clone lines, per-function contributions, source/parser identity,
exclusions and gaps. No target tests, models or new per-edit scans run. Interpret absolute
burdens alongside ratios: unrelated simple code can dilute the denominator. `--profile python`
selects a separate AST/tokenize profile using isolated stdlib Python >=3.10, bounded batches
(eight files, ten seconds each, thirty-second analysis budget). It excludes docstrings and
Python test names, preserves nesting/indentation in clone evidence, and measures an advisory
opposite-boolean-return pattern. The body CC counter is versioned independently of radon;
existing Python edit gates are unchanged. Missing tools, exhausted budgets, unsupported source
and parse failures remain gaps. This limited pattern set is
not benchmark-equivalent, a composite score, a safe-deletion verdict or a new hard gate.
Interactive trivial-helper warnings remain capped; the explicit census is uncapped.
`metrics diagnostics compare` accepts saved reports and refuses incompatible/missing scope;
the older `metrics compare` remains for scores. Save snapshots outside the measured tree so
their files do not change recorded exclusions. `simplify review --diagnostics js-ts|python`
joins candidates to existing scoped review/overlap/recording, with validation still not run. See
`docs/metrics-iterative-diagnostics.md` for the counting contract and pending qualification.

`interlinked metrics score` defaults to the schema-2 `interlinked-slop-v1` composite:
individual structure, file-size, coverage, mutation, test-integrity, redundancy,
type-operation, architecture, correctness and declared-contract measurements.
The profile has a fixed 100-point budget and hashes its measurement revision.
Higher burden is worse. This is an experimental quality policy, not authorship detection.
The report also prints (and `--json` carries as `axes`) two evidence axes over the same
groups: **Stability** (coverage, mutation, test integrity: a change fails a test) and
**Correctness** (correctness detectors, declared contracts). The axes are a grouping; they
change no score. Neither shows that the behaviour is the required one.

Use **syntax tokens** (lexical tokens) in user-facing explanations. AST nodes are
different units. JS/TS uses parser-resolved lexical leaves under `interlinked-code-v2` /
`interlinked-ts-ast-v1`; regexes, templates and JSX follow that contract. Complete
function size includes types and nested functions, while composite exposure excludes
double ownership. The stable `canonicalTokens` field retains counter provenance.
The inclusive 500 syntax-token cap and existing over-limit hold-or-shrink policy are
independent of scoring curves. There is no additional LLM-token cap or model download.
The optional semantic index's `llama-tokenize` path has a separate purpose.

Every reading supplies state, numerator/denominator, eligible/measured entities,
evidence IDs and limitations. States are `measured`, `not-applicable`, `missing`,
`stale`, `unsupported` and `inconclusive`. `observedScore` covers measured weight;
`evidenceCompleteness` is not line coverage. Missing evidence widens `range` and
withholds `slopScore` / `rankingEligible`. Unmeasured source broadens whole-repo
bounds to 0–100. Do not rank provisional reports as complete repository scores.
CRAP and uncovered mutation sites remain diagnostics to avoid overlap.

`--profile structure-v1` retains the schema-1 structural report and its earlier
field names. Select it explicitly for existing consumers. Do not silently compare
different profile hashes, parser revisions, source roles or behavioral policies.
Export-surface correction revision `2026-09-08.2` changes the profile hash;
historical `2026-09-08.1` corpus measurements retain their original identity.

Declared `export` contracts name the module's exported binding, including aliases
and re-exports; use `name: "default"` for a default export. A default function's
local declaration name does not establish a named export. The compiler reads
inventoried project source and its standard library; unresolved export bindings,
re-export dependencies outside that inventory, conflicting exports and malformed
modules remain inconclusive. Unrelated type errors or unresolved ordinary imports
do not erase a provable local export name. This checks the declared export surface,
including TypeScript type exports, without executing the module or proving its behavior.

```bash
interlinked metrics catalog --checks --json
interlinked metrics explain tokens --json
interlinked metrics compare before.json after.json --json
interlinked metrics corpus manifest.json --out scratch/corpus --json
interlinked metrics evidence status --json
interlinked metrics evidence identity --json
interlinked metrics evidence import receipt.json artifact.json --json
interlinked metrics gates --json
interlinked metrics coverage status --json
```

Catalog assigns each registered check/guard a scored, supporting, advisory or
enforcement disposition. A changed registry requires scoring review. Scoring
supports JS/TS; recognized unsupported source remains a gap, even when another
CLI capability supports that language. Generated/vendor/fixture/test roles cannot
pad product denominators. Bare `@generated` comments do not exempt product code.
Only recognized dependency lockfile names and suffixes receive the configuration
role; product filenames containing `lock`, such as `clock.ts` or
`file-mutation-lock.ts`, remain product. Source roles use
`interlinked-source-roles-v2`; composite profile revision `2026-09-08.3` invalidates
older scope and score comparisons.

`types.unsafe` scores unsafe access/call/assertion/assignment/return sites and
reports explicit `any`/`unknown` counts separately. Safe unknown narrowing and
sound widening do not incur penalties. Missing compiler bindings and saturated
detector limits produce inconclusive results. Graph/deletion candidates still
need review for dynamic and external consumers. A surviving mutant is not dead-code proof.

The corpus manifest contains `repositories: [{name,path,commit,stars?,cohort?}]`,
with full Git SHAs, manifest-relative paths and optional `calibration`/`held-out`
cohorts. The command requires clean pinned clones, writes individual reports plus
`corpus.json`, and does not clone, install dependencies, execute target code or
call a model. The source script `scripts/metrics-corpus.ts` delegates to this engine.

Behavioral work is explicit: `metrics evidence run --kind coverage|mutation
--command '<JSON argv>' --artifact <relative-json> --runner-version <version>
--policy <id> [--timeout <ms>] [--resume]`. It runs without a shell in a disposable
copy, binds source/tests/configuration/manifests/locks/support inputs, runner,
outcome and artifact hashes, and supports cancellation. Dependencies must already
exist. Resume requires matching inputs; failed/cancelled attempts cannot be hidden
by older passes. These runs consume CPU time but make no model calls by Interlinked.
An explicitly selected third-party command remains responsible for its own behavior.

Local evidence runs capture the complete inherited environment before asynchronous
work and pass that snapshot to the child process. The receipt stores a digest of
its string entries and Node runtime identity, never raw environment values. Any
environment change, including a feature flag, invalidates `--resume`; absent and
empty values remain distinct. Unchanged environments can reuse matching receipts.
Imported CI receipts continue to assert their own runner environment provenance.

Local `--resume` also requires a digest of the actual disposable workspace inputs,
including Git-ignored runtime files such as `.env`, installed dependency bytes,
relative symlinks and file/directory permissions. The configured output artifact
and control directories omitted by the copy policy are excluded. Raw runtime
configuration is never added to receipts. A cache lookup still copies and hashes
the workspace; this can be substantial for installed dependencies. Copying and
hashing share the execution deadline and the 200,000-entry / 4-GiB workspace
bounds. Unavailable, escaping or unstable inputs cannot produce measured evidence.
The original inputs must match the copy before execution and remain unchanged
afterward; new runner outputs are allowed. Older receipts without the workspace
digest remain readable but cannot satisfy local `--resume`. The normalized
`--artifact` selector is persisted and is part of cache identity: selecting
`a.json` and then `b.json` requires separate evidence even for the same runner;
equivalent relative spellings share one selector.

Local evidence status and scoring revalidate the runtime digest and current
inherited environment before treating a receipt as measured. Changed bytes or
environment make it stale; missing provenance, unreadable inputs or exhausted
validation budgets make it inconclusive. Synchronous reads share a ten-second
validation deadline and hash each artifact selector at most once per store load;
an execution's earlier deadline takes precedence. No raw environment/configuration
values are persisted. Copied ignored directories such as `scratch` and `coverage`
remain inputs, so changing them can invalidate evidence and increase hash cost.
Imported CI receipts retain explicitly asserted provenance rather than claiming
that the local process independently reproduced the CI runtime.

Coverage accepts strict Istanbul maps; mutation accepts source-bound Stryker-style
reports. Missing files remain inconclusive. Timeout/error/ignored outcomes are not
kills, and no-coverage mutants cannot establish assertion discrimination. Imported
CI receipts have asserted provenance and hash integrity, not signed CI attestation
or independent verification of all installed dependency bytes. Artifact and receipt
JSON must be valid UTF-8; malformed bytes make the evidence unavailable.

In this repository, the pre-push gate groups protected ref updates by their exact
pushed revision and unions changed source paths within each revision. New refs or
unknown comparison bases require that revision's full tracked source tree. Each
revision runs in a disposable export; source-changing pushes run the tests once
with coverage there, using a 120-second per-test timeout and JSON summary output.
Working-tree coverage reports and report timestamps never establish freshness.
Distinct revisions get distinct runs, and export failures block the push.

The full pre-push suite remains mandatory. `INTERLINKED_PRE_PUSH_WORKERS=1|2|3|4`
selects a bounded local worker count (default 1); it changes neither test scope nor the
strict coverage ratchet. Use `node scripts/benchmark-tests.mjs` in this repository to
compare 1/2/4 workers on explicit unit and subprocess samples with retries disabled,
elapsed time, failures and sampled process-tree RSS. Add `--full --coverage` for the
actual full coverage workload and `--iterations=3` for repeated measurements. Sample
speedups alone do not establish a safe CI or pre-push default.

The repository's E2E-capable build and deterministic E2E preflight run before that
suite. Malformed baselines, unresolved inventory moves, invalid source maps or unsafe
report destinations therefore fail before unit execution. Preflight is explicitly unmeasured:
the E2E run, merge and strict measured ratchet remain required. Build fingerprints
exclude untracked runtime-state files only when current build-input analysis proves
they are not inputs; tracked files, declaration inputs, copied assets and uncertain
cases remain bound. This does not authorize ignoring runtime files in test receipts.

The gate copies the local coverage baseline into the export and checks that every
changed, previously baselined runtime source is measured in that export's report,
including when other changed files are present. A reporter captures the native
coverage provider's effective inclusion decisions during that same test run;
explicitly excluded files do not become required merely because a retained
baseline still names them. Dynamic configuration is evaluated by Vitest, and
missing scope evidence fails closed. A scope with no remaining runtime targets is
reported explicitly without certifying a coverage pass. Deleted files, test-only paths
and modules containing only explicit type/declaration syntax do not require an
entry. Ordinary imports retain a measurement requirement because compiler options
can preserve their runtime side effects. It then runs
`coverage check --strict --json` on that report and checks the JSON measurement
verdict as well as the exit code. Partial, missing or malformed evidence cannot
certify coverage. The CLI's existing advisory/partial-report exit behavior is
unchanged. Coverage instrumentation increases source-push verification time;
there is no second uninstrumented test run. Working-tree files and reports are
left untouched.

`coverage check --from-index [--index-store <root>] [--timeout <ms>]` (Unit 7,
2026-09-29) is the ratchet over that index instead of a report: only the test
shards whose transitive inputs changed re-run, every other shard's recorded
contribution and the zeroed `@denominators` shard stay, so the summary is
full-shaped and the ratchet can judge it (a report assembled from selected tests
alone reads as partial and certifies nothing). `--index-store` names the checkout
whose `.interlinked/coverage-index/` holds the index, so a disposable pre-push
export measures against the source checkout's index the way `--receipt-store`
reuses its receipts. When the index cannot certify (a failed or unstable shard,
a changed runtime, quarantine, or a missing index whose full warm then failed)
the command exits 75 — no verdict, never a pass — and the `coverage:index`
stage row carries the reason as `reuse_denied_reason`; `reused: true` means no
shard re-ran. The route is ADMITTED like a scheduled test run
(`coverage-index/admission.ts`: the project's heavy-process lease, the
foreground host slot, then a memory budget the capture's child tree is
supervised against — a refused admission is exit 75 with its reason), and a run
that captured shards ACCEPTS its proposal before returning (a proposal the
current bytes no longer match is no verdict). The test child's environment
identity excludes the supervisor's own variables and the shell's working
directory (`PWD`, `OLDPWD`, `INIT_CWD`), so two exports of one revision share
one identity. The pre-push hook runs this route only when explicitly enabled with
`INTERLINKED_PRE_PUSH_COVERAGE_COMPARE=1`, in COMPARISON MODE — after a measured
regression immediately (nothing follows), after a passing verdict LAST, once
e2e and packaging have judged the export (the comparison runs tests in that
export; no authoritative gate reads bytes it could have modified); only a
partial or unmeasured result compares nothing — and appends `{push_sha, full, index, agree}` to
`.interlinked/coverage-index-comparison.jsonl` (`interlinked query
coverage-compare`); it never decides the push, and promotion waits on that
ledger agreeing over recorded pushes (`INTERLINKED_PRE_PUSH_SKIP_COVERAGE_COMPARE=1`
takes precedence and skips it for one push). When enabled, the comparison runs in a DETACHED
background job that owns the export: the push returns as soon as the
authoritative gates finish, the job appends the same row, writes its notes to
`.interlinked/coverage-index-compare.log` and removes the export when done
(`INTERLINKED_PRE_PUSH_COMPARE_FOREGROUND=1` keeps it inline; the hook tests use
that). Indexed checks and warm runs propagate SIGINT/SIGTERM through discovery and
capture; cancellation prevents accepted summary/proposal promotion and exits without
a verification verdict. Measured on this repository (2507 test shards, an
export, 2026-09-30, supervised, one worker — `--workers`, default 1: three
instrumented workers exceeded the 4 GiB tree budget): the first full index
run 1679 s (961 s unsupervised with three workers on 2026-09-29), a re-run of
the same revision from a DIFFERENT export directory 28 s with `reused: true`
(6 s runtime census plus 22 s folding the shard blobs), one edited source line
1035 s with 2506/2506 test files re-run — nearly every test here is OPAQUE and an opaque shard binds
the whole inventory, so on this repository the index buys exact-revision reuse,
not selection, until the opacity backlog is worked down — peak RSS 3.8 GB;
materialization STREAMS
(each shard is persisted and folded as it is read; holding every contribution
at once needed 11 GB), an opaque shard binds the whole inventory through ONE
`@inventory` digest entry, and the indexed capture is worker-capped by the
host governor. The index is 156 MB on disk. Limits: the runtime census that
validates the index walks every file in the checkout except `.git`,
`.interlinked`, generated and tool directories (`coverage-e2e/`, the e2e
lane's own outputs; `node_modules/.vite`, Vite's cache; the index's own
`.interlinked-coverage-capture-*` scratch), so a working tree carrying
gigabytes of probe or eval bulk (`scratch/`, `evals/`) exceeds the 4 GiB bound
and the index cannot be built there — build and measure in an export. A test
file the runner discovers under a fixture directory is inventoried as a test
(roles v3), because the index needs every executed test in the inventory. A
test that writes into the checkout (a fixture-rooted harness run, a learned
permission persisted to the daemon's cwd) makes the runtime "change" during
the run and the index unavailable; the census error names the files. A wholly
skipped test file is a passed, empty shard; a negative implicit-else branch
count from the V8→istanbul converter is 0 hits.

`metrics coverage warm --timeout <ms>` runs full Vitest coverage in an overlay and
initializes an exact per-test-file contribution index. Its scoring receipt remains
explicitly inconclusive: index validation uses its own overlay input policy, not
the workspace identity required by local composite scoring receipts.
Use `metrics evidence run` to obtain that scoring evidence. Warming and index
operations remain available; warming alone does not certify a composite score.
Affected tests replace their previous contribution; untouched shards and zero-hit
denominators remain. Input/configuration/dependency/discovery/runner/environment
changes invalidate reuse. Dependency uncertainty is per importing module and
per shard: a pure shard can remain valid alongside an unrelated opaque I/O shard.
Opaque consumers retain repository-wide source dependencies; opaque shared setup or
configuration widens every shard. Configuration/runtime/discovery identity still
invalidates globally when needed. The same static dependency graph powers
`tests plan/run`; ordinary test-run receipts do not replace coverage contributions.

Coverage-index runtime validation captures a shared original/workspace root once
per validation boundary, comparing that capture with both expected identities.
Distinct overlays still get separate captures, and later validations read fresh
bytes; this is not a time-based cache or a lockfile-only dependency identity.
Proposal promotion checks whether candidate entries exist before scanning source
or runtime inputs. No candidate means no promotion, not a fresh coverage verdict.

A bounded child process uses Vitest's native discovery
to identify executable test files. Both warm and status load the project's Vitest
configuration in that child; status does not execute tests. Helpers, resolved setup
and global-setup files, and configuration dependencies remain invalidating inputs
without being counted as executable shards. Their static import closure is global
support even when filenames otherwise look like product code. Streamed snapshots bind the
actual overlay inputs, including Git-ignored files and linked dependency bytes,
before and after execution. They require a project-root `node_modules` directory
(a verified dependency mount may be linked), allow at most 200,000 entries and
4 GiB per snapshot, and share the command deadline. Vite's bundle directory is
initialized before capture; existing cache contents remain hashed. Unreadable,
unstable or over-budget inputs prevent an authoritative index verdict. Dynamic dependencies widen selection. Unsupported,
multi-project, incomplete-location or ambiguous capture degrades visibly.
A staged generation promotes only after its exact source is on disk. Corruption
prevents reuse; identical-input coverage churn quarantines it until three full
warm runs agree. Do not enable a local gate solely from the small synthetic benchmark.

`metrics gates` reports policy separately from actual execution reach, freshness,
deferred/unavailable attempts and measured latency. Historical ratchet reach is
not test coverage; a disabled gate measures nothing. Use warm/status to establish
local evidence before changing a disabled gate's policy.

`metrics deletions` joins advisory candidates with source-bound behavioral evidence.
`metrics deletions validate plan.json` runs explicit removal trials in isolation,
requiring both baseline and candidate tests plus type checking. A checks-passed
result still requires public-API/runtime review; it does not apply the deletion.
Baseline and candidate phases use separate matching copies prepared before any
check runs. Each phase executes the same ordered checks, so a compiler/build can
produce artifacts consumed by later tests within that phase. Baseline side effects
do not become candidate inputs. Copying and validation share the trial deadline;
changed original runtime inputs make the result inconclusive. This uses two
bounded disposable trees and can increase copy/storage costs.
See `docs/metrics-scoring.md` and `docs/metrics-corpus-2026-09-08.md` for the complete
contract, policies, bounds and pinned empirical artifacts.

`metrics arch` now retains isolated modules in directory and propagation populations. Its existing
`propagation.cost` still uses N² with self excluded from reach. `normalizedReach` uses N(N−1), or
zero for a fully inventoried singleton/empty graph. The JSON identifies `graphVersion: 2`; old and
new node populations are not interchangeable. These are import-reach diagnostics, not proven change
impact or an architecture quality score. Type-only/runtime edge qualification remains separate work.
