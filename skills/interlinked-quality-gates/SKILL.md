---
name: interlinked-quality-gates
description: "Respond to and configure Interlinked metric ratchets: line count, function tokens, cyclomatic complexity, coverage, CRAP, baseline integrity, mutation-score ratchet, per-edit survivor gate and protocol-v3 durable mutation jobs. Load for a quality-gate block or lowered-baseline refusal; `caps`, `coverage`, `mutation`, `mutation cloud`, debt obligations, `debt markers`, `metrics`, `adopt`; mutation cadence, scope or strictness; `mutation_gate` or `per_edit_mutation`; mutation runner shards or journal; `[interlinked:mutation]` or `[mutation:not-measured]`. Water-lines only tighten: meet the bar."
---

# interlinked-quality-gates — the metric ratchets

For `metrics standards --profile dmmulroy-typescript`, see
[local standards measurements](references/standards.md). It retains all 35 pinned
guidance groups with separate syntax, detector, candidate and unknown coverage,
all-role denominators, source-driven units and explicit caller/context gaps.
Explicit metrics/standards surveys retain complete selected sources without implicit
body-size, path-count or Git-listing limits. See [metrics procedures](references/metrics.md)
for the separate foreground Python policy, runtime bounds, exclusions and unavailable inputs.

Every quality metric is a **water-line** stored in a JSON file under `.interlinked/`. The gates
enforce **"may only move in the tightening direction"**: coverage/mutation scores may only rise;
caps may only fall. The harness raises water-lines itself (internal writes); **an agent
hand-lowering a water-line is the canonical gate-gaming move and is blocked.** North star:
~100% coverage paired with mutation testing.

**Meet a gate by improving the implementation or its behavioral evidence, never by
loosening the baseline.** The strict cyclomatic and per-edit coverage gates have no
suppression or environment bypass. Read applicable limits before editing. Simplify
redundant logic, remove duplication, or extract a cohesive responsibility with clear
inputs and outputs. Early returns can reduce nesting without reducing branch count.
Avoid trivial wrappers, repeated parameter forwarding and scattered control flow that
only move measured complexity between functions.

After a meaningful refactor, run relevant existing tests and preserve intended public
contracts, including error behavior and state transitions. Where evidence is absent,
add focused cases from the user's requirements; state untested scope. A passing local
test or lower complexity score does not prove complete correctness. Intentional contract
changes need corresponding expectations; do not preserve a bug merely to keep a test green.
Do not tailor implementations or test selection to hidden benchmark cases.

The experimental Cowork portable plugin does not carry these repository baselines
or run coverage/mutation automatically. Load **interlinked-cowork** for explicit
host bridging and version checks. Its `cowork verify` external-tool subset is not
evidence that a coverage, mutation, CRAP or baseline ratchet passed.

## The gates you bump into at edit time

Edit-time function tokens, cyclomatic complexity and cognitive complexity now
advise by default. Shared `.interlinked/config.json` can explicitly select
`harness.edit_metrics.mode: "enforced"` for the existing hard cap behavior.
The following cap-block and grandfather-ledger instructions apply in that mode;
measurements, protected baselines, explicit verification and behavioral test gates
remain intact. Do not add concepts merely to lower a structural count.

Per-metric settings in the check policy `metrics` map now control `cyclomatic`,
`cognitive`, and `function-tokens`: report, warn, block or off, with targets and
file/role scopes. Missing entries inherit the legacy posture. Blocking targets may
only tighten canonical caps, and adopted policy is protected against agent weakening.
See [metric policies](references/metric-policies.md) for edit configuration and
unsupported metric IDs. `metrics policies export|inspect|evaluate` shares versioned
data-only references to installed metrics and detectors. Its report/warn/off
assessment retains all 23 project readings and explicit evidence gaps. See
[policy profiles](references/policy-profiles.md) for the schema, aggregate-scope
limits and reviewable structural proposals.

Physical per-file size is now advisory. The `lines` setting remains a review
preference and historical measurements remain available; it never blocks source
edits, native cold fallback, verification or commits solely for size. Do not remove
braces, join lines, invent temporary variables, or split modules merely to satisfy
that number. This is a decomposition prompt, not an LLM context-token budget.
Guard ownership belongs to predict–reveal–reconcile; see **interlinked-harness**.
The `file.lines` metric-policy entry controls advice targets, path/role scope and
report/warn/off disposition in the daemon and native cold pre-write path. Standalone
generated cold hooks emit NOT MEASURED for physical-line settings. The policy
reference records phase coverage and the project AST line-count convention.

File-size and per-function checks share Write/Edit/MultiEdit and native patch projection.
Multi-file patches check every reconstructed target, and moves retain their source
before-state. Equivalent known effects face the same policy. Unknown reconstruction
is unmeasured, never a passing receipt. Arbitrary shell writes still require checking
their observed effects after execution.

| Gate | Blocks when | Threshold | Correct response |
|---|---|---|---|
| **File-size preference** | never blocks; advice on growing files | **500** physical lines (`DEFAULT_MAX_LINES`) | Review module responsibilities; preserve readable layout |
| **Function tokens** | an edit introduces or grows an implementation above the inclusive canonical-token cap | **500** tokens; no per-edit slew allowance | Extract cohesive helpers; an already-over-cap function may hold or shrink |
| **Cyclomatic — over cap** | edit adds/raises a function over the hard cap | shipped **25**; this repo overrides to **22** | Extract cohesive branches into named helpers |
| **Cyclomatic — below cap** | no edit-size restriction; the resulting function is within its effective cap | no slew | Prefer cohesive implementation; avoid extraction solely to reduce the size of one edit |
| **Cognitive — over cap** | edit leaves a function over the cognitive cap | **30** | Flatten: guard clauses, extract the deepest-nested block |
| **Cognitive — below cap** | no edit-size restriction while the resulting function stays within its effective cap | no slew | Use coherent patches and cohesive helpers; flatten nesting where useful |
| **Per-edit coverage** | edit adds an uncovered executable line/function, or drops a file's coverage vs its high-water | gate default on; drop ε 0.005; hard floor `min_coverage` default 0 (off) | Stay within the source/test pair and add coverage; default debt mode allows the first uncovered/red edit but blocks unrelated wandering |

**Coverage has a GOAL, not a cap (2026-08-17).** `coverage_goal` in
`metric-caps.json` (set via `interlinked caps set coverage <pct>`) is the target
the ratchets climb toward — default **100**, adjustable to a less ambitious 80/90,
free to move in either direction because no gate reads it. Enforcement is the
pair above it: `interlinked adopt` seeds today's per-file % as the floor
(hold-or-rise), and added lines must be covered — so a brownfield repo is never
bricked and coverage only moves toward the goal. The separate `min_coverage`
hard floor blocks outright and, once set, only rises (baseline-integrity gate).
| **CRAP** | a touched function is both complex AND under-covered | shipped **30**; this repo overrides to **25**, default on | Decompose OR add coverage (both lower CRAP) |
| **Per-edit mutation** | a measured edit adds a changed-region survivor/uncovered site, makes affected tests red, or exceeds the site limit | default **off**; site limit **50**; `mode: block\|warn\|off` | Strengthen the test, fix/remove the source behavior, or split an oversized behavioral change |
| **Baseline-integrity** | a Write/Edit *loosens* any `.interlinked/` water-line (the name matches in any letter case), or a `git commit` deletes one (`git rm`, `git mv`, `--pathspec-from-file` counts as the whole tree) | per-file direction | Meet the bar; don't edit, move or delete the baseline |

**Modes ladder the philosophy-dependent gates (2026-08-17).** `interlinked mode`
writes gate posture into `guard-rules.json` alongside its check-policy overrides:
`strict` = new-file TDD gate blocks + characterize-before-touch blocks +
per-edit coverage strict (no debt); `balanced` = both TDD-family gates warn +
coverage debt mode; `lenient` = TDD/characterize gates, per-edit coverage, and
session-end nudges off. Findings still surface as warnings in lenient; security
rails and every tighten-only ratchet ignore the mode. Hand edits to
`guard-rules.json` win until the mode is re-applied.

**File size** — three advisory surfaces: PreToolUse growth advice,
`large_files` under `verify --all-checks`, and a `[interlinked:file-size]` PostToolUse
nudge. None refuses edits. Historical baselines and measurements remain intact.
**Cappable = hand-written code only**;
exempt: `.d.ts`, anything under `.interlinked/`, root `scratch/`, non-code extensions
(md/json/yaml/toml/html/…), generated files (`.gen.`/`generated/` path or `@generated`
content), test/spec paths, and `@codegen-data`-marked modules. Content-marker
exemptions require at most two executable branch tokens; strings and comments do not
spend this budget. An unavailable JS/TS parse denies the marker exemption.

Baseline-integrity comparisons reject duplicate JSON keys and non-JSON numeric values. Removing
fields must not loosen effective defaults. Full-suite coverage high-water marks cannot
decrease merely because the measured scope changed. Local recursive `tsconfig` inheritance
participates in strictness comparisons; unresolved/dynamic or missing Vitest denominator
evidence remains NOT CHECKED. See **interlinked-harness** for post-call restoration limits.

**Function tokens** — a deterministic, model-independent size cap. Interlinked counts complete
implementation spans with the `interlinked-code-v2` contract. JS/TS uses the shared
`interlinked-ts-ast-v1` parser-resolved counter; Python retains its standard-library
`interlinked-python-tokenize-v1` policy. Comments, whitespace, JSDoc and empty parser markers
do not count in JS/TS; written tokens, types and nested implementations do. The shipped ceiling
is inclusive (`500` passes, `501` is over)
and may be ratcheted down but never raised above 500. The edit comparison has brownfield delta
semantics: a pre-existing over-cap function may hold or shrink, but may not grow; a new or newly
over-cap function blocks. TypeScript/JavaScript and Python have exact adapters. Unsupported or
unavailable languages fail open with a visible `not-measured` warning because heuristic spans are
not eligible for a hard block. There is no suppression or model-tokenizer fallback.

Migration recounts both before and after source with the same counter. A function newly
revealed as oversized by v2 is existing debt and may hold or shrink. New over-cap functions,
growth, and relocation into new oversized helpers still block. A recovered/unavailable parse
on either side produces a visible unmeasured comparison, never an empty baseline. Reports retain
`canonicalTokens` and publish v2 plus adapter/parser-version provenance; do not relabel historical
receipts or compare v1 numbers directly with v2. No size baseline needs to be manually reset.

This count is not an embedding context-window estimate. `interlinked semantic` records a selected
model's separate `modelTokens` value and chunks inputs that do not fit; semantic availability,
scores, and tokenization never affect this gate. See **interlinked-semantic-index** for that surface.

**Cyclomatic** — strict, **no override**. Over-cap uses an identity-free multiset compare (a new
over-cap function, or raising one past the cap, blocks). Below the cap, a whole implementation
and the same implementation built incrementally face the same end-state limit. JS/TS uses
the TS AST and Python uses its qualified AST counter; unsupported languages remain unmeasured. **Fails open
(allows) + warns loudly** when the analyzer is unavailable — never a silent skip.

**Cognitive** — same three rules, promoted from warn-only to blocking 2026-08-01 (measured p99 26
vs cap 30). Two ways it is *stricter* than cyclomatic: uniquely-named functions are compared by
identity rather than rank, so relocating complexity into a newly-created over-cap helper still
blocks; and the remedy is flattening, not extraction — pulling a deeply-nested branch into its
own function unchanged carries the nesting cost with it. Run `interlinked caps` for live values;
the numbers in this table are the committed defaults, not a promise about your repo.

**Per-edit coverage** — default **ON**. Runs tests under a scoped overlay,
then decides: red-bar (default on) → uncovered-added-line → per-file coverage drop vs
`coverage-edit-baseline.json` → `min_coverage` floor → CRAP (default on). With default
`debt_mode:true`, the first uncovered or red result opens a pair-scoped debt and the edit lands;
keep working in that source/test pair until it is covered and green. The commit gate remains the
ground-truth backstop. Commit coverage takes the real checkout’s heavy-process lease and the shared host test slot. Vitest runs one instrumented worker. A busy host or interrupted run leaves coverage obligations open. Retry the full coverage suite against the same staged contents or resulting commit.

**CRAP** = `cyclomatic² · (1 − coverage/100)³ + cyclomatic`, where coverage is a percentage.
Full coverage reduces the score to cyclomatic, but low coverage can exceed the default threshold
even at modest complexity (complexity 5 at 0% coverage scores 30). Treat complexity and coverage
as independent levers; neither cap alone guarantees a safe CRAP score.

The Coverage row reports whether the source coverage report was available. With
coverage present, an empty hotspot list means there are no CRAP rows to display.

**A function with no coverage reading gets no CRAP score at all.** When the report contains no
measurement for a function — the source moved since the last coverage run, or the instrumenter
never emitted an entry for it — that is *unknown* coverage, not 0%. Such functions are omitted
from CRAP findings entirely: absent from `interlinked metrics` hotspots, from the CRAP
distribution, and from the over-cap gate count (they still carry cyclomatic complexity, so they
stay in the function inventory). Scoring them as 0% used to drive CRAP to its ceiling, which put
fully-covered functions at the top of the hotspot list and false-blocked edits to well-tested
code. If a function you expect to see is missing from the hotspots, regenerate coverage
(`npm run test:coverage` or the project equivalent) rather than reading its absence as a pass.

## Mutation testing: choose cadence, scope, and enforcement

Interlinked currently exposes **three mutation surfaces**. Their persistence, readiness, and
configuration are not interchangeable.

| Surface | Cadence and scope | Persistent state | Who runs the engine? |
|---|---|---|---|
| **Report score ratchet** — `interlinked mutation check` | Manual/CI/pre-push/weekly; every file present in the supplied report | `.interlinked/mutation-baseline.json`; score drop = error, below `min_score` = warning | The user or CI runs Stryker (or emits the supported generic `files` JSON shape) first |
| **Live per-edit survivor gate** — `per_edit_mutation` | Each supported source edit; runner measures the selected JS/TS file and the gate judges changed symbols | `.interlinked/mutation-manifest.json`; new survivor/uncovered site = warn or block | A configured mutation-runner endpoint runs Stryker against the proposed overlay |
| **Protocol-v3 durable jobs** — `interlinked mutation cloud …` | Explicit manual jobs plus a separately opted-in, default-off daemon scheduler | `.interlinked/mutation-journal.sqlite` plus the authority-scoped manifest head/outbox and `.interlinked/mutation-findings.jsonl` delivery log | A configured authenticated cloud service executes the job; the local CLI authenticates evidence, evaluates it, and journals before acknowledgement. The production cloud deployment is not provided by this repo. |

### Report score ratchet

Use this when mutation is too slow for every edit or when CI owns the exhaustive campaign:

```bash
npx stryker run                         # scope/operators/tests come from Stryker config
interlinked mutation check --report reports/mutation/mutation.json
interlinked mutation check --report reports/mutation/mutation.json --update-baseline
interlinked mutation baseline
```

Set the score floor in `.interlinked/check-policy.json` (team) or
`.interlinked/check-policy.local.json` (personal override):

```json
{
  "version": 1,
  "mutation_gate": {
    "enabled": true,
    "min_score": 0.75,
    "schedule": "weekly"
  }
}
```

**Current contract:** `min_score` affects the comparison. `enabled` and `schedule` record policy
intent but do not invoke or schedule Stryker; wire the command into the chosen CI/hook/cron
surface yourself. The public command currently exposes `--report`, `--baseline`,
`--update-baseline`, and `--json`. Omitted `--report` searches
`reports/mutation/mutation.json`, `reports/mutation/mutation-report.json` and
`.stryker-tmp/reports/mutation.json` in order. An explicit report selects that
path and empty path arguments fail visibly.

`--baseline <path>` selects an existing comparison baseline. The default is
`.interlinked/mutation-baseline.json`. Explicit inputs require readable,
shape-checked mutation data. With `--update-baseline`, the selected file receives
the preserved-or-tightened water-lines. JSON output retains requested and resolved
paths, selection source and update status. Ordinary aliases update their resolved
baseline target under the same cross-process claim. Other protected runtime
control paths, including resolved aliases, fail before comparison or updates.
The root mutation policy supplies `min_score`. Alternate updates target the
selected comparison file. Internal `minScore`/`changedFiles` support remains
available to existing callers.

The score is `killed / (killed + survived)`. Timeout, no-coverage, compile-error, and
runtime-error mutants are excluded from that denominator; inspect the engine report instead of
reading a high score as proof that every mutant was conclusively measured.

Interlinked decides only the **ratchet verdict**. Configure how much mutation work happens in the
engine: Stryker's `mutate` paths/ranges, test runner and selected tests, mutator exclusions,
concurrency, timeouts, coverage analysis, and incremental mode. There is no Interlinked
`light|standard|full` preset.

### Live per-edit survivor gate

The shipped default is off. Opt in with a `per_edit_mutation` block in `.interlinked/guard-rules.json`
(team policy) or `.interlinked/guard-rules.local.json` (machine-local runner and credentials).
The knob table (`enabled`, `mode`, `unavailable_behavior`, `site_count_threshold`, `budget_ms`,
`harvest_budget_ms`, `runner_url`, `token`) and the per-finding fixes (new survivor, uncovered site,
affected suite red, over site limit, not measured) are in
[references/mutation-live-gate.md](references/mutation-live-gate.md).
A "not measured" result is never a pass.

## Command surface

`caps --json <subcommand>` and `caps <subcommand> --json` both preserve JSON output.
`metrics --cwd <path>` propagates the selected repository to nested commands,
including every `metrics decisions` action. A leaf's explicitly parsed options
take precedence when merging inherited options.

Finding review uses `metrics decisions findings plan BUNDLE --select IDS --output PLAN`
to freeze complete semantic inputs, provider identity and labeled cost estimates.
`assess PLAN --approve-plan ID --output RUN` admits that frozen identity, while
`--estimate-allowance-usd` explicitly accepts estimate-based admission. Inspect saved
plans and v1/v2 runs with `show`; viewing and validated v2 `--reuse` are inference-free.
TypeSafe exposes its exact public JSON body. Other installed decision adapters expose
semantic inputs and retain actual wire receipts after dispatch. Unknown costs stop
later paid requests, and byte-derived estimates can exceed monetary allowances.

`findings questions DRAFT --output PROFILE` freezes alternative disposition and
priority instructions and criteria. `plan --question-profile PROFILE` creates
plan/2 with a full map and checksum. Outcome keys stay fixed. Metadata-only renaming
retains semantic request identity, while wording or criteria changes miss the cache.
Default plan/1 and saved v1/v2 runs remain readable. Orchestrator retries are zero,
with external adapter retry guarantees recorded as capability-dependent.

| Command | Purpose |
|---|---|
| `interlinked caps` | Show effective caps (lines/function-tokens/cyclomatic/crap/coverage) + provenance. |
| `interlinked caps set <lines\|function-tokens\|cyclomatic\|crap\|coverage> <n>` | Retune a cap → `.interlinked/metric-caps.json`. Function tokens cannot exceed 500. |
| `interlinked caps explain [metric]` | Definition, default, fix hint per metric. |
| `interlinked caps ratchet <cyclomatic\|cognitive> --to <n> [--dry-run]` | Tighten a per-function cap AND regenerate the grandfather ledger (`function-complexity-baseline.json`) for everything over it. Only writer of the ledger; `caps set` delegates here when a section exists. |
| `interlinked caps status` | Ledger burn-down per metric: cap, entries remaining, top offenders, delta vs the previous snapshot. |
| `interlinked caps propose` | Data-driven cap proposals from a live census: percentile ladder and the count each candidate cap would grandfather. |
| `interlinked metrics complexity [--metric <m>] [--top <n>] [--churn-days <n>]` | Complexity census: within-repo ranks, histograms, per-file mass, churn hotspots (90 days by default), directory line-count Gini, over-cap counts. Generated, vendored and minified files are set aside (source roles v5, as in `metrics score`) and counted in `population`. |
| `interlinked metrics jit [ref] [--staged] [--message <text>] [--calibrate <n>] [--cwd <path>] [--json\|--short]` | Scores HEAD or the selected commit against recent first-parent commits (default 200). Use `--calibrate 0` for the score with an empty comparison population. `--message` classifies the staged commit's purpose. |
| `interlinked metrics diagnostics [--profile auto\|js-ts\|python] [--cwd <path>] [--json\|--short]` | Explicit verbosity/erosion census, line overlap and absolute contributors; separate language profiles, diagnostic only. Without `--profile` the profile follows the product files: only JS/TS runs `js-ts`, only Python runs `python`, both return `{mixed, profileSelection, profiles: [js-ts, python]}` with one report per language and no shared denominator; `profileSelection {rule, languages, shares}` is printed. An explicit `--profile` is unchanged. A mixed envelope is not a snapshot: save one profile to run `compare`. Uses source roles v5 (`population` in the JSON). |
| `interlinked metrics diagnostics compare <before> <after> [--cwd <path>] [--json]` | Resolve relative snapshots against the selected root and validate identity, scope and totals. Incompatible overall deltas remain explicit with nonzero exit. |
| `interlinked metrics score [--profile structure-v1] [--cwd <path>] [--json\|--short\|--full]` | Explained composite and individual burdens, explicit evidence bounds and ranking eligibility; full/JSON adds every retained action and evidence gap. Legacy structure profile remains selectable. |
| `interlinked metrics arch [--cwd <path>] [--json]` | Import graph statistics including isolated modules; graphVersion 2 retains N² propagation cost and adds normalizedReach with N(N−1). |
| `interlinked metrics split-plan <file>` | Where to cut one over-cap file: 2–4 cohesive modules from the intra-file reference graph. |
| `interlinked coverage check [--strict] [--changed-files a,b] [--report <p>] [--update-baseline] [--json]` | Full-suite per-file coverage ratchet vs `coverage-baseline.json`. ADVISORY by default (exit 0 with findings); `--strict` exits 1 on any per-file drop; `--changed-files` scopes to a comma-separated list (what the pre-push hook passes). |
| `interlinked coverage check --from-index [--index-store <root>] [--timeout <ms>] …` | The same ratchet over the coverage INDEX: only changed test shards re-run, the rest of the universe is reused (full-shaped summary). Exit 75 = no verdict (the index could not certify); one `coverage:index` stage row. The pre-push hook runs it in comparison mode only. |
| `interlinked mutation check [--report <p>] [--update-baseline]` | Per-file mutation-score ratchet vs `mutation-baseline.json` (needs a Stryker report). |
| `interlinked mutation measure <file> [--record]` | Measure one source file; `--record` persists a complete, conclusive measured report as an explicit manifest baseline update. Recording is not a clean verdict. |
| `interlinked mutation survivors [--file <substr>]` | Rank open manifest survivors by file, symbol, and mutator. |
| `interlinked mutation saturation [--file <substr>] [--ratchet]` | Per-file saturation from the manifest: `saturated` (every mutant killed or proved equivalent on current symbol hashes), `open`, `unknown` (stale or unmeasured symbols), `unmeasured`, `gone`. `--ratchet` only adds files to `.interlinked/saturation-baseline.json` (a water-line: a removal is blocked). A listed file that is no longer saturated exits 1. Stability, not correctness. |
| `interlinked mutation sweep [--all-eligible] [--measured-before <iso>]` | Re-measure ranked debt or run a restartable full-source census; repeat `--runner-url` for worker lanes. |
| `interlinked mutation cloud submit --request <json> --artifact <bytes>` | Explicitly submit one protocol-v3 job, authenticate acceptance, journal it, and poll once. Requires the ignored local v3 config; does not enable the edit gate. |
| `interlinked mutation cloud submit-edit <target>` | Capture immutable HEAD plus the current regular target as one proposed edit, submit it with deterministic replay identity and `require_established`, journal its authenticated acceptance, and poll once. Never adopts a baseline or enables the edit gate. |
| `interlinked mutation cloud onboard <target>` | Prepare a first-baseline job from a clean immutable HEAD snapshot, persist its exact bytes before network, and activate `adopt_current` only after authenticated acceptance. Does not deploy or enable the edit gate. |
| `interlinked mutation cloud process` | Manually resume at most one due journaled v3 job through the same verified evaluator and journal-before-ack path. A separately opted-in (`background_enabled:true`) harness daemon also runs this single-row processor on a 15-second cadence; autonomous processing is default-off while manifest snapshots are copy-amplifying. Pending/failure retries are durably delayed; eight consecutive failures dead-letter and exit nonzero. |
| `interlinked mutation cloud dead-letters [--limit <1..100>]` | List bounded local job dead letters without claiming or processing them, including the poll/ack phase and token needed for fenced recovery. |
| `interlinked mutation cloud redrive <job-id> --redrive-token <token>` | Make one matching dead letter due again without processing it or returning a verdict; preserves poll-vs-ack phase. |
| `interlinked metrics [--top <n>] [--full] [--include-tests] [--json]` | Measures function tokens, companion tests, coverage, cyclomatic complexity and CRAP. The hotspot limit accepts decimal integers from 1 through 200 and defaults to 25. Full and JSON output retain every projected action and next step. |
| `interlinked debt list \| show <file> \| resolve <file>` | The obligation ledger — coverage / red-suite debts AND `transient` debts (the deferred tsc/registry findings a coordinated edit opens). All three verbs see every kind; `resolve` is the human override for a debt no future edit will clear. |
| `interlinked debt markers [--root <path...>] [--exclude <path...>] [--record [--reason <text>]] [--json\|--short\|--full]` | Scan explicit design-debt receipts in source comments. The default is read-only; `--record` appends a local snapshot and lifecycle transitions. Neither mode consults or mutates the obligation ledger. |
| `interlinked adopt [--dry-run] [--suite-baseline]` | Seed the supported adoption artifacts from the repo's current state (see below; mutation state is excluded). |

`interlinked coverage`/`mutation` need a report on disk first (a coverage run / `stryker run`) —
those runs are slow; don't trigger them incidentally. `interlinked metrics` reports complexity +
companion presence even without a coverage report (coverage columns marked unavailable).

Coverage readers validate nested report data before using it in ratchets. Partial summary
entries may omit a metric; a present metric must have the expected numeric fields. Malformed
entries are excluded rather than trusted through a type assertion. Missing or rejected data
does not establish coverage, and must not be described as a clean measurement.

## Automatic obligations vs manual debt markers

The `debt` namespace has two deliberately separate records:

- `debt list/show/resolve` reads the harness-created, pair-scoped obligation ledger. A coverage,
  red-suite, or transient finding opens that debt automatically, and future work can clear it.
- `debt markers` scans source comments that a human or agent explicitly wrote to document an
  accepted shortcut and its upgrade boundary. A default scan is read-only and its report
  confirms `read_only: true` and
  `obligation_ledger: { consulted: false, mutated: false }`.

A valid marker is a source-aware comment whose payload is one JSON object:

```ts
// interlinked-debt: {"id":"cache-bound","decision":"single-process cache","ceiling":"one process","trigger":"p95 > 50ms","owner":"platform","issue":"OPS-42","review_after":"2026-11-01","finding":"review-42"}
```

Use either `decision` or its `shortcut` alias, plus a non-empty `ceiling` and a measurable
`trigger` containing a comparison or threshold. `id`, `owner`, `issue`, `review`,
`review_after`, and `finding` are optional. An explicit `id` keeps marker identity stable across
source moves and content changes; it must be unique. `review_after` is a real ISO calendar date,
and `finding` links to an id in the local common findings corpus. Duplicate ids, stale reviews,
missing linked findings, malformed JSON, missing/ambiguous fields, unknown fields, and prose-only
triggers such as “when needed” are advisories, not blocking findings. Ambiguous duplicate-id
markers are omitted from the valid-marker set until their ids are made unique.

The scanner recognizes each supported language's actual line-comment syntax, ignores ordinary
string literals plus JavaScript/TypeScript templates and Python triple-quoted strings, and
excludes generated, vendor, docs, examples, fixtures, build output, and dependencies by default.
An outside-project `--root` is skipped and counted; it is never traversed. A marker fingerprint
survives unrelated line movement; the separate content fingerprint detects semantic changes. The
report also carries repository root, HEAD, tree, exact scanned paths, and working-tree provenance.
`--exclude` adds repo-relative exclusions and `--root` narrows coverage. Always report the
coverage receipt with the marker count.

Recording is explicit:

```bash
interlinked debt markers --record --reason "capacity review"
```

`--record` appends the source snapshot to
`.interlinked/debt/manual-marker-snapshots.jsonl` and derives `opened`, `changed`, and `closed`
transitions against the prior valid snapshot. Source remains authoritative: changing a marker's
semantic payload changes it, and deleting its source comment closes it on the next explicit
record when the selected coverage proves absence. Narrow or incomplete scans preserve unknown
prior markers. The v2 fingerprint binds the previous receipt, timestamp, reason, raw scan,
materialized state, and transitions; readers also independently derive the lifecycle and skip
content-addressed but impossible rows. Recording never edits source, never applies a fix, and
never reads or writes the automatic obligation ledger. `--reason` requires `--record`;
`--record --json` keeps stdout as the canonical scan report rather than wrapping it in persistence
metadata.

## Baselines & direction rules (`.interlinked/`)
The integrity gate matches these eight files; direction is **per-file**:

| File | Direction (what's blocked) |
|---|---|
| `coverage-baseline.json` | pcts may only **rise** (`interlinked coverage` CLI). |
| `coverage-edit-baseline.json` | fraction may only **rise** (per-edit gate high-water). |
| `mutation-baseline.json` | score/killed may only **rise**. |
| `large-files-baseline.json` | `max_lines` may only **fall**; a grandfather count may only **shrink**; a new over-cap entry is blocked. |
| `untested-files-baseline.json` | `min_coverage_pct` may only **rise**; `files` is an **exemption list** → may only **shrink**. |
| `metric-caps.json` | `max_*`/`crap_threshold` may only **tighten**; `min_coverage` may only **rise**. `max_function_tokens` also has an absolute 500 ceiling. Includes `max_predicate_drift` — see below. |
| `skipped-tests-baseline.json` | `max_skipped` may only **tighten**; a grandfather count may only **shrink**. |
| `mutation-manifest.json` | the accepted-survivor set may only **shrink**. |
| `function-complexity-baseline.json` | per-function grandfather ledger (cyclomatic / cognitive): a recorded value may only **fall**, an entry may only be **dropped**; new entries enter only through `caps ratchet` on a tightening; Write-tool creation is refused. A listed function may hold or shrink at its value; an unlisted over-cap function blocks even when held. When the cap in `metric-caps.json` is tighter than the ledger's, the block says so and names `caps ratchet <metric> --to <cap>`. |

## Adopting on a legacy repo — `interlinked adopt`

Seeds the supported non-mutation water-lines from the repo's **current** state so day-1 gates become ratchets
("everything can only improve from here"). Human-invoked `fs` writes, so it bypasses the
integrity gate (the sanctioned carve-out). Idempotent and **never loosens** — a re-run refuses
to grandfather a *new* offender (decompose/cover it instead). Steps: (1) trigram index,
(2) large-files grandfather list, (3) untested-files exemption list, (4) coverage baseline from
any existing report (never runs the suite), (5) metric-caps defaults (only if absent),
(6, opt-in `--suite-baseline`) run the suite once to record red/green. `interlinked doctor` flags
missing adoption artifacts. **It does not seed `mutation-baseline.json` or
`mutation-manifest.json`.** The report ratchet is seeded explicitly with
`interlinked mutation check --update-baseline`; the live gate establishes a file floor on its
first measured sighting. The lower-level brownfield manifest adoption helper is not wired to a
public `interlinked mutation adopt` command.

## Gotchas
- **The advisory file-size preference is ONE number.** `DEFAULT_MAX_LINES` (code) and `max_lines`
  (large-files-baseline) are pinned equal by a test; `metric-caps.json → max_lines` overrides
  both. `caps set lines` changes the review threshold, not a source-edit gate.
- **The function-token cap is canonical, not model-specific.** Use `caps set function-tokens`
  to tighten it. Do not infer pass/fail from MiniLM, Nomic, llama.cpp, or another model tokenizer.
- **Lowering a baseline is exactly what the integrity gate stops.** If you're blocked editing a
  baseline, you're doing the gate-gaming move. Intentional reset:
  `INTERLINKED_DISABLE_BASELINE_GUARD=1`.
- **Cyclomatic & per-edit-coverage gates have no bypass and no suppression** — decompose/test is
  mandatory. (`per_edit_coverage.enabled:false` in `guard-rules.local.json` is a repo-wide
  policy opt-out, not a per-edit escape. Record the rationale next to it as
  `disabled_reason` or `_note`: the Stop-phase `[interlinked:gate-reach]` line stays loud
  about the zero reach but reports "OFF by recorded decision" with that text instead of
  asking you to record why on every Stop.)
- **Mutation has two configs and two states.** `check-policy*.json → mutation_gate` controls the
  report score floor; `guard-rules*.json → per_edit_mutation` controls the live survivor gate.
  `mutation-baseline.json` and `mutation-manifest.json` are not substitutes.
- **Interlinked does not choose the mutator strength.** Use and pin the mature native engine for
  the target language (Stryker for this JS/TS repo) plus its operator set and test scope; changing
  any of them can make scores incomparable without changing the Interlinked baseline schema. The
  proposed Interlinked-owned cross-language/text mutator is backburner calibration work, not a
  substitute for native-engine evidence today.
- **`mutation accept` REFUSES every prose accept — do not plan around it.** (Corrected
  2026-08-07; the previous text here described behavior that no longer exists.) Since typed
  dispositions, `equivalent` status requires a verifier-issued certificate bound to the
  mutant's current symbol hash, and the CLI cannot mint one — so
  `interlinked mutation accept --file <p> --id <mutantId> --reason <why>` reports the refusal
  and exits non-zero, whatever the reason says. A reason is not a mechanism.
  **Consequence to know before promising anyone a number:** a survivor's only recordable
  end-states are *killed* or *unjustified*, so an "unjustified survivors" count can never fall
  below the survivor count. Kill the mutant with a test, or delete the code if the mutant is
  unkillable because the code should not exist. (`interlinked mutation disposition --list
  dead_code` lists the certificate-free judgments — `dead_code`, `unresolved`; for the
  reachability layers of dead code — unreachable files, unused imports/exports — the
  whole-repo sweep is `interlinked deadcode`, 2026-08-17.) Hand-editing the manifest
  remains blocked by the integrity gate.
  Use it only for mutants with no observable behavior change; agent-facing message prose is
  behavior in this repo, so assert it instead of accepting. Campaign guidance:
  `docs/plans/15-survivor-elimination-campaign.md`.
- **Cyclomatic policy judges the resulting code.** The former +2-per-edit slew is removed;
  hard caps, grandfathered debt and coverage/CRAP obligations remain. Simplify decisions or
  extract a cohesive responsibility when necessary; avoid trivial forwarding helpers.
- **`tsgo` ≠ `typescript` for the AST gate.** The cyclomatic/CRAP gate parses with the optional
  `typescript` compiler API; `tsgo` is typecheck-only with no importable JS API. Installing with
  `--omit=optional` makes the cyclomatic gate fail open to the regex walker AND leaves the
  `self_import` pre_block check **NOT MEASURED**: it reports no findings rather than guessing
  from a line scanner, and every JS/TS edit then carries a `[interlinked:self_import] NOT
  MEASURED` warning (the daemon startup warning names both degrades). A clean edit in that state
  was not scanned for self-imports — keep `typescript` installed. Python needs `radon` on PATH.

## Quick reference
```bash
interlinked caps                       # current caps + provenance
interlinked metrics --top 10           # token distributions + top function/file outliers
interlinked metrics --json             # exhaustive functionTokenMetrics inventory
interlinked adopt --dry-run            # preview seeding a legacy repo
interlinked coverage check             # full-suite coverage ratchet (advisory: exit 0)
interlinked coverage check --strict    # same, exit 1 on any per-file drop (pre-push uses --changed-files)
interlinked mutation check --report reports/mutation/mutation.json
interlinked mutation baseline          # inspect report-ratchet high-water scores
interlinked mutation survivors --short # rank live-manifest survivor debt
interlinked debt markers --full        # explicit source-comment debt + coverage
interlinked debt markers --record --reason "reviewed" # append source snapshot + transitions
```

## References

Read a reference file only when the task needs it.

- [references/gates-detail.md](references/gates-detail.md): language coverage and Python test-first naming, refactor readiness, Python and Vitest coverage-gate internals, the `self_import` and batch type-check detail, and evidence qualification additions.
- [references/expression-readability.md](references/expression-readability.md): `interlinked metrics expressions` and `.interlinked/readability.json`.
- [references/e2e-coverage-water-line.md](references/e2e-coverage-water-line.md): the e2e coverage lane and its baseline in the Interlinked CLI checkout, and behavioral contracts beside metric gates.
- [references/mutation-live-gate.md](references/mutation-live-gate.md): how the live per-edit survivor gate measures a file, and `baseline_adopted`.
- [references/mutation-cloud-v3.md](references/mutation-cloud-v3.md): `mutation cloud`, runner connection and sharding, protocol-v3 durable jobs and the mutation journal.
- [references/mutation-campaigns.md](references/mutation-campaigns.md): source-only mutation research helpers, the full-manifest census and survivor rounds.
- [references/metrics.md](references/metrics.md): ranks and commit-risk nudges, the function-token inventory, model-free scoring, evidence runs, this repository's pre-push gate and the coverage index.
- [references/decision-metrics.md](references/decision-metrics.md) covers changed-function evidence, declaration-level complexity, frozen finding assessments and directional Astra reference reviews in the experimental `metrics decisions` namespace.
- [references/baselines-detail.md](references/baselines-detail.md): decomposition campaigns, the SessionEnd baseline auto-fold and `max_predicate_drift`.
- [references/lint-debt-adoption.md](references/lint-debt-adoption.md): `interlinked lint import` and the lint-debt baseline.
- [references/dead-code.md](references/dead-code.md): dead-code controls, evidence layers and deletion buckets.

## Related skills
- **interlinked-verify** — the content gate (pre_block/biome/tsc) and how to land edits.
- **interlinked-harness** — the general guard, suppression grammar, cold fallback.
- **interlinked-observability** — `interlinked metrics` and recurrence for finding hotspots.
- **interlinked-simplification** — advisory delete/stdlib/native/YAGNI/shrink review and audit.
