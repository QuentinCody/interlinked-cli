# Iterative quality diagnostics

`interlinked metrics diagnostics [--profile js-ts|python] [--cwd <path>] [--json|--short]`
produces a read-only census for investigating candidate quality gates. It does not execute
target code or tests, invoke a model, install dependencies, change a baseline, or add hook work.
The existing `metrics score` profiles and warning policies are unchanged.

The default profile is `interlinked-iterative-js-ts-v1`; `--profile python` selects the separate
`interlinked-iterative-python-v1`. Neither implements the benchmark's pinned analyzer. The
JS/TS profile still reports Python as unsupported. Its first pattern is the existing
`single_use_trivial_helper` advisory detector, now exposed as uncapped evidence for this
explicit command. Interactive warnings retain their ten-match cap.

## JS/TS counting contract

- Source roles use the existing `interlinked-source-roles-v2` census. Only product source is
  measured. Reports retain discovery issues, exclusions, unsupported files and parse failures.
- SLOC is the set of lines intersecting parser-resolved lexical tokens. Comments, JSDoc and
  whitespace outside tokens do not count. All lines inside multiline literal/JSX tokens count,
  including blank literal lines. Type syntax counts. This is not executable-line coverage.
- Each token belongs to its innermost implementation for function SLOC. Signatures count;
  nested functions own their tokens and branches. Two functions with tokens on the same line
  each count that line. Function SLOC sums therefore need not equal file SLOC.
- Exact clones reuse the existing written function-body token sequence, preserving identifiers
  and literals, with an inclusive implementation threshold of 30 tokens. Near clones and
  arbitrary repeated blocks are not measured. Line coverage uses body spans, not whole
  declarations. All members count in clone coverage; redundant coverage separately excludes
  the first representative in each group. Overlapping clone spans count once per file.
- Trivial-helper pattern coverage uses the whole declaration span intersected with token lines.
  The existing private/single-call/generic-name heuristic is reused. Findings retain source
  hashes and locations; the syntax match does not establish semantic redundancy.

`verbosity = |pattern lines union clone lines| / measured product SLOC`

Reports expose pattern lines, clone lines, intersection, union and redundant clone lines
separately. The pattern set is deliberately limited; zero means no measured candidates, not
absence of unnecessary code. An empty denominator has `fraction: null` and `not-applicable`.
For partial scope these quantities describe only the measured subset, including when it is empty.

`mass(f) = cyclomatic(f) * sqrt(function SLOC(f))`

`erosion = sum(mass(f) for CC(f) > 10) / sum(mass(f))`

The report retains each function's CC, SLOC, total mass and high-complexity mass. The CLI shows
the largest contributors. No functions means no erosion measurement, rather than a good score.
The discontinuity at CC 10 and denominator dilution remain visible in raw values. Adding a
simple module can lower erosion without changing the existing high-complexity mass.

## Python counting contract

The Python adapter runs a fixed AST/tokenize script using `python3 -I -S -B`, with source sent
as JSON on stdin. It needs Python 3.10 or later, uses no third-party packages, imports no target
modules and disables site initialization. Each batch contains at most eight files, has a
10-second process timeout and a 16 MiB output limit; the analysis loop has a 30-second budget.
A failed process stops further batches; completed earlier batches survive and remaining files
become explicit gaps. These are command budgets, not a real-time per-edit latency promise.

Python test basenames `test_*.py`, `*_test.py` and `conftest.py` are excluded in addition to the
shared role rules. This is recorded as `interlinked-source-roles-v2+python-test-names-v1`.
Comments, docstrings and indentation/newline tokens do not contribute SLOC; multiline literal
lines do. Token ownership is innermost function/async function/lambda, including signatures.
Decorators are outside the function's SLOC; complexity measures function bodies only.
Unsupported token ownership, parser failures and unavailable Python are gaps, never zero debt.

The declared body CC counter starts at one and adds if/conditional expressions, loops,
exception handlers, assertions, boolean operator arity minus one, comprehension loops and
filters, non-wildcard match cases and guards. Nested functions/classes do not add to an
enclosing function's CC. This counter is **not radon parity** and leaves the existing Python
edit gates unchanged. Parser version and the full counter contract enter measurement identity.

Clones preserve identifiers, literals and indentation/newline token kinds, while normalizing
indentation text. The threshold is 30 non-layout implementation tokens. The first advisory
pattern is an if/else whose branches each return one opposite literal boolean. Evaluation
behavior, truth conversion, public seams and intentional independent implementations still
need semantic review. A zero verbosity reading means no candidates in this small pattern set.

## Comparing and reviewing evidence

Read scope before ratios. Parser recovery and languages unsupported by the selected profile are gaps. Missingness
must not be interpreted as passing quality. `measurementIdentity` binds the profile contract,
source-role revision and observed parser versions; file hashes identify evidence.

`interlinked metrics diagnostics compare before.json after.json [--json|--short]` validates
snapshot identities, populations, ratios and function-mass totals. It refuses overall deltas
for different measurement identities, incomplete scope, changed discovery/exclusions or
changed path/language populations; valid matching-file deltas remain visible. A lower ratio
without a lower numerator is explicitly flagged as dilution. Incompatible or malformed input
returns nonzero. Keep snapshots outside the measured repository to avoid changing its recorded
exclusions. These digests do not authenticate an externally supplied report.
The older `metrics compare` continues to accept score reports only.

Use candidates to review intent, public API seams, independent validation, domain names and
behavioral tests before changing code. `interlinked simplify review --diagnostics js-ts|python`
adds their candidates to the existing changed/staged/range review, overlap groups, coverage
receipts and optional `--record` workflow. It performs an explicit full diagnostic census for
cross-file context, then filters candidates to the selected paths and related clone peers.
Default simplification scans add no diagnostic census. Candidates carry exact source hashes;
estimated removals remain unknown and validation remains `not_run`. Python source receipts
cover only this adapter's limited patterns, not every simplification capability.
No heuristic here is eligible for `pre_block` merely because it can be counted deterministically.

Next work: independently reviewed pattern precision and counter qualification,
function coupling/churn/cohesion, extension-effort measurements, and latency
on held-out repositories. Freeze each profile before an eventual evaluation and
keep its results separate from hidden correctness tests and benchmark analyzer scores.
