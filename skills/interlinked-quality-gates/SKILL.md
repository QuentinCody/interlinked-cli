---
name: interlinked-quality-gates
description: "Configure and respond to Interlinked's metric ratchets: line-count, per-function canonical-token count, cyclomatic complexity, coverage, CRAP, baseline integrity, the report-based mutation-score ratchet, the live per-edit mutation survivor gate, and experimental protocol-v3 durable mutation jobs. Load this for a quality-gate block; `caps`, `coverage`, `mutation`, `mutation cloud`, automatic debt obligations, manual `debt markers`, `metrics`, or `adopt`; a lowered-baseline refusal; choosing mutation cadence/scope/strictness; configuring `mutation_gate` or `per_edit_mutation`; connecting/sharding a mutation runner; operating the durable mutation journal; or interpreting `[interlinked:mutation]` and `[mutation:not-measured]`. Water-lines only tighten: meet the bar rather than lowering the baseline."
---

# interlinked-quality-gates — the metric ratchets

Every quality metric is a **water-line** stored in a JSON file under `.interlinked/`. The gates
enforce **"may only move in the tightening direction"**: coverage/mutation scores may only rise;
caps may only fall. The harness raises water-lines itself (internal writes); **an agent
hand-lowering a water-line is the canonical gate-gaming move and is blocked.** North star:
~100% coverage paired with mutation testing.

**When a gate blocks you, the correct move is always to meet the bar — decompose, add a test,
cover the line — never to loosen the baseline.** The strict gates (cyclomatic, per-edit
coverage) have **no suppression and no env bypass**; decomposition or a test is the only way
past. The habit that pays here is **decompose-first**: extract helpers *as you write* branchy
functions, rather than waiting for the gate to block. (Measured on the harness's own repo
across 17+ sessions of the strongest available models, at an identical per-edit rate — so it
is a property of how models write branchy code, not of one codebase.)

## The gates you bump into at edit time
These run before an edit lands. The local metric ratchets use **delta semantics**: holding or
reducing existing debt is allowed. Per-edit mutation is separately configurable as off, warn,
or block.

| Gate | Blocks when | Threshold | Correct response |
|---|---|---|---|
| **Line cap** | a Write/Edit grows a *cappable* file past its ceiling | **500** lines (`DEFAULT_MAX_LINES`) | Decompose into a re-exporting entry + sibling modules |
| **Function tokens** | an edit introduces or grows an implementation above the inclusive canonical-token cap | **500** tokens; no per-edit slew allowance | Extract cohesive helpers; an already-over-cap function may hold or shrink |
| **Cyclomatic — over cap** | edit adds/raises a function over the hard cap | shipped **25**; this repo overrides to **22** | Extract cohesive branches into named helpers |
| **Cyclomatic — slew** | a uniquely-named ≤cap function jumps **>2** branches in one edit | tolerance **2**/edit | Extract cohesive branches into named helpers; do not stage one logical complexity increase across edits |
| **Cognitive — over cap** | edit leaves a function over the cognitive cap | **30** | Flatten: guard clauses, extract the deepest-nested block |
| **Cognitive — slew** | a uniquely-named ≤cap function jumps **>4** cognitive points in one edit | tolerance **4**/edit | Flatten rather than extract-in-place; a branch pulled out unchanged keeps its nesting cost |
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
| **Baseline-integrity** | a Write/Edit *loosens* any `.interlinked/` water-line | per-file direction | Meet the bar; don't edit the baseline |

**Modes ladder the philosophy-dependent gates (2026-08-17).** `interlinked mode`
writes gate posture into `guard-rules.json` alongside its check-policy overrides:
`strict` = new-file TDD gate blocks + characterize-before-touch blocks +
per-edit coverage strict (no debt); `balanced` = both TDD-family gates warn +
coverage debt mode; `lenient` = TDD/characterize gates, per-edit coverage, and
session-end nudges off. Findings still surface as warnings in lenient; security
rails and every tighten-only ratchet ignore the mode. Hand edits to
`guard-rules.json` win until the mode is re-applied.

**Refactor-readiness additions (plan 25, 2026-08-17).**
- `characterize_before_touch` (`structural_checks.characterize_mode`): editing
  a file on the untested list asks for a characterization test FIRST — capture
  today's behavior with exact assertions, then change it. Same
  `// interlinked-tdd: exempt` escape as the new-file gate.
- Ratchet-family dimensions: `seam_ratchet` (ambient clock/random/env reads
  must not rise) and `assertion_strength_ratchet` (an edit may not add weak
  matchers without adding exact ones, test files only).
- `new_import_cycle` (structural, default warn): fires the moment an edit
  closes a module cycle that did not exist before.
- Advisory portability family: `dynamic_code_execution`,
  `builtin_prototype_mutation`, `float_equality_comparison`, plus
  `test_contract_annotation` (mutation-directed files only) and
  `unvalidated_input_boundary`.
- Class-2 knobs: `per_edit_mutation.max_test_scope` (default 150) and
  `per_edit_coverage.drop_epsilon` (default 0.005) — engine budgets, tunable;
  the slew tolerances and daemon timings deliberately are not.

**Line cap** — three surfaces, one policy: PreToolUse block (pure before/after delta — shrinking
or holding an over-cap file is always allowed, the refactor-down path), a `large_files` verify
check, and a `[interlinked:file-size]` PostToolUse nudge. **Cappable = hand-written code only**;
exempt: `.d.ts`, anything under `.interlinked/`, root `scratch/`, non-code extensions
(md/json/yaml/toml/html/…), generated files (`.gen.`/`generated/` path or `@generated`
content), test/spec paths, and `@codegen-data`-marked modules.

**Function tokens** — a deterministic, model-independent size cap. Interlinked counts complete
implementation spans with the versioned `interlinked-code-v1` lexer: comments and whitespace do
not count, while code tokens do. The shipped ceiling is inclusive (`500` passes, `501` is over)
and may be ratcheted down but never raised above 500. The edit comparison has brownfield delta
semantics: a pre-existing over-cap function may hold or shrink, but may not grow; a new or newly
over-cap function blocks. TypeScript/JavaScript and Python have exact adapters. Unsupported or
unavailable languages fail open with a visible `not-measured` warning because heuristic spans are
not eligible for a hard block. There is no suppression or model-tokenizer fallback.

This count is not an embedding context-window estimate. `interlinked semantic` records a selected
model's separate `modelTokens` value and chunks inputs that do not fit; semantic availability,
scores, and tokenization never affect this gate. See **interlinked-semantic-index** for that surface.

**Cyclomatic** — strict, **no override**. Over-cap uses an identity-free multiset compare (a new
over-cap function, or raising one past the cap, blocks); sub-cap limits a named function to +2
branches/edit. JS/TS via the TS AST, Python via `radon`, other languages skipped. **Fails open
(allows) + warns loudly** when the analyzer is unavailable — never a silent skip.

**Cognitive** — same three rules, promoted from warn-only to blocking 2026-08-01 (measured p99 26
vs cap 30). Two ways it is *stricter* than cyclomatic: uniquely-named functions are compared by
identity rather than rank, so relocating complexity into a newly-created over-cap helper still
blocks; and the remedy is flattening, not extraction — pulling a deeply-nested branch into its
own function unchanged carries the nesting cost with it. Run `interlinked caps` for live values;
the numbers in this table are the committed defaults, not a promise about your repo.

**Per-edit coverage** — default **ON**. Runs the *affected tests only* under a scoped overlay,
then decides: red-bar (default on) → uncovered-added-line → per-file coverage drop vs
`coverage-edit-baseline.json` → `min_coverage` floor → CRAP (default on). With default
`debt_mode:true`, the first uncovered or red result opens a pair-scoped debt and the edit lands;
keep working in that source/test pair until it is covered and green. The commit gate remains the
ground-truth backstop.

**CRAP** = `cyclomatic² · (1 − coverage/100)³ + cyclomatic`, where coverage is a percentage.
Full coverage reduces the score to cyclomatic, but low coverage can exceed the default threshold
even at modest complexity (complexity 5 at 0% coverage scores 30). Treat complexity and coverage
as independent levers; neither cap alone guarantees a safe CRAP score.

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
`--update-baseline`, and `--json`; `--baseline` is accepted but the handler still reads the
standard `.interlinked/mutation-baseline.json`. Internal `minScore`/`changedFiles` support is not
registered as public CLI flags.

The score is `killed / (killed + survived)`. Timeout, no-coverage, compile-error, and
runtime-error mutants are excluded from that denominator; inspect the engine report instead of
reading a high score as proof that every mutant was conclusively measured.

Interlinked decides only the **ratchet verdict**. Configure how much mutation work happens in the
engine: Stryker's `mutate` paths/ranges, test runner and selected tests, mutator exclusions,
concurrency, timeouts, coverage analysis, and incremental mode. There is no Interlinked
`light|standard|full` preset.

### Current dogfood and cloud boundary (2026-08-31)

The local synchronous runner can be exercised without enabling the edit gate
or changing a manifest:

```bash
interlinked mutation measure src/path/to/file.ts \
  --runner-url http://127.0.0.1:8790 --budget-ms 180000
```

Omit `--record` for a read-only smoke test. A successful command proves that
the selected local runner completed this one measurement; it does not prove
that background delivery, cloud tenancy, or the live hook path is ready.

An HTTP 200 alone is not a recordable measurement. `measure` and sweep label a
syntactically readable but incomplete response `PARTIAL — NOT RECORDED`, show
any parsed mutants/survivors for diagnosis, and withhold the raw report from the
write path. `--record` moves the manifest only when the response names the exact
target and source, reports engine exit 0, proves a green test run with more than
zero executed tests, loses zero mutant rows during parsing, and has a non-zero,
conclusive whole-file census. On an existing baseline, every prior mutant in an
unchanged symbol must also remain in that census. The record function repeats
these checks itself, so callers cannot bypass them by invoking the writer
directly. Missing, malformed, red, stale, truncated, timeout, and indeterminate
evidence remains visible but cannot establish or replace a baseline.

Protocol v3 now has a digest-pinned evidence contract, authenticated local
adapter, SQLite leases/journal-before-ack primitives, and strict cloud HTTP
submission/claim clients. The manual, explicit opt-in CLI composition is:

```bash
interlinked mutation cloud submit \
  --request scratch/job-request.json --artifact scratch/source.bundle
interlinked mutation cloud submit-edit src/path/to/file.ts
interlinked mutation cloud onboard src/path/to/file.ts
interlinked mutation cloud process
```

All four commands require `.interlinked/mutation-cloud-v3.local.json` (or
`--config`) with `version:1`, `enabled:true`, one HTTPS endpoint, project /
claimant / owner identities, timeouts and lease duration, the pinned contract
digest and key registry, independently configured server authority, evaluator
policy version, and site limit.
The configured digest must equal the contract identity compiled into this CLI
build; agreement between a config file and a remote service is not sufficient,
and a mismatch is refused before source upload, admission, or evaluation.
These four durable-journal verbs require Node
22.5 or newer because they use the built-in `node:sqlite`; importing or using
other CLI commands does not open that runtime. The separate
`background_enabled` field defaults to `false` and is not required for any
manual command. `submit` authenticates cloud acceptance before
the job enters `.interlinked/mutation-journal.sqlite`, then makes ONE immediate
claim attempt. `submit-edit <target>` is the bounded convenience path for one
current proposed target: it rejects symlinks and unsafe paths, captures immutable
HEAD plus exactly those current target bytes, selects tests only from that synthetic
snapshot, and submits the parser-minted request plus its exact archive and target.
Its deterministic job key makes an exact retry idempotent, while a changed target,
HEAD, authority, artifact, scope, or test set produces a different job. It always
uses `require_established`; it cannot establish its own baseline, adopt current code,
or enable the live gate. `process` resumes at most one job through claim → authenticate →
the shared local evaluator → atomic SQLite decision/manifest/receipt/run/outbox
commit → remote ack. A failed ack leaves the committed row recoverable; none of
these verbs enables `per_edit_mutation` or changes its mode.

`onboard <target>` is the separate, safe first-baseline path. It refuses any
staged, unstaged, or untracked change; binds the configured repository identity,
a stable immutable HEAD, and a tracked regular-file target; builds a bounded,
versioned `git archive` and selects tests only from its materialized HEAD snapshot.
The protocol binding names that byte format exactly as `git-archive-tar-v1`;
the request, acceptance receipt, and execution receipt all hash-bind the same
format/hash/length tuple, so a cloud executor must decode that format and must
never infer an archive type from content or a filename.
Before any network call it persists a fresh random job key plus the exact request,
archive, and target bytes as an unclaimable schema-v7 prepared intent. Only an
authenticated acceptance activates that intent atomically as a normal pending job
with `adopt_current`; reopen/replay reuses those exact bytes and rejects drift.
Ordinary `cloud submit` remains `require_established` and cannot carry adoption
intent. Onboarding does not deploy infrastructure or enable the live edit gate.

Schema-v6 authenticated evidence retains the canonical envelope, receipt, and
terminal JSON plus exact report BLOB bytes for offline re-verification, with the
journal commit completed before remote acknowledgement.

Schema v8 scopes the authoritative protocol-v3 manifest head by the exact
authenticated tenant, project, and repository. Switching any of those values is
a baseline miss, never reuse of another authority's state; reopening with the
same values reuses the same head. Upgrading a pre-v8 journal deliberately leaves
the old unscoped singleton head as historical data and creates no attributed
head from it. Ordinary v3 runtime startup does not scan or import
`.interlinked/mutation-manifest.json` or the legacy JSONL stores at all, so a
large, changing, corrupt, or unreadable legacy file cannot grow the SQLite
journal or block startup. The internal explicit audit-import seam is bounded to
256 KiB per file and 512 KiB total; larger files record only bounded metadata
and an `oversized` skip reason. Whether captured or skipped, legacy bytes never
mint or replace v3 authority state. After that migration, run authenticated
`mutation cloud onboard <target>` for each target whose v3 baseline should be
established; `submit` and `submit-edit` remain `require_established` and cannot
bootstrap from legacy state.

Schema v9 applies that same authority boundary before a queue lease is minted.
Both keyed immediate processing and background `process` claims require exact
tenant, project, and repository columns written with the job; runtimes sharing
one local journal cannot claim one another's rows. Pre-v9 job rows are preserved
for audit but deliberately receive no inferred authority, remain unclaimable,
and are not automatically resumable; preserve/review them separately rather
than treating them as v3 work for the configured authority. Onboarding lookup
and uniqueness use the full tenant/project/repository/commit/target tuple, so
the same repository commit and target may establish independent baselines for
different authorities. Existing onboarding rows migrate using the tenant and
project values already persisted and request-bound in those rows; no authority
is reconstructed from a response.

The authority key intentionally excludes contract digest and evaluator policy
version. The head stores mechanical mutant identities and statuses, not an old
clean verdict or policy decision. Each result is authenticated under the
currently pinned contract and evaluated under the current policy; missing
prior mutants in unchanged symbols produce not-measured rather than clean.
Evaluation rows and receipts retain the evaluator policy version separately.

The CLI resolves the request, source artifact, target source, and local config
through real paths under the repository root before opening the journal. Each
local input is opened once with no-follow semantics where the host supports
them, then regular-file identity, size, and repository confinement are checked
on that same descriptor before and after a bounded read. Final-component
symlinks are refused even when they point back inside the repository; a path,
inode, parent-link, or size change during the read also refuses the operation.
Protocol-v3 source artifacts are capped at 64 MiB, reports at 16 MiB, target
source at 2 MiB, request JSON at 1 MiB, and the ignored local config at 64 KiB;
remote JSON responses are capped at 8 MiB. These limits are enforced while
reading streams even when `Content-Length` is missing or dishonest, so an
oversized response is **not measured**, never a clean result.

The SQLite queue persists a `next_attempt_at_ms` for every deferral so one old
job cannot monopolize `process`. A normal not-ready response waits one second
and clears the consecutive-failure counter. Operational, parse, evaluation,
commit, and acknowledgement failures retry after 1, 2, 4, 8, 16, 32, then 60
seconds (the delay remains capped at 60 seconds). The eighth consecutive
failure dead-letters the row, preserves its last stage-qualified error, and
exits nonzero with “no clean verdict exists”; it is no longer auto-claimed.
Running `process` before a row is due returns idle rather than hot-looping.
Inspect and token-fence recovery through the public local operations:

```bash
interlinked mutation cloud dead-letters --limit 20
interlinked mutation cloud redrive <job-id> --redrive-token <token>
```

The list limit defaults to 20 and must be from 1 through 100. It reports each
row's poll-vs-ack phase, failure count, last error, and current redrive token.
Redrive only clears the dead-letter state and makes the row due; it does not
claim, process, evaluate, acknowledge, or return a verdict. A poll row resumes
polling and an evaluated row resumes acknowledgement-only when a later
`mutation cloud process` invocation claims it. A stale token is refused.

The explicit commands remain available for inspection and recovery with
`enabled:true`. Autonomous daemon work has a second, default-off boundary:
only a local config that also sets `background_enabled:true` starts the
daemon-owned scheduler. This second opt-in is experimental while each terminal
job still copies the full manifest into an append-only journal snapshot. Leave
it false until bounded/delta manifest storage and retention land. When it is
explicitly enabled, every 15 seconds while the harness daemon is running the
scheduler processes at most one due job and delivers at most one committed
finding. Delivery fsyncs a versioned record to
`.interlinked/mutation-findings.jsonl` before acknowledging the exact SQLite
outbox lease. The stable `outbox_id` makes retries safely deduplicable; every
session active at delivery time queues the bounded finding for its next hook
event (subject to the in-memory queue's 10-minute TTL). With no active session
the durable JSONL row still exists, but the daemon does not currently replay
that file into a later-created session.

This local scheduler is **not** the protocol-v3 live edit gate or proof of a
deployed cloud product. The cloud deployment still needs provisioned
D1/R2/Workflow/private-Sandbox bindings and an isolated executor, followed by
the deployed crash/retry/adverse acceptance matrix. Until that cutover is
atomic, the live gate remains the legacy synchronous v2 path and the old late
harvest remains survivor-only evidence.

Protocol-v3 signing authority is split across that deployment boundary. The
control plane may sign admission plus pre-execution terminalization and its
matching failure result; it must not possess the runner private key. The
isolated executor signs every execution receipt and matching execution result
before returning its service artifact. Verification requires the result signer
to be the same key that signed the receipt for that arm, so a control key cannot
mint measured execution and a runner key cannot approve admission or
terminalization. Only the runner public key is configured in the control
Workflow; provisioning the private runner key in the separate executor remains
a release prerequisite, not something `mutation cloud` commands do locally.

A protocol-v3 durable first sighting defaults to **not measured** when no
baseline exists. It may adopt only when the caller explicitly marks a
background onboarding measurement of current code; a proposed per-edit job
must never establish its own floor.

### Live per-edit survivor gate

The shipped default is off. Opt in under `.interlinked/guard-rules.json` for team policy or
`.interlinked/guard-rules.local.json` for machine-local runner topology/credentials:

```json
{
  "per_edit_mutation": {
    "enabled": true,
    "mode": "warn",
    "unavailable_behavior": "allow_unmeasured",
    "site_count_threshold": 25,
    "budget_ms": 10000,
    "harvest_budget_ms": 15000,
    "runner_url": "https://mutation-runner.example"
  }
}
```

| Knob | Effect |
|---|---|
| `enabled` | Master opt-in. `false` does no live mutation work. |
| `mode` | `block` rejects measured findings; `warn` runs the same measurement but allows with warnings; `off` is a no-op. |
| `unavailable_behavior` | `allow_unmeasured` preserves continuity with `[mutation:not-measured]`; `block` fails closed when no verdict is available. |
| `site_count_threshold` | Maximum distinct changed-symbol mutation sites in one established file before "split this patch"; default 50. |
| `budget_ms` | Initial runner round-trip ceiling; default 25,000 ms. Expiry is not a pass. Harvest of an expired run works only when the configured runner implements the durable job protocol; the current experimental Cloud Worker does not, so its expired runs are simply not-measured. |
| `harvest_budget_ms` | PostToolUse wait for an over-budget pending run; default 25,000 ms. A harvest that comes back with nothing is reported as **survivor-only evidence, NOT clean** (2026-08-27): the late path carries back survivors and nothing else — no test-run, engine-exit or mutant-census evidence, and it does not go through the evaluator the synchronous path uses — so "no survivors" is equally consistent with a run that executed no tests. Read that message as "nothing adverse was reported", never as a pass. |
| `runner_url` | THE mutation-runner endpoint (exactly one). No endpoint means unavailable, not clean. |
| `runner_urls` | OBSOLETE (2026-08-27): line-range sharding is retired from v1 — a mutant spanning a range split vanished from both sides. Extra entries are NOT used (no partition, no failover) and the daemon logs a deprecation warning. Remove them. |
| `token` | Optional bearer credential. Keep it in the gitignored local rules file, never committed policy. |

Every v1 run measures the WHOLE FILE (the runner receives no line range; the
incremental cache is explicitly off on the wire); the evaluator still judges
only changed symbols. Scope is deliberately narrow: JS/TS product source
(`.ts/.tsx/.js/.jsx/.mjs/.cjs`) only; test and root `scratch/` paths are
excluded. A change set with MORE THAN ONE eligible source file returns
not-measured (MUT-AC-26) — today's tool adapters are single-file, so
multi-file shapes (apply_patch, CLI batch) are simply NOT measured yet;
adapters are open work. A **NEW file** (no on-disk baseline) is likewise
reported as not-measured naming the file, rather than passing silently
(2026-08-27): with no prior manifest entry every mutant is first-sighting,
which is baseline ADOPTION, not evidence this edit is safe — and the silent
version made brand-new untested code the one edit that skipped the gate with
no trace. It ships the full proposed change set, companion
test, and local dependencies as
overlays; the runner measures that primary file, while the ratchet judges mutants in changed
symbols. There is no sharding in v1: the range-split prototype was retired because a mutant
whose span crossed a shard boundary vanished from both sides. A future partial-scope design
lives dormant in plan 27 Appendix B and would need sharded-vs-whole-file census equality
proven before it can return.

The first measured sighting of a file is a distinct **`baseline_adopted`** outcome (2026-08-28):
it records the accepted floor so brownfield survivors do not make adoption impossible, persists
the manifest, and appends a receipt whose `outcome` field says "baseline_adopted" — it is an
allow with a visible "baseline adopted … NOT certified clean" warning, never a clean verdict
(nothing was compared, because that run created the baseline; "adopted" is declared only after
the persistence callback completes — but the current file-based state (manifest → receipt →
index → ledger, no transaction) can still be PARTIAL after a crash, and a failed persist
downgrades to "measured but NOT fully adopted"; true atomicity waits on the SQLite journal). A
red affected suite still blocks in `block` mode even on first sighting. Later runs flag new
changed-region survivors and uncovered sites, plus killed→survived regressions in unchanged
symbols (the accepted floor never grows from a routine run). Beyond adoption, only a FULL-scope,
fully-conclusive clean run refreshes the manifest and appends a receipt (its receipt says
"measured_clean"). A partial (line-range) run can block on
positive evidence but never certifies clean, never creates a first-sighting baseline, and never
touches the manifest; changed-region timeout/indeterminate results are likewise not-measured.
A report with zero mutants for the target — or no entry for it at all — is not-measured, never
clean: an empty report is not proof of a mutant-free scope.
Certifying clean also requires an explicit **engine exit 0** from the runner (strict since
2026-08-28): a response whose `engine.exitCode` is absent, `null`, or non-zero is not-measured —
a crashed engine's partial report is indistinguishable from a complete one, and its unreached
survivors are exactly what a forged clean pass would hide. A red suite still blocks WITHOUT
engine evidence (the engine legitimately never ran; adverse evidence outranks missing evidence).
It also requires a positive **executed-test count**. A green boolean with an absent, malformed,
or zero count is not-measured: it does not prove that any test oracle actually ran. The live
protocol-v2 gate and `mutation measure [--record]` share this evidence floor; neither may persist
or certify from a zero-test run. The sole v3 exception is an authenticated `not_mutatable`
result with an exact zero-mutant report and a `no_test_policy` approved by the signed acceptance
receipt. That exception reaches the evaluator through an opaque verifier-minted capability, not
a caller-controlled flag, and cannot be used by v2 runners. Proven adverse evidence still wins
first, so a survivor or red suite is reported even when the executed-test count is missing.
Note: Stryker exits non-zero when its score is under `thresholds.break`, so a runner that does
not disable that threshold will produce not-measured runs on valid reports — fail-safe, but
configure the runner's Stryker with `thresholds.break: null`.
Every "could not measure" exit — no runner, runner failure, missing shards, inconclusive
evidence — obeys `unavailable_behavior`. Warn-mode findings never launder the manifest clean.

When the live gate reports:

- **New survivor:** strengthen the assertion, fix the source behavior, or remove dead/over-specific code.
- **Uncovered site:** add a test that executes the changed behavior.
- **Affected suite red:** restore green before interpreting mutation results.
- **Over site limit:** split the patch into smaller behavioral changes with their tests.
- **Not measured:** check runner configuration/reachability, test selection, budget, and the target repo's Stryker setup. Do not describe it as a pass.

### Full-manifest census and survivor rounds

Use `mutation measure <file> --record` for one source file. Use `mutation sweep` for a ranked
survivor batch. For a genuinely current whole-repo manifest, take one cutoff after proving the
exact working tree green, then reuse it across every restart:

```bash
cutoff="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
interlinked mutation sweep --all-eligible --measured-before "$cutoff" --dry-run
interlinked mutation sweep --all-eligible --measured-before "$cutoff" --limit 20 \
  --runner-url http://runner-a:8790 --runner-url http://runner-b:8790 \
  --budget-ms 1200000 --skip-preflight
```

Repeat the second command with the **same cutoff**. Each successful record gets newer provenance
and drops out of the next batch. `--all-eligible` inventories JS/TS product source under `src/`,
including absent and previously measured-clean files; it excludes test/spec paths and `.d.ts`.
Repeated runner URLs create worker lanes pulling from one queue, so one CLI process owns manifest
writes. Use `--skip-preflight` only after this exact overlay/tree passed its suite; otherwise a red
suite can falsely report mutants killed. Keep `not_measurable` and errors as explicit census residue.

After the census, rank work with `interlinked mutation survivors`. Add or strengthen tests in
small file/symbol batches, remeasure each target with `mutation measure --record`, and run an
independent final census from a new cutoff. A baseline is fully current only when every eligible
file has qualifying provenance from that final round; a high score alone does not prove that.

For a file-scoped survivor report, the CLI also prints the mutation-test grounding form. Put one
receipt immediately before every new case in a mutation-directed JS/TS test:

```ts
// test-contract: <public-api|invariant|bug|security|boundary> — <specific reference or rationale>
```

Mutation-directed filenames are dotted policy segments. Canonical forms are
`foo.mutation-kill.test.ts`, `foo.mutation-hardening.test.ts`, and `foo.survivors.test.ts`.
Model/wave qualifiers are allowed directly on the semantic token — for example
`foo.mutation-kill-luna.test.ts` — and remain inside the same strict class. A repo opts into the
blocking profile with `{"mutation_directed_strict_profile":{"enabled":true}}` in
`.interlinked/guard-rules.json` (team policy) or the local rules file. Under that profile,
introduced missing receipts, broad truthiness, missing SUT grounding, and assertion removal are
pre-execution blocks; pre-existing findings remain warnings. Do not rename a file to evade this
classification.

The write hook now surfaces `test_legitimacy` before a mutation-directed test edit lands; then run
`interlinked verify --all-checks --details` for the full audit. The advisory check reviews
missing/generic receipts, broad truthiness, incidental call order, and explicitly private/internal
imports (including multiline named imports); a companion warning catches cast-based private-member
access. Exact CLI/help/policy strings can be the public contract. “Kills mutant X” cannot: a
mutation kill proves sensitivity to an injected fault, not that the asserted distinction is a
supported behavior. The wider branch/partition, property/model, hermetic-repeat,
refactor-resistance, and blinded-review protocol is currently a design workflow, not a shipped
single command; see `docs/design/session-2026-08-11-synthesis.md` Part 6. Do not claim those
evidence layers ran merely because `mutation measure` succeeded.

**Baseline-integrity** — a PreToolUse block on any edit that loosens a water-line file (below).
Pure disk-vs-proposed numeric diff, near-zero FP. Reset an intentional baseline change with
`INTERLINKED_DISABLE_BASELINE_GUARD=1` (logged). A commit-gate backstop closes the
`apply_patch`/subagent hole for the git-tracked baselines.

## Command surface
| Command | Purpose |
|---|---|
| `interlinked caps` | Show effective caps (lines/function-tokens/cyclomatic/crap/coverage) + provenance. |
| `interlinked caps set <lines\|function-tokens\|cyclomatic\|crap\|coverage> <n>` | Retune a cap → `.interlinked/metric-caps.json`. Function tokens cannot exceed 500. |
| `interlinked caps explain [metric]` | Definition, default, fix hint per metric. |
| `interlinked caps ratchet <cyclomatic\|cognitive> --to <n> [--dry-run]` | Tighten a per-function cap AND regenerate the grandfather ledger (`function-complexity-baseline.json`) for everything over it. Only writer of the ledger; `caps set` delegates here when a section exists. |
| `interlinked caps status` | Ledger burn-down per metric: cap, entries remaining, top offenders, delta vs the previous snapshot. |
| `interlinked caps propose` | Data-driven cap proposals from a live census: percentile ladder and the count each candidate cap would grandfather. |
| `interlinked metrics complexity [--metric <m>] [--top <n>]` | Complexity census: percentiles, histograms, hotspots, per-file mass, over-cap counts. |
| `interlinked metrics split-plan <file>` | Where to cut one over-cap file: 2–4 cohesive modules from the intra-file reference graph. |
| `interlinked coverage check [--update-baseline] [--json]` | Full-suite per-file coverage ratchet vs `coverage-baseline.json`. |
| `interlinked mutation check [--report <p>] [--update-baseline]` | Per-file mutation-score ratchet vs `mutation-baseline.json` (needs a Stryker report). |
| `interlinked mutation measure <file> [--record]` | Measure one source file; `--record` persists a complete, conclusive measured report as an explicit manifest baseline update. Recording is not a clean verdict. |
| `interlinked mutation survivors [--file <substr>]` | Rank open manifest survivors by file, symbol, and mutator. |
| `interlinked mutation sweep [--all-eligible] [--measured-before <iso>]` | Re-measure ranked debt or run a restartable full-source census; repeat `--runner-url` for worker lanes. |
| `interlinked mutation cloud submit --request <json> --artifact <bytes>` | Explicitly submit one protocol-v3 job, authenticate acceptance, journal it, and poll once. Requires the ignored local v3 config; does not enable the edit gate. |
| `interlinked mutation cloud submit-edit <target>` | Capture immutable HEAD plus the current regular target as one proposed edit, submit it with deterministic replay identity and `require_established`, journal its authenticated acceptance, and poll once. Never adopts a baseline or enables the edit gate. |
| `interlinked mutation cloud onboard <target>` | Prepare a first-baseline job from a clean immutable HEAD snapshot, persist its exact bytes before network, and activate `adopt_current` only after authenticated acceptance. Does not deploy or enable the edit gate. |
| `interlinked mutation cloud process` | Manually resume at most one due journaled v3 job through the same verified evaluator and journal-before-ack path. A separately opted-in (`background_enabled:true`) harness daemon also runs this single-row processor on a 15-second cadence; autonomous processing is default-off while manifest snapshots are copy-amplifying. Pending/failure retries are durably delayed; eight consecutive failures dead-letter and exit nonzero. |
| `interlinked mutation cloud dead-letters [--limit <1..100>]` | List bounded local job dead letters without claiming or processing them, including the poll/ack phase and token needed for fenced recovery. |
| `interlinked mutation cloud redrive <job-id> --redrive-token <token>` | Make one matching dead letter due again without processing it or returning a verdict; preserves poll-vs-ack phase. |
| `interlinked metrics [--top <n>] [--full] [--include-tests] [--json]` | Read-only whole-repo scan: exhaustive function-token inventory and file aggregates, companion-test, coverage, cyclomatic, CRAP + gate verdicts. |
| `interlinked debt list \| show <file> \| resolve <file>` | The obligation ledger — coverage / red-suite debts AND `transient` debts (the deferred tsc/registry findings a coordinated edit opens). All three verbs see every kind; `resolve` is the human override for a debt no future edit will clear. |
| `interlinked debt markers [--root <path...>] [--exclude <path...>] [--record [--reason <text>]] [--json\|--short\|--full]` | Scan explicit design-debt receipts in source comments. The default is read-only; `--record` appends a local snapshot and lifecycle transitions. Neither mode consults or mutates the obligation ledger. |
| `interlinked adopt [--dry-run] [--suite-baseline]` | Seed the supported adoption artifacts from the repo's current state (see below; mutation state is excluded). |

`interlinked coverage`/`mutation` need a report on disk first (a coverage run / `stryker run`) —
those runs are slow; don't trigger them incidentally. `interlinked metrics` reports complexity +
companion presence even without a coverage report (coverage columns marked unavailable).

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

### Decomposition campaigns (added 2026-09-02)
The gates carry campaign-aware relaxations so a refactor is never blocked by the
metric it improves: the cyclomatic block lists a `↳ plan:` (fewest arm
extractions to get under the cap); per-edit coverage treats a RELOCATED uncovered
line as moved, not added; per-edit mutation reconciles survivors that moved into
an extracted helper; `mutation_directed_assertion_removal` recognizes an assertion
moved to a new test file (`INTERLINKED_ASSERTION_MOVE_WAIVER=1` is the logged
escape). `structural_checks.characterize_mode: block` requires a test run covering
the file before a ledger-listed function is edited. Two advisory nudges catch the
decomposition footguns: `new_export_without_importer` and
`extracted_helper_duplicate`.

### SessionEnd baseline auto-fold (added 2026-08-16)

Three of those water-lines used to go stale, because refreshing them needed a human to
remember a manual full run — measured 2026-08-16, the coverage and untested-files
baselines were 49 and 66 days old, and one `interlinked adopt` dropped 38 exemptions
that had been earned weeks earlier. The daemon now folds the session's own evidence
back in at **SessionEnd**, so the bar tracks the tree instead of lagging it:

| Fold | What it does | Refusal direction |
|---|---|---|
| coverage | raises per-file high-waters from a **fresh** `coverage/coverage-summary.json` | a pct that FELL is held at its high-water, never lowered |
| untested-files | drops the exemption for a file you wrote that now has a companion test | never ADDS an exemption |
| large-files | drops (or lowers) the grandfather count for a file you brought back under the cap | never adds a new entry, never raises a count |

Each fold is independent and skippable; the whole pass is time-bounded (~2s) and never
throws into SessionEnd. When something folds, the session shows one line —
`[interlinked:baseline-fold] coverage +N raised, untested -M dropped, large-files -K dropped`
— and one JSONL row per fold lands in `.interlinked/baseline-folds.jsonl`. A dry run
(`interlinked harness test`) writes nothing.

The fold writes through plain `fs` from inside the daemon, so it does not pass the
PreToolUse baseline-integrity gate — the same sanctioned carve-out `coverage-ratchet.ts`
and `interlinked adopt` use. That is safe only because the loosening direction is refused
in the planners themselves, not merely avoided.

**Opt out** with `{"baseline_autofold": {"enabled": false}}` in
`.interlinked/guard-rules.local.json` (default ON). This does not replace
`interlinked adopt` — adopt still seeds a repo from scratch and folds metrics the
auto-fold leaves alone.

### `max_predicate_drift` — ratchet the unchecked-assertion count to zero (added 2026-08-09)

A repo-wide COUNT water-line, not a per-function cap. It bounds how many
`type_predicate_drift` findings the tree may carry: a hand-rolled
`function isFoo(v): v is Foo` that validates some of `Foo`'s required properties
and silently ignores the rest.

Why it needs a ratchet rather than a block: `v is T` is an **unchecked assertion**.
TypeScript never compares the predicate body to `T`, so adding a required field to
`T` leaves every stale guard returning `true` — no compile error, no test failure.
The count only ever grows by accident, so the water-line only ever falls.

To clear a finding, do not enlarge the guard — replace it with a parser:

```ts
export function parseFoo(v: unknown): Foo | null {
  if (!isJsonObject(v)) return null;
  // …validate each field…
  return { a, b, c };   // CONSTRUCTED literal — the compiler checks it against Foo
}
```

The constructed return is the point: add a required field to `Foo` and this fails
to compile at the boundary instead of under-validating at runtime.

Measure the current count with `interlinked verify --all-checks` (section
"type predicate drift"), then lower `max_predicate_drift` to match. Raising it is
blocked by `baseline_integrity_gate`.

> **Two different "min coverage" numbers:** `metric-caps.json → min_coverage` = the per-file
> **floor for the edit-time gate** (default 0 = off). `untested-files-baseline.json →
> min_coverage_pct` = the threshold deciding whether a companion-less file counts as "tested"
> for the `untested_files` verify check (default 60). And **two coverage baselines**:
> `coverage-baseline.json` (full-suite CLI) vs `coverage-edit-baseline.json` (per-edit gate).
> Editing the wrong one has no effect on the gate you're trying to satisfy.

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
- **The line cap is ONE number.** `DEFAULT_MAX_LINES` (code) and `max_lines`
  (large-files-baseline) are pinned equal by a test; `metric-caps.json → max_lines` overrides
  both. Ratchet down by editing them together (or `caps set lines`).
- **The function-token cap is canonical, not model-specific.** Use `caps set function-tokens`
  to tighten it. Do not infer pass/fail from MiniLM, Nomic, llama.cpp, or another model tokenizer.
- **Lowering a baseline is exactly what the integrity gate stops.** If you're blocked editing a
  baseline, you're doing the gate-gaming move. Intentional reset:
  `INTERLINKED_DISABLE_BASELINE_GUARD=1`.
- **Cyclomatic & per-edit-coverage gates have no bypass and no suppression** — decompose/test is
  mandatory. (`per_edit_coverage.enabled:false` in `guard-rules.local.json` is a repo-wide
  policy opt-out, not a per-edit escape.)
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
- **Do not split one branchy change into multiple edits to evade the +2 slew.** The edit-sized
  tolerance is a regression detector, not permission to accumulate the same design debt slowly.
  Extract a helper or simplify the control flow.
- **`tsgo` ≠ `typescript` for the AST gate.** The cyclomatic/CRAP gate parses with the optional
  `typescript` compiler API; `tsgo` is typecheck-only with no importable JS API. Installing with
  `--omit=optional` makes the cyclomatic gate fail open (silent enforcement gap) — keep
  `typescript` installed. Python needs `radon` on PATH.

## Dead code: two controls, four evidence layers, buckets before deletion

Per-edit detection and repo scanning are SEPARATE controls (operator decision
2026-08-17). The config keys `structural_checks.dead_imports` /
`dead_exports` run on every edit (with `dead_code_action: "flag" | "delete"`
deciding whether the warning reports candidates or instructs the agent to
remove them in the same edit — the harness never deletes code itself). The
verb `interlinked deadcode` sweeps the whole repo on demand, in its own
process, and works with or without any of the per-edit checks enabled.

Four evidence layers, weakest claim first: unreachable files (nothing imports
them — the scan resolves `export … from` barrels and dynamic `import()` edges,
but runtime path-loading stays invisible, so every row is a CANDIDATE), unused
import bindings (same-file evidence, near-zero FP), unused exports (cross-file
inference, type-surface FPs are common), and behaviorally inert branches —
which only the MUTATION lane can prove (`interlinked mutation disposition
--list dead_code`; reachable code whose mutants change nothing observable).

**Never hand a raw candidate list to a deletion agent.** Run
`interlinked deadcode --categorize` first: every candidate buckets by
mechanical signals (git first-import probe, docs/plans references, seam-shaped
names, package.json published surface, test-only importers, re-export shape,
type-only shape). `future-scaffolding` (never imported + doc-referenced —
planned design) and `deliberate-seam` (test seams, published API) are KEEP
buckets; `reexport-residue` and `orphaned-type` are compiler-guarded
deletions; `superseded` carries git evidence of a successor; `ambiguous`
means review, not delete. The buckets exist because the costly error is
deleting planned or deliberate code — a candidate is a lead, a bucket is a
policy.

`interlinked simplify scan/review/audit` composes a bounded subset of these dead-code signals
with other advisory simplification evidence. Its local dead-code adapter deliberately skips
per-candidate Git archaeology for latency, so it does not replace `deadcode --categorize` before
deletion or mutation evidence for behaviorally inert branches. Load
**interlinked-simplification** for its evidence, coverage, recording, and deep-handoff contract.

## Quick reference
```bash
interlinked caps                       # current caps + provenance
interlinked metrics --top 10           # token distributions + top function/file outliers
interlinked metrics --json             # exhaustive functionTokenMetrics inventory
interlinked adopt --dry-run            # preview seeding a legacy repo
interlinked coverage check             # full-suite coverage ratchet
interlinked mutation check --report reports/mutation/mutation.json
interlinked mutation baseline          # inspect report-ratchet high-water scores
interlinked mutation survivors --short # rank live-manifest survivor debt
interlinked debt markers --full        # explicit source-comment debt + coverage
interlinked debt markers --record --reason "reviewed" # append source snapshot + transitions
```

## Related skills
- **interlinked-verify** — the content gate (pre_block/biome/tsc) and how to land edits.
- **interlinked-harness** — the general guard, suppression grammar, cold fallback.
- **interlinked-observability** — `interlinked metrics` and recurrence for finding hotspots.
- **interlinked-simplification** — advisory delete/stdlib/native/YAGNI/shrink review and audit.
