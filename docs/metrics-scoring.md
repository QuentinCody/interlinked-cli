# Deterministic code-quality scoring

`interlinked metrics score` reports individual measurements and an explained
0–100 slop score under the experimental `interlinked-slop-v1` profile. Higher
means more measured burden. It measures code characteristics, not authorship.
Interlinked makes no model calls to calculate these metrics. Static scoring
does not execute repository scripts; behavioral measurements explicitly run tests.

## Commands

```bash
interlinked metrics score --json > score.json
interlinked metrics catalog --checks --json
interlinked metrics explain tokens --json
interlinked metrics compare before.json after.json --json
interlinked metrics evidence status --json
interlinked metrics gates --json
interlinked metrics deletions --json
```

All accept `--cwd <path>`. Catalog inventories metrics and every registered inline,
external, structural, suggestion, behavioral, sequence, spec-ledger and command
guard. Each check is classified as scored, supporting, advisory or enforcement.
A session guard is not added to repository burden merely because it exists.
Registry changes invalidate ranking until their scoring disposition is reviewed.

`metrics score --profile structure-v1` preserves the earlier schema-1 structural
report. The default report is schema 2 and uses `rankingEligible`. Consumers of
the earlier `rankEligible` field should select that legacy profile or migrate
explicitly. Existing top-level `metrics`, `metrics complexity`, `metrics arch`
and the `canonicalTokens` inventory field remain available.

## Reading scores and missing evidence

Every metric carries its raw value, numerator, denominator, burden score,
eligible/measured entity counts, evidence IDs and limitations. Burden curves are
piecewise linear between the catalog's knots. For function size, 150 syntax tokens
has zero burden, 300 has 20, 500 has 50, and 1,000 has 100. These are scoring-policy
points, independent of the 500-token edit cap. Function scores combine exposure
and tail burden; exclusive ownership avoids charging nested syntax repeatedly.

| State | Meaning |
| --- | --- |
| `measured` | The declared measurement completed for its eligible scope. |
| `not-applicable` | The declared metric has no applicable opportunities. |
| `missing` | Required evidence was not supplied. |
| `stale` | Evidence does not match current inputs. |
| `unsupported` | No suitable measurement adapter is available. |
| `inconclusive` | Partial results or execution limitations prevent a complete measurement. |

`observedScore` summarizes measured scoring weight. `evidenceCompleteness`
reports how much applicable weight was measured, not test coverage.
`range` gives missing-evidence bounds under the profile. Unmeasured source or
incomplete discovery broadens whole-repository bounds to 0–100.
`slopScore` remains null and `rankingEligible` remains false until all applicable
scoring evidence is complete and no integrity/review blocker remains.
Unknown evidence is never silently converted to a clean score or zero coverage.

For complete evidence, the composite is the weighted mean of applicable group
scores. Not-applicable weights are removed; missing weights are retained as
uncertainty. The fixed budget is:

| Group | Points | Combination |
| --- | ---: | --- |
| Function structure | 20 | Cyclomatic, cognitive, syntax size and Halstead difficulty |
| File size | 10 | Physical lines and executable syntax outside functions |
| Coverage | 15 | Lines 30%, branch outcomes 50%, functions 20% |
| Mutation | 15 | Surviving / (killed + surviving) mutants |
| Test integrity | 10 | Unique affected test cases |
| Unreferenced code | 5 | Maximum of declaration and disconnected-module burdens |
| Duplicate implementations | 3 | Repeated exclusive syntax after retaining one representative |
| Overwritten initial values | 2 | Dead-store candidates |
| Unsafe types | 5 | Unsafe operations and unchecked assertions |
| Import graph | 5 | Maximum of cycle and propagation burdens |
| Declared import boundaries | 2 | Violating resolved edges |
| Correctness/security | 5 | Reviewed findings per affected executable statement |
| Declared contracts | 3 | Failing evaluated assertions |

CRAP and uncovered mutation sites remain diagnostic to avoid counting their
underlying complexity/coverage evidence again. Related findings share bounded
groups. `metrics explain <id>` provides the precise current curve, denominator,
group rationale, findings and a counterfactual improvement estimate.

Comparison requires compatible profile hashes, reviewed registries, language
cohorts, selected behavioral policies and complete evidence. Provisional reports
may expose individual measured metric deltas, but have no composite ranking delta.
Measurement revisions are included in the profile hash; do not compare old parser
or adapter results as though they used identical measurements.

Revision `2026-09-08.2` resolves declared export contracts against module export
names: export lists, aliases and re-exports count, while a named default function
only establishes `default`. TypeScript type exports remain part of this declared
surface. Unresolved export bindings, conflicting exports and missing re-export
source remain inconclusive; unrelated semantic errors do not hide a known local
export. Analysis shares a compiler program and reads inventoried project source
plus the compiler's standard library without executing modules. Historical corpus
results from revision `2026-09-08.1` retain their original measurement identity.

Revision `2026-09-08.3` uses source-role policy `interlinked-source-roles-v2`:
ordinary implementation names such as `clock.ts` and `file-mutation-lock.ts`
remain product source. Lockfile configuration requires a `.lock` suffix or a
recognized filename such as `package-lock.json`, `pnpm-lock.yaml` or `bun.lockb`,
rather than the substring `lock`. The changed role policy invalidates evidence
scope identities, and the revised profile hash prevents comparisons with earlier
measurements that omitted those implementations.

## Scope and interpretation

Product source, tests, configuration, documentation, generated outputs, fixtures,
vendors and assets have explicit roles. Tests supply test-integrity evidence;
they do not pad product-code denominators. Generated/build/vendor/fixture paths
are excluded under the shared role policy; a bare `@generated` comment does not
exempt product source. Declarations and excluded support files remain visible.
Ignored directories explicitly selected as roots receive a bounded filesystem
census when Git returns no files.

Scoring adapters currently support JavaScript/TypeScript. Recognized unsupported
source (including Python, Vue, Svelte and Astro) remains a gap. This differs from
the edit gate, which also has an exact Python token adapter. Syntax recovery,
symlink sources, inputs over 2 MiB and bounded discovery failures are not passing
measurements. Dynamic loading and unresolved local imports qualify graph results.
Declared package exports and recognized framework routes protect public entries;
static reachability still cannot prove that external consumers do not exist.

`types.unsafe` distinguishes explicit `any` and `unknown` counts from unsafe
access/call/assertion/assignment/return sites. Safe narrowing, `as const` and sound
widening do not incur a penalty. Direct unchecked propagation is measured;
arbitrary deep data flow is not. Missing type bindings make results inconclusive
because compiler error-types can otherwise resemble `any`. A justification
comment alone does not establish that an assertion is sound.

Test integrity and redundancy include heuristic findings. Saturated detector
limits produce lower-bound findings and inconclusive metrics. The scoring profile
is a review policy, not an empirical guarantee of architectural quality. Ratios
can be diluted by padding; inspect scope, tails and findings alongside the number.

## Syntax tokens and the edit gate

The user-facing term is **syntax tokens** (lexical tokens), not “AST tokens.”
Tokens are language units such as identifiers, keywords, operators and punctuation;
AST nodes describe parsed constructs and are not interchangeable with tokens.
Interlinked's JS/TS counter resolves lexical leaves through the TypeScript parser
so regexes, template literals and JSX follow a declared parsing contract. Languages
and counting policies still differ: there is no universal tokenizer-independent
conversion to LLM tokens.

The `interlinked-code-v2` gate counts complete implementation spans, including
types and nested implementations, excluding comments, whitespace, JSDoc and
zero-width recovery markers. Its JS/TS adapter is `interlinked-ts-ast-v1`.
Python uses `interlinked-python-tokenize-v1`. The hard cap is inclusive:
500 passes; a new 501-token implementation does not. Existing over-limit functions
may hold or shrink, and may not grow. Migration recounts before and after with
the same adapter, preserving existing debt. Unavailable parsing is visibly
unmeasured, never an empty baseline.

The stable `canonicalTokens` field now denotes this versioned syntax count.
There is no additional 500 LLM-token cap. The optional semantic index still uses
`llama-tokenize` and its GGUF model to measure separate `modelTokens` and chunk
embedding inputs. Neither a model download nor that executable is required for
the edit gate or scoring. Reducing existing oversized functions is a separate,
deferred campaign.

## Coverage and mutation evidence

```bash
interlinked metrics evidence run --kind coverage \
  --command '["node","node_modules/vitest/vitest.mjs","run","--coverage","--coverage.reporter=json"]' \
  --artifact coverage/coverage-final.json --runner-version vitest-YOUR-PIN \
  --policy v8-product-scope-v1 --timeout 120000 --resume --json
interlinked metrics evidence identity --json > identity.json
interlinked metrics evidence import receipt.json artifact.json --json
```

Use the repository's configured runner and declare its exact version and policy.
The explicit argv runs without a shell in a disposable copy, with a shared copy/
execution deadline and cancellation. Dependencies must already exist; the runner
does not install them. Source/tests/configuration/manifests/locks/support inputs,
scope, runner identity, outcome and artifact hashes are bound into receipts.
Source mutation by the runner invalidates evidence. Resume requires matching
inputs and a current passing receipt; a newer failed/cancelled attempt cannot be
hidden by an older pass.

The normalized artifact selector is part of cache identity, so choosing another
report from the same runner requires separate evidence. Local status and scoring
also recheck the inherited environment and all copied runtime inputs, including
ignored files and installed dependencies. Changes make a receipt stale; missing
provenance, unreadable inputs or exhausted validation budgets make it inconclusive.
Each store load shares a ten-second validation deadline and the existing
200,000-entry / 4-GiB workspace bounds. An execution's earlier deadline takes
precedence. Older local receipts remain readable but cannot certify a current score.

Coverage uses strict Istanbul maps and aligned nonnegative counts. Mutation uses
Stryker-style reports with exact source bytes and sites. Missing eligible files
stay inconclusive. Killed, surviving, uncovered, timed-out, errored and ignored
mutants remain distinct; only killed and surviving outcomes establish assertion
discrimination. Reported operator scope matters as much as the survivor ratio.

CI imports use the schema-1 receipt contract in
[src/lib/metrics/evidence-types.ts](../src/lib/metrics/evidence-types.ts).
Import validates hashes and preserves the asserted CI origin; these receipts are
not cryptographically signed CI attestations. Dependency identity binds manifests
and locks, not an independently attested host or every installed dependency byte.
Keep runner/environment policy consistent when comparing results.

## Incremental per-edit coverage

```bash
interlinked metrics coverage warm --timeout 120000 --json
interlinked metrics coverage status --json
interlinked metrics gates --json
```

A full Vitest warm run measures an isolated overlay, checks full-report parity,
and records per-test-file contributions. Its scoring receipt is inconclusive
because the index's overlay input identity differs from scoring receipt provenance;
use `metrics evidence run` for local composite scoring evidence. Incremental runs
replace affected contributions, retain unchanged ones and preserve zero-hit
denominators. Source, test, configuration, dependency, discovery, import-graph,
runner and environment changes invalidate the appropriate evidence. Vitest's native
discovery supplies the executable test universe; helpers, resolved setup/global-setup
files and configuration dependencies remain inputs. Their static import closure
invalidates every shard, including files with product-like names. Streamed snapshots cover the actual overlay policy, including
Git-ignored inputs and linked dependency bytes. They are checked before and after
execution, including reuse with no selected tests; unreadable, unstable or
over-budget snapshots cannot authorize reuse.
Opaque dependencies broaden selection conservatively. Multi-project or ambiguous
capture and incomplete exact locations may prevent reuse; status explains why.

A proposed generation can promote only after its exact inputs exist on disk.
Content-addressed blobs and locked generation checks preserve accepted data.
Identical-input coverage churn quarantines reuse until three full warm runs agree.
A stale/corrupt index cannot authorize a guessed coverage verdict.

`metrics gates` separates enabled policy, actual execution attempts, fresh measured
files, stale/unavailable/deferred work and recorded latency percentiles. Historical
ratchet reach is not current test coverage. A disabled gate measures nothing.
The local development checkout remains explicitly disabled pending an acceptable
full-suite warm run; the controlled benchmark does not justify silently enabling it.
Its eight-file fixture measured a median 668 ms incremental versus 1,997 ms full
run, rerunning one test file while retaining all eight files' coverage. Those
timings predate runtime-byte revalidation and do not estimate current latency.

## Deletion trials

`metrics deletions` joins unused/disconnected/duplicate/dead-store candidates with
current coverage and exact-site mutant evidence. Public APIs, dynamic consumers
and missing evidence remain review blockers. A survivor alone is not dead code.

`metrics deletions validate plan.json --timeout 120000 --json` runs an explicit
schema-1 removal plan in isolation. Each edit supplies a relative path, exact source
SHA-256 and a UTF-16 half-open deletion range (`start`, `end`). Checks supply
`kind` and argv; both tests and type checking are required, with optional build.
Baseline and candidate trees are prepared from the same captured runtime inputs
before any check runs. Each phase starts fresh and executes its own ordered
checks, so baseline-generated state cannot hide a broken candidate. Runtime
input changes in the source checkout invalidate the trial. Baseline checks must
pass before candidate checks run. A `checks-passed` result
records what the checks established; review remains required and the source
checkout is unchanged. The command does not automatically apply a removal.

See the [calibration report](metrics-corpus-2026-09-08.md) for pinned repository
results and original behavioral artifacts, and
[the completion record](metrics-completion.md) for implementation validation.
