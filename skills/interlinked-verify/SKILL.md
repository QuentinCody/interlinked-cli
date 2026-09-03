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
  closed. (`interlinked multi-edit` runs **only biome + tsc**, not `pre_block`; see below.)
- **Other PreToolUse guards** (real Edit/Write only): function tokens, coverage, cyclomatic, CRAP, baseline —
  see **interlinked-quality-gates**; package/allowlist — see **interlinked-supply-chain**.
- **PostToolUse** (after the write lands): external tools (tsc/biome/eslint/semgrep/gitleaks/…)
  plus the inline check registry. **Warn only** — surfaced to you next turn. Bash and unknown
  writer tools are routed by their observed filesystem ChangeSet, not merely command parsing.

`interlinked verify` is the **on-demand, whole-project** run of that same check catalog.
Its `function_tokens` finding uses exact canonical adapters and reports every current
product-source implementation over the effective cap. Unsupported languages are reported as
not measured; semantic-model token counts are unrelated and never substitute for this check.

## Load this when
- You want to verify a batch of edits before declaring done.
- A `pre_block` check blocked an edit (see also **interlinked-harness** for how blocks read).
- You're landing a cross-file refactor and hitting transient `tsc` errors.
- You're unsure whether a finding is default-gate or advisory-only.
- You need to write a probe/analysis script and want it in the right place.

## `interlinked verify`
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

## Custom build/test command overrides (`tool_commands`)

A project can pin the **exact argv** Interlinked spawns for its build/lint/test tools in a
dedicated two-tier config — `.interlinked/tool-commands.json` (committed, team) +
`.interlinked/tool-commands.local.json` (gitignored, personal). This is how a Go project makes
`check --only go-build`/`--only go-test` and PostToolUse run the same flags as its dev server
(e.g. `-tags 'dev devaccounts'`, sharing air's Go build cache):

```jsonc
// .interlinked/tool-commands.json
{
  "version": 1,
  "tool_commands": {
    "go_build": { "base_args": ["-tags", "dev devaccounts", "./..."], "timeout_ms": 300000 },
    "go_test":  { "base_args": ["-tags", "dev devaccounts", "./..."], "timeout_ms": 300000 }
  }
}
```

- Keyed by **check/config names** (`go_build`, `go_test`, `golangci_lint`, …); a full `command`
  array wins over `base_args`, which REPLACE the runner's default scope (`./...`).
  **No shell interpolation** — `-tags 'dev devaccounts'` is ONE argv token (`["-tags","dev devaccounts"]`),
  not two (`["-tags","dev","devaccounts"]` treats `devaccounts` as a package pattern).
- **Trust split** mirrors `merge.ts`: the committed team tier may set `base_args`/`timeout_ms`
  (flags for a fixed binary; bounded cap), while `command`/`env` are personal-tier only
  (arbitrary executable / runtime rewiring) — `interlinked doctor` reports violations.
- `go-test` is a project-wide catalog tool that runs the full suite (`check --only go-test`,
  `--tools go-test`, `verify --only go-test`). It is **opt-in**: unfiltered runs skip it until
  `go_test` is configured (or it is explicitly requested); `check --report` lists it either way.
- `affected_tests` PostToolUse carries `go_test` tags into the touched-package run
  (`go test <tags> -count=1 ./<pkg>`, no full-suite `./...`).

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

## Landing multi-file edits (the ordering rule)
Three agent-callable commands gate proposed content **without** running function-token/coverage/complexity/post
checks. `interlinked write` and `verify-changeset` run `pre_block → biome → tsc`; `interlinked
multi-edit` runs **biome + tsc only** (no `pre_block` — it does *not* screen for eval/injection/etc.):

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
