# interlinked-quality-gates: gate detail

Reference for [SKILL.md](../SKILL.md). Read it when a gate row in SKILL.md does not explain a result.

## Language coverage and Python test-first naming

Behavioral execution and structural measurement have separate language coverage. Explicit
`tests suite` supports TS/JS, Python, Rust and Go; the new iterative diagnostic profiles
remain JS/TS and Python only. A passing runner is not evidence that new requirements have
tests. Exercise new public boundary/error/state-transition contracts as well as preserving
existing cases. Project-suite failures without a before result are not proven regressions.
No new verbosity or erosion hook gate is enabled by these diagnostics.

Python test-first guidance recognizes `test_<name>.py` and `<name>_test.py`, including
root, package and separate test directories. Discovery refreshes when directories or
runner configuration change during a daemon session. These are naming hints, not proof
of coverage: inspect custom collection layouts before creating redundant tests. The
configured new-file policy applies to JS/TS and Python. Explicit
`test_first_mode: "enforce"` requires a companion even in an empty repository;
layout detection does not demote it. Create the first behavioral test before its
implementation. Pair debt can sequence later source/test edits once a test layout
exists; it cannot replace that first-test bootstrap. `"warn"` remains advisory.
A companion filename alone is not evidence of a failing or passing test. Python uses
`# interlinked-tdd: exempt` for the existing explicit exemption directive. This does not
establish equivalent pre-execution TDD enforcement for arbitrary Bash writes.

## Refactor readiness

**Refactor-readiness additions (plan 25, 2026-08-17).**
- `characterize_before_touch` (`structural_checks.characterize_mode`): editing
  a file on the untested list asks for a characterization test FIRST — capture
  today's behavior with exact assertions, then change it. Same
  `// interlinked-tdd: exempt` escape as the new-file gate.
- Ratchet-family dimensions: `seam_ratchet` tracks added ambient clock/random/env
  reads. `assertion_strength_ratchet` is heuristic PostToolUse advice for test files,
  never a block: it flags introduced broad matchers without introduced exact checks.
  JS/TS comparison uses complete assertion calls, ignoring comments, strings,
  formatting, moves, and existing calls; Python retains a stripped-line heuristic.
  Missing raw pre-edit content or unusable JS/TS syntax yields no assertion advice.
  Exact undefined/null, call-count, and zero-call checks are legitimate contracts.
  Broad membership/type checks can also be appropriate; assess the tested behavior
  before changing them. A matcher classification does not prove mutation coverage
  or require literal-only expected values.
- `new_import_cycle` (structural, default warn): fires the moment an edit
  closes a module cycle that did not exist before.
- Advisory portability family: `dynamic_code_execution`,
  `builtin_prototype_mutation`, `float_equality_comparison`, plus
  `test_contract_annotation` (mutation-directed files only) and
  `unvalidated_input_boundary`.
- `per_edit_mutation.max_test_scope` (default 150) is an engine budget.
  `per_edit_coverage.drop_epsilon` is a tighten-only water-line: values above the
  built-in 0.005 are ignored with a warning unless an operator intentionally resets
  it in the daemon environment. Daemon timings are separate implementation budgets.
  Cognitive and cyclomatic have no sub-cap slew rule.

## Python and Vitest coverage-gate internals

JS/TS can select affected tests from its supported dependency evidence. Python currently
uses the bounded full-suite route: a companion filename or an empty JS graph cannot prove
a complete Python test selection. Over-budget work retains the existing deferral policy.
Python suite and coverage paths share interpreter selection: explicit adapter configuration,
active `VIRTUAL_ENV`, project `.venv`/`venv`, then the platform Python. A selected but broken
environment is unavailable, with no silent fallback. Overlays execute in the staged tree
using the original project's interpreter; recognized environment layouts are linked rather
than copied, with proposed writes kept from mutating the original environment.
If observed imports resolve to original project source outside the staged tree, the run
is unmeasured for that edit, even when those cases pass or fail. This detects common editable
install mistakes; it does not remap editable installs or certify all subprocess/data inputs.

Default pytest execution records fresh structured case outcomes. Missing, empty, skipped-only
or incomplete execution never earns a green verdict or a clean baseline. Observed assertion,
fixture or teardown failures remain red even if coverage is missing or collection is incomplete;
the configured failure/debt policy still applies. Custom Python command overrides retain their
argv but are unmeasured for red/green without structured evidence. Default Python coverage
runs own separate JSON report directories and `COVERAGE_FILE` databases, cleaned after parsing;
they preserve project cwd/configuration and do not clear a caller's existing report/database.
Custom command overrides keep their existing report-path contract and are not qualified for
concurrent report isolation. Reusable dependency-aware indexing and live mutation still lack
parity. Do not describe the language as fully qualified from a runner pass.

Python edit/commit CRAP now uses coverage.py's native function-region executable lines,
matched to Radon by declaration line and function name. Nested bodies do not contribute to
their enclosing function's coverage; excluded lines and branch percentages do not inflate
function line coverage. Reports must include native regions with `start_line` (introduced in
coverage.py 7.13.1). Older/malformed reports, ambiguous or unmatched functions, and functions
with no measured executable lines produce explicit missingness, not inferred coverage or
invocation counts. A wholly excluded function is unmeasured for CRAP. Missing attribution
cannot earn a clean edit baseline or discharge commit obligations while CRAP is enabled;
known coverage violations still apply. Unavailable complexity analysis also keeps commit
obligations open. These changes qualify the edit/commit paths, not every metrics/report surface.
Active distributed pytest execution is explicitly unmeasured until worker collection and
runtime identity are qualified; installing xdist alone does not make a serial run unsupported.

Vitest coverage include/exclude edits block only when a concrete path example is
provably included by HEAD and omitted by the proposed combined scope. These
examples describe configured path membership, not an on-disk file census.
Supported comparisons cover positive relative globs with literal directories,
complete globstars, filename suffix wildcards and bounded comma brace alternatives.
Widened includes, narrowed exclusions and equivalent redundant patterns pass.
Negation, extglobs, character classes, unsupported wildcard placement, unknown
defaults, computed object keys, object spreads or unresolved overlaps allow with an explicit abstention warning:
review manually; an abstention makes no measured or clean claim. The shared
baseline bypass policy is unchanged.
Any computed property name in the config source causes abstention, including
literal-looking computed names and nested objects accessed through aliases or
factories. The gate does not evaluate JavaScript bindings to prove a computed
value irrelevant. Ordinary identifiers and quoted property names retain the
literal-array/glob comparison. When a coverage literal exists, any object spread
in the source also requires abstention: an enclosing or aliased spread may
replace the entire `test` or `coverage` object. A blocking comparison requires
unique plain `test.coverage` properties in a directly default-exported object,
optionally wrapped by the named `defineConfig` import from `vitest/config` or
`vite` (including an import alias). Duplicate keys, accessors, detached literals,
exported bindings, factories, arbitrary calls and CommonJS assignments are not
resolved by this guard; they warn when a coverage literal cannot be established
as the effective configuration. Parentheses and TypeScript assertions are transparent.

## Istanbul report cache

The per-function Istanbul reader scopes its cache to the normalized report path and
repository root, with mtime invalidation. A shared monorepo report can therefore be
read from a package root or workspace root without reusing the other root's file keys.

## Gotcha detail: `self_import` and batch type checking

  Module resolution respects each usage's mode: dynamic imports in CommonJS use import
  resolution, while import-equals declarations in ESM use require resolution. Parser
  availability at startup does not establish that any particular file was measured.
  `self_import` resolves each specifier with the PROJECT's own compiler options (the nearest
  tsconfig, following `references` to the project whose `files`/`include` claim the file; nothing
  cached, so an edited `extends` target or a new nearer tsconfig applies on the next edit). Five
  more states are NOT MEASURED rather than guessed, each with its own `[interlinked:self_import]
  NOT MEASURED` warning: a tsconfig on that walk that cannot be parsed, two referenced projects
  that both claim the file, a reference walk that hits its 32-project bound with projects
  unvisited, a file that no config in reach claims by a `files`/`include` pattern (the nearest
  config, its `references`, and its sibling `tsconfig*.json` files are all consulted; an
  unclaimed file may be a transitive member — a `/// <reference>` target — which root patterns
  cannot decide, so it is never guessed into the nearest config), and an importer whose
  directory is not on disk yet. Inside a batch (`write --batch`, `multi-edit`, `verify-changeset`
  — all three run the one shared gate) every check sees the WHOLE proposed batch: a sibling the
  batch creates is visible to `self_import` AND to the type checker's overlay, and the
  introduced-only baseline is judged against the DISK, so an exporter-first batch that adds
  `widget.native.ts` and points `widget.ts` at it passes end to end, while a batch that rewrites
  `tsconfig.json` so an existing re-export becomes a self-import is refused as INTRODUCED. A
  batch that rewrites any file of the project's configuration graph — the selected tsconfig,
  any file its `extends` chain reaches whatever its name (`base.json` counts), or a
  tsconfig/jsconfig/package.json anywhere in the batch — gets a `type checker cannot see the
  proposed configuration` row for its TypeScript entries (the checker reads the disk's config):
  land the configuration change first, then the sources. A member whose bytes equal the disk
  is still type-checked against the members that differ (a changed exporter can break an
  untouched consumer); `multi-edit` validates every manifest member and writes only the
  changed ones. Only a batch whose members are ALL unchanged skips the type check, and a
  config member whose bytes equal the disk is not a rewrite. The type checker judges each
  file under the SAME project `self_import` selects (one program per governing config); a
  file no single project claims is `type checker unavailable (project_orphan: …)` rather than
  checked under the project root's config. Its disk baseline is recomputed on every check, so
  a dependency repaired on disk cannot mask a reintroduced error; a warm compiler service is
  rebuilt when the content of its tsconfig or any `extends` target changes on disk and
  re-reads the project's root files on every reuse (a declaration file added or removed on
  disk joins or leaves the program), sees a dependency rewritten on disk whatever its
  timestamp says, and forgets a proposal the moment its check ends (a refused proposal never
  colours a later check); and a configured project with no source on disk yet still measures
  the first source written into it.

The type checker's snapshot and its identity share one captured compiler text per file
per check. The identity preserves every UTF-16 code unit, including lone surrogates;
UTF-8 replacement encoding would incorrectly merge distinct compiler texts.
An unreadable disk baseline is unavailable, not an empty baseline. Diagnostic comparison
counts repeated equivalent findings, so moving existing debt is allowed while another
occurrence remains new debt.

## Evidence qualification additions

The baseline-integrity gate treats removing entries from `check-evidence-baseline.json#corpus_cohort` as weakening. Qualification requires fresh complete v2 corpus evidence and the named controls; stale or legacy zero-hit records cannot qualify. This remains local, bypassable enforcement. The broader policy-change contract is a design proposal, not an implemented external authority.

Stryker adapter paths retain optional statusReason, killedBy, testsCompleted, test IDs, unknown fields and report/run hashes in `.interlinked/mutation-evidence/`. Reports exceeding the 16 MiB retention budget or failed writes emit NOT RETAINED. These are locally hashed JSON-value sidecars, not authenticated protocol-v3 extensions or original HTTP-byte attestations. Mutation score semantics are unchanged. A historical kill and applicability to current tests/helpers/fixtures/config/runtime/environment are separate; incomplete dependency closure remains unknown, and killedBy alone is not closure or causal attribution. Signed v3 payloads retain their existing strict schema; the sidecar capability design is documented separately.

The cloud runner requires an explicit evidence root and never uses the process working directory as an implicit persistence target. Sidecar retention is bounded to 64 MiB, 128 reports and 30 days, retaining the current report. Run metadata keeps two generations of at most 1 MiB each. Pruning counts are recorded; unrelated files are untouched. This diagnostic store is not an indefinite audit archive, and old run metadata may reference a pruned report.
