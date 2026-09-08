---
name: interlinked-verify
description: "Run `interlinked verify`, understand the PostToolUse quality checks, and land multi-file edits through the content gate. Load this when you want to check your changes (`interlinked verify` — the on-demand whole-project check run), when a `pre_block` check refused an edit, when you need to land a cross-file refactor without transient tsc errors (`interlinked write --batch` / `multi-edit` / `verify-changeset` and the exporter-before-importers rule), when deciding whether a finding is default-gate or advisory, or when you need to know where to put probe/scratch scripts (`interlinked scratch`). Verify reports ordinary findings with exit 0; an unavailable/deferred run exits nonzero because no verdict exists."
---

# interlinked-verify — check your work & land edits through the gates

Interlinked gates edits at **three moments**, and they run different check sets:
- **PreToolUse content gate**: real agent Edit/Write calls run deterministic `pre_block` checks
  without synchronously launching biome/tsc on the daemon event loop; those external overlays
  are reported as **NOT CHECKED** and run asynchronously after the write. Transactional CLI
  paths (`interlinked write` / `verify-changeset`) still run `pre_block → biome → tsc` and fail
  closed. `interlinked multi-edit` uses the same shared content gate.
- **Other PreToolUse guards** (real Edit/Write only): function tokens, coverage, cyclomatic, CRAP, baseline —
  see **interlinked-quality-gates**; package/allowlist — see **interlinked-supply-chain**.
- **PostToolUse** (after the write lands): external tools (tsc/biome/eslint/semgrep/gitleaks/…)
  plus the inline check registry. **Warn only** — surfaced to you next turn. Bash and unknown
  writer tools are routed by their observed filesystem ChangeSet, not merely command parsing.

`interlinked verify` is the **on-demand, whole-project** run of that same check catalog.
Its `function_tokens` finding uses the shared `interlinked-code-v2` adapters and reports every current
product-source implementation over the effective cap. Unsupported languages are reported as
not measured; semantic-model token counts are unrelated and never substitute for this check.
JS/TS counts match `metrics score` function size, edit gates and commit checks. Recovered source
syntax remains unmeasured. Verify is an inventory of current over-cap functions; edit/commit
ratchets separately allow existing debt to hold or shrink, including debt revealed by migration.

Explain that size unit as **syntax tokens** (lexical tokens); AST-node counts and embedding
model tokens are different units. `metrics score` is an advisory composite, not a replacement
for verify or the hard cap. A provisional score does not prove checks passed. Use
`metrics gates --json` for actual coverage execution/freshness and `metrics coverage status`
for index validity. `metrics coverage warm` explicitly runs full Vitest coverage; subsequent
per-edit runs can replace affected test-file contributions. Proposed evidence promotes only
after the matching edit lands, and unsupported/stale capture remains visibly unmeasured.
Route evidence receipts, incremental coverage setup and deletion trials to
**interlinked-quality-gates**.

## Load this when
- You want to verify a batch of edits before declaring done.
- A `pre_block` check blocked an edit (see also **interlinked-harness** for how blocks read).
- You're landing a cross-file refactor and hitting transient `tsc` errors.
- You're unsure whether a finding is default-gate or advisory-only.
- You need to write a probe/analysis script and want it in the right place.

## `interlinked verify`
For `[interlinked:hook-coverage] NOT CHECKED`, use `interlinked harness coverage verify
--json`. This starts one daemon-owned recovery run over the pending versions and waits
for completion; `--no-wait` returns after starting it. Poll `harness coverage status
--json` to inspect progress. Checks reuse the configured PostToolUse battery in bounded
external batches. This does not replay PreToolUse guards or certify every hook phase.
While waiting, an unavailable status response is retried up to three consecutive
polls without restarting verification. A responsive report resets that counter.
Persistent unavailability exits nonzero with the original reason; the job may still
be running. Only a ready response with a missing or different job establishes that
the observed job changed or disappeared.
Recovery allows at least two minutes for each related-test process; ordinary hook
deadlines and the shared admission/source-count limits remain in effect on their paths.

The daemon retains `automated_check` receipts with exact file identities, completed check
names and findings. Completed checks may have findings; a receipt is not a clean verdict.
Ordinary single-file PostToolUse checks also consume their exact pending version when
they complete without deferral. Multi-file batches use the explicit recovery command,
which accounts for shared external deferrals before attributing evidence to each file.
Unavailable checks, unreadable/excluded/absent files, and file or policy changes during
verification stay pending. With waiting enabled, findings or remaining pending versions
produce exit 1. Re-run after the reported capacity/tool problem is resolved. A daemon
restart interrupts the job; recorded receipts survive and unchecked entries remain pending.
Active recovery keeps the raw and framed listeners out of idle shutdown and delays
automatic build handover within its normal freshness deadline. Explicit restarts and
memory safety shutdowns still interrupt recovery; inspect status and retry afterward.

Released reservations remain watched while pending, so review cannot acknowledge a stale
historical hash. `harness coverage acknowledge <id> <generation> <identity> <evidence>`
records an explicit manual review of the current version, including a reviewed deletion or
optional absence. It does not manufacture automated evidence. Do not bulk-acknowledge
unreviewed files. Checking/reviewing files never accepts protected policy; that is the
separate `harness coverage accept-policy <digest>` operation. Writer identity stays unknown.

```
interlinked verify [target]
  --all-checks        add the advisory smell/complexity/dead-code tier to the default gate
  --only <tool>       run only one external tool (e.g. --only tsc)
  --skip <ids>        comma-separated check ids to skip
  --suggestions       also run scored regex heuristics (sql-injection/perf/quality)
  --structure         also run artifact-structure checks
  --adoption-gate     fail when adopted structure categories drop below thresholds
  --suppress <e...>   add a suppression (file:check or file:check:reason)
  --json --details    machine-readable / per-file detail
```
`target` may be a local path, a GitHub/git URL (cloned to a tmpdir, scanned, deleted), or
omitted (scans cwd). Narrow with `--subdir <path>` in monorepos.

**Two tiers.** Default = high-signal gate: tsc, biome, oxlint/eslint, semgrep, gitleaks,
dep-audit (+ language tools as available) **plus** the FP-safe inline checks. `--all-checks`
adds the advisory tier (complexity, taste/smell, DRY clones, most `ubs_*`, test heuristics) —
a **review tool, expect noise, not a gate**.

> **`interlinked verify` exits 0 even with findings.** It is a *reporting* tool, not a
> pass/fail gate — do not `&&`-chain on its exit status. To gate programmatically, parse
> `--json`, or use `interlinked write` / `verify-changeset` (which **do** exit nonzero on
> blocking findings). (Exceptions that *do* exit nonzero: usage errors, and
> `--structure-only` / `--adoption-gate`, or a deferred/unavailable run that produced no
> verification verdict.)

Whole-project heavyweight work is admitted once per canonical project across CLI and agent
processes. If another verify/check/test batch already owns that lane, verify does not queue or
start a second memory-heavy scan: it prints `verify deferred`, states that no verdict was
produced, and exits 1. Retry after the active project run finishes. Different project roots use
independent lanes, and the compiler has a separate nested lease so `--only tsc` can run while
verify owns the heavyweight lane. `--only <tool>` really runs only that external tool; it skips
the inline code-quality census rather than retaining the whole-project scan before the requested
tool.

Lease ownership binds the PID to an OS-derived process-start identity, so a live unrelated
process that reused the same PID cannot keep compiler or heavyweight capacity busy. Legacy
lockfiles without that identity remain compatible while fresh, but expire after 24 hours — well
beyond every minute-scale workload timeout — rather than starving a project indefinitely.

There is **no** `--file`/`--changed`/`--staged` flag — verify always walks the whole discovered
set (or `target`/`--subdir`). Diff-awareness lives at the *edit-time* gate, not in verify.
Run verify to see **pre-existing** findings in a file you're about to touch (the edit gate
hides those as warnings).

## Check families & phases

### Adopt existing project linters

`interlinked lint scan [directory] --json` inventories recognized lint configs,
manifest sections, declaration/selector candidates, ignores, scripts/aliases and task/CI evidence
across nested packages. `lint import` previews which sources can become imported
checks and which need review; `lint import --write --baseline` applies supported
scopes, enables `quality_checks.lint_import`, and measures existing debt.
Preview never executes configuration; the baseline run invokes installed analyzers.

The 22 native adapters cover ESLint, Biome, Oxlint, Ruff, Clippy, golangci-lint,
SwiftLint, RuboCop, Stylelint, mypy, Pylint, Flake8, Standard Ruby, ShellCheck,
Hadolint, actionlint, PHPCS, PHPStan, Psalm, SQLFluff, Semgrep and Prettier.
Other analyzers can use reviewed SARIF stdout declarations in
`.interlinked/lint-adapters.json` (schema/example in `docs/lint-adoption.md`).
Unsupported flags, shell setup and dynamic invocations remain explicit
review items. Rules retain their original analyzer semantics and IDs; static
discovery does not resolve every dynamic preset or replace arbitrary rules with
native guards. See `docs/lint-adoption.md` for recognition and execution boundaries.

Oxlint adoption runs the installed `oxlint --format=json .`, including configured
JS plugin rules. Warnings from exit 0 remain findings; parse failures, invalid
reports and zero measured files produce no verdict. `.eslintignore` is tracked.
Select named ESLint files with repeatable `lint import --eslint-config <file>`;
add `--write --baseline` to apply and measure. Files are relative to the command
target, inspected as text in preview, and passed through ESLint's `--config`.
`--eslint-scope <directory>` sets the working directory/`.` lint target for those
selections (default: project root, not config directory). It requires a selector.
Named `eslint.<name>.config.*` profiles are automatic audit candidates; inspect their
inferred package scope. General repeatable `--config tool=file` and optional `--scope`
select arbitrary configs for any adapter supporting an explicit config flag.
`--cadence hook|audit` sets cadence for all profiles in the import plan.
Each config/scope/target/flag profile has its own
ratchet identity; re-import retains selected profiles without repeating flags.

PostToolUse and ordinary `verify` run hook profiles; `verify --all-checks` and
`lint check` run all profiles. Saved cadence survives re-import. Named/type/build-heavy
and CI profiles initially use audit cadence. Imported checks run asynchronously; hook findings
warn, never become automatic `pre_block` errors. `lint check` is the explicit
gate: exit 0 = complete/no new debt, 1 = new debt, 2 = incomplete/no verdict.
`lint check --update-baseline` seeds new scopes and tightens existing allowances.
Ordinary complete checks also retire resolved debt; incomplete runs never do.
Analyzer report capture has a 10 MiB threshold per stream. A truncated report is
unavailable even if its captured prefix parses; it cannot seed or retire debt.
Stylelint's stderr fallback also requires completely captured, empty stdout.
Truncated diagnostic logging on stderr does not invalidate a complete stdout report.
Source snapshots before/after each analyzer and again at batch completion reject
changed, added, deleted or replaced files; stale clean reports cannot retire debt.
Snapshots stream SHA-256 over every regular file in the working scope, including
custom extensions, dependencies, generated files and Git-ignored output. They also
compare file identity, mode and nanosecond timestamps; metadata alone cannot
detect unflushed memory-mapped writes. This is observational before/after freshness,
not an atomic filesystem snapshot or proof of arbitrary reads outside that closure.
For native ShellCheck and Hadolint, explicit targets must name existing regular
files in the working scope; confined regular-file symlinks are supported. Each
target is checked independently, including files under `vendor` or other default
discovery exclusions. Missing files, directories, escaping links and explicit
glob patterns make the result unavailable; another valid target cannot hide them.
Default inferred targets still use the adapter's discovery exclusions. Expand
explicit globs into a reviewed literal file list before importing the command.
Regular symlink targets are hashed; confined directory links are traversed with
cycle detection. Escaping directory links are unavailable. Diagnostic anchors use
a checked stream matching the original digest; out-of-snapshot diagnostics fail.
The census omits `.git`, `.interlinked`, `__pycache__`, `.mypy_cache`,
`.ruff_cache`, `.pytest_cache`, `.eslintcache` and `.stylelintcache`; explicit
targets or ignore overrides intersecting omitted runtime state are unavailable.
Each snapshot permits 100,000 entries and 4 GiB total, streamed in 64 KiB chunks
within the shared batch deadline. Large files do not require whole-file allocation;
diagnostic anchor lines have a separate 1 MiB character limit. Unreadable inputs or
exhausted bounds mean unavailable, never clean. Large scopes incur repeated reads
and may need a longer timeout or narrower valid working scope. Native ignores are
not guessed to make a census fit.
Native Clippy runs use a unique temporary Cargo target/build directory outside
the project, removed when the process finishes; compiler caches start fresh on each
measurement. Cargo arguments and child
environment override configured output locations so normal compilation cannot
invalidate the source snapshot. Existing `target` files remain measured inputs;
source, lockfile or build-script writes inside the scope still make the result
unavailable. A temporary-directory setting inside the project is unavailable.
Other analyzers that write inside their scope can also invalidate
their snapshots; only the listed runtime/cache exclusions are omitted.
Config drift requires review with `lint import`, then `--write`. The default
batch budget is 30000 ms (`--timeout`, maximum 300000 ms, on lint commands).

Literal config/plugin imports and package/lock context are fingerprinted. Ruff's
`extend` and local Biome/Oxlint JSON `extends` paths also enter the transitive digest
closure, including bare relative names such as `base.toml`. Paths resolve from each
declaring config, not the analyzer's working directory. Missing, out-of-project or
unresolved literal inputs prevent measurement. Existing policies missing one of these
dependencies require re-import; checking does not silently approve the new input.
Ruff's reader handles ordinary literal strings and table/dotted/inline keys; unsupported
string escapes or multiline inline inheritance require review. Biome package presets
retain package/lock tracking. This is not general YAML or dynamic inheritance resolution.
Discovery
does not execute config or expand arbitrary environment/matrix/build expressions.
YAML task parsing needs the optional `yaml` package; unavailable/invalid YAML remains
review evidence. Follow the supply-chain skill if adding the parser is blocked;
do not silently approve a dependency. An inventory marked complete can still have
unadopted review items. Never describe it as universal effective-rule coverage.

Two catalogs, both surfaced by verify + PostToolUse: the **tool wrappers** (`typescript`,
`biome_lint`, `eslint`, `semgrep`, `gitleaks`, `dependency_audit`, `secrets_in_source`,
`affected_tests`, per-language tools…) and the **inline families** in
`src/harness/checks/<family>.ts` (security/injection, PII/secrets, async/promises,
correctness/bug-class, agent-clarity, complexity, test-quality, comment/spec drift, …). Use
`interlinked harness checks` for the authoritative current inventory.

**Phase determines what blocks:**
- `pre_block` — the **only inline checks that BLOCK** an edit. Zero-FP,
  deterministic (`eval`, `nan_comparison`, `throw_literal`, `promise_reject_non_error`,
  `child_process_exec_user_input`, `cookie_missing_security_flags`, most `ubs_*` blockers…).
  Introduced-only. (Merge-conflict markers also block, but via a separate write-guard on real
  Edit/Write — not the `pre_block` registry, so `interlinked write` won't catch them in a new file.)
- `pre_warn` — PreToolUse warning, never blocks (e.g. `floating_promises`, `broad_object_types`).
- `post` — PostToolUse warning + surfaced by verify (the bulk: `nan_coercion_guard`,
  `write_without_mkdir`, `unvalidated_json_boundary`, `magic_literal_in_conditional`,
  `non_null_assertion` ratchet, `introverted_test`, …).

**Type assertions.** `unjustified_cast` uses the TypeScript AST when available, including
angle-bracket assertions, literal targets, and anonymous object targets. `as const` is excluded.
A justification must be an actual comment with a nonempty `SAFETY:` explanation on the
assertion's line, asserted expression's starting line, or nearest enclosing statement's starting line, or the immediately preceding
comment lines (up to two). Text inside
a string does not qualify. Without TypeScript, the legacy lexical scan remains available;
malformed syntax combines recovered AST findings with that fallback.

Prefer deleting a redundant assertion, adding a checked declaration type, using `vi.mocked`
with complete test fixtures, or validating an unknown input. Keep an assertion only when its
specific invariant is understood and explained. Exercise malformed external data at its actual
parser or adapter boundary. Do not fabricate impossible internal states just to kill a mutant
or prove that a removed feature stays absent. Retain a malformed-input assertion only when an
actual untyped caller can supply that value, and explain that caller and the expected behavior.
A generic explanation or an unchecked JSON annotation does not establish safety.

**Test-file ladder.** A test edit is checked before it lands as well as after it lands. `pre_block`
rejects only introduced deterministic theatre/sabotage: assertion-free cases, tautologies
(including identical literals/constant truthiness), SUT self-mocking, focused cases, and
unconditional skips. PreToolUse warnings immediately coach low-noise shapes such as removed test
signals, duplicate names, real I/O, nondeterministic clocks/RNG, fixed waits, missing SUT imports,
mock-only assertions, private-member access, silent dependency skips, and `test_legitimacy`.
PostToolUse retains context-heavier review such as happy-path-only and introverted tests. A warning
is not a pass; rewrite toward a precise observable behavior or document the real compatibility
contract.

**Default vs advisory.** Default-gate checks fire on every edit + default verify. Advisory
checks (the `DEFAULT_ADVISORY_SKIPS` list — complexity, CRAP, DRY clones, `boolean_trap`,
`write_without_mkdir`, `homedir_write_escape`, most `ubs_*`, Swift/test heuristics,
`conditional_empty_object_spread`, `unknown_type_alias`…) fire
**only** under `verify --all-checks`. `unvalidated_json_boundary` was PROMOTED to the
default gate 2026-08-10 after the boundary-parser sweep took the repo to 0 fires — expect
it on ordinary edits: route parsed JSON through a local `parseX(v: unknown): X | null`
(or an `isX` guard / `Array.isArray` gate) before field access. **"Advisory" ≠ silent** — an advisory check that fires at PostToolUse
still warns; demoting a check doesn't stop it warning on edits. Fix the detector, not the list.

`test_legitimacy` is one of those advisory test heuristics. It runs as immediate PreToolUse
coaching and under `verify --all-checks`. For each case in a
`*.mutation-kill.*`, `*.mutation-hardening.*`, or `*.survivor(s).*` JS/TS test, put an adjacent
contract receipt immediately before the case:

```ts
// test-contract: boundary — parseWindow rejects the documented zero-width interval
it("rejects a zero-width interval", () => { /* precise public-behavior assertion */ });
```

Kinds are `public-api`, `invariant`, `bug`, `security`, or `boundary`; the rationale must be
specific, not “kills the mutant.” The check also reviews broad `toBeTruthy`/`toBeFalsy`,
incidental call-order assertions, and explicitly private/internal imports, including multiline
named imports such as `__test_only__`. Cast-based private-member access is a companion warning. These shapes are not
automatically wrong, so this check stays heuristic: exact CLI/help/policy strings are legitimate
compatibility assertions, while unpromised internal formatting usually is not.

Two newer TS type-discipline advisories, both AST-parsed and both `[heuristic]`:

- **`unknown_type_alias`** — a named alias resolving to exactly `unknown`, chased through
  same-file non-generic aliases (`type Foo = unknown; type Bar = Foo;` flags both). Name the
  real shape, or keep `unknown` at the boundary and narrow with a parser/guard.
- **`conditional_empty_object_spread`** — `{ ...(cond ? {} : { field: v }) }`, the spread-a-
  ternary trick for omitting a field. The idiomatic guarded passthrough
  `guard ? { key: guard } : {}` is exempt.

Every finding is tagged `[proven]` (a real tool ran it — fix it) or
`[heuristic]` (regex/AST shape — evaluate it). See **interlinked-harness** for
the suppression grammar (`// interlinked-ignore: <check> — reason` /
`verify-suppressions.json`).

**Checker availability is a first-class state (2026-08-27).** The tsc overlay
returns one of three outcomes: `ok` (it RAN — empty findings = checked clean),
`skipped` (it deliberately did not apply: non-TS file or operator `mode: off` —
nothing was verified, and nothing claims to be), or `unavailable` (it SHOULD
have run and could not: sidecar spawn failure, timeout, cooldown, or per-project
compiler backpressure). Unavailable
is never clean: transactional paths — `interlinked write` (single AND
`--batch`), `multi-edit`, `verify-changeset` — ABORT with a
`tsc-overlay-unavailable` failure and leave files untouched; the ordinary
single-edit hook path does not launch the sidecar at all. It surfaces a NOT CHECKED warning,
and the admitted PostToolUse path checks the on-disk result asynchronously.

Full-project TypeScript children are serialized per project across concurrent
hook and CLI processes. Heavy verify/check/test/audit/sweep work uses one
project-scoped cross-process lease and does not queue: contention is an explicit
deferred/no-verdict result. Each accepted request runs after its own edit is on
disk; results are never shared across edit generations.
A multi-file PostToolUse request also owns one external-tool batch for its
entire ChangeSet: project-capable compilers, linters, and security scanners run
at most once, then their findings are attributed back to the touched files.
Cheap inline checks still run once per file. A same-ecosystem dependency audit
runs once for the ChangeSet, and TypeScript/Vitest affected tests run once with
the union of changed source paths. Mixed-language affected-test sets,
multi-ecosystem audits, file/tool-cap overflow, a file-only external runner, or
a batch denied by capacity produce one aggregate `NOT CHECKED` result for the
request instead of N subprocesses or N warnings. Existing-file TypeScript
diagnostics from the batch warn without claiming they were introduced: only a
request-proven new file has an empty compiler baseline; the exact per-edit
introduction decision remains the PreToolUse overlay's responsibility.
When several PostToolUse checks defer for one edited file, the model-visible
output is one `[interlinked:checks-deferred]` NOT CHECKED warning with the
individual reasons; structured `check_results` still retain every deferral.
`checks_ran` lists only checks that completed with a real verdict; attempted
checks that throw or defer are recorded under a `deferred_<check>` timing
boundary instead of being reported as completed.
The same deferral is not repeated by the project-wide sweep, and a deferred
event never receives an `all clean` summary. Re-editing a file cannot repair
checker capacity, so operational deferrals also never become a
`persistent_warning_escalation` source error, recurrence signal, or
feedback-effectiveness warning/resolution. They remain structured operational
telemetry, and the NOT CHECKED notice remains visible until a real verdict
exists. Retry every named check before claiming the edit is verified.

PostTool warning delivery is request-owned. Each daemon check pass writes its
own tokenized active/ready record under `.interlinked/quality-warning-spool/`;
both installed hook runtimes acknowledge a synchronous result before showing
it, while a result that finishes after the hook timeout is atomically claimed
and shown once on that same session's next PreToolUse. The originating hook's
PID preserves its first-delivery right without making another hook wait.
Parallel agents cannot overwrite or unlink one another's work, clean results
create no replay record, and a PreToolUse never force-removes a live check
marker. A PostTool pipeline exception publishes an explicit `NOT CHECKED`
diagnostic instead of an empty record, and an abandoned active-only marker is
claimed only after its hook process is gone (or the marker expires); live
markers are preserved. The old shared `pending-quality-warnings.json` file is read only as a
one-time rolling-upgrade migration path; when request-owned evidence exists,
unscoped legacy text is discarded rather than mixed into another request.

Because the synchronous overlay path cannot wait without blocking the daemon
from reaping an async compiler, contention returns `unavailable` immediately;
retry after the active check finishes instead of treating the edit as verified.
The synchronous export-ripple advisory follows the same rule: it reports an
explicit `export_ripple_compilation_deferred` info finding and launches no
second compiler while same-project compiler work is active.
Different project roots remain independent and may compile concurrently.

## Reviewing test discrimination

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

## Landing multi-file edits (the ordering rule)
Three agent-callable commands gate proposed content **without** running function-token/coverage/complexity/post
checks. `interlinked write`, `multi-edit`, and `verify-changeset` share `pre_block → biome → tsc`:

```bash
interlinked write <path> --stdin                 # single gated write, content on stdin
interlinked write --batch <manifest.json>        # gated batch with rollback protection
interlinked multi-edit <path> --stdin            # single-file old→new edits
interlinked multi-edit --manifest <file>         # single- or multi-file edits
interlinked verify-changeset --file <cs.json>    # preview the gate, write nothing
```
- **`write --batch` manifest:** `{ "version": 1, "writes": [ { "path", "content" }, … ] }`.
  The gate sees all final contents before any write, so a blocking finding writes nothing. Commit
  uses per-file atomic renames, preserves existing target modes, and performs best-effort rollback
  if a later rename fails; POSIX provides no literal multi-file atomic rename, and an incomplete
  rollback is reported explicitly.
  New files use an empty biome/TypeScript baseline, so diagnostics introduced by a fresh `.ts`,
  `.tsx`, `.mts`, or `.cts` file block just like diagnostics introduced while editing an existing
  file; `scratch/` is not an escape lane.
- **`multi-edit` manifest:** `{ "version": 1, "edits": [ { "old_string", "new_string" }, … ] }`
  (path = positional arg), or `{ "version": 1, "batches": [ { "path", "edits": […] } ] }`.
  Edits apply in order to an in-memory buffer; the gate runs once on the final content.
  **Ambiguity is judged after prior edits** — each `old_string` must match exactly one location
  in the *current* buffer state.
- **`verify-changeset`** previews (Write/Edit/MultiEdit shapes), enforces nothing; exit 1 =
  "would be blocked".

**Transactional consistency.** `write` and `multi-edit` capture target bytes and modes before
verification, then compare them again under a shared project commit lock. A concurrent change
aborts the batch: re-read the targets and rebuild the proposal. Unchanged multi-edit members
still participate in this comparison. Both commands preserve existing file permissions and use
guarded rollback that refuses to overwrite newer content. Targets must be regular files or
missing; symlink targets, duplicate physical targets, and escapes through parent symlinks are
rejected. Parent resolution is checked again before staging, committing, and rollback;
a redirected parent aborts the operation. A failed `multi-edit` reports the actual failing
target in `error_detail.path`. `write --unsafe-outside-repo` retains its explicit outside-root exception. This lock
coordinates Interlinked transactions; it does not make ordinary editors participate or make
multi-file writes crash-atomic. An incumbent lock is an unavailable transaction, never permission
to delete the lock blindly.

**Biome availability.** A configured analyzer that times out, crashes, or returns unreadable
diagnostics produces `biome-overlay-unavailable` and aborts transactional writes/previews.
Ordinary edit hooks retain asynchronous PostToolUse checking and visible NOT CHECKED feedback.
Unconfigured projects skip Biome. Existing and proposed contents are measured with the same
analyzer; moving existing lint debt is allowed, while another occurrence of the same rule is
new debt. A missing diagnostic cache never establishes a clean baseline. Overlay execution
uses installed tooling without installing a missing package.

The Biome overlay uses a sibling temporary file. It supports directory and simple
extension selectors; filename selectors (including `*.test.ts`), inherited config,
plugins, VCS ignore rules, filename-sensitive rules, and `BIOME_CONFIG_PATH` report
unavailable because the temporary file cannot reproduce their semantics. Nested
target configs are discovered even without a root config. For an unsupported
configuration, use the ordinary edit workflow and run Biome on the actual file;
do not interpret an unavailable preview as approval or weaken project rules to
make the preview pass.
Creating, changing, or deleting a governing Biome config in the same proposal also
reports unavailable, since the analyzer reads disk configuration. Land that config
change before the source batch. A submitted config whose bytes equal disk is unchanged.

> **CRITICAL — exporter before importers.** The tsc overlay blocks *newly-introduced* type
> errors per file, so importing a not-yet-exported symbol is a `TS2305`/`TS2304` the overlay
> blames on your edit. Either (a) put the exporter **and** every importer in **one atomic
> `write --batch` / `multi-edit --manifest`** (the gate sees the whole consistent final state),
> or (b) if sequencing with real Edits, **land the exporter first**, then the importers — never
> the reverse. (Batch editing skips the function-token and coverage ratchets, so a batch can land
> over-cap or under-covered; the commit backstop/next real Edit and coverage gate re-assert them.)

## Scratch — where probe/draft code goes
The scratchpad guard **blocks** agent-authored **code** aimed at the host session scratchpad and
redirects you to **`<repo>/scratch/`** (rg-searchable, quality-gated, survives the session;
coverage/companion-test ratchets are exempt there, like `scripts/`).
```bash
interlinked scratch init     # provision scratch/ (README + .gitignore carve-out + .ignore negation)
interlinked scratch status
```
Convention: one date-prefixed subdir per effort (`scratch/2026-07-19-<slug>/`). Downloads and
`npm pack` extractions still belong in the host scratchpad (non-code bulk). Softening:
`scratchpad_guard.code_write_mode: "warn"|"off"`; bypass `INTERLINKED_DISABLE_SCRATCH_GUARD=1`
(placement only — the secrets scan on temp paths is never bypassed).

## Common workflows

### Verify writes observed outside tool gates

`interlinked harness coverage status --json` shows pending exact file identities,
watcher readiness, automated check receipts and manual review receipts. Run
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

## Gotchas
- Batch gate ≠ full edit gate — `write`/`multi-edit`/`verify-changeset` skip function tokens,
  coverage, cyclomatic, CRAP, and `post` checks. A batch that passes can still trip those on the next real
  Edit, and verify will still flag `post` findings.
- New files ARE checked by the biome/tsc overlay in the `write`/`multi-edit`/`verify-changeset`
  gate — a fresh file diffs against an EMPTY baseline, so every diagnostic it introduces counts
  (the earlier "new files skip the overlay" claim was stale; corrected 2026-08-27). The real-Edit
  hook path is where the merge-conflict caveat above applies.
- `--all-checks` re-enables high-FP heuristics; it's for periodic audits, not CI gating.

## Quick reference
```bash
interlinked verify                       # default gate, whole project (reports, exits 0)
interlinked verify --all-checks --details # deep audit with per-file detail
interlinked verify --only tsc            # just typecheck
interlinked write --batch changes.json --json
interlinked verify-changeset --file cs.json --json
```

## Related skills
- **interlinked-harness** — how blocks read, suppression grammar, determinism tags.
- **interlinked-quality-gates** — the function-token/coverage/complexity/line-cap ratchets the content gate does NOT run.
- **interlinked-supply-chain** — the package-install gate.
