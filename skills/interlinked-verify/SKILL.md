---
name: interlinked-verify
description: "Run `interlinked verify`, read PostToolUse check findings, and land multi-file edits through the content gate. Load when you check your changes, when a `pre_block` check refused an edit, when a cross-file refactor hits transient tsc errors (`interlinked write --batch`, `multi-edit`, `verify-changeset`, exporter before importers), when you decide default-gate versus advisory, or when you place probe or scratch scripts (`interlinked scratch`). Exit 0 reports findings; an unavailable or deferred run exits nonzero because no verdict exists."
---

# interlinked-verify — check your work & land edits through the gates

## Load this when

- You want to verify a batch of edits before declaring done.
- A `pre_block` check blocked an edit (see also **interlinked-harness** for how blocks read).
- You're landing a cross-file refactor and hitting transient `tsc` errors.
- You're unsure whether a finding is default-gate or advisory-only.
- You need to write a probe/analysis script and want it in the right place.

Jev evaluations are internal experiments, separate from public verification and
Stop hooks. Do not recommend `interlinked jev` or `jev.enabled` to users.
For authorized internal evaluations, see `docs/internal/jev.md`. The runner
sends selected evidence to TypeSafe; its findings are advisory, not gate evidence.

## `interlinked verify`

`interlinked structure doctor` exits nonzero when it finds error-severity
issues in either human or JSON output. Warning-only results retain exit zero.

`structure scan` and `structure scan --full` perform a full extraction and report
`mode: "full"`, including when a cache exists. Explicit `--incremental` reports
the unavailable capability with a nonzero exit before extraction or cache writes.
JSON mode keeps that error structured on stderr.

`interlinked tdd status` inspects remembered cycles. `tdd clear <file>` clears
matching cycles, and omitting the file clears every tracked cycle. Explicit
empty or whitespace-only selectors fail before writing snapshots. Snapshots
with no matching cycles retain their contents. Restart the harness after clearing
remembered cycles so its in-memory state reflects the saved snapshots.

On JS/TS module edits, `omitted_private_parameter` records a private function's
optional or defaulted parameter when every visible direct call omits its position.
Routine hooks group design advisories into a review notice.
Use `interlinked verify --all-checks --json` to audit existing files and inspect
`omitted_private_parameter.details`. Review the callers and preserve default
evaluation and side effects when tightening a helper. Named top-level function
declarations in ES modules are supported. Exports, callbacks, spread arguments
and ambiguous bindings are excluded. Explicit `undefined` counts as supplied.
Public APIs and dynamic consumers require separate compatibility evidence.

For external inputs, review `unvalidated_input_boundary` alongside
`numeric_zero_default`. Use the consumer's documented contract to choose tests.
For example, if a CLI option accepts a nonnegative decimal count, exercise
omission, explicit zero, a positive count and a malformed value such as `12junk`
through the CLI. Assert the malformed case fails before the command writes
files or starts a process.

`interlinked search` honors `--context 0` with both engines. Ripgrep execution
errors, signals and timeouts produce an error and nonzero exit, including when
the process emitted partial matches. Native `--type` accepts searchable filename
extensions without the dot and these aliases, `ts`/`typescript` for `.ts`/`.tsx`,
`js`/`javascript` for `.js`/`.jsx`/`.mjs`/`.cjs`, `python`, `rust`, `ruby`,
`kotlin`, `markdown`, `yaml` for `.yaml`/`.yml`, and `shell` for `.sh`/`.bash`/`.zsh`.
Unsupported native types fail before scanning. The ripgrep engine uses its own
installed type catalog.

```
interlinked verify [target]
  --all-checks        add the advisory smell/complexity/dead-code tier to the default gate
  --only <tool>       run only one external tool (e.g. --only tsc)
  --skip <ids>        comma-separated check ids to skip
  --timeout <ms>      optional whole-command deadline; omitted or 0 means none
  --tool-timeout <ms> optional external-analyzer deadline; omitted or 0 means none
  --gitleaks-scope <scope> working-tree (default) or explicitly narrower git-visible
  --suggestions       also run scored regex heuristics (sql-injection/perf/quality)
  --structure         also run artifact-structure checks
  --adoption-gate     fail when adopted structure categories drop below thresholds
  --suppress <e...>   add a suppression (file:check or file:check:reason)
  --json --details    machine-readable / per-file detail
```
`target` may be a local path, a GitHub/git URL (cloned to a tmpdir, scanned, deleted), or
omitted (scans cwd). Narrow with `--subdir <path>` in monorepos.

`--only` selects the named external tool directly from the tool catalog,
including configuration aliases such as `typescript` and `cargo_clippy`.
The text and JSON reports use the same catalog aliases. A selected tool with
an unavailable async runner reports the reason and verify exits 75.
`--only tseslint-types` runs the dedicated typed ESLint project configuration in
either output mode. Edit-time checks keep their existing file-scoped runners.
Explicitly selecting an advisory tool opts it in. Explicit `--skip` still applies,
and unmatched names select no external tools. `--only sca` selects dependency audit.
`--only dep-audit` and `--only dependency_audit` select the same dedicated audit.
Explicit audit exclusions apply to that path as well as generic tool dispatch.
The shared inline detector dispatcher also applies default advisory exclusions and
`--skip` before executing a detector. Excluded work does not consume its time budget
or create an incomplete-check result. `--all-checks` opts advisory detectors back in.

For a client report, inspect `files_scanned`, `files_measured`, `not_measured`,
`not_run`, and `check_coverage` alongside the findings. Deferred inputs and
unavailable tools leave gaps even when a check's findings array is empty.
External analyzers have no default deadline. An explicit `--tool-timeout` applies per tool.
Semgrep and Gitleaks preserve readable findings when a deadline expires and mark the
run incomplete. Their reports distinguish a deadline, truncated capture and malformed JSON.
See [verification scope and evidence](references/verify-run-evidence.md) for the JSON
fields, skip reasons, Gitleaks inputs, foreground limits and import resolution.

Semgrep runs only with `verify --only semgrep`. Both ordinary verification and
`--all-checks` skip its availability probe and record its exclusion in verify JSON.

**Two tiers.** Default = high-signal gate: tsc, biome, oxlint/eslint, gitleaks,
dep-audit (+ language tools as available) **plus** the FP-safe inline checks. `--all-checks`
adds the advisory tier (complexity, taste/smell, DRY clones, most `ubs_*`, test heuristics) —
a **review tool, expect noise, not a gate**.

> **Ordinary findings do not make `interlinked verify` exit nonzero.** Parse
> `--json` to gate on those findings, or use `interlinked write` /
> `verify-changeset`, which exit nonzero on blocking findings. Usage errors,
> failed project-E2E requirements, stale kill-proof receipts, and failed
> `--structure-only` / `--adoption-gate` policies do exit nonzero. Deferred or
> unavailable checks exit 75 with partial evidence. Exit zero alone therefore
> does not establish a clean report.

`verify --all-checks` also includes the advisory catalogue for README command
drift, unread configuration keys and summary coverage of observed file touches.
These checks are omitted with `--only`; `--skip` still applies. In the JSON
`catalogue_advisories` entries, README drift counts historical documentation
under `out_of_scope`, including campaign records dated in both title and
filename and reviews introduced as a pinned branch or dated verification run.
It checks option names inside bracketed command synopses. Unreadable or oversized inputs appear in
`unavailable_inputs` with a repository-relative path and reason. Ambiguous
configuration reads identify the declaration's file, line and key, and retain
a possible read location when available. Older receipts may carry counts alone.
Summary evidence is session history, not a net Git diff,
and lexical command/configuration findings require source review. Per-check timing
is supplementary telemetry and never substitutes for a completed check.

`verify --json` adds a complete `actions` projection of retained check findings,
setup/registry issues, suggestions, dependency audit summaries, structure follow-ups,
open e2e scenarios and stale proof receipts. It preserves the existing raw sections
and their suppression policy. `check_coverage` records external tool execution/skip
reasons and per-check timings. Its `selection` records whether the inline census was
requested, the external-only selector and the configured excluded IDs. Selection
metadata describes the request. Timings and tool records describe execution.
JSON external runner errors and resource deferrals exit 75 with partial-verification
evidence. Disabled, inapplicable and missing tools retain their existing skip semantics.
Failed and deferred inputs, including explicit native-tool unavailable inputs,
become evidence-gap actions. Native limitations remain inventory limitations;
configured exclusions and inapplicable tools stay in coverage metadata. Per-file
inline findings retain the hash of their analyzed primary text; later output does
not reread disk to invent that identity. External/project findings without captured
hashes remain unknown. Supplied spans, references and suppression metadata survive
projection; different columns on one line stay distinct. Supplied `sourceEvidence`
retains supporting producer/consumer paths, lines and hashes from captured bytes.
Conflicting primary or supporting source versions make grouped freshness unknown;
snapshot binding establishes neither current disk freshness nor complete dependency capture.
This projection runs no analyzer or model, adopts no gate,
and does not promote a deterministic pattern or error severity into a confirmed defect.
Normalization reports supplied, accepted and rejected row counts; unsupported rows
remain disclosed projection gaps rather than silently becoming a clean inventory.

`commander_option_attribute` supplies advisory Commander flag-to-attribute evidence
in `verify --all-checks` and PostToolUse. Alongside same-file bindings and direct
`opts()` captures, it follows supported local ESM imports into exported handlers,
including literal dynamic imports and callbacks forwarding the unchanged options
parameter. Findings name the declared attribute and registration provenance.
Canonical/legacy fallbacks and normalization boundaries remain legitimate controls;
mutation, unresolved execution order and unsupported mappings remain NOT MEASURED.

Foreground verification reuses invocation-local project evidence and attributes a
cross-file finding to the handler read. A registrar edit can report the action site
with the remote handler location. Handler-only edits use the daemon's existing
importer index and reread candidate modules with the edited content overlaid. This
does not initialize or rescan a project graph on every edit. The cached regex graph
supplies partial reverse-import evidence, so known findings can coexist with unknown
coverage. Missing or deleted modules cannot establish a clean result. General
dataflow, cross-module re-exports, CommonJS, JSDoc-only Commander factories, custom mappings and
inherited-option forwarding remain outside the supported slice. The check remains
heuristic and advisory; no new blocking gate or model call is introduced.
Runtime NOT MEASURED warnings retain a separate `advisoryGaps` receipt when check
execution is recorded. They do not turn into defect counts, required retry loops or
Stop blockers. See **interlinked-observability** for that evidence distinction.

`numeric_zero_default` reviews numeric parsing followed by a truthiness default.
It is an advisory observation; zero may intentionally mean “use the default.” See
[numeric defaults](references/numeric-defaults.md) for supported local/imported
helpers, shadowing and mutation exceptions, source evidence and runtime coverage.
Replacing `||` with `??` alone does not handle a numeric conversion returning `NaN`.

There is **no** `--file`/`--changed`/`--staged` flag — verify always walks the whole discovered
set (or `target`/`--subdir`). Diff-awareness lives at the *edit-time* gate, not in verify.
Run verify to see **pre-existing** findings in a file you're about to touch (the edit gate
hides those as warnings).

## Check families & phases

`interlinked check --only missing-tests --json` reports JS/TS name mappings and
resolved test imports under `layout.javascript`. For Vitest and Vite it reads
the exported configuration's `test.include`. Coverage and plugin filters have
their own scopes. Dynamic discovery expressions and unsupported test patterns
produce `cannot-judge`. A candidate means neither mapping found a test.

`deadcode` recognizes repository-relative JS/TS scripts invoked directly by
`node` or `tsx` in root README, docs and skills command examples, and in
GitHub Actions `run` steps. Wrangler JSON/JSONC `main` and local oxlint JSON `jsPlugins` paths
resolve from the configuration directory. Directory overrides, compound shell commands and
dynamic paths can leave a reachable file in the candidate list. Review the
entry point before removing it.

A nested README or report can also demonstrate a command when its script path
starts with that subproject's root directory and resolves unambiguously. Export
parsing ignores module source written inside template literals.

For a Python invocation in nested documentation, the analyzer checks both
the repository root and the document directory. If those paths identify two
different Python files, the example supplies insufficient evidence to select one.

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

**Comment and string stripping is parser-backed.** The shared `stripComments` /
`stripCommentsAndStrings` that most inline checks read first go through the TypeScript parser
when the content parses as TS or TSX. Other content (Python, Rust, Go, fragments, an install
without `typescript`) uses the line scanner. `INTERLINKED_STRIP_PARSER=0` sends every caller to
the line scanner, as a rollback or to compare fire rates. The advisory `hand_rolled_lexer`
check names a new function that lexes JS by hand (a character loop with quote or comment
state). Mark a deliberate fallback with a `lexer-fallback: <reason>` comment.

**Checks that judge score metrics.** `dead_literal_store` (`pre_warn`, default gate) judges
`redundancy.dead_stores`: a local literal initial value that the next statement overwrites (TS/JS
by AST, Python by a line rule; the score adapter calls the same TS function). `top_level_burden`
(`post`, advisory, run by `--all-checks` through the registry sweep) judges `file.top_level` at 500
tokens of import-time WORK (loops, conditionals, try, await, bare calls, effect calls, static blocks).
It does not count literal data, pure declarations or declarative builder chains (zod, createAction,
defineX), so it is stricter in scope than the metric, which counts them.
`halstead_difficulty` (verify default gate, ceiling 80, volume floor 200) judges `difficulty` for
TS/JS. Whole-tree metrics are judged by `interlinked metrics score` (`judgments`), not by verify.

With TypeScript installed, `constant_condition` measures literal runtime branches, including
parenthesized boolean ternaries. Conditional types and optional type members are type syntax.
`duplicate_test_names` compares titles containing escaped or embedded quotes.
`file_level_suppression` ignores example directives inside JavaScript and TypeScript strings.

`public_api_leaks_internal_type` reports a type named in an exported signature
that consumers cannot import by name. A local export under an alias makes it
available. TypeScript can emit declarations that refer to module-private types.

Test checks recognize `.test.mts`, `.spec.mts`, `.test.cts` and `.spec.cts`
alongside other JavaScript and TypeScript test filenames. Companion-import and
self-mock checks resolve the module basename across these extensions.
An executable `assert.throws` assertion counts as a negative path in a Node test.

**Type assertions.** `unjustified_cast` uses the TypeScript AST when available, including
angle-bracket assertions, literal targets, and anonymous object targets. `as const` is excluded.
A justification must be an actual comment with a nonempty `SAFETY:` explanation on the
assertion's line, asserted expression's starting line, or nearest enclosing statement's starting line, or the immediately preceding
comment lines (up to two). Text inside
a string does not qualify. Without TypeScript, the legacy lexical scan remains available;
malformed syntax combines recovered AST findings with that fallback.

**Boundary and ownership evidence.** Discarded `safeParse`/predicate results do not
count as validation of the original value. Direct argv advice excludes executable
and entrypoint metadata at indexes 0 and 1. Positional-boolean advice accepts named
options. Positional-boolean advice also recognizes root `test`/`spec` entry files
and genuine test directories. Its test scope is local to that advice check.
Initialization advice recognizes IIFEs/static initialization and excludes
deferred bodies and type declarations. Resource advice reads bounded, root-confined
release-helper bodies and checks acquisition before cleanup protection. These remain
heuristics: parser-like names, a visible close call and direct effect names do not
prove whole-program control flow. Missing parser support is not a clean measurement.
For opt-in semantic review of a finding, use **interlinked-quality-gates** and
`metrics decisions findings`; it never changes verify results or edit gates.

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

`write_without_mkdir` inspects the destination argument, including multiline calls.
Paths in data being written are independent of the destination directory.

Every finding is tagged `[proven]` (a real tool ran it — fix it) or
`[heuristic]` (regex/AST shape — evaluate it). See **interlinked-harness** for
the suppression grammar (`// interlinked-ignore: <check> — reason` /
`verify-suppressions.json`).

## Proving one kill (`tests prove-kill`)

When you add a test that claims to catch a specific mutant or fault, prove it:
`interlinked tests prove-kill --test <file> --mutant <id>` (a survivor id from
`interlinked mutation survivors --file <src>`), or with an explicit fault in any vitest
repository: `--file <src> --find '<text occurring once>' --replace '<text>'`. The live
tree is copied once into a frozen copy (it is only ever read); the named tests run
unmutated in a clone of it (all must pass), then in a second clone with the one mutant
applied, then twice more unmutated (a kill must repeat). `killed` (exit 0) means a named
case failed by its own check — executed evidence that the test distinguishes the two
implementations, not that the assertion is meaningful; `survived`
(exit 1) means the tests do not detect the mutant — strengthen the assertion on the value
the mutant changes; `not-passing-now` (exit 1) means fix the test first; `inconclusive` or
`unavailable` (exit 2) means nothing was proven (a product crash, a load error, a timeout,
an unresolvable mutant). The receipt under `.interlinked/test-runs/kill-proofs/` binds
source and test sha256, the helpers the tests and the source import, mutant identity and
offset, node/vitest/config; `interlinked tests kill-proofs --verify` reports STALE after
any of them change, and its fix line is the receipt's own command (manifest id, or the
explicit `--file/--find/--replace`). A `[interlinked:kill-proof]` PostToolUse line on a
`*.mutation-kill.*` / `*.survivors.*` file means the fresh killed receipts together do not
cover every case added since HEAD (a case proven against fault A and another against
fault B are both covered). When the companion source has known manifest survivors, only a
`--mutant` / `--all-survivors` kill covers the file; an explicit fault does not. `kill-proofs
--prune [--dry-run]` removes receipts whose source or test file is gone. Coverage, a `test-contract`
marker, a green run or an old receipt is not proof. Guide: `docs/mutation-grounded-test-proof.md`.

## After you edit an old test (`tests edit-protection`)

Before you hand over a change that edited or deleted existing tests, run
`interlinked tests edit-protection` (no argument: every test changed against `--base`,
default HEAD, that holds a stale killed receipt). Each recorded kill is re-proved with the
test's current bytes and no receipt is written. `kept` is fine. `retired` means the source
no longer holds the mutant. `lost` in a source the change-set touched is requirement-linked:
confirm the requirement changed. A `FINDING` (exit 1) is a lost kill in a source the change
did NOT touch that no other test still kills: restore the assertion, or move it to a test
that keeps it. Exit 2 means a prior kill went undecided. An `[interlinked:edit-protection]`
PostToolUse line after you edit a test names this command: kill proofs recorded the old bytes
killing a mutant. On a mutation-directed file, the `[interlinked:kill-proof]` stale line names
it too; run it BEFORE you re-run `prove-kill`.

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

`interlinked harness coverage status --json` shows all pending exact file identities,
watcher readiness and bounded recent check/review receipts with explicit history counts. Run
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
# instruction packets (no verify row; shadow unless promoted on a measured holdout)
interlinked packets compile --from draft.json --dry   # replay counts: triggered / settled / residue
interlinked packets status
interlinked packets replay --sessions 25              # fill the ledger from collection.jsonl
interlinked packets calibrate export --out sheet.jsonl
interlinked packets calibrate score --labels a.json --labels b.json [--apply]
interlinked packets adjudicate <id> true|false|unsure
interlinked packets budget [--runner <id>]            # per instruction file: pass-1 / NET releasable / released (live) / released_fallback / shadow chars
interlinked packets release <file> [--only id…] [--dry]  # warn/cosign spans → packet file, one pointer line per packet left (locked; words first, two renames)
interlinked packets restore <file>                    # byte-identical inverse; works on a stale, demoted or interrupted set; refuses ~/ sources
```

## References

Read a reference file only when the task needs it.

- [references/project-e2e.md](references/project-e2e.md): `tests e2e` scenarios, policy, gates and CI in any host repository.
- [references/behavioral-contracts.md](references/behavioral-contracts.md): `tests contracts`, `tests readiness`, `tests review`, `tests suite`, and recovery from `[interlinked:hook-coverage] NOT CHECKED`.
- [references/test-selection.md](references/test-selection.md): `tests plan`, `run` and `status`, test selection, result reuse and resume.
- [references/resource-admission.md](references/resource-admission.md): project and host lanes, memory budgets, exit 75, pre-push outcomes, `tests trace` and `tests opacity`.
- [references/lint-adoption.md](references/lint-adoption.md): `interlinked lint scan` and `lint import`, and the native linter adapters.
- [references/check-notes.md](references/check-notes.md): `verify --fp-filter`, `html_duplicate_id`, `test_legitimacy` receipts, effect-cleanup and type-discipline advisories, suppression hygiene, checker availability and warning delivery.
- [references/test-discrimination.md](references/test-discrimination.md): `tests fail-before-fix` and the test-discrimination advisories.
- [references/prove-kill.md](references/prove-kill.md): kill-proof receipt versions, parameterized families and check-evidence stores.
- [references/compiler-batches.md](references/compiler-batches.md): Claude `PostToolBatch` compiler batches.
- [references/advisories.md](references/advisories.md): `metrics decisions` warnings and the `repeated_implementation` advisory.
- [references/corpus-replay.md](references/corpus-replay.md): `harness corpus` qualification and replay evidence.
- [references/interlinked-e2e-lane.md](references/interlinked-e2e-lane.md): the e2e lane for boundary edits in the Interlinked CLI checkout only.

The edit-time shared-helper overlap advisory is in **interlinked-simplification**.

## Related skills
- **interlinked-harness** — how blocks read, suppression grammar, determinism tags.
- **interlinked-quality-gates** — function-token/coverage/complexity ratchets and advisory file-size measurements.
- **interlinked-supply-chain** — the package-install gate.
