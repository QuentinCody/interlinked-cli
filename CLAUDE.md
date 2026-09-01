# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is for (read before changing any check, gate, or threshold)

**Interlinked is a portable, per-tool-call quality and security standard for
agent-written code.** A local daemon sits in front of an agent's tool calls and
judges each one — ideally before it reaches disk. Four goals, in priority order:

1. **Judge agent-written code at the moment it is written, in ANY codebase.**
   This repo is one instance, and an unrepresentative one: single language,
   agent-hardened, no human legacy. Portability is the product; this tree is the
   test fixture.
2. **Ratchet the quality and security of whatever codebase it runs in.** Default
   scope is the DIFF — the edited region of this tool call, not the file. Opt-in
   wider scopes: whole-file ("fix the file you touched") and whole-codebase
   ("bring this repo up to standard": tests, types, coverage, low complexity).
3. **Catch problems at the earliest point the evidence exists.** PreToolUse when
   the proposed content is enough; PostToolUse when the file on disk or a
   compiler is required; trajectory when the pattern spans several calls; Stop
   when the only observable is "they finished without doing X". A check should
   declare the earliest phase its evidence supports, and sit there.
4. **Double as a step-level training signal for other coding agents**, especially
   small/local ones. An agent that clears the strictest per-tool-call gates is
   demonstrably good — closer to rewarding every step than rewarding the final
   diff.

### The consequence that reverses the obvious reading

**A check that never fires in this repo is not dead weight, and must not be
retired or demoted for being quiet.** It is the part of the standard this
particular (strong) agent already clears. Point it at a 7B local model or at
human-written legacy code and it earns its keep.

> **Fire rate measures the AGENT, not the check.**

Two corollaries that bind day-to-day work:

- **Never calibrate a threshold against this repo alone.** It is hardened and
  atypical. `halstead_difficulty` was tuned to 25 against unit-test fixtures;
  the real tree said 25 was the *75th percentile* and it fired 2,226 times.
  Fixtures and a hardened tree fail in opposite directions, and both mislead.
- **Blocking and scoring have different precision bars.** A wrong block stops
  real work, so blocking needs high precision. Scoring does not block and can
  record low-confidence findings weighted by confidence. The existing
  `[proven]` / `[heuristic]` determinism tag is that axis — use it rather than
  forcing every check to be blockable.

Treat **more checks as a cost, not a win**: a gate nobody reads is a gate that
is not running. And expect Goodharting — once gates are a training signal,
gaming them is the optimal policy, which is why `baseline_integrity_gate`
exists (the agent being gated can write the water-lines it is judged against).

**Status: this vision is validated at N=1.** Registry-wide rework — explicit
scope/phase fields, the UBS class port, tier recalibration — waits until the
harness has run against a genuinely different codebase (other language, human
legacy, not agent-hardened) and shown where the abstraction is wrong.

## Project Overview

`interlinked-cli` is the whole system today: a Node daemon (`src/harness/`, ~795
source files) plus a CLI (`src/commands/`, ~111). Agent hooks connect to a Unix
socket per PreToolUse/PostToolUse/Stop event; the daemon returns a block/allow
decision and warnings, and every event is appended to local JSONL under
`.interlinked/`. It is offline-first and has one required runtime dependency
(`commander`).

**On the "Interlinked MCP Server":** a remote Worker/DO system was the original
center of this project, and ~17 commands still import `src/lib/api-client.ts`.
That surface is **dormant** — no non-test source path calls the MCP tool proxy,
server sync is deliberately unimplemented, and the `active_server` entry in a
working config today points at a LAN mutation-runner broker, not an MCP server.
Do not treat the server as the system of record, and do not describe the CLI as
its companion; the local harness is the product. Leave the dormant code alone
unless the task is specifically about it.

Source of truth for the CLI is `QuentinCody/interlinked-cli`; current installs run from a linked source checkout. It has a single **required** runtime dependency (`commander`) and zero external dependencies for formatting/output. Two **optionalDependencies** (installed by default; the CLI's core hooks/activity work without them): `typescript` — the JS compiler API the AST-accurate cyclomatic/CRAP gate parses with (the `tsgo` native-port binary has **no importable JS API**, so it can't substitute; TS 7's replacement is an out-of-process gRPC API, stable ~7.1) — and `@typescript/native-preview` (`tsgo`), which accelerates `npm run typecheck`. When `typescript` is absent (`--omit=optional`), the complexity gate degrades to the regex walker and says so loudly (`astComplexityAvailable()`; daemon-startup warning).

## Working effectively in this repo (best-model profile)

These four habits are **measured, not asserted** — derived from the best released
models' actual behavior on this repo (17 Fable-5 sessions + Opus-4-8; the per-edit
cyclomatic hit-rate is identical across them at ~0.015/edit, so the profile is
model-agnostic). Full analysis and numbers: `docs/design/fable-corpus-extraction.md`.
The harness gates already nudge toward these; adopting them pre-emptively skips the
block→retry round-trip.

- **Decompose-first.** For naturally-branchy functions — data-shape parsers, summary
  loaders, multi-screen policy handlers — extract cohesive sub-blocks into named
  helpers *as you write*, not after the cyclomatic gate blocks you. The best model
  needed this nudge every time it hit the gate and complied every time, always
  producing the better decomposed design; pre-empting it is strictly faster. The
  orchestrator drops under the cap and each extracted helper becomes independently
  testable — a coverage win too.
- **Prefer `Edit` over `Write`** when changing existing code — surgical edits, not
  file rewrites (best-model Edit:Write ≈ 6:1). Full rewrites lose context and trip
  the read/edit-balance and blast-radius detectors.
- **Verify after substantive edits.** Run the project's test / typecheck / build at
  ~0.5–1.0 verifier runs per code edit (the best-model floor; the anti-pattern is
  ~0). The Stop-event nudge fires when a session's verify-to-edit ratio runs far
  below this floor.
- **Concise out, deep in.** Terse user-facing messages; deep private reasoning. The
  best model thought ~6× more than it spoke and still shipped ~580-char messages.

## Commands

```bash
npm run dev             # Run CLI directly via tsx (no build step)
npm run build           # Build to dist/ via tsup (ESM)
npm run typecheck       # TypeScript type checking (tsgo --noEmit; native Go port)
npm run test            # Run tests (vitest)
npm run test:watch      # Watch mode tests
```

Run the CLI in development:
```bash
npx tsx src/index.ts <command>        # e.g. npx tsx src/index.ts status
npx tsx src/index.ts enable --dry-run
```

Run a single test file:
```bash
npx vitest run src/commands/__tests__/cli-bugs.test.ts
```

## `interlinked verify` — two-tier mode

`interlinked verify` runs in two modes:

| Mode | Flag | Purpose |
|------|------|---------|
| **Default (high-signal gate)** | *(none)* | Tsc/biome/oxlint/gitleaks/semgrep/dep-audit + check-FP-safe generic checks. Intended to run clean; failures are actionable. |
| **Deep audit** | `--all-checks` | Adds heuristic smell/taste checks (complexity, magic numbers, data clumps, test-coverage signals, etc.) and the `tseslint-types` row — typescript-eslint's type-CHECKED rules via `eslint.interlinked-types.config.mjs` (`no-unnecessary-condition` = dead branches / impossible states, inert `as` casts, redundant union members). Checker-proven, but 620 open findings on landing (2026-09-01), so advisory until the backlog clears. Intended for periodic review, not as a gate. |

ESLint ≥ 10 removed the built-in `unix` formatter; every eslint invocation here uses
`--format json` parsed by `check-engine/output-parsers-eslint-json.ts` (the old
`--format unix` rows exited 2 and reported nothing — found 2026-09-01).

The demoted list lives in `DEFAULT_ADVISORY_SKIPS` in `src/commands/verify/advisory.ts` (re-exported from `verify.ts` for back-compat) and is pinned by a regression test so policy changes show up in diffs. Edit both together. Each entry has a rationale comment explaining why it's advisory.

**When adding a new check**: if false-positive rate is low and the check catches real bugs, leave it in the default set. If it's heuristic (style, complexity, coverage, smell), add it to `DEFAULT_ADVISORY_SKIPS` with a one-line rationale and update the regression test.

**When an existing check produces noise in production**: prefer refining the check's detection logic over demoting it. Demotion should be a last resort when the check can't cleanly separate true positives from legitimate patterns.

## Per-file line cap (`large-file-policy.ts`)

Hand-written code modules are capped at **<!-- gen:line_cap -->500<!-- /gen:line_cap --> lines**
(`DEFAULT_MAX_LINES`; ratcheted 1500 → 1000 → 800 → 500 across 2026-06,
decomposing each over-cap module into a re-exporting public entry + sibling
helpers as the cap dropped). `src/harness/large-file-policy.ts` is the single
source of truth — the threshold, the `isCappableFile` predicate (`.interlinked/`
tool-state / root `scratch/` probe dir / generated / `@codegen-data` / test /
`.d.ts` / non-code files are exempt; `isCappableFile` is also the ONE
product-code domain definition the coverage-targeting and debt-focus gates
consult, added 2026-07-17 after two gates disagreed about `scratch/`), the
baseline loader, the one canonical line counter (`countLines`; the
comment-aware `countCodeLines` lives in `code-line-count.ts`, re-exported), and
the ratchet verdict. The number above is gen-markered: `extract-doc-facts.mjs`
reads `DEFAULT_MAX_LINES` and `npm run docs:check` (CI) fails if this prose
drifts from it — run `npm run docs:build` after ratcheting to refresh it.

**The cap is ONE number.** `DEFAULT_MAX_LINES` (code) and `max_lines` in
`.interlinked/large-files-baseline.json` (config) are kept identical by a
regression test in `large-file-policy.test.ts` (`DEFAULT_MAX_LINES === committed
baseline.max_lines`). `maxLinesFor()` returns the baseline value when present
and falls back to the constant when absent — keeping them equal means the
fallback is never a *different* cap (the old footgun: a missing baseline
silently raised the cap). All enforcement surfaces and tests derive from this
constant; tests build fixtures as `DEFAULT_MAX_LINES ± n` rather than hardcoding,
so ratcheting is a one-place change.

Three enforcement surfaces, one policy:
- **PreToolUse block** — `checkLargeFileLineCountWrite` (`pre-checks.ts`)
  blocks a Write/Edit that would grow a cappable file past the cap. It is a
  pure before/after delta against live file state — shrinking or holding an
  over-cap file is always allowed (the refactor-down path).
- **`interlinked verify`** — the `large_files` check (default gate, no
  longer in `DEFAULT_ADVISORY_SKIPS`) reports any cappable file over the cap.
- **PostToolUse nudge** — the `[interlinked:file-size]` warning on write/read.

The cap and the grandfather list live in `.interlinked/large-files-baseline.json`
(committed — carved out of the `.interlinked/*` gitignore). The grandfather list
(`files`) records a high-water line count per offender: a listed file may shrink
or hold but not grow past its recorded count. Drop each entry once its file falls
below `max_lines` (decompose it, or let it become `@codegen-data`-exempt) — the
goal end-state is an empty list. Codegen DATA — the `.mjs` hook script carried as
template strings under `src/lib/hook-template-chunks/`, large embedded data
tables — is exempt via a `@codegen-data` header marker, NOT grandfathered; the
marker is scoped to the line cap only (tsc/lint still run). Ratchet the cap down
(500 → …) by editing BOTH `max_lines` (baseline) and `DEFAULT_MAX_LINES` (code)
together — the pinning test enforces they match, so it surfaces in one diff. The
cap is a coarse proxy; the `complexity` / `cyclomatic` checks do the fine-grained
"is this file bad" work, which is why the enforced line number sits well above
the ~300–500-line aspirational module size.

## History & relational metrics (added 2026-07-24)

Beyond the capped metrics, `interlinked metrics <sub>` computes relationship
and change-over-time metrics on demand (never on the hook path — they shell to
git / walk the graph). Spec + phase status:
`docs/design/history-relational-metrics.md`; deferred cloud lanes:
`docs/plans/06-cloud-metrics-program.md`.

| Subcommand | Metric | Source |
|---|---|---|
| `metrics coupling` | Tornhill co-change pairs; no-import-edge pairs flagged `hidden` | git log + project-graph |
| `metrics arch` | Martin Ca/Ce/instability per dir + propagation cost | project-graph |
| `metrics rework` | share of changed lines whose prior version was < `--window` days old | git blame |

Cognitive complexity runs on two surfaces with two thresholds (deliberate):
the advisory `cognitive_complexity` registry check at the Sonar-default 15,
and the `cognitive` metric cap (`interlinked caps`, `max_cognitive`,
tighten-only under the baseline-integrity gate) whose PreToolUse companion
(`evaluator/cognitive-write-guard.ts`) **BLOCKS** an edit that leaves a
function over the cap — promoted from warn-only 2026-08-01 once measurement
answered the FP-calibration hedge (p99 = 26 against a cap of 30, and the
over-cap set overlaps heavily with what cyclomatic already refuses). Delta
semantics, so holding or shrinking an already-over function never blocks; see
*Monotonic metric ratchet* for the tolerance. `cognitiveWriteWarning` remains
in the same module as the legacy warn-only signal. The per-edit pulse line
also carries `cogΣ` and `astΔ`
(AST semantic-delta: a rename is astΔ 0; a rewritten conditional is not).

## Scratchpad governance (added 2026-07-09)

The host session scratchpad (`<temp-root>/claude-<uid>/<slug>/<session-id>/scratchpad`)
is allowed by repo-confinement (the June triad carve-out) but governed by intent:

| Intent | Policy | Where |
|---|---|---|
| Agent-authored CODE (probes, drafts) | **Block-with-redirect to `<repo>/scratch/`** (default; `scratchpad_guard.code_write_mode: "warn"\|"off"` softens; `INTERLINKED_DISABLE_SCRATCH_GUARD=1` one-command bypass). Covers Write/Edit AND bash redirect/tee — bash targets are resolved through same-command `VAR=` assignments and `cd` hops (`resolveBashWriteTarget`). | `evaluator/scratchpad-write-guard.ts`, steer in `evaluator/pre-tool-rules.ts` |
| Secrets to ANY ephemeral temp path | **Block unconditionally** (`builtin-tmp-secrets`; temp paths sit outside protected-file globs but are the classic exfil-staging surface). Escape hatch does NOT apply. | same guard |
| Hand-rolled PATCH APPLIER (script that writes into repo source) | **Block** (`builtin-patch-applier`) in the scratchpad AND in `<repo>/scratch/`. Two required signals: a filesystem-write call plus a target outside its own sandbox (`src/**`-shaped literal, `process.cwd()`, `..`). Bypass: `INTERLINKED_DISABLE_PATCH_APPLIER_GUARD=1`. | `evaluator/patch-applier-guard.ts` |
| Downloads / extractions / non-code bulk | Allowed — belongs out-of-repo (in-tree it would poison rg + the trigram index) | — |
| Captured EXTERNAL-AGENT output (review/audit/report `.md`) | Allowed, but warned toward `<repo>/.interlinked/agent-output/` — hours-long Codex/Sol runs are the artifacts least able to afford archival roulette | `evaluator/scratchpad-write-guard.ts` |
| Every ephemeral write, ANY extension | **Recorded** to `.interlinked/ephemeral-writes.jsonl` (`ts/session/tool/path/ext/bytes/kind/blocked`); manifest-ish and unclassified kinds also warn. Closes the pre-2026-08 blind spot where the guard only inspected CODE extensions, so `.json` gate-workaround manifests left no trace at all. | `ephemeral-write-log.ts` |
| Everything left at session end | **Archived** into `.interlinked/scratchpad-archive/` (content-addressed blobs + per-session manifest; caps + excludes recorded, no silent truncation; `scratchpad_archive` config, default ON) | `scratchpad-archive.ts`, wired in `server/lifecycle-events.ts` SessionEnd |

`interlinked scratch init|status` provisions `scratch/` in any repo (README +
`.gitignore` carve-out + `.ignore` search negation — `src/commands/scratch.ts`).
Both config sections are locally overridable (classified in `rules/merge.ts` +
pinned by `merge-parity.test.ts`).

**The archive skips FOREIGN PROJECT ROOTS** (2026-08-04). A scratchpad
subdirectory carrying `.git` / `package.json` / `Cargo.toml` / `go.mod` /
`pyproject.toml` is a clone or extraction, not the session's work, and its whole
subtree is skipped with reason `vendored-tree`; `scratchpad_archive.archive_excludes`
takes extra globs for bulk that carries no marker. This is not hygiene — it is
the difference between an archive and nothing: before the rule, a single cloned
repo spent the entire 2000-file cap, so both surviving manifests read
`truncated: true` and every agent-authored artifact was evicted, including the
`plm/apply.mjs` patch applier that motivated the row above. The scratchpad ROOT
is never treated as foreign, so a lone `package.json` repro still archives.

**A dry run must not move the gate.** `interlinked harness test --write/--edit`
sets `dry_run: true` on its synthetic event and every evaluator that PERSISTS
must honor it (`transient-debt-guard.ts`, `ephemeral-write-log.ts`). Found the
hard way 2026-08-04: three simulated writes opened a real TS2305 transient debt
against a file they never touched, which then blocked an unrelated edit. When
adding an evaluator that writes to a ledger, thread `event.dry_run` or the
read-only probe becomes a state mutation.

## Harness (Guard + Lifecycle + Auto-Reservation)

The CLI includes a **local harness server** (`src/harness/`) that runs on Node.js and evaluates agent actions via a Unix socket. Full documentation: `docs/harness.md`. Auto-generated reference docs: `docs/generated/`.

**Key commands:**
```bash
node dist/harness/server.js --verbose      # Start harness (pre-compiled)
npx tsx src/harness/server.ts --verbose    # Start harness (dev mode)
interlinked harness start                  # Start as daemon
interlinked harness stop                   # Stop daemon
interlinked harness status                 # Show status + loaded rules
interlinked harness checks                 # Authoritative check inventory (per-family counts + total)
interlinked harness test "rm -rf /"        # Test command against rules
npm run docs                               # Regenerate reference docs
```

### A blocked edit is a stale-daemon suspect first

**The running daemon serves the build it started with.** `interlinked harness
start` loads `dist/harness/server.js`; editing `src/harness/**` changes nothing
about the process currently answering the socket. So when a gate blocks an edit
that *should* pass — or a fix you just wrote fails to take effect — the first
hypothesis is not "the guard is misconfigured", it is **"the daemon is older
than the fix"**. Two sessions were spent diagnosing correctly-configured gates
that were simply not the code running.

Check freshness before theorising:

```bash
find src -name '*.ts' -newer dist/harness/server.js -print -quit   # any output => build is stale
interlinked harness status                                          # pid + loaded rules
npm run build && interlinked harness restart                        # the actual fix
```

(Scope the freshness probe to all of `src` — the daemon bundles `src/lib` and
`src/commands` too, so a `src/harness`-only probe misses ~100 importer files.)

`~/.claude/hooks/interlinked-gate-status.sh` runs this at SessionStart and
prints a warning, so the staleness should be in context before the first edit.
Orphan daemons from other sessions can't steal the socket (the PID-aware
anti-stomp guard owns that), but multi-session restart churn can briefly leave
NO daemon answering — tool calls then fail closed until the auto-restart wins;
`interlinked harness start` reaps orphans and reports what it reaped. A rebuild
here also does NOT reach other repos' daemons: each guarded repo (e.g.
mcp-client-bio) runs its own copy of this build — restart those daemons too
after a harness change that matters to them.

The gate semantics themselves are documented where they are enforced — the line
cap in *Per-file line cap* above, installs in *Supply-chain allowlist*, the
water-lines in *Baseline-integrity gate*. Do not restate their thresholds here;
duplicated policy numbers drift, which is a class this repo's own
`duplicated_policy_constant` check exists to catch.

**Harness source files (core):**
| File | Purpose |
|------|---------|
| `src/harness/types.ts` | All type definitions |
| `src/harness/server.ts` | Node.js Unix socket server (main entry, `node:net`) |
| `src/harness/evaluator.ts` | Guard evaluation: PreToolUse blocking + PostToolUse feedback |
| `src/harness/rules-loader.ts` | <!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> built-in rules + JSON config + hot-reload |
| `src/harness/session-state.ts` | Per-session trajectory tracking |
| `src/harness/cohort.ts` | Agent cohort manager |
| `src/harness/reservations.ts` | Auto file reservation with optimistic locking |
| `src/harness/quality-checks.ts` | PostToolUse: <!-- gen:quality_check_count -->33<!-- /gen:quality_check_count --> checks across 8+ languages (tsc, biome, cargo, rustfmt, mypy, ruff, etc.) |
| `src/harness/server-bridge.ts` | Server coordination: reservation sync, guard event reporting |
| `src/harness/trigram-index.ts` | Trigram search index: build, query, serialize, dirty layer |
| `src/harness/regex-trigrams.ts` | Regex → trigram decomposition, rg command parsing |
| `src/harness/grep-accelerator.ts` | PreToolUse grep acceleration: index query + block-and-answer |
| `src/harness/large-file-policy.ts` | Per-file line cap: threshold, `isCappableFile` predicate, baseline loader, ratchet verdict |
| `src/harness/mutation/` | Per-edit mutation gate (spec `docs/design/per-edit-cloud-mutation-testing.md`): stable mutant identity, `mutation-manifest.json` + receipts, survivor-diff invariant, ChangeSet overlays, cloud runner client. Config `per_edit_mutation` (default off; `budget_ms` caps the runner round-trip). Engine scaffolding: root `stryker.conf.json` (MUST ignore `.interlinked/` — Stryker's tree-copy crashes on the harness socket) + `vitest.stryker.config.ts`. Probe: `npx tsx .interlinked/e2e-mutation-gate.mts`. The older per-file score ratchet (`mutation-gate.ts`, `interlinked mutation check`) is a separate, coarser system. |
| `src/harness/check-inventory.ts` | **Single source of truth for "how many checks."** `getCheckInventory()` derives per-family counts (inline `CHECK_REGISTRY` / sequence / structural / tool-quality / suggestion / behavioral — disjoint) live from each registry; pinned by `check-inventory.test.ts`; surfaced by `interlinked harness checks`. `GENERIC_CHECK_META` is the doc-view of a subset of the inline family, NOT a count — never sum it. Guard rules (`BUILTIN_RULES`) are a separate primitive, pinned by docs-freshness. |
| `src/harness/evaluator/complexity-pulse.ts` | Ambient per-edit cyclomatic telemetry: the strict gate's observer stashes its already-paid before/after parses at PreToolUse; PostToolUse emits one `[interlinked:cyclomatic]` line per edited code file (ΣCC + max + per-fn Δ; absolutes on stash miss). Same population as the gate (cappable files). Live probe: `node .interlinked/e2e-pulse-probe.mjs` (flip `per_edit_coverage` off first or expect overlay-run latency). |
| `src/harness/agent-metrics.ts` | Per-subagent cost + activity, summed off the agent's OWN transcript (2026-08-08): tokens (input/output/cache read/creation), models, per-tool call counts, `tool_use_ids`, turn counts, duration, thinking-block counts. The stop payload carries NO usage (0/1507 measured), so this is the only capture point. `tool_use_ids` is the attribution key — a subagent's tool calls reach the guard under the PARENT session id with no agent marker, so joining activity.jsonl rows back to their agent requires this list. |
| `src/harness/server/agent-event-context.ts` | Label + metrics resolution for one agent event. `SubagentStart` carries `agent_type`, `SubagentStop` usually does not (1439/1507 unlabeled), so the daemon remembers the start label and re-attaches it; `agent_type_source` records payload-vs-remembered. Empty-string labels normalize to null. |
| `src/harness/background-task-log.ts` | Background-agent roster capture (2026-08-08, found by the census): Stop/SubagentStop carry `background_tasks: [{id,type,status,description,agent_type}]`. A background agent fires NO per-agent hook — its result reaches the parent over a queue notification — so this array is the only report that it exists. One row per observed STATE CHANGE to `.interlinked/background-tasks.jsonl`; honors `dry_run`. |
| `src/harness/payload-key-census.ts` | **The "are we capturing everything" backstop.** Every hook invocation diffs the raw runner payload's top-level keys against `CONSUMED_PAYLOAD_KEYS` and records the leftovers — with a TYPE + MEMBER-NAME shape, never values — to `.interlinked/payload-keys.json`. The conversion to the harness event copies a fixed whitelist, so a field a runner starts sending is otherwise dropped in silence; this is how the subagent token/label gaps stayed invisible. When you add a reader for a field, add it to `CONSUMED_PAYLOAD_KEYS` in the same change. |
| `src/harness/server/agent-event-capture.ts` | Subagent/parallel-agent result capture (2026-07): SubagentStart/SubagentStop/TaskCompleted → `agent_event` records in collection.jsonl. The final message comes from the hook payload or a bounded tail-read of the agent's transcript (scrubbed, 64KB cap) — SubagentStop is the ONLY hook carrying a background agent's result (the queue-notification delivery fires no hook). Also one-shot drains the agent's own transcript into timeline.jsonl (`agent_id`-attributed) with a 750ms re-drain covering the runner's post-Stop flush race. Surfaced by `interlinked logs --type subagent_stop`. |

**Harness source files (analysis):**
| File | Purpose |
|------|---------|
| `src/harness/structural-checks.ts` | 25 dependency-aware checks (export surface, import resolution, cycles, blast radius) |
| `src/harness/checks/<family>.ts` | 50+ inline code analysis checks split by family (SQL injection, complexity, async/await, PII, secrets, etc.). New detectors go here. |
| `src/harness/generic-checks.ts` | Compatibility barrel re-exporting from `checks/<family>.ts`. Do not add new detectors here; import from `checks/<family>.js` directly. |
| ~~`src/harness/check-registry.ts`~~ | **Removed 2026-08-17** — the flat-file compatibility shim had zero importers. Import from `check-registry/index.js`. |

**Stop-event reflection helpers** (formatters returning `string | null`, called from the `server.ts` Stop / SessionEnd branch; never block — all stderr warnings only):
| File | Purpose |
|------|---------|
| `src/harness/commit-cadence.ts` | Stop nudge when too many uncommitted code-file edits this session + mid-session backstop. Escalates wording by session token band. Says "Don't push." |
| `src/harness/verification-stop-checks.ts` | Three nudges: unverified code (no tsc/test/lint/build), UI not interacted (no dev-server / browser MCP), stubs introduced (TODO/FIXME/disabled-test/throw-not-impl). Signal capture lives in `session-state.ts` (trajectory signals) and `evaluator/post-tool.ts` (content scan). See `docs/design/stop-event-checks.md` for the Tier 2 / 3 backlog. |

### Agent-quality checks (added 2026-04)

Ten new cold-agent-clarity checks landed as part of the agent-quality rollout
(see `docs/design/harness-agent-quality-checks-plan.md`). Each is registered
through `check-registry/entries-warnings.ts` (or `entries-errors.ts` for
`promise_reject_non_error`) and surfaces in `interlinked verify`.

| Check | Phase | Severity | Gate |
|-------|-------|----------|------|
| `floating_promises` | pre_warn | warning | default |
| `non_null_assertion_ratchet` (metric) | post | warning | default |
| `broad_object_types` | pre_warn | warning | default |
| `boolean_trap` | post | warning | advisory |
| `magic_literal_in_conditional` | post | warning | advisory |
| `promise_reject_non_error` | pre_block | error | default |
| `unvalidated_json_boundary` | post | warning | advisory |
| `dead_exports` (generic variant) | post | warning | advisory |
| `circular_imports` | post | warning | advisory |
| `lifecycle_cleanup` | post | warning | advisory |
| `default_export` | post | warning | advisory |
| `positional_optional_boolean` | post | warning | advisory |
| `many_optional_params` | post | warning | advisory |

Advisory checks only run under `verify --all-checks`; default-gate ones run
on every edit. Non-null-assertion enforcement is a ratchet metric alongside
`as any` and suppression directives: the pre-edit count is baselined and any
post-edit increase is flagged.

### Bug-class checks generalized from review findings (added 2026-06)

Four detectors generalized from concrete review bugs so the harness catches the
same CLASS in any guarded repo. Detectors live in their own `checks/` family
files; the first three are registered (PostToolUse + verify), `gitignored_written_config`
is verify-only (its 3-arg signature can't satisfy the registry's
`(content, filePath) => InlineMatch[]` contract — it needs a `git check-ignore`
resolver, so it sits in `VERIFY_ONLY_CHECKS`).

| Check | File | Phase | Gate | Catches |
|-------|------|-------|------|---------|
| `nan_coercion_guard` | `checks/nan-coercion.ts` | post | **default** | `Date.parse`/`Number`/`parseInt`/`parseFloat` result used in a `< > <= >=` comparison with no `Number.isFinite`/`isNaN` guard — NaN reads as false → fail-open. (Found + fixed 2 real instances in `sponsor/types.ts` on landing.) |
| `write_without_mkdir` | `checks/fs-write-safety.ts` | post | advisory | `writeFileSync`/`appendFileSync`/`writeFile`/`createWriteStream` to a nested path with no prior `mkdirSync(…, {recursive})` / `existsSync` guard → ENOENT. |
| `duplicated_policy_constant` | `checks/policy-constant-drift.ts` | post | advisory | a bare numeric literal duplicating a same-file `DEFAULT_*`/`*_CAP`/`*_THRESHOLD` constant's value (drift — the literal won't follow the constant). |
| `gitignored_written_config` | `checks/gitignored-write.ts` | (verify-only) | advisory | code writes a statically-resolvable config path that `.gitignore` excludes with no `!` carve-out → never committable. |

**Test-quality (from external-pulse intake):** `introverted_test` (`checks/introverted-test.ts`, post, advisory) flags `it()/test()` blocks whose assertions never trace to a non-mocked system-under-test call/read — the static-dataflow layer beneath `mock_only_test` (matcher kind) and `test_missing_sut_import` (the import). SUT = the companion module only; it does not fire when the SUT is exercised in the body (directly or via a file-local factory helper). Ported from Uncle Bob's deintroverter4clj; intake at `docs/external-pulse/deintroverter.md`. Dogfood: 0/791 test files on landing.

Shared patterns when adding another agent-quality check (verified
against current code, May 2026):
1. Detector in `src/harness/checks/<family>.ts` (a new family file or
   an existing one — e.g. `iteration-safety.ts`, `b-series.ts`, `pii.ts`).
   The barrel `src/harness/generic-checks.ts` re-exports automatically;
   do not add new detectors directly to the barrel.
2. Canonical registry entry in `src/harness/check-registry/entries-warnings.ts`
   (or `entries-errors.ts` for `pre_block` errors). Phase contract is in
   `src/harness/check-registry/types.ts` — `pre_block` is reserved for
   fully-deterministic, zero-FP errors only.
3. Metadata entry in `src/harness/check-metadata.ts`.
4. ~~Legacy-mirror entry~~ — the flat `src/harness/check-registry.ts` shim is
   deleted (2026-08-17). No manual sync step. Skip.
5. Verify wiring is split across `src/commands/verify/`:
   - `advisory.ts` — `DEFAULT_ADVISORY_SKIPS`, skip-set helpers
   - `file-checks.ts` — per-file check orchestration
   - `tool-results.ts` / `tool-results-types.ts` — tool result aggregation
   - `section-table.ts` / `output-json.ts` — formatters
   - `streaming-output.ts` — `streamCqSection` and friends
   The orchestrator `src/commands/verify.ts` still holds `VerifyOpts` /
   `ToolSpec` and re-exports `DEFAULT_ADVISORY_SKIPS`. Touch only the
   subfile your check actually surfaces in.
6. Update `AGGREGATED_IN_JSON` in `__tests__/check-pipeline-parity.test.ts`
   and `DEFAULT_ADVISORY_SKIPS` in `src/commands/verify/advisory.ts` +
   its regression test when demoting to advisory.
7. Each new check ships with labeled MUST-FIRE and MUST-NOT-FIRE cases
   meeting its **phase-scaled** obligation under the Check Evidence
   Contract (below) — not a flat count.

### Check Evidence Contract (added 2026-07-26)

The checks are what everything else trusts, and they used to be the least
verified code in the tree: the old "≥3 positive / ≥3 negative" rule was prose
with no pin, and **13 of 100** check test files followed it. `src/harness/check-evidence/`
replaces it with a measured, phase-scaled contract. Spec:
`docs/design/verification-density-program.md`.

A flat count was always a proxy for the real question — *does every
distinguishable behavior of the detector have a case in both directions?* One
case is **complete** if it covers the only branch; three is negligent if there
are twelve. So the obligation scales by phase, and Phase 3 will derive it from
the detector's own branch structure.

| Tier | Min +/− cases | Branch cov | Corpus | Mutation | Adversarial |
|---|---|---|---|---|---|
| `pre_block` | 3 / 3 | 100% | required | required | required |
| `pre_warn` | 2 / 2 | 100% | required | required | — |
| `post` (default gate) | 2 / 2 | 90% | required | — | — |
| `post` (advisory) | 1 / 1 | 80% | — | — | — |

Only the case counts and test-file presence are **enforced** today; the later
columns are recorded on the tier and enforced in Phases 2–4 (reporting them as
shortfalls now would fail every check on landing and teach the agent to ignore
the pin).

| File | Purpose |
|---|---|
| `check-evidence/types.ts` | Evidence record, tier, verdict, baseline shapes |
| `check-evidence/obligations.ts` | The four tiers + `tierFor` / `evaluateEvidence` |
| `check-evidence/case-parser.ts` | Extracts labeled cases from test source (two conventions) |
| `check-evidence/resolve.ts` | Detector-name → source file + exercising test files |
| `check-evidence/extract.ts` | Registry-wide sweep producing records + verdicts |
| `check-evidence/baseline.ts` | Loads the shrink-only grandfather list |
| `check-evidence/contract.test.ts` | **The pin.** Fails on any ungrandfathered violation |

Labeling conventions the parser recognizes — either is enough:
- a `describe()` whose title names a direction (`"— positive (must fire)"` /
  `"— negative (must not fire)"`); every `it()` inside inherits it
- a per-test prefix (`it("P1: …")` / `it("N3: …")`), which overrides the
  enclosing describe

Four evidence dimensions exist (`cases`, `corpus`, `derived_cases`, `mutation`,
`adversarial`); enforcement is **staged** via the baseline's `enforced` field,
which is GROW-ONLY under `baseline_integrity_gate`. At landing only `cases`
fails the pin — the rest are measured and reported so turning one on later is a
ratchet step with a known backlog, not a guess. Supporting modules:
`corpus.ts` / `corpus-scan.ts` (dogfood runs + adjudication,
`.interlinked/check-corpus.json`), `recall.ts` (case floors derived from the
detector's own branch structure; detector mutation scores), `adversarial.ts`
(independent FP hunt, bound to a source hash so rewriting the detector re-opens
the review).

**A check earns per-edit latency by catching defects, not by expressing taste.**
Both checks added by this program (`halstead_difficulty` — Halstead density,
the dimension the control-flow metrics cannot see; `property_test_candidate` —
pure algorithmic functions with no property test) are **verify-only**, decided
on measurement: the property check reads companion test files so it is not the
pure `(content, filePath)` function the registry contract requires, and the
Halstead check's full TS parse pushed `determinism-conformance` past its 30s
budget on the inline path. Both are advisory and fire ~17 / ~62 times
repo-wide — deep-audit cadence. They live in `VERIFY_ONLY_CHECKS` alongside
`gitignored_written_config` and `readme_script_drift`.

**The corpus obligation is not ceremony.** `halstead_difficulty` was calibrated
on unit-test fixtures at a difficulty ceiling of 25; the corpus run over 9023
real functions showed that is the *75th percentile* and produced 2226 findings.
Recalibrated to 80 it produces 17. Calibrate new checks against the tree, never
against fixtures.

Compliance (2026-08-04): **151/252 checks pass; 101 grandfathered** in
`.interlinked/check-evidence-baseline.json` (committed, carved out of the
`.interlinked/*` ignore). The list is **shrink-only** and enforced by
`baseline_integrity_gate` (`check-evidence` kind) — adding an id there exempts a
check from having to prove it works, so it blocks. New checks get no
grandfathering. Worst tier is still the strictest one: `pre_block` hard rails
sit at 54% (20/37), so backfill those first. Re-derive these numbers with
`npx tsx scratch/evidence-tier-census.mts` rather than trusting the prose.

| `src/harness/project-graph.ts` | Multi-project file dependency graph with caching |
| `src/harness/impact-analysis.ts` | Cross-file dependency tracking and breaking change detection |
| `src/harness/change-propagation.ts` | Side-effect tracking across edits |
| `src/harness/error-history.ts` | Error pattern memory with optional embeddings support |
| `src/harness/language-profiles.ts` | Language-specific checks for 12+ languages |
| `src/harness/taint-tracker.ts` | Sensitivity classification (Public/Confidential/Secret) and flow tracking |
| `src/harness/pattern-detector.ts` | Cross-cutting pattern detection |
| `src/harness/suggestion-scorer.ts` | Weighted finding scoring and ranking |
| `src/harness/registry-parity.ts` | Configurable drift detector for paired registries / exception lists. Reads `.interlinked/registry-parity.json`; runs as part of `interlinked verify` and surfaces drift in both streaming and `--json` output. |
| `src/harness/suppressions.ts` | Inline suppression directives |
| `src/harness/check-metadata.ts` | Structural check metadata for docs generation |
| `src/harness/check-engine/` | Unified caching/memoization layer for checks |

**Harness source files (artifact structure):**
| File | Purpose |
|------|---------|
| `src/harness/structure/types.ts` | All structure type definitions (determinism, provenance, artifact kinds, graph shapes, config schemas) |
| `src/harness/structure/schema-validator.ts` | Validates `structure.json` and all 9 artifact file schemas (unknown-key rejection) |
| `src/harness/structure/structure-loader.ts` | Loads `interlinked/structure.json`, resolves mode defaults, loads artifact files |
| `src/harness/structure/artifact-graph.ts` | ArtifactGraph: node/edge CRUD, companion traversal, incremental refresh, serialization |
| `src/harness/structure/cache-manager.ts` | Read/write `.interlinked/structure-cache/` files, staleness detection, manifest hashing |
| `src/harness/structure/structure-checks.ts` | PostToolUse entry point: graph build, incremental refresh, declared artifact layering, rule evaluation |
| `src/harness/structure/structure-formatter.ts` | Human-readable `[interlinked:structure]` warnings, verify JSON output builder |
| `src/harness/structure/adoption.ts` | Coverage calculation per category (0.0–1.0) |
| `src/harness/structure/baseline.ts` | Baseline suppression matching, SHA-256 context hashing |
| `src/harness/structure/extractors/` | 7 generic extractors: module, package, env, config, test, docs, examples |
| `src/harness/structure/rules/` | 6 built-in rule families: public symbol companions, env/config key companions, layer/package boundaries, glossary residue |

**Auto-generated reference docs** (run `npm run docs` to regenerate):
| File | Contents |
|------|----------|
| `docs/generated/guard-rules.md` | All <!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> built-in guard rules by category |
| `docs/generated/quality-checks.md` | All <!-- gen:quality_check_count -->33<!-- /gen:quality_check_count --> PostToolUse quality checks |
| `docs/generated/structural-checks.md` | All <!-- gen:structural_check_count -->26<!-- /gen:structural_check_count --> structural checks by tier |
| `docs/generated/configuration.md` | Default config: diff-aware filtering + structural check settings |

**How guard evaluation works:**
1. Hook script connects to `/.interlinked/harness.sock` on PreToolUse
2. Harness evaluates event against rules + reservations + trajectory state
3. For Grep/Bash-grep calls: queries trigram index for candidate files, runs rg on candidates
4. Returns `{decision: "block"|"allow", reason?, warnings?}`
5. If blocked: hook outputs decision to stdout, agent sees reason
6. If warnings: hook writes to stderr, agent sees on next turn
7. If harness unavailable: inline fallback patterns (sleep, rm -rf, force push, DROP)

**Grep acceleration:**
- Build index: `interlinked index build` (0.1-10s depending on repo size)
- Harness loads index on startup, refreshes incrementally on each SessionStart
- Intercepts Grep tool calls AND Bash rg/grep commands (including from subagents)
- Queries index in ~10-50μs, narrows to candidate files, runs rg on candidates only
- Agent sees results via block-and-answer pattern (formatted like normal grep output)
- Dirty layer tracks file edits in-memory so agent's own writes are immediately searchable

**Important patterns:**
- Guard rules are in `.interlinked/guard-rules.json` (team-shared) + `.interlinked/guard-rules.local.json` (personal overrides)
- Built-in rules cannot be modified, only disabled via `disabled_rules` in local config
- The evaluator uses OR logic for patterns within a rule (any pattern match fires the rule)
- Negated patterns (`negate: true`) act as exceptions (if matched, rule does NOT fire)
- Quality checks (tsc, lint, etc.) run on PostToolUse only — they need the file on disk and full project context
- Structural checks (export surface, import resolution, etc.) also run on PostToolUse
- Diff-aware filtering suppresses pre-existing findings, only reporting issues introduced by the current edit
- `pre_block` registry checks are likewise **introduced-only** at both write gates (shared semantics in `src/harness/pre-block-gate.ts`): a finding blocks only when the edit adds it vs the on-disk baseline (multiset over normalized line text); pre-existing findings surface as warnings instead of bricking the file for unrelated edits. Inline `// interlinked-ignore: <check> — reason` directives and `.interlinked/verify-suppressions.json` entries are honored at pre-block time (same grammar as PostToolUse/verify; ratcheted, auditable)
- Secrets detection runs on BOTH PreToolUse (in file content) and PostToolUse (re-check)

## Findings carry a determinism tag

Every warning the harness sends to the agent is prefixed with a `[proven]`
or `[heuristic]` tag derived from the check's `Determinism`:
`fully_deterministic` → `[proven]` (compiler / linter / scanner / parser
ran the actual code); everything else → `[heuristic]` (regex / AST shape,
not behavior-verified). Unknown check ids get no tag rather than a
guessed one. The classifier lives in
`src/harness/quality-checks.ts::classifyDeterminism`; the proven
allow-list for tool-based checks is in
`src/harness/quality-checks/instructions.ts::PROVEN_TOOL_CHECKS`.

When adding a new tool-based check (one that wraps an external
verifier), add its id to `PROVEN_TOOL_CHECKS`. Inline checks in
`CHECK_REGISTRY` use their existing `determinism` field — no parallel
maintenance.

Suppression comments (`// @ts-ignore`, `// eslint-disable-next-line`,
`// biome-ignore`) are split into two warnings: `suppressions-unjustified`
(loud, line-numbered) and `suppressions` (soft, fired only when every
disable on the file carries a reason). Justification conventions: any
text after `@ts-ignore`/`@ts-expect-error`; ` -- ` for ESLint; `:` for
Biome. `@ts-nocheck` is exempt (file-level, no per-line convention).

## Querying the local data (`.interlinked/`) — check it BEFORE raw transcripts

`.interlinked/INDEX.md` (generated, point-in-time) maps every entry in the data
directory — schemas, sizes, live/dead status, and bounded shell recipes. The
local logs are richer than `~/.claude/projects/*.jsonl` transcripts: they carry
cross-runner tool events (`collection.jsonl`), guard verdicts with rule ids
(`activity.jsonl`), per-check outcomes (`check-results.jsonl`), and token costs
(`costs.jsonl` — dormant since 2026-06-01). Query them first; fall back to raw
transcripts only for something genuinely absent locally.

`interlinked query` is the read verb (added 2026-07-24): `interlinked query`
with no args prints the source catalog; `query blocks`, `query checks --by
checks.id --since 7d`, `query costs --by session_id --sum output_tokens`, or
any `.jsonl` path with `--where k=v`. Scans are bounded by default (newest 20k
records / 64 MB tail) and the footer always states how much was scanned.
**Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl`** —
they are hundreds of MB; bound every read (`tail -n` / `interlinked query`).

## Recurrence — repeating-pattern aggregation

`interlinked recurrence` surfaces patterns that recur across sessions,
files, or agents. Three observation kinds, all stored in one
append-only JSONL log at `.interlinked/recurrences.jsonl`:

| Kind | Source | Suggested action |
|------|--------|------------------|
| `harness_caught` | Wired into `server.ts` after `errorHistory.recordError(...)` — fires automatically on every PostToolUse check failure | Ratchet (advisory → default → block) |
| `harness_missed` | Manual: `interlinked recurrence flag <signature>` for patterns the harness should have caught | Scaffold a new rule entry |
| `codebase_existing` | `interlinked recurrence scan [--record]` walks the working tree with the same inline detectors used at edit time | Cleanup PR |

```bash
interlinked recurrence list                        # Top rows by count
interlinked recurrence list --kind harness_caught  # Filter
interlinked recurrence detail <signature>          # All events for one row
interlinked recurrence flag raw-sql-concat \
  --message "spotted in db.ts" --file src/db.ts    # Manual harness_missed
interlinked recurrence scan --record               # Append codebase_existing
interlinked recurrence propose <signature>         # Suggested action
```

All deterministic — counting + grouping over the JSONL, no LLM-as-judge
in the aggregator (per `feedback_harness_deterministic_only.md`).
Aggregation is computed on demand from the log; no separate cache.

Source files:
- `src/harness/recurrence.ts` — types, storage, aggregation, `proposeAction`, `recordHarnessCaught` / `recordHarnessMissed` wrappers
- `src/harness/recurrence-scanner.ts` — `scanCodebaseForRecurrences` (walks the working tree, runs `buildAgentSafetyChecks` per file)
- `src/commands/recurrence.ts` — CLI subcommands (list/detail/flag/scan/propose)

The existing `non_null_assertion_ratchet` and `as any` ratchets are a
specialized form of `harness_caught` recurrence response. Future
unification: subsume them under the recurrence model (one place to
declare "this is a recurring shape; ratchet over time").

## Reservations are a single-source-of-truth state machine

`src/harness/reservations.ts` declares its state changes as one
`ReservationTxn` discriminated union and applies them through one
`applyTransition(state, txn)` function — Bitar's "edge-defined-once"
pattern adapted for TS. Both live execution and `replayTransitions(events)`
go through the same dispatch, so live state and replay can't drift.

Optimistic local grant + async server confirm: the server-confirm
rejection path now rolls back the local grant and emits a
`conflict` event with `conflict_reason: "server-rejected"` (was a
silent `.catch(() => {})` before — the silent-double-allocation bug
class). The conflict event carries the rollback reason for log
consumers (`reservation-events.jsonl`, `interlinked recurrence`
aggregation).

Property tests in `src/harness/__tests__/reservations.test.ts` use
`fast-check` to assert: replay==live, no double-grant, release
ownership-respecting + idempotent, evict_remote local-safe,
release_all targets exactly the named agent.

## Architecture

### Relationship to the MCP Server

The server (`Interlinked MCP Server`) is the remote Worker/DO system. Communication is strictly one-directional: CLI → server via HTTP. Key server endpoints consumed:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/hooks/activity` | Single event (fire-and-forget from hook script) |
| `POST /api/hooks/activity/batch` | Batch sync of buffered events |
| `POST /api/ui/call` | MCP tool proxy (used by `status`, `activity`, `doctor`, `workspace`) |
| `GET /api/workspaces` | List workspaces (registry endpoint) |
| `POST /register`, `POST /token` | OAuth dynamic client registration and token exchange |

### Entry Point and Command Registration

`src/index.ts` registers all commands via `commander`. When invoked with no arguments, `handleImplicitEntry()` from `src/commands/first-run.ts` runs an interactive wizard (TTY) or non-interactive bootstrap (non-TTY). If already configured, it falls through to `statusCommand`.

### Key Source Files

| File | Purpose |
|------|---------|
| `src/lib/config.ts` | Two-tier config system: `config.json` (shared/committed) + `config.local.json` (personal/gitignored). `resolveConfig()` merges both and resolves multi-server entries. |
| `src/lib/auth.ts` | Token resolution (CLI token → Claude Code credentials fallback) + OAuth PKCE flow |
| `src/lib/hooks.ts` | Orchestrator: hook script generation + per-client install/uninstall delegation through `CLIENT_INSTALL_REGISTRY`. Generates `.interlinked/hooks/interlinked-activity.mjs` (self-contained, zero imports). |
| `src/lib/hook-installers.ts` | Per-client install/uninstall implementations (Claude Code, GitHub Copilot CLI, Gemini CLI, OpenAI Codex CLI). Each `installXxxHooks` writes a settings file and tags commands with `INTERLINKED_CLIENT="<id>"` so the .mjs runtime can disambiguate clients with overlapping payload shapes. Codex additionally writes `.codex/config.toml` to set `[features] hooks = true` (legacy `codex_hooks` is recognized and auto-migrated; the writer lives at `src/lib/codex-feature-flag.ts`). |
| `src/lib/api-client.ts` | HTTP client wrapping `POST /api/ui/call` for MCP tool proxying |
| `src/lib/local-activity.ts` | JSONL append-only log, session state, sync cursor (byte-offset), merge/dedup |
| `src/lib/activity-utils.ts` | Shared `ActivityEvent` type, `parseDuration()`, `formatActivitySummary()` |
| `src/lib/formatter.ts` | ANSI colors, tables, timestamps — hand-coded, no external deps. Respects `NO_COLOR`/`CI`. |
| `src/lib/output.ts` | Output mode abstraction: `json`, `short`, `normal`, `full` |
| `src/lib/settings.ts` | Client detection and settings file paths for claude/copilot/gemini/codex (registry consumed by `interlinked enable`/`disable`) |
| `src/lib/viz/` | The loopback dashboard (`interlinked viz serve`). `feeds.ts` is the seam: each live lens is ONE `VizFeed` descriptor (route + seed + subscribe) and `server.ts` hosts them all through one generic SSE path — add a lens there, not by copying the plumbing. `agent-roster.ts` folds the activity stream into per-actor presence lanes (a subagent gets its OWN lane keyed `<agent>/<subagent_id>`, never merged into its parent's counters) and assigns each actor a stable hue — the ONE hashing rule for actor colour, reused by every surface that attributes work to an agent. Dashboard vocabulary is deliberately literal: dot = source file, line = import, lane = agent session, frame = one judged tool call. Feeds: activity, `check-results.jsonl`, `test-events.jsonl` (TESTS), `mutation-manifest.json` (MUTANTS). `reporter-vitest.ts` is the shipped producer for the test feed, published as the `interlinked-cli/viz-reporter` export and duck-typed against vitest so it never imports it. `status-file.ts` publishes `.interlinked/viz.status` so the statusline renders a `◈ viz` link only while a server is actually alive. Every feed renders an honest empty state when its file is absent — nothing is repo-specific. |

### Activity Event Pipeline

```
AI Agent hook fires → stdin JSON → hook script (.interlinked/hooks/interlinked-activity.mjs)
  ├── Connect to harness socket (if available, 500ms timeout)
  │   ├── PreToolUse: harness returns {decision: block/allow} → stdout
  │   └── PostToolUse: harness returns {warnings} → stderr
  ├── Local write (always, sync, ~0.1ms) → activity.jsonl + sessions/{id}.json
  ├── Fire-and-forget POST /api/hooks/activity (if sync_mode != "local", 3s timeout)
  └── Batch sync on session end (if sync_mode == "realtime", cursor-based, 100-event chunks)
```

Three sync modes: `realtime` (default), `local` (offline-only), `manual` (POST per event, no batch at session end).

### Two-Tier Config System

| File | Git | Contains |
|------|-----|----------|
| `.interlinked/config.json` | Committed | `server_url`, `default_project`, `version` |
| `.interlinked/config.local.json` | Gitignored | `access_token`, `agent_name`, `workspace_id`, `sync_mode`, `servers` map |

Multi-server isolation: `config.local.json` has an `active_server` key and `servers` map. Each server entry holds its own `server_url`, `workspace_id`, and `mcp_prefix`.

Environment variable overrides: `INTERLINKED_SERVER_URL`, `INTERLINKED_ACCESS_TOKEN`, `INTERLINKED_AGENT_NAME`, `INTERLINKED_WORKSPACE_ID`, `INTERLINKED_SYNC_MODE`.

### Auth Token Resolution

`resolveAuthToken()` priority:
1. CLI's own `access_token` from `config.local.json` (checks `token_expires_at`)
2. Claude Code credentials fallback from `~/.claude/.credentials.json` → `mcpOAuth`, matched by `mcp_prefix` key prefix or `serverName` containing "interlinked"

Dev mode bypass: when `server_url` is localhost/127.0.0.1, auth is skipped entirely.

## Three-tier policy enforcement (Tier 1 shipped 2026-05, Tier 2/3 designed)

`/enforce` runs three passes over agent-instruction markdown (AGENTS.md,
SKILL.md, CLAUDE.md, .clinerules/, etc.) and emits artifacts for three
enforcement tiers:

| Tier | Layer | Consumer | Artifact | Cadence |
|---|---|---|---|---|
| 1 | Local deterministic | Interlinked harness (sub-10ms) | `.interlinked/distilled-rules.json` | Every tool call |
| 2 | Cloud LLM policy gate | gpt-oss-safeguard-120b (~3-6s) | `.interlinked/policies/<group>.policy.md` + `.cedar` + `.interlinked.cedar` | Most tool calls (post-filter) |
| 3 | Cloud architectural review | Sonnet/Opus on staged commits (~30-120s) | `.interlinked/policies/<group>.prose.md` | Pre-push / on-demand `/review` / `/security-review` |
| — | Audit | Humans | `.interlinked/policies/skipped.report.md` | After /enforce runs |

The Cedar emission is Sondera-compatible by default (drops into Sondera's
`policies/` directory). Policies needing skill-scope or trajectory state
get a sibling `.interlinked.cedar` file using extensions documented at
`docs/design/interlinked-cedar-extensions.cedarschema`. Pass 3 prose
artifacts are consumed by the Tier 3 cloud agent during pre-push review
for after-the-fact evaluation against principles the deterministic layers
can't enforce. See `skills/enforce/SKILL.md` §15 for the full routing
contract and `docs/examples/policies/disk-forensics/` for a worked example.

Tier 2 and Tier 3 are designed but not built — full design memos at
`docs/design/tier-2-llm-policy-gate.md` (architecture, provider selection,
prompt caching, pre-filter, cost model, rollout cadence) and
`docs/design/tier-3-async-deep-review.md` (trigger model, scope, model
selection, prose-policy evaluation pipeline, warn-only contract). Only
Tier 1 (and the artifact-emission side of /enforce) is shipped. Local-only
mode (no cloud): policy and prose artifacts load as agent context but
aren't enforced; Cedar files work for self-hosted Sondera.

## Supply-chain allowlist (fail-closed package installs)

Built 2026-05 in response to the surge of malicious npm / PyPI packages.
**Default stance: any new dep is potentially malicious.** Three gates,
one allowlist, every ecosystem:

| Vector | Gate | File |
|---|---|---|
| Shell `npm install <pkg>`, `pip install <pkg>`, `cargo add`, `go get`, … | PreToolUse Bash gate | `src/harness/evaluator/package-install-guard.ts` |
| Edit/Write to `package.json` / `requirements.txt` / `pyproject.toml` / `Cargo.toml` / `Gemfile` / `go.mod` that adds a new dep | PreToolUse Write gate | `src/harness/evaluator/manifest-edit-guard.ts` |
| Same shell commands when the daemon is unreachable | Cold-fallback gate | `src/hook-entry-cold-gates.ts::coldPackageInstallBlockReason` (allowlist-aware) + `src/lib/hook-template-chunks/package-install-cold-guard.ts::checkPackageInstallCold` (the .mjs copy: refuses every install verb — it cannot reach the parser or the allowlist) |

Coverage: **npm / pnpm / yarn / bun + pip / pip3 / pipx / poetry / uv +
cargo + gem / bundle + go**. URL-based specs (`git+`, tarball, `file:`)
are blocked unconditionally — they bypass registry signing entirely.
Custom `--registry` / `--index-url` overrides are likewise blocked.

The allowlist lives at `.interlinked/package-allowlist.json` (committed).
Two grant kinds:
- **Per-package** — exact name match, ecosystem-keyed.
- **Lockfile snapshot** — sha256 of a manifest or lockfile, approving its
  entire resolved state. Re-snapshot whenever the file changes.

Bypass for one command: `INTERLINKED_DISABLE_PACKAGE_GUARD=1` (logged,
intended for documented bootstrap flows only).

```bash
interlinked allowlist add npm lodash --by qcody --reason utility
interlinked allowlist snapshot --by qcody                    # hash all manifests + lockfiles in cwd
interlinked allowlist snapshot --lockfile package-lock.json --by qcody
interlinked allowlist list                                   # human-readable
interlinked allowlist list --json
interlinked allowlist verify                                 # diff manifest deps vs allowlist
interlinked allowlist remove npm lodash
```

**Approving a bad package is the worst failure mode** (after which install
proceeds silently), so `allowlist add` runs three admission screens and
refuses unless `--force` is passed (added 2026-06, adapted from cargo-deny's
CI role — see `docs/external-pulse/sondera-coding-agent-hooks.md`):
1. **Typosquat** — Levenshtein distance against popular names
   (`src/harness/checks/supply-chain.ts::findTyposquatMatch`); npm only (the
   popular-package list is npm-specific).
2. **License** — registry-declared SPDX expression vs the committed
   `license_allowlist` array in `package-allowlist.json` (default: permissive
   seed in `src/harness/license-policy.ts::DEFAULT_LICENSE_ALLOWLIST`). The
   license is recorded on the entry; manifest-edit-guard re-checks the
   RECORDED field per-edit (warning only, zero network on the hook path) so
   `--force`-admitted grants and later policy tightening stay visible.
3. **Advisories** — OSV query (`api.osv.dev`) for vulns affecting the latest
   published version.
Screens 2–3 fetch registry metadata (`src/harness/registry-metadata.ts`) —
network is acceptable at admission (human-invoked) and never on the hook
path; both fail open with a loud "screen skipped" note when offline.
`allowlist verify` exits non-zero on unapproved deps (CI-gateable).

Source files (added 2026-05):
- `src/harness/package-install-parser.ts` — pure-function parser for ten
  install verbs (npm/pnpm/yarn/bun/pip/pipx/poetry/uv/cargo/gem/bundle/go),
  classifies each positional spec as registry / git_url / tarball_url /
  local_path / file_url.
- `src/harness/package-allowlist.ts` — file I/O, sha256 snapshotting,
  per-spec `isPackageAllowed` decision, `effectiveLicenseAllowlist`.
- `src/harness/license-policy.ts` — SPDX allowlist seed + `isLicenseAllowed`
  (exact ids, WITH exceptions, top-level OR/AND; parens/`+` → conservative
  false).
- `src/harness/registry-metadata.ts` — admission-time-only network module:
  registry latest-version/license fetch + OSV advisory query (both fail open
  to null).
- `src/harness/evaluator/package-install-guard.ts` — daemon-side
  PreToolUse Bash gate combining parser + allowlist.
- `src/harness/evaluator/manifest-edit-guard.ts` — daemon-side
  PreToolUse Write gate; diffs the manifest's dep entries before/after
  the edit and blocks if any newly-added entry is not on the allowlist.
- `src/commands/allowlist.ts` — `interlinked allowlist` subcommand.

Tests pin every ecosystem path (positive + negative cases). The pre-2026-05
`builtin-npm-no-ignore-scripts` warn-only rule still fires for
defense-in-depth on allowlisted installs (a stale `--ignore-scripts`-less
install of a package that's been updated since approval is still risky).

## Sponsor slots

Opt-in sponsored row 3 on the statusline, driven by an Ed25519-signed feed
(fail-closed: unsigned/tampered/expired ⇒ no render; control bytes stripped
at the daemon). Client-side code is public: `src/harness/sponsor/`,
`src/commands/sponsor.ts`, `src/lib/sponsor-spinner.ts`,
`src/registrars/sponsor.ts`, row-3 render in
`src/lib/hook-installers-statusline.ts`. `interlinked sponsor
enable|status|disable` manages opt-in. Intake, review tooling, and the
Worker live in the private `interlinked-cloud` repo; operator notes in
`CLAUDE.local.md` (gitignored).

## External-pulse intake

Before "what can we do with X?" on a tool, paper, or repo found on the
internet, fill in the rubric at `docs/external-pulse/INTAKE.md` (six lanes
+ determinism filter + smallest-spike + which surface ships it). Output
goes to `docs/external-pulse/<slug>.md`, one page per project — PRIVATE
(2026-08-17: `docs/design`, `docs/plans`, `docs/external-pulse`, reviews,
marketing, and upstream-bug notes are real files here but gitignored from
this public repo and versioned by the operator overlay repo instead;
`.ignore` negations keep them searchable and @-mentionable. Competitive
intake, strategy, and unfixed-gap analyses do not belong in the public
tree. Overlay mechanics live in CLAUDE.local.md).
Skip the rubric for drive-by curiosity — it's specifically for the things
that would otherwise become a paste-and-ask. See `docs/external-pulse/codewiki.md`
for a worked example, including the "marketing-vs-reality" failure mode
(read the load-bearing function in source, not the README).

## Baseline-integrity gate (ratchet water-lines may only tighten)

Spec: `docs/design/baseline-integrity-gate.md`. Every ratchet (coverage / mutation /
per-edit-coverage / cyclomatic-slew / CRAP / line-cap / untested-file floor) decides
by reading a committed water-line JSON under `.interlinked/`. The agent being gated
has write access to those files, so lowering one is the canonical gate-gaming move —
it defeats every ratchet at once. `src/harness/evaluator/baseline-integrity-gate.ts`
(PreToolUse `block`, `rule_id: baseline_integrity_gate`, wired in `pre-tool.ts` via
`evaluateBaselineIntegrityGate` in `pre-tool-guards.ts`) blocks a Write/Edit/MultiEdit
that loosens any of `coverage-baseline.json`, `coverage-edit-baseline.json`,
`mutation-baseline.json`, `large-files-baseline.json`, `untested-files-baseline.json`,
`metric-caps.json`. **Direction is per-file and non-uniform** (see the doc's table):
coverage/mutation values may only rise; caps (`max_*`/`crap_threshold`) may only
tighten and `min_coverage` may only rise; `untested-files.files` is an *exemption
list* so it may only shrink; `large-files` grandfather counts may only shrink.
Compares against the **current on-disk** water-line (not git HEAD — most baselines are
gitignored), which the hook sees pre-write. The harness's own ratchet raises go through
internal `fs` writes (`coverage-ratchet.ts` etc.), never the edit tools, so they never
hit the gate. Bypass an intentional reset with `INTERLINKED_DISABLE_BASELINE_GUARD=1`.
**tsconfig strictness is a water-line too** (2026-09-01): `evaluator/config-loosening-gate.ts`
BLOCKS a Write/Edit that flips any tracked strictness flag off relative to git HEAD
(`strict` and its implied family, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, and the inverted-polarity
`allowUnreachableCode: false`). Same bypass env as above. `package.json` / biome loosening
stays ask-mode. The `tsconfig_strictness` check *demands* only four flags from any repo; the
three dead-code flags are advisory there — the gate ratchets them once a repo turns them on.

A **commit-gate backstop** (`evaluator/commit-baseline-gate.ts`, wired in
`pre-tool-pipeline.ts` before `runCommitGate`) closes the `apply_patch`/sub-agent hole
for the 3 git-tracked/stageable baselines (large-files, untested-files, metric-caps):
on a real `git commit` it diffs `git show HEAD:<f>` vs the staged blob through the same
`detectBaselineGaming` detector. A sibling test-integrity check, `snapshot_hygiene`
(`checks/snapshot-hygiene.ts`, advisory), blocks writing a `*.snap.new` / `*.pending-snap`
snapshot-review artifact (the snapshot analog of leaving an `.only`/`.skip` behind).

## Monotonic metric ratchet (bounded per-edit growth, hard cap as backstop)

Spec: `docs/design/monotonic-metric-ratchet.md`. Four metrics, each gated so no
edit leaves a function past its hard cap and (cyclomatic, cognitive) no single
edit makes a big complexity jump (per tool call, trajectory-aware via the
on-disk/baseline state). Every cap number below lives in
`.interlinked/metric-caps.json` — read it, don't trust this prose:
- **Cyclomatic** — `complexity-write-guard.ts`: a uniquely-named function present
  before+after may rise by at most `SUB_CAP_RATCHET_TOLERANCE` (= 2) branches *per
  edit* while at/under the 22-branch cap (`subCapRatchetViolations`); a larger
  one-edit jump blocks. New/anonymous/collision functions and any end-state over
  the cap are bounded by the cap (the over-cap path). No suppression; the escape
  is to decompose. Small rises across edits can walk a function toward the cap but
  never past it (the cap is the ceiling; the slew limit only governs how fast you
  approach it). Set the constant to 1 for a tighter "+1/edit" policy.
- **Coverage** — `coverage-write-decision.ts` (pre-existing): blocks an uncovered
  added line or a per-file coverage drop vs `coverage-baseline.json` (high-water).
- **Cognitive** — `cognitive-write-guard.ts`: mirrors the cyclomatic rules against
  the 30-point cognitive cap, with `SUB_CAP_COGNITIVE_RATCHET_TOLERANCE` (= 4),
  not 2 — cognitive runs ~1.5x higher than cyclomatic at shallow nesting and
  worse as it deepens, so copying 2 would false-block routine edits inside
  already-nested code. STRICTER than cyclomatic in one respect: it compares
  uniquely-named functions by identity (plus pooled rank for anonymous ones), so
  "shrink the target, spawn an over-cap helper" still blocks — cyclomatic's
  rank-only comparison reads that as an improvement and allows it. The block
  message steers toward flattening (guard clauses, extract the deepest-nested
  block), not cyclomatic's "extract a branch".
- **CRAP** — implied: CRAP = cyclo²·(1−cov)³+cyclo is ↑ in cyclo, ↓ in cov, so the
  bounded cyclomatic slew + coverage-hold-or-↑ bound the per-edit CRAP rise — it
  inherits the relaxation automatically. There is **no** separate sub-cap CRAP
  ratchet: every CRAP gate (`decideCrap` block, `computeCrapRisers` advisory)
  fires only at/over cap 25, which bounds new/touched functions and is the
  end-state backstop. A function whose coverage is UNKNOWN (no report entry)
  yields no CRAP finding at all — unknown is not 0%, and treating it as 0% drove
  CRAP to its ceiling and false-blocked edits to fully-covered code.

Endgame seam (mutation, not built this session): the per-edit run returns the
FULL `MetricRegression[]` (all metrics at once) so an agent fixes them in one
pass; a parallel mutation suite slots in as "another metric" over the same
scoped overlay + affected-test set, kept ≤25s by small files.

## Conventions

- **Output mode pattern**: All commands support `--json`, `--short`, `--full` via `getOutputMode(opts)` and `output(mode, data, { json, short, normal, full })`.
- **Graceful degradation**: Commands use `Promise.allSettled` for local+server parallel fetches, falling back to local-only when server is unavailable.
- **Dry-run support**: `enable`, `sync`, `clean` support `--dry-run` / `--force` patterns.
- **Hook script is self-contained**: The generated `.mjs` has no imports from the CLI package — it must work standalone even if the CLI is uninstalled.
- **Hook uninstall walks to git root**: `uninstallAllHooks()` checks ancestor directories via `findProjectRoot()` to clean `.claude/settings.json` files above CWD.
- **CWD-relative paths**: All `.interlinked/` paths are resolved relative to `process.cwd()`.

## Testing

```bash
npx vitest run                                          # Full suite (~20k tests; count drifts — don't pin it here)
npx vitest run src/harness/__tests__/evaluator.test.ts  # Harness guard tests
npx vitest run src/commands/__tests__/cli-bugs.test.ts  # CLI regression tests
```

Test files:
- `src/harness/__tests__/evaluator.test.ts` — destructive command blocking, sleep detection, protected files, curl-to-MCP, auto-reservations, safe command allowlist
- `src/harness/__tests__/trigram-index.test.ts` — trigram index, regex decomposition, grep accelerator
- `src/harness/__tests__/structural-checks-extended.test.ts` — structural check validation
- `src/harness/__tests__/generic-checks-extended.test.ts` — generic code analysis checks
- `src/harness/__tests__/impact-analysis.test.ts` — cross-file impact analysis
- `src/harness/__tests__/project-graph.test.ts` — project dependency graph
- `src/harness/__tests__/taint-tracker.test.ts` — sensitivity classification
- `src/harness/__tests__/diff-aware-checks.integration.test.ts` — diff-aware filtering
- `src/harness/__tests__/command-guard-parity.test.ts` — guard rule parity with inline fallback
- `src/harness/__tests__/docs-freshness.test.ts` — validates generated docs match source
- `src/harness/__tests__/hook-conflicts.test.ts` — hook installation conflict detection
- `src/commands/__tests__/cli-bugs.test.ts` — regression tests for numbered bugs (Bug 4, 5, 10, 14, 18, 21, 23, 24, 26)
- `src/commands/__tests__/activity-workspace-regressions.test.ts` — activity feed API contract and workspace switch tests

Tests heavily mock the file system and network. The test infrastructure uses vitest with `vi.mock()` for module-level mocking.

Manual harness testing via Unix socket:
```bash
node dist/harness/server.js --verbose &
echo '{"hook_event":"PreToolUse","session_id":"t","agent_source":"claude","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"timestamp":"2026-03-17T00:00:00Z"}' | nc -U .interlinked/harness.sock
# Expected: {"decision":"block","reason":"BLOCKED: Recursive deletion..."}
```

## Graph-prediction probes (checked-in regression harnesses)

Five end-to-end probes under `.interlinked/` exercise the full
predict/reveal/reconcile flow against the live daemon. Use them to
verify the system still works after any harness change. All five are
re-runnable, create + clean their own tmp fixtures, use unique session
ids; the first four require a running daemon, the cold-fallback probe
deliberately points at a non-existent socket to exercise fail-closed.

```bash
node .interlinked/e2e-protocol-probe.mjs    # core block→write→reveal flow (11 assertions)
node .interlinked/e2e-protocol-suite.mjs    # 6 cases × 3 modes (16 assertions)
node .interlinked/e2e-stability.mjs         # 5000-event burst, p99 + RSS budget
node .interlinked/e2e-hook-script.mjs       # dist/hook-entry.js → Claude Code envelope
node .interlinked/e2e-cold-fallback.mjs     # daemon unreachable → fail-closed gate fires (18 assertions)
```

See `docs/design/graph-prediction-verification-status.md` for what each
probe pins, plus the deployed-config snapshot.
