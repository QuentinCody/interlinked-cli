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

Source of truth for the CLI is `QuentinCody/interlinked-cli`; current installs run from a linked source checkout. It has a single **required** runtime dependency (`commander`) and zero external dependencies for formatting/output. Two **optionalDependencies** (installed by default; the CLI's core hooks/activity work without them): `typescript` — the JS compiler API the AST-accurate cyclomatic/CRAP gate parses with (the `tsgo` native-port binary has **no importable JS API**, so it can't substitute; TS 7's replacement is an out-of-process gRPC API, stable ~7.1) — and `@typescript/native-preview` (`tsgo`), which accelerates `npm run typecheck`. When `typescript` is absent (`--omit=optional`), the complexity gate degrades to the regex walker and says so loudly (`astComplexityAvailable()`; daemon-startup warning); the `self_import` pre_block check has NO regex fallback and is NOT MEASURED in that state — it reports no findings, and every JS/TS edit carries a `[interlinked:self_import] NOT MEASURED` warning (`checks/self-import-scan.ts`; a pre_block check never blocks on a guess).

## Working effectively in this repo (best-model profile)

These four habits are **measured, not asserted** — derived from the best released
models' actual behavior on this repo (17 Fable-5 sessions + Opus-4-8; the per-edit
cyclomatic hit-rate is identical across them at ~0.015/edit, so the profile is
model-agnostic). Full analysis and numbers: `docs/design/fable-corpus-extraction.md`.
The harness gates already nudge toward these; adopting them pre-emptively skips the
block→retry round-trip.

- **Use coherent patches and cohesive helpers.** Group a logical same-file change
  into one patch when possible. Extract helpers when they clarify responsibility
  or keep a function within its effective cap. Sequence dependent changes deliberately;
  sending multiple tools in one message does not create a transaction. Avoid forwarding
  helpers or splitting edits solely to manipulate a per-call metric increment.
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
goal end-state is an empty list (reached 2026-09-02: 0 files over cap, list
empty; keep it that way). Codegen DATA — the `.mjs` hook script carried as
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
*Monotonic metric ratchet* for the cap policy. `cognitiveWriteWarning` remains
in the same module as the legacy warn-only signal. Captured per-edit telemetry
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
| `src/harness/quality-checks.ts` | PostToolUse: <!-- gen:quality_check_count -->34<!-- /gen:quality_check_count --> checks across 8+ languages (tsc, biome, cargo, rustfmt, mypy, ruff, etc.) |
| `src/harness/server-bridge.ts` | Server coordination: reservation sync, guard event reporting |
| `src/harness/trigram-index.ts` | Trigram search index: build, query, serialize, dirty layer |
| `src/harness/regex-trigrams.ts` | Regex → trigram decomposition, rg command parsing |
| `src/harness/grep-accelerator.ts` | PreToolUse grep acceleration: index query + block-and-answer |
| `src/harness/large-file-policy.ts` | Per-file line cap: threshold, `isCappableFile` predicate, baseline loader, ratchet verdict |
| `src/harness/mutation/` | Per-edit mutation gate (spec `docs/design/per-edit-cloud-mutation-testing.md`): stable mutant identity, `mutation-manifest.json` + receipts, survivor-diff invariant, ChangeSet overlays, cloud runner client. Config `per_edit_mutation` (default off; `budget_ms` caps the runner round-trip). Engine scaffolding: root `stryker.conf.json` (MUST ignore `.interlinked/` — Stryker's tree-copy crashes on the harness socket) + `vitest.stryker.config.ts`. Live engine test: `npm run test:integration -- gate-live`. The older per-file score ratchet (`mutation-gate.ts`, `interlinked mutation check`) is a separate, coarser system. |
| `src/harness/shadow/protocol/` | Public client contract and local reference implementation for remote shadow execution: strict parsers, byte grammars, overlays, changeset identity, provenance, and binding comparison. Cross-repository fixtures and schema metadata live in `protocol/shadow-v1/`; see its README for the public/private boundary and vendor workflow. After changing contract source or corpus data, regenerate the digest with `npx tsx scripts/gen-shadow-contract-digest.mts`; use `--check` to verify freshness. Regenerate schemas with `npx tsx scripts/gen-shadow-schema.mts` when contract shapes change. |
| `src/harness/check-inventory.ts` | **Single source of truth for "how many checks."** `getCheckInventory()` derives per-family counts (inline `CHECK_REGISTRY` / sequence / structural / tool-quality / suggestion / behavioral — disjoint) live from each registry; pinned by `check-inventory.test.ts`; surfaced by `interlinked harness checks`. `GENERIC_CHECK_META` is the doc-view of a subset of the inline family, NOT a count — never sum it. Guard rules (`BUILTIN_RULES`) are a separate primitive, pinned by docs-freshness. |
| `src/harness/evaluator/complexity-pulse.ts` | Ambient per-edit cyclomatic telemetry: the strict gate's observer stashes its already-paid before/after parses at PreToolUse; PostToolUse emits one `[interlinked:cyclomatic]` line per edited code file (ΣCC + max + per-fn Δ; absolutes on stash miss). Same population as the gate (cappable files). Isolated hook test: `npm run build:e2e && npm run test:e2e -- pulse`. |
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

**Test-discrimination family (2026-09-06/07):** fourteen advisory `post`
checks, also surfaced by `verify --all-checks`; none blocks. Registry:
`check-registry/entries-warnings/test-discrimination.ts`. Every detector entry
module has CLASS / FIRES WHEN / DOES NOT FIRE / CALIBRATION / KNOWN GAPS /
HOW TO EXTEND sections. Reproduce fire rates with
`npx tsx scripts/scan-test-discrimination.ts [corpus-root] [check-id ...]`.
The operator design note is `docs/design/test-discrimination-checks.md`.

| check | review target |
|---|---|
| `fallback_only_assertion` | default-only outcomes without same-file/same-SUT sibling pins |
| `duplicate_expected_literal_pos_neg` | invariant literals across positive/negative cases |
| `spy_call_unpinned_args` | call counts without argument/value evidence |
| `wildcard_in_observable` | wildcard-only observables; excludes imported-export smoke |
| `in_tree_temp_fixture` | fixture roots without recognized OS-temp provenance |
| `duplicate_throw_message_assertion` | repeated error messages in the resolved callee |
| `catch_without_assertion_guard` | catch-only assertions without recognized guards |
| `fixed_port_in_test` | fixed ports in recognized network contexts |
| `vacuous_loop_assertion` | loop-only assertions; mapped equality pins recognized |
| `mock_return_echo` | literal overlap with mock returns; coarse literals require one discovered mock |
| `duplicate_test_body` | repeated bodies under equivalent setup, including late hooks |
| `spy_without_restore` | missing applicable cleanup, considering runner config and test-local objects |
| `export_existence_smoke_test` | imported export existence/function-type assertions only |
| `commented_out_assertion` | actual disabled assertions, excluding strings/prose/skip fixtures |

Review corrections: negation and throwing evidence are not mock echoes; quoted keys
are not mock return values. Setup normalization preserves literal whitespace.
The original vacuous-loop 8/8 precision claim included two known false positives
and supports at most 6/8. Fire rates and builder samples are not independent precision.

Two lessons that bind future checks: the builder's own 8-sample precision read was
wrong by 70 points on two detectors (posneg read 87% TP, independent adjudication
said 86% FP) — measure precision with an independent census or adjudication, never
the builder's sample; and four scoped detector fixes removed 514 hits where a
165-unit agent wave had removed 153 — fix the detector before fixing the tests.
`test_name_matcher_mismatch` is built and deliberately UNREGISTERED (0/8 precision
three times: title claims are verified through literals the title cannot see).

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
| `src/harness/taint-tracker.ts` | Sensitivity classification (Public/Confidential/Secret) and flow tracking. The step budget (`step_limits`) binds the calling ACTOR's own count (`actorStepCount`; `SessionTrajectory.actor_tool_calls` keyed by `subagent_id` → `agent_name` → session id, resolved once in `pre-tool.ts::newPreToolCtx`), never the session total — a subagent's tool calls arrive under the PARENT session id, and counting them there put a 50-agent campaign's orchestrator into read-only mode at ~79k steps (2026-09-05). The LEVEL stays session-wide on purpose: a worker's secret-shaped output still ratchets the parent |
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
| `src/harness/structure/rules/` | 7 built-in rule families: public symbol companions, public symbol test-case, env/config key companions, layer/package boundaries, glossary residue |

**Auto-generated reference docs** (run `npm run docs` to regenerate):
| File | Contents |
|------|----------|
| `docs/generated/guard-rules.md` | All <!-- gen:builtin_rule_count -->121<!-- /gen:builtin_rule_count --> built-in guard rules by category |
| `docs/generated/quality-checks.md` | All <!-- gen:quality_check_count -->34<!-- /gen:quality_check_count --> PostToolUse quality checks |
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

**Grep acceleration (OPT-IN, off unless an index exists — 2026-09-10):**
- Build index: `interlinked index build` (0.1-10s depending on repo size).
  `interlinked enable` no longer builds it: the in-process build walks every
  tracked file and ran a 50k-file prose corpus out of heap mid-enable, leaving
  hooks installed but no daemon. Nothing on the hook path needs the index.
- Harness loads an existing index on startup, refreshes incrementally on each SessionStart
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
`// biome-ignore`, and since 2026-09-04 the coverage-ignore pragmas
`v8 ignore` / `c8 ignore` / `istanbul ignore` / `node:coverage ignore`, which
shrink the coverage denominator and were previously invisible to every
surface) are split into two warnings: `suppressions-unjustified`
(loud, line-numbered) and `suppressions` (soft, fired only when every
disable on the file carries a reason). Justification conventions: any
text after `@ts-ignore`/`@ts-expect-error`; ` -- ` for ESLint; `:` for
Biome; ` -- <reason>` for coverage pragmas (`/* v8 ignore next -- child
process only */` — measured against ast-v8-to-istanbul 1.0.3: trailing text
is tolerated, the `next N` count is NOT honored, so one node is suppressed
regardless of N). `@ts-nocheck` is exempt (file-level, no per-line
convention). The same token list drives the delta `suppression_ratchet`
(`quality-checks/ratchet-metrics.ts`); both surfaces mirror the provider's
ignore-hint grammar verbatim.

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

## Jev-backed semantic checks (opt-in, added 2026-09-16)

Three checks ask TypeSafe's Jev model (System One: typed probabilities, no
text, ~200 ms, ~$0.00005/call) a question the deterministic registry cannot
answer. They live under `src/harness/jev/` behind `jev.enabled` in
`guard-rules.local.json` (default OFF) with `TYPESAFE_API_KEY` in
`config.local.json`; every one is warn-only and fail-open, and NONE sits in
the registry or `interlinked verify` — `feedback_harness_deterministic_only`
still governs the check pipeline. Each module header carries its measured
operating point (blind-labeled evals, k/n; run-book
`scratch/CAMPAIGN-jev-checks.md`, intake `docs/external-pulse/typesafe-jev.md`).

| Check | Surface | Question |
|---|---|---|
| `claim-evidence.ts` | Stop nudge `[interlinked:jev-claims]` (`server/lifecycle-stop-jev.ts`) | Is each claim in the final message backed by a tool call in this turn? |
| `test-title-body.ts` | `interlinked jev test-titles <files>` | Does the test body test what its title claims? (the semantic half the retired `test_name_matcher_mismatch` lacked) |
| `doc-claim-liveness.ts` | `interlinked jev doc-claims <files>` | Does a doc paragraph claim a module is live that nothing imports? |

A Jev verdict is a scoring signal merged tighten-only, never a lone block: it
cannot write a block reason, and its probabilities are calibrated per group,
not per call. Re-measure before moving any threshold; the eval drivers and
labeled datasets are under `scratch/2026-09-16-jev-checks/`.

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
**The vitest coverage denominator is a water-line too** (2026-09-04, coverage-campaign
pre-work): the same gate routes `vitest.config.*` / `vitest.<lane>.config.*` / `vite.config.*`
to `evaluator/vitest-coverage-water-line.ts`, which BLOCKS a Write/Edit whose
`coverage.exclude` gains a member or whose `coverage.include` loses one relative to git HEAD
(set semantics; reorder/dedupe/format allowed). It compares only when BOTH sides declare the
array as string literals; a spread, identifier, template-with-expression, second `coverage:`
object, parse failure, `typescript` unavailable, or present-vs-absent array is UNDECIDABLE and
allows with a warning naming the member — a block needs ~zero FP, and a declared array
replaces vitest's defaults so absent-vs-present is not comparable. One line in that array
used to remove a file from every coverage ratchet forever, silently (the ratchet iterates the
REPORT and copies a vanished file's baseline entry forward).

A **commit-gate backstop** (`evaluator/commit-baseline-gate.ts`, wired in
`pre-tool-pipeline.ts` before `runCommitGate`) closes the `apply_patch`/sub-agent hole
for the 3 git-tracked/stageable baselines (large-files, untested-files, metric-caps):
on a real `git commit` it diffs `git show HEAD:<f>` vs the staged blob through the same
`detectBaselineGaming` detector. A sibling test-integrity check, `snapshot_hygiene`
(`checks/snapshot-hygiene.ts`, advisory), blocks writing a `*.snap.new` / `*.pending-snap`
snapshot-review artifact (the snapshot analog of leaving an `.only`/`.skip` behind).

## Monotonic metric ratchet (effective caps and retained debt)

The historical design is `docs/design/monotonic-metric-ratchet.md`. Current policy
uses effective caps and grandfather identities, without sub-cap edit-size limits.
Read `.interlinked/metric-caps.json` and `interlinked caps status` for this repo's values.
- **Cyclomatic** — `complexity-write-guard.ts`: new over-cap functions and over-cap
  growth block. Under-cap changes can land in one coherent patch. Existing debt may
  hold or shrink according to the grandfather ledger; splitting cannot relax the cap.
- **Coverage** — `coverage-write-decision.ts` (pre-existing): blocks an uncovered
  added line or a per-file coverage drop vs `coverage-baseline.json` (high-water).
- **Cognitive** — `cognitive-write-guard.ts`: the former +4-per-edit block is removed.
  Cap crossing, over-cap growth and grandfather identity rules remain enforced.
  Flatten nesting with guard clauses or cohesive helper responsibilities when useful.
- **CRAP** — implied: CRAP = cyclo²·(1−cov)³+cyclo is ↑ in cyclo, ↓ in cov, so the
  cyclomatic and coverage changes can both affect it. There is **no** separate sub-cap CRAP
  ratchet: every CRAP gate (`decideCrap` block, `computeCrapRisers` advisory)
  fires only at/over cap 25, which bounds new/touched functions and is the
  end-state backstop. A function whose coverage is UNKNOWN (no report entry)
  yields no CRAP finding at all — unknown is not 0%, and treating it as 0% drove
  CRAP to its ceiling and false-blocked edits to fully-covered code.

Endgame seam (mutation, not built this session): the per-edit run returns the
FULL `MetricRegression[]` (all metrics at once) so an agent fixes them in one
pass; a parallel mutation suite slots in as "another metric" over the same
scoped overlay + affected-test set, kept ≤25s by small files.

## Complexity-campaign tooling (added 2026-09-02)

Built for whole-repo burn-downs (cyclomatic / cognitive / LoC-per-file) so the
gates HELP the campaign instead of blocking the refactor they demanded. Ten
lanes, every one a deterministic local surface; numbers live in
`.interlinked/metric-caps.json` and the ledger, never in this prose.

| Lane | Surface | What it does |
|---|---|---|
| Grandfather ledger | `interlinked caps ratchet <cyclomatic\|cognitive> --to <n> [--dry-run]`, `caps status`; `.interlinked/function-complexity-baseline.json` (committed; `function-complexity-baseline.ts`, gate `evaluator/function-complexity-baseline-gate.ts`) | Tightens the cap and records every function over it as `{file,name,line,value}`. A listed function may HOLD or shrink at its recorded value; an unlisted over-cap function blocks even when held. Shrink-only under `baseline_integrity_gate` (a value may fall, an entry may drop, nothing may be added except by `caps ratchet` on a tightening; Write-tool creation of the ledger is refused — only the ratchet writes it). `caps set cyclomatic\|cognitive` delegates to the ratchet whenever a section exists, so cap and ledger cannot drift; the commit-gate backstop covers it as a tracked baseline. |
| Census + proposals | `interlinked metrics complexity [--metric …] [--top n]`, `interlinked caps propose` (`commands/metrics-complexity.ts`) | Percentile ladder, histograms, hotspots, per-file mass, and "the smallest cap whose ledger stays under budget". Calibrate against the TREE, never fixtures. |
| Decomposition plan | `harness/decomposition-plan.ts`, wired as `planFor` on the cyclomatic spec (`evaluator/metric-gate-plan-hints.ts`) | The cyclomatic block now carries a `↳ plan:` sub-line per named over-cap function: the fewest arm extractions that bring it under the cap. Anonymous units and held/grandfathered functions get no plan. |
| Moved-line coverage | **NOT LANDED** (2026-09-04 audit: `evaluator/coverage-moved-lines.ts` was never added to git; no `classifyEditedLines` symbol exists; the only trace is an agent lane record in `scratch/build-lanes.json`) | Designed behavior: per-edit coverage would split edited lines by PROVENANCE (multiset diff of normalized text) so a relocated uncovered line is not a NEW uncovered line. Today the added-line block has no such exemption; `per_edit_coverage` is OFF locally so nothing observes the gap. |
| Survivor moves | `mutation/survivor-moves.ts` (`priorContent` on `evaluateMutation`, `movedSurvivors` on the verdict) | Per-edit mutation reconciles a survivor that moved into an extracted helper against its vanished same-content twin instead of charging it as new. A vanished NON-accepted twin (killed/uncovered) never excuses an arrival. |
| Assertion moves | `checks/assertion-move.ts`, `harness/assertion-waiver-log.ts`; `INTERLINKED_ASSERTION_MOVE_WAIVER=1` (logged) | `mutation_directed_assertion_removal` distinguishes an assertion MOVED to a new test file from one deleted; the waiver is an audited one-command escape, never silent. |
| Characterize-first | `evaluator/characterize-campaign-target.ts`; `structural_checks.characterize_mode: block\|warn\|off` (default `warn`) | In `block`, an edit to a ledger-listed function requires an observed test run covering that file first (per-file, directory, or `.`). Covers Write/Edit/MultiEdit AND apply_patch. |
| Helper hygiene | `checks/helper-hygiene.ts` → `new_export_without_importer`, `extracted_helper_duplicate` (pre_warn, advisory) | Edit-time nudges for the two decomposition footguns: exporting a helper nobody imports, and re-extracting a helper a sibling already has (≥0.90 shingle-Jaccard). Diff-vs-baseline checks, so they have no verify surface by design. |
| Split plan | `interlinked metrics split-plan <file> [--max-clusters 2..4]` (`commands/metrics-split-plan*.ts`) | Intra-file reference graph → 2–4 cohesive modules with line count, ΣCC, imports, a filename each, and the cross-module references the split creates. |

A per-file "no ΣCC regression" guard was designed and REJECTED: extraction
raises the file's ΣCC by construction (each helper adds 1), so it would block
the burn-down itself. Campaign run-book: `scratch/CAMPAIGN-cc16.md`.

**First live run (cyclomatic 22 → 16, 2026-09-02):** 105 file units, 219
agents (decompose → adversarial verify → one fix round), 0 units failed; every
function ended ≤ 16 and the ledger regenerated empty. What the gates taught
(all fixed the same day — the campaign is the calibration corpus a check
cannot get from fixtures):
- The 500-line **no-growth** rule is the dominant force: ~40 units could not
  add a single line to an over-cap parent, so helpers went to a NEW sibling
  module (companion test first, module, then the parent import). Expect the
  exporter-first order, not in-place extraction, whenever the parent is over cap.
- `stale_read_then_write` / `file_overwrite_after_other_agent` attributed a
  subagent's OWN writes to "another agent" (~30 times): activity rows carry
  the parent session id with a per-subagent `agent_name`, and the trajectory
  pins the first agent_name it saw. Same session id is now self.
- The characterize signal lived in the 100-entry `commands_run` ring, so a
  test run at the start of a long unit expired behind typechecks and greps
  (8 forced re-runs). Test-runner commands now go to a durable
  `test_commands_run` list (500 entries, 2000 chars).
- `dead_type_exports` and `public_api_leaks_internal_type` contradicted each
  other on a type named only in an exported signature; the dead-type side now
  exempts signature-referenced types.
- `extracted_helper_duplicate` read a verbatim MOVE (sibling written first,
  originals deleted next edit) as six re-extractions; ≥0.99 similarity or a
  new file now yields ONE "move in progress" note.
- `ubs_string_concat_in_loop` fired on `cursor.offset += n`; numeric-named
  targets / numeric RHS evidence are now exempt.

**Second live run (lines per file, 2026-09-02):** 30 over-cap files → 0, the
grandfather list emptied, 56 new modules, 0 units failed. Each unit used
`metrics split-plan` for the cut and a verify probe that ran
`circular_imports` + `dead_exports` + `dead_type_exports` per file plus a
whole-repo `interlinked deadcode` diff against a pre-campaign baseline: 0 new
dead exports, 0 new unreachable files. Lessons:
- **Exporter-first splits are inherently transient-noisy.** Between "sibling
  written" and "parent block deleted" every duplicate detector fires
  (`duplicate_type_declaration`, `code_clones`, `extracted_helper_duplicate`,
  TS2323 redeclare). The move-in-progress classification now covers types as
  well as functions; expect one note per sibling, not one per symbol.
- **A probe that calls a 3-arg detector with 2 args reports `undefined`
  findings.** Three units lost time to `checkDeadTypeExports(content, file)`
  missing its `cwd`. A verify probe is code too: run it against a known-clean
  file before trusting a red result.
- **Concurrent units see each other's transient breakage** through the
  project-wide tsc pass and `vitest related`. Verifiers must attribute a red
  result to a file in their own unit before rejecting; the campaign's falsifier
  prompt now requires file:line evidence for exactly that reason.
- `write_without_mkdir` fired on writes directly inside a `mkdtempSync` dir;
  fixed to recognize mkdtemp-created directories.

**Deletion wave (2026-09-02, after the two campaigns):** what the deterministic
detectors could and could not decide, measured:
- `interlinked deadcode` dead exports: 41 → 0 (26 un-exported, 12 deleted);
  typed dead branches 18 → 0 (5 impossible branches deleted, 8 were TYPES THAT
  LIED — `Node.parent`, sparse-array holes, a null session a test proves —
  where the guard stayed and the type was widened). Re-export shims left by
  the splits: every test-only shim removed and the tests re-pointed.
- Test-hygiene detectors were mostly wrong at the deletion decision:
  `duplicate_test_names` 10 → 1 true duplicate (names match, bodies differ:
  rename, not delete); `test_missing_sut_import` 87 → 0 orphans (it keys on
  the filename stem, and black-box CLI/daemon tests import no module by
  design); `assertion_free_test` 2 → 0 (assertion in a helper / two lines
  down). They locate candidates; they do not adjudicate.
- Product files with no non-test importer: 43 → 3 real orphans. The rest were
  entry points (bin/exports/setupFiles/build entries/evals) or designed-but-
  unwired modules. SEVEN carried a commit message or design doc claiming the
  feature was live (`git log -S` showed six were never imported, one was
  reverted and never re-landed). Decisions: Stop-phase self-heal, CRAP
  telemetry, and `public_symbol_test_case` wired; agent-io primitives deleted
  (spec kept); dead-code-signal, retrieval-cost, graph-prediction harvester
  left as is. The generalizable check: "commit/doc says X now runs, nothing
  imports X" — a claim-vs-import-graph detector, not yet built.
- `interlinked deadcode`'s `testOnlyImporterFiles` lane over-reports ~3x
  (147 vs 43): it does not count `export … from` barrels or dynamic imports
  as importers. Fix before trusting it.

**Third live run (cognitive 30 → 20, 2026-09-02):** 127 functions in 110
files, 0 failed, ledger regenerated empty; distribution afterwards p95 12,
p99 17, max 20, 293 over the advisory 15 (was 406). The cognitive planner
(`cognitive-plan.ts`, wired as the `↳ plan:` line) was consulted before every
edit: followed verbatim on 47 units, in substance on 15. Where agents deviated
they were right to: a loop body that mutates caller state or carries
`break`/`continue` cannot become a bare helper call, so they extracted the
DEEPEST sub-block instead (the next rung on the same ladder). The estimator's
residual-guard correction holds (delta 0 on hand-applied plans) but it does
not price loop-local state that must be threaded through a helper's
signature — the remaining source of 3–9 point over-estimates. 106 blocks,
16 judged false positives, all transient exporter-first noise or
cross-unit tsc attribution.

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

## Project e2e enforcement (plan 31, Unit A landed 2026-09-23, Unit B 2026-09-24)

`src/harness/project-e2e/` is the host-project feature the Interlinked-only
E2E lane below is NOT: a repository declares behavioral scenarios in
`.interlinked/e2e-policy.json` (projects → suites → scenarios → portable
contract cases in `.interlinked/behavioral-contracts.json`) and the daemon
turns observed edits into scenario obligations that only a supervised run can
clear. Spec: `docs/plans/31-project-e2e-enforcement.md`; run-book
`scratch/CAMPAIGN-project-e2e.md`. Unit A ships: strict policy parser
(`policy.ts`), expectation lifecycle proposed → accepted / disputed /
superseded bound to exact revision digests (`expectations.ts`, file side in
`store.ts`), per-scenario input generation (`generation.ts`), append-only
ledger + pure reducer (`ledger.ts`, `.interlinked/e2e-obligations.jsonl`),
change reconciliation (`reconcile.ts`), the ONE qualification predicate with
reason codes and the 0/1/2 exit contract (`qualify.ts`), write-once receipts
(`receipt.ts`, `.interlinked/test-runs/e2e/<runId>/receipt.json`), the
supervised managed-process runner (`run.ts`, reuses `contracts/runner.ts`
under the project heavy-process lease) and the hook surfaces (`hooks.ts`:
PostToolUse `[interlinked:e2e]` lines, Stop summary). CLI: `interlinked tests
e2e status|plan|run|check` and `tests e2e expectations
propose|review|accept|replace|dispute`. Fixtures under
`project-e2e/__fixtures__/` (TypeScript CLI, Python CLI, Rust CLI) share no
code with the engine; `lifecycle.test.ts` is the Unit A acceptance run and
`dogfood.test.ts` drives the built `dist/index.js` from a disposable host.

Rules that bind (hardened by the 2026-09-23 review, findings R1–R12 in
`scratch/review-project-e2e-unit-a/REVIEW.md`, each pinned in
`review-regressions.test.ts`): a scenario is satisfied only for the exact
generation a receipt names — policy digest, affected files, manifest,
`contract-policy.json`, each case's cited requirement, declared inputs and
the bytes of any path-shaped executable in argv (so revoked acceptance, a
rewritten requirement or a swapped candidate binary all go `stale`);
collection limits (>8 MiB, symlinks, file cap) are gaps ⇒ `unavailable`,
never `scope=complete`; the receipt reader is a constructing parser (an
unknown case state ⇒ `RECEIPT_INVALID`); receipts bind the canonical
worktree root and the ledger's runId; the policy parser refuses
`boundary.entry: "http"` and any `real` component other than `application`
until a managed service adapter exists, and an `http` runner is
`BOUNDARY_UNSUPPORTED`; expectation revisions are recomputed from content on
load and on every decision; runs copy the project into a disposable snapshot
(private HOME) before prepare/cases, so the live tree is only read;
compiled executables travel byte-for-byte; a bound PROPOSED expectation is an
advisory unless `gates.review: "require"` (disputed/superseded always block);
mapping gaps in a required-mode project make `check` exit 1; expectation
binding is project-scoped. Round 2 (2026-09-24, F1–F6 in
`REVIEW-round2.md`, pinned in `review-regressions-round2.test.ts`): the
manifest and acceptance are frozen before preparation and restored after,
declared inputs are re-hashed in the snapshot after preparation (any drift ⇒
no case runs), executed case digests must equal the live contract digests,
symlinks are never copied into the snapshot and a link covering a declared
input is a scope gap, every argv file (prepare and case), every bound
expectation's cited document and each input's mode bits are part of the
generation, protected-inventory capture gaps gate required projects, a
project with zero scenarios still owes its protected inputs, and nested
projects accept into their own `contract-policy.json`. Round 3 (G1–G3,
`review-regressions-round3.test.ts`): the ABSENCE of a control file is
frozen too, wildcard globs detect symlinked ancestors segment-wise, and
expectation citations resolve under the project root everywhere. A green run never accepts an unaccepted contract;
`.interlinked/e2e-policy.json` absent ⇒ every hook path returns early at
zero cost, and `tests e2e check` exits 2 UNCONFIGURED (never a pass). The
TypeScript fixture compiles `src/cli.ts` with Node's built-in type stripping.
`src/e2e/project-e2e.e2e.test.ts` runs the lifecycle through a real daemon
and the built CLI. Status is precise: Unit A is reviewed and locally
validated with TypeScript and Python; the compiled Rust route is
UNVERIFIED here (cargo absent) and owes a run on a Cargo-equipped CI runner.

Unit B (2026-09-24) is the adoption workflow, `tests e2e
discover|surfaces|adopt|doctor` (`commands/tests-e2e-adopt.ts`): `discover.ts`
inspects a repository read-only (manifests to depth 4, a `__main__`-guarded
`.py` directory counts as a project, nested `package.json` without a declared
workspace is an ambiguity, a nested project is named by its directory) and
proposes an ADVISORY policy with one scenario per process-runner contract case
plus gaps; `surfaces.ts` inventories bins / scripts / OpenAPI JSON operations
in document order and maps them to scenario `surfaceIds` (explicit /
unresolved / dangling; YAML and code-registered routes are limits, never an
empty complete inventory); `adopt.ts` writes only the selected projects and
scenarios, forces advisory unless `--mode required`, strips every expectation
(inferred behavior is never adopted), and refuses to overwrite without
`--replace`; `doctor.ts` diagnoses prerequisites without running (exit 1
fail, 2 invalid policy). TypeScript and Python are the pilots; the policy,
discovery report and qualification rules carry no language-specific field.
Unit B review (2026-09-24, B1–B6 in `scratch/review-project-e2e-unit-b/REVIEW.md`,
pinned in `review-regressions-unit-b.test.ts`): the protected scope is derived
from the ACTUAL layout (`src/**`, python packages, top-level source files, the
executable's own file), never a nonexistent default; `adopt --mode required`
refuses a project with no scenarios or whose protected globs match no file;
discovery binds the build's script files as shared inputs and infers artifacts
from path literals in the script plus contract paths absent from the tree (an
uninferable build is a named `suites[].artifacts` gap); a project-level
`surfaces` list (`{id, kind: cli|http|other, address}`) is the
language-independent declaration that binds through `surfaceIds` (the
`cli:`/`http:` id shape admits `:`, `/`, space and braces); OpenAPI path-item
`$ref`s resolve locally with bounded hops and an unresolved one is a named
limit; a `[project.scripts]` console entry is invoked as its declared callable
(never substituted by `-m`) and becomes a `python-entry` surface, or a gap when
its module has no file; subtrees under the depth bound are recorded in
`limits.omittedSubtrees` and a gap. Round 2 (C1–C3, `REVIEW-round2.md`):
build commands are word-split with quote and backslash handling (no
expansion) and a script word that resolves to no file, or a `$VAR`, is an
unresolved build-input gap; an artifact directory needs WRITE evidence
(`mkdir`/`writeFile`/`rm`/`outDir`/`--out` argument, or a contract path
absent from the tree) — a directory the script only reads is never an
artifact, and an inferred artifact glob covering an existing declared input
is a conflict gap; the console-entry wrapper is `sys.exit(callable())`, so
None/int/str returns keep console-script exit semantics. Round 3 (D1): a
conflict is RESOLVED conservatively, not just printed — the inferred glob is
dropped from the proposal so the existing input stays in freshness tracking
(`build.conflicts` is the structured record, echoed in the adoption notes),
unless the script names that exact path as a write target (a pre-built
`dist/cli.js` stays an artifact); `adopt --mode required` re-runs the same
evidence-aware check on any policy and refuses an artifact glob that covers
an existing bound input the build does not provably write. Round 4 (E1–E2):
write evidence is POSITIONAL — `writeFile`/`createWriteStream` first
argument, `copyFile`/`cpSync`/`rename` SECOND argument, `outfile`/`--out`
option value; a copy SOURCE or a variable destination proves nothing — and
the evidence text comes from the suite's declared `prepare` argv (an
`npm run <name>` alias resolves one level into package.json), so an explicit
`node build.mjs` policy adopts without any npm script. Round 5 (F1–F2) made
the invariant STRUCTURAL: an artifact-covered case input that already
EXISTS is still hashed into the generation (`generation.ts`
`addDeclaredInput`; listed in `ScenarioInputs.regenerated` so the
post-preparation drift check tolerates the build rewriting it), so an edit
goes stale no matter how the glob was inferred — textual write evidence is a
SIGN for proposing/accepting a glob, never proof and never load-bearing for
freshness; that evidence now strips comments, requires the literal to be the
complete argument, and is judged per SELECTED suite (a writer in a suite no
scenario runs proves nothing). Round 6 (G1): input ROLES are preserved — a
path collected as source (protectedInputs, a scenario's `affects`,
sharedInputs, build scripts, citations) is never listed as `regenerated`
even when an artifact glob also covers it, so preparation replacing the code
under test in the snapshot is still drift; required adoption refuses an
artifact glob that covers a protected source outright. Round 7 (H1–H2): the
drift exemption is computed across the WHOLE run (`run.ts driftExempt`: a
path exempt only if no scenario of the run holds it as source), and prepare
argv script files are always captured as source inputs whatever artifact
glob covers them (adoption refuses that overlap too).
Unit C (durable state, structured runner, scheduling; landed 2026-09-24,
UNCOMMITTED) makes the evidence survive concurrency and restarts. A suite may
be `adapter: "structured-runner"` (`run` argv + `report {format: json|junit,
path}`; scenarios declare `caseIds` and still bind `contractIds`): the runner
deletes any pre-existing report, runs the command in the snapshot, and
`structured-report.ts` parses a versioned JSON protocol (v1: `{version,
cases:[{id,status}]}`) or a documented JUnit subset (no DOCTYPE/entities,
`tests=` must match, nested suites refused); `skipped`/`todo` never pass and a
missing or malformed report leaves every declared case `CASE_NOT_RUN`
(exit 1). Every run writes `attempt.json` (pid, host, keys, generations)
before executing; the receipt is published temp→rename exactly once; and
`recoverOrphanedRuns` (run start, daemon SessionStart via
`hooks.ts recoverProjectE2eOrphans`) turns a dead-pid / other-host attempt
into an explicit `unavailable` attempt under an `orphaned.json` one-writer
marker. PostToolUse opens one durable request per pending key per session in
`.interlinked/e2e-requests.jsonl`; a run serves only the requests whose
key+generation its receipt certifies (`receipt.requestIds`), so two sessions
share one qualifying run and an unrelated key stays open. The policy's
`scheduling {autoRun, quietMs, minIntervalMs, budgetMs}` block (bounded,
`autoRun` default OFF) drives the pure `decideAutoRun` and the daemon-side
`AutoRunner`, which spawns `tests e2e run` DETACHED after the quiet period, at
most one job per project and one start per interval, retaining work that
arrives mid-run; nothing ever runs a suite inside the daemon.
`RunE2eOptions.signal` cancels: an aborted prepare or run is `ok: false`
"cancelled", the cases stay not-run, the attempt is `unavailable`. Pins:
`structured-report.test.ts`, `structured-runner.test.ts`, `attempts.test.ts`,
`requests.test.ts`, `scheduler.test.ts`, `review-regressions-unit-c.test.ts`.
Unit C review round 1 (2026-09-24, C1–C6 in
`scratch/review-project-e2e-unit-c/REVIEW.md`, pinned in
`review-regressions-unit-c-round1.test.ts`): the snapshot is re-verified
after EVERY writing stage (`run.ts stageIntact`: frozen controls restored,
declared inputs re-hashed against the generation, artifacts re-bound from
the bytes now present), so a native test command that rewrites protected
source in the snapshot leaves the run incomplete and no contract runs (C1);
a nonzero test-command exit is `execution.ok: false` and is explained only by
a failed/error case the report itself records, otherwise the run is
incomplete (C2); cancellation is checked before admission, threaded into
`runContractsUnderLease` (`RunContractsOptions.signal`; a case observed after
abort is unavailable, never a verdict) and re-checked after the contracts so
a cancelled run never publishes a complete result (C3); a policy that turns
`scheduling.autoRun` off, disappears or fails to parse DISARMS the project's
lane (`AutoRunner.disarm`), and the detached child re-validates the current
policy (`RunE2eOptions.automatic`, `INTERLINKED_AUTO_RUN=1`) before running
(C4); orphan recovery is per (run, key) — a crash between the per-scenario
publication rows recovers exactly the missing keys, and `orphaned.json` is
written AFTER the rows so it means completed, not claimed (C5); reconcile
reports `affected` (unresolved at the current generation) beside `pending`
(newly opened), and requests plus scheduling key off `affected`, so a second
session observing a generation another session opened gets its own request
and the shared receipt attributes both (C6). One regression the fix itself
introduced: importing `scheduler.ts` from `run.ts` moved it into a
`dist/chunk-*.js` shared with `dist/index.js`, and `resolveCliEntry` (which
took `../index.js` relative to its own bundle) silently found nothing, so
the detached child never spawned; it now verifies each candidate root by
its sibling daemon entry, and `src/e2e/project-e2e.e2e.test.ts` pins the
real detached child both enabled and disabled-before-timer.
Round 2 (D1–D2, `REVIEW-round2.md`, pinned in
`review-regressions-unit-c-round2.test.ts`): request attribution is frozen
at PUBLICATION and `serveRequests` serves exactly the ids the receipt names,
so a request arriving during execution is listed and served while one
arriving after publication stays open; orphan recovery is serialized per run
by `recovery.lock` (live same-host holder ⇒ skip, dead or foreign holder ⇒
take over), the missing keys are re-derived under the lock, and two real
recoverer processes released at the same instant produce one row.
Round 3 (E1, `REVIEW-round3.md`): the hand-rolled lock published its owner
after exclusive creation, so an empty lock file read as abandoned; it is
deleted, and recovery runs under the repository's `withFileMutationLock`
(`src/lib/file-mutation-lock.ts`, keyed on the run's `orphaned.json`,
`waitMs: 0` so contention defers the orphan), which publishes ownership
atomically, recovers dead owners and never releases a successor's lock.
Unit D (managed HTTP services, native test layouts, proof modes; landed
2026-09-24, UNCOMMITTED). A managed-contracts suite may declare
`services[] {id, argv, env, ready {kind: http, path, status}}`; `{port}` is
allowed only there. `services.ts` allocates a loopback port, REFUSES it if
anything already answers (PE-19), spawns the argv in its own process group
inside the snapshot, calls it ready only while the OWNED child is alive and
answers the declared status, and on stop kills the group and proves the
port silent — a port that still answers belonged to something else, so the
run cannot qualify (PE-26). Contract cases may be service-bound
(`runner {kind: http, service, path, method, body?}`) with workflow
`steps [{kind: restart, service}]` (create → restart → read-back, §5.3); the
standalone contract runner marks such cases unavailable without the
supervisor. A scenario's `boundary {entry: http, service, real}` must name
an owned service; `fixture-store` is real only when that service's env
binds `{fixture-directory}`. The receipt carries `services[]` and each http
case's `service`; qualification grants `boundary: http-driver` only against
an owned, ready, cleanly stopped service, and a literal-URL case is never a
boundary. Fixture `__fixtures__/ts-http` (TypeScript HTTP service with
disposable persistence; PE-20 defect) is pinned by `http-services.test.ts`;
`py-native.test.ts` qualifies a pytest layout through the structured-runner
route plus portable contracts (pytest reports the fixture's extra unit test
too: undeclared native cases are observed, never required). Proof modes
(§9.4): a scenario may declare `proof {mode: old-new | controlled-fault |
characterization, revision | fault, designated}`; `sensitivity.ts` builds
the comparison side as a SECOND disposable snapshot (a `git archive` export
of the pinned commit run from the project directory, or the candidate with
exactly one recorded fault applied) with the candidate's frozen manifest and
acceptance, runs it through the same prepare → services → contracts stage,
and classifies per the §9.4 table (both-pass is NOT_DEMONSTRATED for
old-new, an unrelated failure before the designated case is not
demonstrated, a comparison that cannot be built or a non-passing candidate
is INCONCLUSIVE, characterization both-pass is preserved). The receipt
records `sensitivity[scenarioId]`, the attempt is `unavailable` unless
demonstrated/preserved, and qualification adds the `sensitivity` dimension
with `SENSITIVITY_NOT_DEMONSTRATED` / `SENSITIVITY_INCONCLUSIVE`. The live
worktree is only ever read (`proof-modes.test.ts` pins it byte-identical).
Not in Unit D: the MCP/Worker profile (§10.3), remote profiles.
Unit D review round 1 (2026-09-25, D1–D5 in
`scratch/review-project-e2e-unit-d/REVIEW.md`, pinned in
`review-regressions-unit-d.test.ts` + `services.test.ts` N5): a comparison
must ESTABLISH THE ACTION before its failure counts — the contract runner
records which DECLARED observables `matched` / `mismatched` per case, and a
failed designated case is a behavioral red only when it produced primary
output, exited 0, answered below 500, or ended with the declared exit code /
status; an undeclared abnormal end with no output (a missing import) is
INCONCLUSIVE `setup-build-dependency-failure`, never a demonstrated red. The
comparison's own lifecycle is evidence: `runComparison` carries
`contractsStage`'s completion, reasons and service records into
`sensitivity[id].lifecycle`, and an incomplete one (a leaked responder that
outlived teardown) is INCONCLUSIVE `comparison-lifecycle-failure` in the
classifier AND in qualify, whatever the cases said. A proof revision is
resolved to its commit at GENERATION time (`resolveProofRevision`, `git
rev-parse <rev>^{commit}`): the sha is part of the generation and of
`QualifyInput.generation.comparison`, so a moved ref makes the receipt stale
(`STALE_GENERATION` + `SENSITIVITY_INCONCLUSIVE` "now resolves to …") and an
unresolvable ref is `SCOPE_INCOMPLETE`. A service's argv executable gets the
case-executable treatment — bytes in the generation, `regenerated` when an
artifact glob covers it, a source role only through another declaration —
so a prebuilt `dist/server.js` plus a harmless source edit runs and passes
while `dist/**` also in `affects` still turns the rebuild into drift.
`stopService` polls the whole OWNED process group (`kill(-pgid, 0)`),
escalates to SIGKILL while any member survives, and reports clean shutdown
only once the group is gone; a port squatter is still reported, never
killed.
Round 2 (R1, `REVIEW-round2.md`): output presence is not action evidence —
a startup banner before a missing import and a 500 "dependency unavailable"
body both look like output. A counterfactual proof now DECLARES its
evidence: `designated: [{id, outcome?, action?}]` is required for old-new /
controlled-fault (a plain id is refused). `outcome` names the observables
that ARE the designated outcome; every other observable the case declares
must hold on the comparison side. `action` names cases that must pass there
first (the workflow's create before its read-back). `classifySensitivity`
reads only the runner's per-case `matched` / `mismatched` sets: evidence
that did not hold ⇒ INCONCLUSIVE `setup-build-dependency-failure`, no
declared evidence (an outcome covering every observable, an undeclared key,
a record without observations) ⇒ INCONCLUSIVE `action-evidence-undeclared`;
exit codes, status classes and stdout are recorded, never decisive. A failed
action case is never an "unrelated" failure. Characterization takes no
split (every designated observation must hold on both sides). The CLI
fixtures' `orders.invalid` contract now declares its usage line on stderr as
the action evidence behind its exit-code outcome.
Round 3 (R1, `REVIEW-round3.md`): an action case establishes an observation
only if it EXECUTED before it. Sides are recorded in execution order, so
`misordered` checks the action's index precedes the designated case's on the
candidate (`preconditions`) and on the comparison (`unestablished`) —
otherwise INCONCLUSIVE `action-evidence-undeclared`; and because the runner
follows manifest order, `generation.ts actionOrderGaps` makes a reversed
manifest a scope gap (`SCOPE_INCOMPLETE`) before anything runs.
Unit E (stability cohorts, Playwright, quality feedback, runtime
observations; landed 2026-09-25, UNCOMMITTED). E1 (§9.5): a scenario may
declare `stability {qualificationRuns 1–5, seed?, clock?}`; `tests e2e
qualify --scenario <id> [--runs n]` runs N INDEPENDENT supervised attempts
(own snapshot each; seed derived per attempt, `INTERLINKED_E2E_SEED/COHORT/
ATTEMPT[/CLOCK]` reach prepare, services AND contract case processes),
publishes every attempt, records the cohort under
`.interlinked/test-runs/e2e/cohorts/<id>.json` and a ledger `cohort` txn;
mixed ⇒ a quarantine row in `.interlinked/e2e-quarantine.jsonl` keyed by
generation (an unchanged rerun cannot erase it; a repair is a new
generation); budget exhausted ⇒ deferred, resumable; qualify dimension
`stability` + `STABILITY_*` codes (`stability.ts`, `cohort.ts`,
`policy-stability.ts`). E2 (§10.2): a `playwright` suite OWNS its app as a
`services` entry; the run fronts it with the supervisor's recording proxy
(`proxy.ts`, `INTERLINKED_E2E_BASE_URL`), forces `--reporter=json
--workers=1`, normalizes Playwright's JSON (`playwright-report.ts`: id =
`file › titlePath [project]`, the FIRST attempt decides, PE-27; skipped /
fixme / fail never pass) and credits each declared case exactly the requests
the proxy saw inside its attempt window (`browser-stage.ts`; receipt
`runnerKind: "browser"` + `boundaryRequests`; qualify `browser-driver` only
against an owned, ready, cleanly stopped service with ≥1 request).
`@playwright/test` absent in the project ⇒ cases `unavailable` with install
guidance and a `<project>:<suite>:playwright` doctor failure — never an
install (PE-24); the browser cache is passed as `PLAYWRIGHT_BROWSERS_PATH`
from the REAL home because the run's HOME is private. Fixture
`__fixtures__/ts-browser` (`.mjs` config/spec so the repo tsconfig never
sees `@playwright/test`); the LIVE route is asserted only where this
checkout carries `@playwright/test` and is UNVERIFIED here (`playwright.test.ts`
P2 skipped). Policy parsing was split: `policy-primitives.ts`,
`policy-suites.ts`. E3 (§12.3, §14): `quality-feedback.ts` turns the rule
table into `[interlinked:e2e-quality] <project>/<scenario>: <rule> at
<path>:<line>` advisories on PostToolUse (removed assertion/test block,
`.only`/`.skip`, truthiness replacement, raised timeout/retry, `force:
true`, timing wait, brittle locator, intercepted app endpoint, test with no
assertion) — net-new multiset diff so a moved line is silent, ≤3 lines,
never a verdict; `tests e2e scaffold <name> [--suite] [--write]` proposes a
scenario (required: false, placeholder contract id) plus a skeleton whose
only assertion FAILS deliberately, never edits the policy, never overwrites.
E4 (§7.4, PE-85/86): `projects[].observations.runtimeCoverage:
off|node|node-required` sets `NODE_V8_COVERAGE=<run>/coverage` on owned
services and contract case processes (never prepare or the test runner);
`runtime-observations.ts` folds V8 output into RUN-level `RuntimeEdge`
rows (`caseId: null` — shared servers get no per-case attribution) in
`<run>/runtime-observations.jsonl`, the receipt carries the summary, and
`node-required` makes an incomplete collection `OBSERVATIONS_INCOMPLETE`
(missing child output is incomplete, never zero; a service must exit
normally on SIGTERM for V8 to flush — the fixtures do). Unit E review
round 1 (2026-09-25, E1–E5 in `scratch/review-project-e2e-unit-e/REVIEW.md`,
pinned in `review-regressions-unit-e.test.ts`): under a browser boundary the
portable contracts are SUPPORT cases judged by their own mechanism (an http
support case still through the declared service) and only a browser case
establishes the entry — none evaluated ⇒ `BOUNDARY_UNSUPPORTED`; a browser
boundary REQUIRES `requests: [{method, path}]`, the proxy records each
case's `boundaryObservations`, and the boundary holds only when every
required request was observed with a 1xx–4xx answer (GET / alone, a health
check or an intercepted API earns nothing); `tests e2e qualify` judges each
attempt by the shared predicate minus `STABILITY_*` and its exit is the
evaluation's whenever the cohort is qualified or the evaluation says 1
(two green runs with unaccepted contracts exit 1); coverage completeness
reconciles an expected-process inventory — every service spawn's pid
(`ServiceRecord.pids`, restarts included) must have a `coverage-<pid>-…`
file and contract processes are counted — so one flushing service never
hides another; and contract processes' `interlinked-contract-*` workspace
copies map back to project-relative paths, so a supervised CLI run yields
`dist/cli.js` edges. Round 2 (R1–R2): `receipt.services` is append-only
across stages and each record carries its `stage` (`browser` | `contracts`),
so a browser-stage lifetime that never flushed stays required and a browser
case is judged against the instance that served it; the process runner
records each case's own pid (`observations.pid`) and coverage is reconciled
by identity — a neighbour's helper file never discharges a case whose own
process wrote nothing. Composite-boundary pins run through a reporter double
(fake `@playwright/test` + a script driving the proxy). The LIVE controls
are verified (2026-09-25): `@playwright/test@1.59.1` (allowlisted; its
chromium 1217 matches the cached browsers) installed `--no-save`, the fixture
runs the package-local `node node_modules/playwright/cli.js test` (npm's
`.bin` shim breaks when copied), the browser cache is found under the
ACCOUNT home even when HOME is a sandbox, and `playwright.test.ts` P2
(real Chromium ⇒ browser-driver) and N3 (`page.route` intercepts the API ⇒
`BOUNDARY_UNSUPPORTED`) pass 6/6; they skip only where the package is
absent.
Unit F (completion gates and installed-package behavior; landed
2026-09-25, UNCOMMITTED). Hooks CHECK, the supervised lane EXECUTES. F1
snapshot identity (`target.ts`): `tests e2e check --staged | --revision
<rev>` exports the INDEX (`git write-tree` + `checkout-index`) or a commit
(`git archive`) into a disposable directory and computes every generation
from those bytes, so a worktree receipt certifies a target only when the
generation digest is identical — an unstaged fix never certifies broken
staged bytes (PE-35); the evaluation records `target {mode, commit?,
tree?}`; a policy not in the target is UNCONFIGURED, an unknown revision
UNAVAILABLE (exit 2). F2 `scripts/smoke-tarball-e2e.mjs` runs the whole
lane from the packed tarball's own bin. F3 base-policy comparison
(`policy-diff.ts`, `policy-base.ts`, `policy-changes.ts`): `check --base
<rev>` compares the judged policy with the TRUSTED base's policy (distinct
from `proof.revision`, PE-74) and reports weakening kinds (removed/demoted
scenario or project, loosened gate/observations/boundary/proof/stability,
narrowed scope, unbound contract/case) as `POLICY_WEAKENED` (exit 1) unless
a §13 record in `.interlinked/e2e-policy-changes.jsonl` — written by
`tests e2e policy replace --base --project [--scenario] --rationale` —
binds the exact base and head digests; refactors and reorders are not
findings; a base without a policy is a bootstrap (PE-38); an unresolvable
base is UNAVAILABLE, never HEAD (PE-37). F4 git hooks (`gate.ts`, `tests
e2e gate install|status|uninstall`): pre-commit runs `check --gate commit
--staged --base HEAD`, pre-push runs one `check --gate ci --revision <sha>
--base <remote sha>` per pushed ref (deleted ref skipped, new ref a
bootstrap); an existing hook is backed up and chained through a wrapper,
never replaced; only the BUILT `dist/index.js` is baked in (a `tsx` source
entry resolves from the hook cwd), else `interlinked` on PATH, else exit 2
UNAVAILABLE; `--gate` honours `gates.commit/ci` (absent on a required
project ⇒ require; warn/off/advisory ⇒ reported, exit 0). F5 `tests e2e
ci` (`ci.ts`): a FRESH supervised run then the same check, base from the CI
event (GitHub pull-request base ref / push `before`, GitLab merge-request
diff base / `CI_COMMIT_BEFORE_SHA`, zero sha = bootstrap) or `--base`; no
base ⇒ UNAVAILABLE and nothing runs; a satisfied verdict whose receipt this
invocation did not produce is `CI_RECEIPT_NOT_FRESH` (exit 1); §13 trust
limits are printed (receipts, base, checker path — pin the CLI in CI). F6
(`stop-summary.ts`): the Stop reminder is bounded per session (3 identical
reminders, one pause note, silence until the open set changes, PE-39), an
all-unavailable set is a handoff (no "run it again"), a quarantined
required scenario stays visible with the qualify path; with the daemon down
the cold Stop says the obligations were NOT CHECKED
(`hook-entry-cold-gates.ts coldProjectE2eStopNotice`); `interlinked verify`
gains an `e2e` section (`verify/project-e2e-section.ts`, JSON key
`project_e2e`) with the same codes as `check`, failing under verify's exit
convention; absent policy ⇒ no section at zero cost. Pins: `target.test.ts`,
`policy-diff.test.ts`, `policy-base.test.ts`, `gate.test.ts` (real `git
commit`/`git push` into a bare remote), `ci.test.ts`,
`stop-summary.test.ts`, `project-e2e-section.test.ts`,
`hook-entry-cold-e2e-stop.test.ts`. Unit F review round 1 (2026-09-25,
F-R1–F-R7 in `scratch/review-project-e2e-unit-f/REVIEW.md`, every
counterexample re-run by its `probe.ts` and pinned in
`review-regressions-unit-f.test.ts`): the chained hook's gate program is a
separate file (`<hook>.interlinked-e2e-gate`) fed the SAME captured stdin as
the original — a heredoc on the gate's stdin had replaced git's ref rows and
let an unqualified push through (R1); `--gate` decisions read the judged
TARGET's own policy (`E2eEvaluation.projects`) for the failing projects
only, and `POLICY_WEAKENED` is never waived by the candidate's gate setting
(R2); `tests e2e ci` exports the CANDIDATE COMMIT (`--revision`, else
`GITHUB_SHA` / `CI_COMMIT_SHA`, else HEAD) into a disposable directory with a
fresh `.interlinked` state and runs everything there — plain runs and every
adopted stability cohort — through `gitRoot` threading (run / reconcile /
cohort / evaluate resolve refs in the real repository), so a working-tree
fix, a workstation receipt, an old cohort or a local record can never reach
the verdict; evidence is copied to `.interlinked/test-runs/e2e/ci/<commit>/`
(R3, R7); §13 replacement records are read from the judged target (the
export for `--staged` / `--revision`, `PolicyEvaluation.recordsFrom`), so a
record must be COMMITTED — carve `.interlinked/e2e-policy-changes.jsonl` out
of `.gitignore` (R4); a revision is exported as its exact tree via
`read-tree` into a private index plus `checkout-index`, never `git archive`
(`export-ignore` hid the committed base policy) (R5); an omitted gate compares
as its effective default (`GATE_DEFAULTS`: commit/ci require, stop warn,
review advisory), so `require (default) → off` is `gate-loosened` (R6).
Round 2 (F2-1–F2-3, `REVIEW-round2.md`, pinned in the same file): a target
is materialized straight from the OBJECT STORE (`target.ts materializeTree`:
`ls-tree -r` for membership and modes, `cat-file --batch` for bytes; the
index is frozen with `write-tree` first) — `checkout-index` applied smudge
filters, so a configured filter repaired a committed defect on export
(F2-1); the CI export's execution state (ledger, requests, quarantine,
`test-runs/`) is EMPTIED before anything runs and freshness is the set of
receipts written under that emptied directory, so a committed deferred
cohort or quarantine row is never resumed or counted (F2-2); the proof
comparison side is exported from the REAL repository's project directory
(`exportRevision(join(gitRoot, project.root), …)`, also via
`materializeTree` of the `<commit>:<prefix>` subtree), so characterization
and old-new proofs resolve inside CI (F2-3). Round 3: a committed symlink is
a blob whose bytes are the link target — every blob is fetched and links are
recreated without being followed, in both export modes (a documentation
symlink outside any input scope had made the whole export fail). Round 4: CI
checks every segment of `.interlinked` and its execution-state paths in the
export for a symlink BEFORE cleanup or any state write (a committed link at
`.interlinked/test-runs` had let cleanup delete a file outside the export) —
a link there is UNAVAILABLE, nothing runs; evidence retention applies the same
rule to its destination under the checkout and is refused, never followed.
Unit G (migration, guidance, release matrix, dogfood; landed 2026-09-25,
UNCOMMITTED). §15 migration: the Interlinked-only boundary reminder
(`e2e-obligation-stop-check.ts`) and `interlinked e2e scaffold` are confined
to the Interlinked checkout (`e2e-boundary.ts isInterlinkedCheckout`, package
name `interlinked-cli`); a host repository never sees the reminder, and the
scaffold refuses there with a pointer to `tests e2e scaffold` unless
`--developer-preset`. Guidance: `docs/project-e2e.md` is the operator guide
(files, schema, commands, reason codes, targets, base comparison, hooks, CI,
proof limits, stability, Stop, recovery); `docs/e2e-testing.md` is scoped to
the self-test lane; the `interlinked-verify` skill and the router carry the
gate/CI/replace/target/boundary rules. Release matrix: `npm run e2e:matrix`
runs every fixture (TS CLI, Python CLI, Rust CLI, TS HTTP, TS browser)
through the common route — toolchain present, valid run accepted, injected
fault rejected, stale input rejected — into `docs/e2e-release-matrix.md`; a
missing toolchain is an explicit gap row, never a skip (Rust is a gap on the
dev Mac), and `.github/workflows/e2e-release-matrix.yml` provisions Python,
Rust and Chromium and fails on gaps. The matrix found a real hole: the
browser fixture's page-only spec passed with broken persistence (PE-20), so
the spec now reads the stored order back through the page and
`playwright.test.ts` N4 pins the faulted run at CASE_FAILED. Dogfood: `npm
run e2e:dogfood` bundles the built CLI into one executable with esbuild (a
case workspace holds ≤128 declared inputs; the live bundle reaches 409
chunks), declares the public `scratch init | status --json` workflow as
portable contracts (exact stdout, exact `.gitignore` / `.ignore` /
`scratch/README.md` bytes) and proves valid → stale → fault with supervisor
and candidate sha256 recorded; the first contract asserted only the
"created" line and let the fault through until the README file itself was
asserted. Gotcha: `npm run build:e2e` overwrites `dist/` with the e2e build —
run `npm run build` after the e2e lane. Explicit gaps: the MCP/Worker
profile (§10.3) is not built; real-project pilots need user-selected
repositories — until then adoption defaults to advisory. The browser
case window is ORDER-based (`browser-stage.ts orderedWindows`): from a
case's reported start to the next report case's start, `--retries=0` forced.
Playwright's reported `duration` is timeout-slot time, not wall time, so the
old `[start, start + duration]` window ended before the test body and, under
full-suite load, credited no request at all (the 2026-09-25 flake); each
browser case's details now carry its window and the proxy log as offsets. cargo is absent on the dev Mac, so the Rust fixture's compiled route
is asserted only where cargo exists; locally it proves the `unavailable`
path.

## E2E lane

`npm run build:e2e && npm run test:e2e` exercises real hook processes and
isolated raw/framed/dual daemons through `src/e2e/fixture.ts`. Fixtures opt into
graph prediction explicitly and require a fresh daemon transport receipt plus
PID ownership. `src/harness/e2e-boundary.ts` defines which product files incur
the advisory Stop obligation. Run the lane from the editing session.

Use `interlinked e2e scaffold <name>` to start a test; replace its deliberate
failure with a behavioral assertion. `npm run test:e2e:coverage` measures child
V8 coverage after the source-mapped build. Compare with
`node dist/index.js coverage check --lane e2e --strict --require-measured`.
`E2E_STABILITY=1 npm run test:e2e` includes the 5,000-event stress case.
The real Stryker library probe lives in
`src/harness/mutation/gate-live.integration.test.ts`; daemon mutation
availability is covered in `src/e2e/mutation-gate.e2e.test.ts`.

See `docs/e2e-testing.md` for collection, baseline transactions and diagnostics.
