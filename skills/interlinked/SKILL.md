---
name: interlinked
description: "Overview and router for the Interlinked CLI, a local guard, quality-gate, and observability layer. Load when a repo has `.interlinked/`, when `[interlinked:*]` output or a `BLOCKED: … Suggestion: …` reason has an unclear area, or to learn what `interlinked` can do. Explains the `.interlinked/` layout and `[proven]`/`[heuristic]` tags, then routes to the `interlinked-*` skill for setup, harness, verify, quality-gates, simplification, semantic-index, supply-chain, spec-audit, observability, or coordination."
---

# interlinked — overview & skill router

For complete local action projections, use **interlinked-quality-gates** for
`metrics --full|--json`, **interlinked-verify** for `verify --json`, and
**interlinked-observability** for `query checks --actions`. These surfaces reuse
measurements and retained evidence without model calls. Historical findings and
unsupported measurements remain explicit; a candidate is not a confirmed defect.
Action evidence preserves supplied source spans, suppression metadata and original
producer references. Distinct same-line positions remain distinct; grouped evidence
from different source versions has unknown freshness. Snapshot-bound refers only
to captured primary text, not current disk contents or complete dependency evidence.
`metrics score --full|--json` also projects retained profile findings, measured
burden, deletion-review blockers and missing evidence without another analysis pass.

For input strictness on JS/TS edits, including optional parameters omitted by
every observed direct caller, use **interlinked-verify**.

For JS/TS test mapping and Vitest discovery limits in `check --only missing-tests`,
and documented, workflow, Worker or oxlint entry points in `deadcode`, use **interlinked-verify**.
That skill also covers per-declaration configuration gaps and historical document
scope in the verification catalogue.

For local MCP stdio recording and the accepted `--inline-limit` byte counts,
use **interlinked-coordination**. For local `search` engine filters, zero context and execution errors, use
**interlinked-verify**. For inherited `caps --json` and nested `metrics --cwd`
options, use **interlinked-quality-gates**. The root `metrics --top` accepts 1 through 200 hotspots.
That quality skill covers mutation report discovery, explicit comparison
baselines and root-relative diagnostic snapshots. **Interlinked-observability**
covers missing recurrence proposals and validated trajectory JSON output.
**Interlinked-verify** covers full structure extraction and the explicit
unavailable response for `structure scan --incremental`.
That skill also covers per-metric cyclomatic, cognitive and function-token modes,
targets and scopes, including inherited defaults and adopted-policy integrity.
Use **interlinked-quality-gates** for `metrics policies export|inspect|evaluate`.
Versioned data-only profiles select installed metrics and detector contracts for
explicit local reports, with raw evidence, unsupported scopes and structural
policy proposals retained separately from adoption.
That skill also covers advisory `file.lines` targets/scopes and phase coverage.
Generated standalone cold hooks explicitly retain an unmeasured physical-line state.

For duplicated push checks, early E2E preflight, resource waits and retained test
obligations, use **interlinked-verify**. Managed push command handoff belongs to
**interlinked-harness**; timing/RSS evidence belongs to **interlinked-observability**.
Use **interlinked-verify** to interpret relative import findings across package boundaries.
It also covers literal runtime conditions, quoted test titles, and suppression directives.
These optimizations do not enable general past-result reuse or relax coverage floors.
Explicit `verify` runs without an Interlinked memory budget, default time deadline,
cumulative detector budget or source discovery/admission cutoff, and waits for the canonical
project lane and shared host lane. Waiting notices appear after one second.
**Interlinked-verify** explains optional `--timeout`/`--tool-timeout`,
cancellation, complete foreground capture and separate test/background policies.
That skill explains Gitleaks working-input scope, ignored `.env` coverage,
tracked exceptions, generated/history exclusions and native analyzer limits.
It also covers full result populations for 40 participating detectors: 28 mapped
to the standards profile and 12 additional scored checks. Verify exposes 37;
the API-type, JSDoc-parameter and unvalidated-input entries retain their existing
registry-backed surfaces. All 16 currently scored checks participate in foreground
collection. Other detector caps, recognition windows, explicit
analyzer policy and unavailable evidence retain their documented coverage limits.
`verify --all-checks` includes advisory `json_stringify_error`,
`catch_rewrap_loses_cause` and `resource_handle_leak`; default verification skips
these three checks and their existing recognition predicates determine candidates.
`verify --only` uses catalog aliases in both text and JSON output. Both report
when the selected tool lacks a foreground runner.
The verify skill describes partial scanner findings and timeout reasons.
For excluded checks and partial external-tool receipts in verify JSON, use **interlinked-verify**.
Semgrep runs only with `verify --only semgrep`. Default and `--all-checks`
skip its version probe and scan. Use `verify --skip gitleaks` to omit Gitleaks
as well. The verify skill explains separate security
passes, complete external diagnostics, setup-probe coverage and the managed
foreground repeated-implementation parser. Saved security-result reuse and scan
cadence are not enabled by these commands.
`verify --gitleaks-scope git-visible` is an explicit smaller secrets inventory;
it excludes Git-ignored inputs, including ignored `.env`. Default working-tree
mode retains ignored working files. The verify skill describes both scopes.
Use **interlinked-verify** for JSON selection metadata and partial-verification status.
That skill also explains selected-input applicability, unsupported async language
runners, root-local documentation checks and managed OSV/npm dependency audits.
Use **interlinked-verify** for `tests trace`, `tests opacity`, and renewing older
kill-proof receipts; use **interlinked-observability** to interpret missing test
counts and trace coverage. Missing reports are not zero executed tests.

For the internal, default-off `claims --receipt-shadow` observer and its explicit receipt
links, use **interlinked-observability** and `docs/internal/jev.md`. It logs comparisons only;
it does not enable claim evaluation in public Stop hooks or alter a model decision.

For experimental `metrics decisions` measurements, ThinkThen/Clef/Jev adapters,
calibration audits, relational ledgers and `[interlinked:decision-metrics]` advice,
load **interlinked-quality-gates**. For Qwen embedding retrieval/resource policy,
also load **interlinked-semantic-index**. These unvalidated judgments are advisory;
they do not participate in deterministic PreToolUse blocking.

For shared invariants, directed semantic coupling, and relational before/after
comparison, use `metrics decisions relations` and **interlinked-quality-gates**.
The graph owns snapshot evidence and runtime claims; reviewed policy and study
reports live in version-controlled `semantic-relations/`; raw study bundles remain
local and ignored. Its Astra reference reviews are explicitly model judgments; no human-review
stage or automatic semantic blocking is part of the workflow.

For `metrics decisions findings discover|prepare|questions|plan|assess|show|labels|review`, use
**interlinked-quality-gates**. It freezes selected source, retains Jev distributions,
and compares them with source-backed Astra labels by direction. Provider selection,
versioned alternative question maps, frozen request/cost previews, explicit allowances and inference-free saved reuse live
in that workflow. Only explicit `assess` sends selected evidence. Missing policy stays
unassessed. It never filters deterministic findings
or joins the check pipeline. Boundary/ownership detector behavior belongs to
**interlinked-verify**. The complete workflow is in `docs/finding-review.md`.

For `metrics standards --profile dmmulroy-typescript`, use **interlinked-quality-gates**.
The local report retains all 35 source-attributed groups, source hashes and units,
exact syntax observations, detector matches, review candidates and unknown context.
That skill also covers complete foreground metric/standards inventories, explicit scope
exclusions and unavailable inputs. Foreground surveys remove implicit source-size, path-count
and Git-listing limits; runtime inventory consumers retain separate resource policies.

For repeated implementation advice (`repeated_implementation`), load
**interlinked-verify**. This is an advisory AST comparison for Python and JS/TS,
reported after a changeset and in the Stop/verification review. It is not a hard gate.

For advisory Commander option-attribute mismatches (`commander_option_attribute`),
load **interlinked-verify**. The detector resolves same-file bindings and supported
local imported handlers. Handler-only hooks reuse the existing partial importer
index; foreground verification uses invocation-local project evidence. Normalization,
mutations and unsupported forwarding stay explicit, and the check remains advisory.
That skill also explains own-barrel value-edge evidence, complete scoped foreground
traversal and bounded runtime unknowns. A graph cutoff does not establish a cycle.
Foreground fallback-only test analysis reads every matching filename-based sibling
and preserves unavailable evidence; runtime retains its separate lookup bounds.
For `numeric_zero_default`, also use **interlinked-verify** and its
[numeric-default reference](../interlinked-verify/references/numeric-defaults.md).
Supported numeric-parser and helper flows yield advisory review candidates; an
intentional zero sentinel is an exception, and no quality score or blocker is added.
**Interlinked-observability** explains its retained advisory coverage gaps separately
from operational check deferrals and defect findings.
Use **interlinked-verify** for positional-boolean advice scope, including root
`test`/`spec` entry files and test directories.

Use **interlinked-harness** for opt-in decision/edit shadows, **interlinked-verify** for
the optional TypeScript scheduler and heuristic false-positive filter, and
**interlinked-observability** for simulation filtering, shadow file touches and reservation
joins. These predictors remain disabled by default; passing implementation tests does not
establish cross-repository calibration or authorize promotion into guard policy.


Use **interlinked-verify** for `tests contracts import|inspect|run`: portable executable
examples, expected-value provenance and retained previous expectations. Use
**interlinked-spec-audit** for preparing explicit documentation examples. Contract
review is advisory; configured acceptance is separate from agent-authored proposals.

For provider edit normalization and Stop delivery, use **interlinked-harness**; for
native qualification, use **interlinked-setup**; for re-entry/translation evidence,
use **interlinked-observability**. Early test-readiness guidance is covered by
**interlinked-verify**. Provider-specific capabilities remain available.

Use **interlinked-verify** for `tests readiness` and bounded `tests review`, including Python
test setup and the distinction between tools present, assertions executed, and requirements
covered. Use **interlinked-simplification** for the advisory Python cleanup/forwarding family.

**Interlinked is a local control plane for AI coding agents.** A local daemon ("the harness")
hooks into Claude Code, Codex, Copilot CLI, Gemini CLI, Cursor, OpenCode, and
Pi — and on every tool call the runner exposes to its hook surface it enforces deterministic
policy (block/allow in milliseconds, no model in the decision path),
fails closed on what causes incidents (destructive commands, secrets, unvetted deps), and writes
a replayable local activity log. It is **offline-first** — no required cloud dependency or
remote telemetry. Activity is recorded locally; an **optional authenticated server** provides
multi-agent coordination and configured sync.

Runner registration is not a claim of identical native APIs. OpenCode and Pi use managed
plugin/extension bridges and lack dedicated native MCP, subagent, and worktree lifecycle hooks;
load **interlinked-setup** for activation/trust and **interlinked-harness** for ask/Stop behavior.

If you're an agent working in a repo with a `.interlinked/` directory, you are being guarded by
it. This skill orients you and points to the right focused skill.

## The three surfaces

Jev semantic review is internal research only. The public Interlinked CLI has no
`jev` command, and its harness never invokes the legacy Jev reviewer at Stop.
Default-off edit shadows and decision shadows can call Jev when explicitly enabled;
they only log results and do not change guard decisions. See `docs/harness.md` for
those configurations. Internal evaluation belongs to the source-checkout runner
documented in `docs/internal/jev.md`. The separate experimental
`metrics decisions` pipeline supports explicitly configured System One backends;
its opt-in PostToolUse advice is not the legacy Jev Stop reviewer.

For the internal GitHub repository collection → pair review → frozen Jev/Luna
comparison workflow, load **interlinked-quality-gates**. If the optional local research
directory is present, read `research/semantic-factory/repo-pipeline/README.md`;
it is ignored and absent from fresh clones and packages. This research pipeline keeps
one repository iteration active and records lessons; it does not add a public
CLI command, embedding model, automatic code edits, or a blocking semantic gate.

| Surface | Role |
|---|---|
| **Interlinked CLI** (`interlinked …`) | Local hooks, guard, quality checks, activity capture, diagnostics. |
| **Interlinked MCP Server** | Optional remote source of truth for tasks, messages, reservations, agent state. |
| **Web UI** (`/chat`, `/map`) | Optional human oversight and coordination. |

## The `.interlinked/` directory
Everything is per-`cwd` under `<repo>/.interlinked/`. Key files:

| File | Git | Purpose |
|---|---|---|
| `config.json` | committed | server URL, defaults, operational mode, feature flags |
| `config.local.json` | gitignored | token, agent name, workspace, sync mode |
| `guard-rules.json` / `.local.json` | team / local | guard rules, file reminders, per-edit coverage/mutation policy |
| `check-policy.json` / `.local.json` | team / local | report-ratchet settings, including the mutation-score floor |
| `lint-import.json`, `lint-baseline.json` | team | imported analyzer scopes/configuration digests and tighten-only existing-debt allowances |
| `package-allowlist.json` | committed | approved dependencies (default-deny installs) |
| `package-proposals/` | local | pending dependency requests; never approval grants |
| `verify-suppressions.json` | committed | file/glob check suppressions |
| `test-dependencies.json` | team | additive literal test-to-input dependency declarations |
| `test-runs/` | local | durable pending requests, validated passing receipts, native reports and the last observed job |
| `*-baseline.json`, `metric-caps.json` | mixed | ratchet water-lines (coverage/mutation/line-cap/caps); the daemon folds session evidence into three of them at SessionEnd, tighten-only — see **interlinked-quality-gates** |
| `baseline-folds.jsonl` | local | audit row per SessionEnd water-line fold (what tightened, what was refused) |
| `hook-coverage.json` | local | daemon-owned protected/reserved file observations, pending versions, the recovery job, and the committed length of the receipt history; writer identity remains unknown |
| `hook-coverage-history.jsonl` | local | append-only manual reviews and automated check receipts (one row each); only the prefix that `hook-coverage.json` names is committed. A pre-split ledger migrates once on daemon start and is kept as `hook-coverage.json.legacy-<iso>` |
| `mutation-manifest.json` | mixed | stable per-mutant state for the live per-edit mutation ratchet |
| `mutation-cloud-v3.local.json` | gitignored | experimental protocol-v3 endpoint, authority, key, runtime, and scheduler configuration |
| `mutation-journal.sqlite` | local | authority-scoped durable mutation jobs, leases, authenticated evidence, manifest head, and outbox |
| `mutation-findings.jsonl` | local | fsynced, deduplicated delivery records for durable background mutation findings |
| `findings/corpus.jsonl` | committed-capable | common finding storage, including recorded simplification extensions |
| `findings/simplification-runs.jsonl`, `debt/manual-marker-snapshots.jsonl` | local | explicit simplification-run and manual-marker snapshot receipts |
| `semantic.json` / `.local.json` | team / local | optional local semantic-index policy / machine runtime topology |
| `index/functions/` | local | generation-scoped function metadata and vectors; never synced |
| `index/data/search.sqlite`, `data.config.json` | local | rebuildable JSONL/archives search projection and bounded maintenance settings |
| `capture-receipts.jsonl`, `capture-capabilities.jsonl`, `capture/state/` | local | producer write/availability evidence and derived lifecycle state |
| `activity.jsonl`, `collection.jsonl`, `timeline.jsonl` | local | captured agent activity (`enable` gitignores the first two) |
| `hook-runtime.json` | local | payload-free proof that each provider executed its current hook definition |
| `harness.sock` / `harness.pid` | — | the running daemon |

## What warnings mean: `[proven]` vs `[heuristic]`
Every message the harness sends you is tagged:
- **`[proven]`** — a real compiler/linter/scanner/parser/test-runner produced it (tsc, biome,
  gitleaks, semgrep, …). This identifies deterministic evidence, not proof that
  every policy threshold or pattern match is a defect. Inspect the finding's contract.
- **`[heuristic]`** — a regex/AST-shape match that could be a false positive. **Evaluate it.**
- No tag — an unknown check id (never guessed).

A **block reason is always surfaced.** Allow-time warnings are surfaced but easy to overlook
(PreToolUse via `additionalContext`, PostToolUse via stderr) — read them.

Guard prediction defaults to advisory shadow mode. Edit-time structural caps also
advise unless `harness.edit_metrics.mode` is explicitly `enforced`; see
**interlinked-harness** and **interlinked-quality-gates**. Deep-audit advice is
retained for `verify --all-checks`, and repetition never promotes a warning to an
error. Missing or deferred evidence still means NOT CHECKED.

## Where things run (server / auth / offline)
| Commands | Server needed | Works offline |
|---|---|---|
| `enable`, `disable`, `doctor`, `verify`, `harness …`, `caps`, `simplify …`, `debt …`, `impact`, `allowlist`, `logs`, `status` | no | yes |
| `sync`, `watch` | yes | no |
| `tasks`, `send`, `inbox`, `handoff`, `workspace` | yes (auth) | no |
| `checkpoint`, `rewind`, `resume`, `guard` | no | yes |

## Which skill to load for what

For OS-denied connections, DNS/HTTPS failures, `interlinked network check`, or reusable
`network codex-profile` setup, use **interlinked-setup**. Probe from the affected runtime;
an allowed Interlinked decision cannot grant access denied by the host sandbox.

Use **interlinked-setup** for init preview/sync validation, strict uninstall runner
filters, cleanup preview precedence, and reload restart outcomes. Local checkpoint
restore failures and archive retention belong to **interlinked-coordination**.
Environment display masking and shell completion setup belong to **interlinked-setup**.
Structure-doctor failure exits and TDD cycle inspection/clearing belong to
**interlinked-verify**.
Scanner policy preservation and review-key selection belong to **interlinked-harness**.
CI collection errors and Git apply preflight/partial failures belong to
**interlinked-coordination**. Sponsor JSON setup belongs to **interlinked-setup**.
Collection duration and telemetry JSONL/truncation behavior belong to
**interlinked-observability**, and trigram numeric inputs belong to **interlinked-setup**.
Socket-ownership refusal during `harness clean` belongs to **interlinked-setup**.
JSON status refreshes belong to **interlinked-observability**, and missing doctest
target errors belong to **interlinked-spec-audit**.

Route `coverage check --lane e2e`, e2e evidence refusals and
`coverage-e2e-baseline.json` to **interlinked-quality-gates**. Route
`e2e scaffold` and `[interlinked:e2e-obligation]` (both confined to the
Interlinked checkout itself — a host repository never sees them) to
**interlinked-verify**.
Route project e2e policy (`.interlinked/e2e-policy.json`), `tests e2e
status|plan|run|check|qualify|scaffold`, the adoption workflow `tests e2e
discover|surfaces|adopt|doctor`, the completion gates `tests e2e check
--staged|--revision|--base|--gate`, `tests e2e gate install|status|uninstall`,
`tests e2e ci`, `tests e2e policy replace`, `POLICY_WEAKENED`,
`CI_RECEIPT_NOT_FRESH`, `tests e2e expectations …`,
`[interlinked:e2e]` and `[interlinked:e2e-quality]` lines to **interlinked-verify**: a scenario obligation clears only through a
supervised `tests e2e run` receipt for the current input generation, never
through a unit run, a green console line or a copied report.
Transport receipt diagnostics (`hook-transport.jsonl`) belong to
**interlinked-harness**.

For the experimental uploaded Cowork plugin, use **interlinked-cowork** and
`interlinked cowork capabilities --json`. Cowork cloud hooks execute away from the
host daemon. Native crash/timeout behavior can fail open; the coding-client claims
above do not imply identical Cowork enforcement or Desktop Chat hooks.

For hook parity and provider limitations, use `interlinked harness capabilities --json`
and **interlinked-setup**. For `[interlinked:hook-coverage] NOT CHECKED` after an
external write, use **interlinked-verify**. A declared hook, an installed entry, an
observed invocation and native enforcement are separate evidence.

| Situation | Load |
|---|---|
| Installing / enabling Interlinked, connecting a coding client/hook, daemon down or **zombie**, `doctor` fails, config/mode | **interlinked-setup** |
| A Bash command or edit was **BLOCKED**; a sandbox/effect-residue warning; a `[interlinked:*]` warning; suppressions | **interlinked-harness** |
| Running `interlinked verify`; a `pre_block` check blocked an edit; landing a cross-file refactor; scratch scripts | **interlinked-verify** |
| Selecting tests, explaining invalidation/reuse, resuming deferred test work (`tests plan/run/status`), explicit TS/JS/Python/Rust/Go suites (`tests suite`) | **interlinked-verify**; incremental coverage contracts: **interlinked-quality-gates** |
| `[interlinked:hook-coverage] NOT CHECKED`; verifying or reviewing pending file versions (`harness coverage`) | **interlinked-verify**; daemon/capability diagnostics: **interlinked-setup** |
| Discovering/adopting lint configs, script aliases and CI/tasks (`lint scan`, `lint import`, `lint check`), native or declared SARIF adapters, isolated `--only-selected --config tool=file` profiles and hook/audit cadence | **interlinked-verify**; baseline integrity and retirement: **interlinked-quality-gates** |
| Advisory **file size**, or blocked by a **function-token / coverage / complexity / CRAP / mutation** ratchet; configuring report, per-edit, or durable `mutation cloud` work; operating the mutation journal; "can't lower a baseline"; `adopt`; automatic obligation or manual marker debt; **dead code** (`deadcode` scan + `--categorize` deletion-safety buckets, per-edit `dead_code_action`) | **interlinked-quality-gates** |
| Finding, reviewing, recording, or auditing opportunities to delete, replace, defer, or shrink code; `simplify …`; simplification coverage/evidence/deep handoff | **interlinked-simplification** |
| `metrics score`, catalog/explain/compare/corpus, behavioral receipts, gate reach, incremental coverage, or syntax-token counter migrations | **interlinked-quality-gates** |
| Dense expressions, callback depth, `metrics expressions`, `.interlinked/readability.json` | **interlinked-quality-gates**; formatter adoption and `lint import --gate errors --target …`: **interlinked-verify** |
| Guard ownership changes, `guard-prediction-protocol`, predicted intent or reconciliation receipts | **interlinked-harness**; shared mode configuration: **interlinked-setup** |
| `metrics jit` calibration size, `metrics rework` scan caps, `metrics arch` depth, hotspot limits, commit-time `[interlinked:jit]` warnings or within-repo ranks | **interlinked-quality-gates** |
| Installing a local embedding model; building, inspecting, searching, or repairing the optional function-vector index | **interlinked-semantic-index** |
| An `npm/pip/cargo/…` install or manifest edit was blocked; the package **allowlist** | **interlinked-supply-chain** |
| Spec/doc facts, drift, invariants, review **findings**, `doctest`; `[interlinked:spec-*]` | **interlinked-spec-audit** |
| Explain earlier work, investigate failed/missed checks or file/session history, assess capture gaps, search JSONL/archives with **`data scan`**, compare storage engines with **`data lab`**, retain logs, inspect **`data` views**, **recurrence**, `viz`, chain `audit`, evidence-classed `impact`, `sync` | **interlinked-observability** |
| Server-backed **tasks/messages/reservations/handoff**; local **checkpoints** (git-mutating!) | **interlinked-coordination** |
| Distill AGENTS.md / CLAUDE.md guidance into enforced harness rules | **enforce** (`/enforce`) |

## Quick orientation

`metrics diagnostics --profile js-ts|python` provides separate verbosity/erosion censuses with overlap and
absolute contributors. Route counting semantics and measurement gaps to **interlinked-quality-gates**;
route `simplify review --diagnostics js-ts|python` and candidate review to **interlinked-simplification**.
`metrics diagnostics compare` validates saved diagnostic scope and identity. These features add
no hook gate or automatic scan cadence; Python uses an isolated, bounded stdlib parser.
```bash
interlinked                 # guided human first run (posture + hooks + skills + daemon)
interlinked enable          # explicit/automation install primitive
interlinked status          # dashboard: sessions, recent activity, health
interlinked doctor          # is everything installed & the daemon answering?
interlinked harness status  # liveness: answering / ZOMBIE / not running
interlinked harness checks   # how many checks / rules are active
interlinked data status --json # is retained evidence indexed through the relevant events?
interlinked data health --json # what capture is observed, failed, or unmeasured?
interlinked --help          # full command list
```

> `harness status` and `doctor` verify liveness by **round-trip, not PID**. A red `ZOMBIE`
> (process alive, nothing answering) means the guard is off — `interlinked harness restart`.
> For Codex, doctor also compares `.codex/hooks.json` with the last executed definition hash;
> review changed hooks through `/hooks`, then run a hooked action.

When prior evidence is relevant, load **interlinked-observability** and use its bundled
investigation workflows. Check freshness, search a specific session/file/check, and verify
supporting raw records. `data scan --raw` reads bounded JSONL/gzip without creating SQLite.
Indexing is an explicit storage choice: import budgets are not disk limits. Both indexing and
rotation automation default off and are independent. Enabled indexing runs at SessionEnd.
Retain raw logs and archives indefinitely. Lossless rotation
keeps history available through `data search`; ordinary live-tail readers have narrower scope.

## Golden rules for an agent in a guarded repo
1. **When blocked, read the `Suggestion:` and take the safe path** — don't rewrite to dodge the pattern.
2. **Meet quality gates by improving code and behavioral evidence** — simplify logic or extract cohesive responsibilities, verify relevant behavior, and never lower a baseline. A lower complexity score alone does not prove a better solution.
3. **`[proven]` findings are real** — fix them; triage `[heuristic]` ones.
4. **Package installs are default-deny** — surface an unapproved dep to the human, don't `--force`.
5. **Checkpoints/rewind mutate git** — never run them without explicit per-turn authorization.
6. **Do not create worktrees** — use the current workspace; ask a human operator to provision
   an approved worktree when isolation is required. Listing and cleanup remain allowed.

## Evidence integrity and capability discovery

For `harness calls --since <duration> --session <id> --strict`, load
**interlinked-observability**. It compares observed transcript calls with daemon
judgments; absent capture is not proof of complete enforcement.

For the source-checkout tool-output efficiency lab, repeated-read measurements,
receipt expansion, and decision/embedding selection experiments, use
**interlinked-observability**. These are opt-in evaluation tools, not native hooks.

Use **interlinked-observability** for `harness health` finding outcomes and `harness explain <topic> --client <client>`. Use **interlinked-verify** for `harness corpus status|scan`, replay compatibility, and `tests e2e attempts|replay`. Use **interlinked-quality-gates** for mutation raw-evidence provenance and corpus cohort water-lines. Permission observations are proposals only; **interlinked-harness** and **interlinked-setup** describe their limits.
