---
name: interlinked-verify
description: "Run `interlinked verify`, understand the PostToolUse quality checks, and land multi-file edits through the content gate. Load this when you want to check your changes (`interlinked verify` — the on-demand whole-project check run), when a `pre_block` check refused an edit, when you need to land a cross-file refactor without transient tsc errors (`interlinked write --batch` / `multi-edit` / `verify-changeset` and the exporter-before-importers rule), when deciding whether a finding is default-gate or advisory, or when you need to know where to put probe/scratch scripts (`interlinked scratch`). Verify reports ordinary findings with exit 0; an unavailable/deferred run exits nonzero because no verdict exists."
---

# interlinked-verify — check your work & land edits through the gates

## Claude compiler batches

After a Claude session has delivered a native `PostToolBatch`, declared single-file
edits queue TypeScript checking until that boundary. Related edits in the same model
message are checked against the completed tree, once per project. Existing atomic
multi-file calls retain their shared check path. Other clients, unknown writers, and
Claude sessions that have not demonstrated the boundary keep per-edit checking.
Security, content guards, lint and hard complexity caps still apply per edit.

Final compiler errors arrive as batch context so Claude can repair them; a native batch
`block` would cancel its loop. Unresolved errors and unavailable compiler work remain
in `.interlinked/compiler-batches/` and are checked before Stop and commit, including
after daemon restart. Do not delete this state to bypass verification. A queued edit
has no TypeScript verdict and must not be described as fully checked. Explicit verify
and commit checks remain necessary for the required repository validation scope.

Runner summaries from `rg -n`/`grep -n` are recognized with a single numeric line prefix.
A failure in any recognized summary takes precedence over a pass; shell success after
a pipe/trailing command alone still does not prove that tests passed.

## Repeated implementation advisory

`repeated_implementation` compares same-file Python and JS/TS function bodies by
AST structure, with a minimum of five statements. Tests, generated files, small
delegates and functions containing nested implementations are excluded. This is
conservative structural matching, not proof that two contracts are equivalent.
It names the matching functions and source lines, shows literal values, and suggests
a shared operation when the contracts match. Do not compress lines or automatically
extract helpers to satisfy it. Preserve correctness and independently evolving behavior.

The daemon reports new or changed groups once per session after all files in the
observed tool changeset have landed. Unchanged groups remain in structured check
results. Stop rescans current touched files through the existing digest and repeat-Stop
filter; `verify --all-checks` reports the full advisory inventory. Default verify skips
this check. It never blocks an edit or Stop and never creates a completion obligation.
A daemon restart can repeat advice. Separate tool calls are separate observed changesets.

Python uses an isolated, bounded `python3` AST parser and does not execute candidate
code. Missing parsers, invalid syntax and oversized detector input return NOT CHECKED,
not a clean duplication verdict. Initial scope is whole functions within one file;
cross-file matching and arbitrary repeated sub-blocks are not covered by this check.


On the first authored edit per language/session without a detected test layout,
PostToolUse probes Python/JS/TS/Rust/Go runner readiness and supplies setup/test guidance.
It does not install packages or hard-block absent tests. Inspect custom layouts before
adding public-contract assertions, then execute them. Explicit `tests readiness` rechecks
changed prerequisites; the automatic probe does not run on every edit.

For Cowork, load **interlinked-cowork**. `cowork verify <workspace>` runs only tsc,
biome and gitleaks with before/after workspace hashes; skipped checks remain
unmeasured. It is not the full `verify` command or a per-edit ratchet. Run configured
repository checks on the filesystem holding the actual version being reviewed.

The optional Bash `tsc` accelerator recognizes executable `tsc` / `npx tsc`
segments in flat, quote-aware command lists. It preserves quoted arguments and
rewrites only the matched invocation. Search patterns, look-alike executable
names, comments, multiline commands, substitutions, and shell grouping fall
through unchanged; run the original compiler normally in those cases.

The file-mode Rust formatter reads the nearest `Cargo.toml` only within the
project root. A neighboring directory with a shared name prefix is outside
that scope; unreadable manifests are reported instead of guessing an edition.
Python behavioral suites run from the resolved project root; companion filenames are
not a sound dependency boundary. Directory-name prefixes never establish confinement.
Missing-companion guidance describes a naming-convention observation, not proof of missing
behavioral coverage. Inspect the project's test layout before adding language-appropriate
public-contract tests.

Interlinked gates edits at **three moments**, and they run different check sets:
- **PreToolUse content gate**: real agent Edit/Write calls run deterministic `pre_block` checks
  without synchronously launching biome/tsc on the daemon event loop; those external overlays
  are recorded as scheduled for applicable file types and run asynchronously after
  the write. Routine scheduling produces no model warning; unavailable or failed checks still
  report **NOT CHECKED**. Python/Go/Rust edits do not receive JS/TS overlay scheduling. Transactional CLI
  paths (`interlinked write` / `verify-changeset`) still run `pre_block → biome → tsc` and fail
  closed. `interlinked multi-edit` uses the same shared content gate.
- **Other PreToolUse guards** (real Edit/Write only): function tokens, coverage, cyclomatic, CRAP, baseline —
  see **interlinked-quality-gates**; package/allowlist — see **interlinked-supply-chain**.
- **PostToolUse** (after the write lands): external tools (tsc/biome/eslint/semgrep/gitleaks/…)
  plus the inline check registry. Findings arrive after the write; default-gate errors can
  return blocking feedback requiring repair, without rolling back the tool. Bash and unknown
  writer tools are routed by their observed filesystem ChangeSet, not merely command parsing.

PostToolUse keeps full findings in the check-results ledger while presenting compact
diagnostics. Repeated advisories are acknowledged per session, check and file; a successful
scoped recheck clears that acknowledgment. Pre-existing TypeScript findings show a count
and the evidence path. "Newly observed" means changed since the previous compiler report,
not proven caused by this edit. Changes observed outside the tool's declared write targets
are labeled "writer unknown"; TypeScript findings there are workspace feedback and do not
block the observing call. Security checks and workspace obligations still apply.

For test evidence, a recognized runner summary can establish the outcome of a piped run.
An unsummarized pipeline's final exit code alone cannot prove the test process passed.
For scratch probes, reading a repository file and writing an unrelated temporary fixture
does not establish a patch applier; the guard checks statically resolved write destinations.
Unknown destinations still rely on filesystem observation after execution.

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

### E2E lane for Interlinked CLI boundary edits

When editing a hook entry, adapter, daemon, installer, generated hook, or ledger
writer identified by `src/harness/e2e-boundary.ts`, add or run a fixture-backed
test: `npm run build:e2e && npm run test:e2e`. Fixtures own their cwd, sockets,
daemon PID and ledgers. Daemon assertions require a fresh transport receipt
with `outcome: "daemon"`, plus PID ownership; cold fallback is a separate case.

`interlinked e2e scaffold <name> --event PreToolUse --tool Edit` creates
`src/e2e/<name>.e2e.test.ts`. `--dry-run` prints it. Replace the deliberate
failure with the required behavior and add MUST-NOT-FIRE cases.
`npm run test:e2e:coverage` collects child coverage after `build:e2e`.
Route ratchet refusals to **interlinked-quality-gates**.

The advisory `[interlinked:e2e-obligation]` Stop warning credits only commands
observed in the current session. Run the lane from that session; another
agent's run, a terminal run, and unit-only evidence do not satisfy it. The viz
feed labels base, unit, integration, e2e and unknown lanes separately.
`E2E_STABILITY=1 npm run test:e2e` adds the 5,000-event stress case.

### Project e2e scenarios in any host repository

A repository with `.interlinked/e2e-policy.json` declares projects, suites
(`managed-contracts`: argv `prepare` steps, build `artifacts`), scenarios
(`affects` globs, `contractIds` from `.interlinked/behavioral-contracts.json`,
`required`, `boundary`) and expectation records. Only that policy creates
obligations; a repository without it pays nothing.

- `[interlinked:e2e] <project>: <scenario> needs current e2e evidence after
  <path> changed` fires on any observed edit to a mapped input (Edit, Write,
  Bash, patch). Run the exact command it prints:
  `interlinked tests e2e run --project <p> --scenario <s>`.
- `needs-mapping` means a protected input has no scenario. Add it to a
  scenario's `affects`; do not delete the protected glob.
- `tests e2e status` / `plan` inspect (exit 0). `tests e2e check` verifies the
  working tree (exit 0 satisfied, 1 open requirement or measured failure, 2
  UNCONFIGURED / unavailable). `tests e2e run` prepares, drives the public
  executable in a disposable workspace, writes
  `.interlinked/test-runs/e2e/<runId>/receipt.json` and appends to
  `.interlinked/e2e-obligations.jsonl`.
- A receipt satisfies only its exact generation: policy digest, affected
  files, the contract manifest and acceptance file, each case's cited
  requirement document, declared inputs and the bytes of any path-shaped
  executable the case invokes. Another relevant edit makes it `stale`; a
  failed case is `failed`; a missing toolchain, a failed prepare step, an
  input the collector could not capture (over 8 MiB, a symlink) or a receipt
  that does not parse strictly is `unavailable`; an unaccepted contract is
  `review-required` even when execution passed. A receipt from another
  worktree or with a runId the ledger never recorded is `RECEIPT_MISMATCH`.
- Every run copies the project into a disposable snapshot first; prepare
  steps and cases execute there with a private HOME. The live tree is only
  read. Compiled executables are copied byte-for-byte with their mode.
- Boundaries: `entry: "process"` (`real: ["application"]`), `entry: "http"`
  driven through a suite-OWNED `services` entry (the supervisor allocates the
  port, proves readiness and clean shutdown; a port that still answers after
  stop belonged to something else and the run cannot qualify), and `entry:
  "browser"` for a `playwright` suite (the app is owned, fronted by the
  supervisor's recording proxy, and every declared `requests` entry must be
  observed through it — a health check or an intercepted API earns nothing).
  A literal-URL case is never a boundary.
- A bound PROPOSED expectation is visible as an advisory (`~` line) and does
  not block completion unless the project sets `gates.review: "require"`.
  Disputed and superseded bindings always block.
- The loop for a new behavior: `tests e2e scaffold <name> [--suite <id>]
  [--write]` prints a proposed scenario (required: false, empty affects,
  a placeholder contract id) and a skeleton whose only assertion FAILS
  deliberately with every assumption marked `ASSUMPTION` / `REPLACE`. Replace
  the assumptions with the observed outcome, add the scenario to the policy
  yourself (the command never edits it), `tests e2e run`, then `tests e2e
  qualify --scenario <id>` for a stability cohort, then `tests e2e check`.
  A deliberate failure is CASE_FAILED, never a pass.
- Completion gates judge EXACT bytes, never "the repository": `tests e2e
  check --staged` judges the index (an unstaged fix does not count),
  `--revision <rev>` an exact commit; both are materialized from git's object
  store (no archive attributes, no smudge filters). `--base <rev>` compares
  the judged policy with the trusted base's: a removed/demoted requirement,
  a loosened gate (an omitted gate is its default: commit/ci require), a
  narrowed `affects`, an unbound contract, a dropped proof/request/stability
  profile is `POLICY_WEAKENED` (exit 1). The reviewed path is `tests e2e
  policy replace --base <rev> --project <p> [--scenario <s>] --rationale
  "<why>"`; the record is read from the judged target, so COMMIT
  `.interlinked/e2e-policy-changes.jsonl` (carve it out of `.gitignore`).
  Never "fix" a weakening by editing gates in the candidate: the candidate's
  own gate setting cannot waive `POLICY_WEAKENED`.
- `tests e2e gate install` writes pre-commit (`check --gate commit --staged
  --base HEAD`) and pre-push (one `check --gate ci --revision <sha> --base
  <remote sha>` per ref) hooks that CHAIN with existing hooks and only CHECK;
  `gate uninstall` restores the originals. A blocked commit or push prints
  the exact recovery command: run it, do not bypass the hook.
- `tests e2e ci [--base <rev>] [--revision <rev>]` exports the candidate
  COMMIT into a disposable directory with empty execution state, runs every
  plain scenario and every stability cohort there and checks the export
  against the event base. Workstation receipts, cohorts, untracked fixes and
  local records never count (`CI_RECEIPT_NOT_FRESH`); preparation steps must
  provision dependencies. Evidence lands in `.interlinked/test-runs/e2e/ci/<commit>/`.
- The Stop reminder is bounded: three identical reminders, one pause note,
  silence until the open set changes; an all-`unavailable` set is a HANDOFF
  (do not retry in a loop); with the daemon down it says NOT CHECKED.
  `interlinked verify` prints the same verdict in its `e2e` section.
- The operator guide is `docs/project-e2e.md` (schema, codes, targets,
  gates, CI, proof limits, recovery table).
- `[interlinked:e2e-quality] <project>/<scenario>: <rule> at <path>:<line>`
  is advice attached to the scenario a test edit affects (§12.3): a removed
  assertion or test block, an added `.only`/`.skip`, a specific matcher
  replaced by truthiness, a raised timeout/retry budget, `force: true`, a
  fixed timing wait, a CSS/XPath locator, an intercepted application
  endpoint, or a new test with no assertion. Net-new only (a moved line is
  not a signal); it never changes the verdict — the scenario still clears
  only through a supervised run.
- A `playwright` suite owns its application as a `services` entry; the run
  fronts it with a recording proxy (`INTERLINKED_E2E_BASE_URL` is the proxy)
  and forces `--reporter=json --workers=1`. A browser case earns the
  `browser-driver` boundary only when the proxy saw its requests inside the
  case's first attempt; `@playwright/test` absent in the project is
  `unavailable` with install guidance (`tests e2e doctor` names it too), never
  an install.
- Expectations: `tests e2e expectations propose --from draft.json` records an
  agent-authored statement with sources, assumptions and questions as
  `proposed`. `accept --from decision.json` binds the exact `revision`
  digest and records the linked contract digests as configured acceptance
  (a local decision, never authenticated human approval). `replace` supersedes
  with rationale and invalidates affected receipts; `review` lists questions,
  source provenance (`matched` / `stale` / `unavailable`) and diffs. Keep
  unresolved product questions in `questions`; do not turn an inference into
  a hard requirement.

- Adoption workflow for a repository with no policy yet (all read-only until
  `adopt`): `tests e2e discover --out report.json` inspects manifests, build
  and test commands, executables and existing contract cases, proposes an
  ADVISORY policy with one scenario per process-runner case, and lists gaps
  (no contract cases, ambiguous nested manifests, unsupported runners).
  Review the report, then `tests e2e adopt --from report.json [--project
  <id>] [--scenario <id>]` writes only the selected configuration; `--mode
  required` must be explicit and expectations in a proposal are always
  dropped. `--replace` is required to overwrite a policy (discarded, not
  merged). `tests e2e surfaces [--write]` inventories bins, scripts and
  OpenAPI JSON operations and shows which scenario `surfaceIds` bind them
  (`explicit` / `unresolved` / `dangling`); YAML documents, routes
  registered in code and unresolved `$ref`s are reported as limits, never as
  an empty complete inventory. An interface no extractor knows is declared in
  the project's `surfaces` list (`{"id": "cli:custom", "kind": "other",
  "address": "…"}`) and bound through a scenario's `surfaceIds`; that is the
  language-independent path. Discovery protects the real layout (`src/**`,
  python packages, top-level source files, the executable's file) and binds
  build scripts as shared inputs; a build whose outputs it cannot infer is a
  `suites[].artifacts` gap to resolve before `--mode required`, which refuses
  a project with no scenarios or with protected globs that match nothing.
  Depth-omitted subtrees are listed in the report's `limits.omittedSubtrees`.
  `tests e2e doctor` diagnoses policy, manifest, contracts,
  acceptance, toolchain, mapping, ledger and receipts without running anything
  (exit 1 on a failed prerequisite, 2 on an invalid policy). Configuration
  alone never produces a pass; the next step is always `tests e2e run`.

Shipped: managed process contracts for any language with a build/run argv
(TypeScript and Python validated locally; the Rust fixture's compiled route
waits for a Cargo-equipped runner), the discover / surfaces / adopt /
doctor adoption workflow, structured-runner suites (JSON protocol / JUnit
report import), owned loopback HTTP services with service-bound contracts,
and per-scenario proof modes (`proof {mode: old-new | controlled-fault |
characterization}`). A counterfactual proof names its `designated` cases as
`{id, outcome?, action?}`: `outcome` lists the observables that ARE the
designated outcome (the case's other declared observables must hold on the
comparison side), `action` lists cases that must pass there first. Without
that declared evidence the supervisor cannot tell a setup failure from a
behavioral red, so it reports INCONCLUSIVE; output presence, exit codes
and status classes never count as evidence. Scaffolding, browser runs,
repetition cohorts and git/CI gates are implemented as described above.
Automatic conversion of existing tests into proposed contracts remains planned;
the MCP/Worker profile remains an explicit release gap.

Jev evaluations are internal experiments, separate from public verification and
Stop hooks. Do not recommend `interlinked jev` or `jev.enabled` to users.
For authorized internal evaluations, see `docs/internal/jev.md`. The runner
sends selected evidence to TypeSafe; its findings are advisory, not gate evidence.

- You want to verify a batch of edits before declaring done.
- A `pre_block` check blocked an edit (see also **interlinked-harness** for how blocks read).
- You're landing a cross-file refactor and hitting transient `tsc` errors.
- You're unsure whether a finding is default-gate or advisory-only.
- You need to write a probe/analysis script and want it in the right place.

## `interlinked verify`

### Behavioral contract evidence

`interlinked tests contracts import <source> --json` prints proposed cases from explicit
`json interlinked-contract` fences; it never executes or accepts them. Each fence is a
JSON object with `id`, `description`, `inputs` (literal project-relative UTF-8 files),
`runner: {kind: "process", argv: ["python3", "main.py"]}` and
`expect: {exitCode: 0, json: {message: "ready"}}`. Import records source path/hash/quote
and ties expected observations to that exact example. Save selected cases in a
version-1 `cases` manifest at `.interlinked/behavioral-contracts.json` (or use `--file`).
`inspect --json` reads provenance; `run --timeout 60000 --json` explicitly executes the
selected runners and records per-case receipts under `.interlinked/contract-runs/`.
`run --previous <manifest>` also tests retained prior expectations against current code.

Process cases use a disposable workspace containing declared inputs and already installed
tooling. This is not an OS sandbox. External state is unsealed, so historical passes are
not reused as current verdicts. HTTP cases use a literal loopback HTTP URL, GET/POST,
no redirects, and exact text/JSON/status/header expectations. Comparisons do not normalize
string values. Missing tooling, stale inputs, conflicting citations and budget exhaustion
are separate from a measured failure. A source citation alone does not prove semantics:
use `source.observation: json|stdout|contract-example` for exact example binding.

Accepted case digests belong in operator-owned `.interlinked/contract-policy.json`,
`{version: 1, accepted: {"<digest>": "rationale"}}`. Never self-approve a proposed case.
`configured` describes that file, not authenticated ownership; protect it outside agent
write authority when required. Intentional replacements need rationale and changed
requirements. `replaces: {id, reason}` does not automatically grant acceptance.

Post-edit `[interlinked:test-contract-review]` is bounded, deduplicated advisory guidance
about new/changed expectations, fixtures or collection settings. Review expectations
against user requirements before adapting them to implementation output. No automatic
runner execution or Stop repair loop is added. See
`docs/plans/behavioral-contract-verification-20260916.md` for schema and scope limits.

`interlinked tests readiness <language> --cwd <project> --json` probes prerequisites for
Python, TypeScript/JavaScript, Rust and Go without collecting tests or installing packages.
Python names the selected interpreter and reports exact approved install argv when possible;
an absent runner or coverage plugin is unavailable evidence. Provision within the existing
authorization boundary, then rerun readiness and execute the tests. There is no system-Python
fallback around a broken selected environment.

At a meaningful change boundary, `interlinked tests review [paths...] --base HEAD --json`
provides a bounded source/test inventory and at most five simplification candidates. Without
paths it discovers staged, unstaged and untracked Git changes. It reads at most 32 source/test
files of 256 KiB each; deletions, unsafe paths and exhausted budgets are explicit gaps. This
is review guidance, not test execution or a passing verdict. Retain executable assertions for
old public contracts and new requirements; review validation ownership, duplication, forwarding
and shared mutable state together. After behavior passes, one focused simplification pass is
enough; rerun relevant tests after changing code and leave uncertain advice unresolved.

`interlinked tests suite <language> --cwd <project> --timeout <ms> --json` explicitly runs
a bounded project suite for `typescript`, `javascript`, `python`, `rust` or `go`. The default
budget is 60 seconds including admission. TS/JS use the shared Vitest scheduler; Python uses
the active `VIRTUAL_ENV`, then project `.venv`/`venv`, then platform Python (an explicit
adapter interpreter takes precedence). A selected missing interpreter is unavailable;
it never silently switches environments. Rust uses offline Cargo
with two jobs/test threads; Go runs all packages with two build jobs and caching disabled.
No runner is installed automatically. Python retains project pytest options and configured
discovery (`testpaths`, `python_files`); the invocation does not append an implicit `.`.
Fresh structured pytest case reports distinguish test failures from collection/configuration
errors and coverage-plugin failures. Fixture and teardown failures count as failed tests.
Known failures remain visible alongside incomplete collection; bounded diagnostics accompany
unavailable results. Terminal text alone is not a pytest verdict. Only an observed passing suite exits successfully;
missing/empty execution is not a pass. `tests plan/run/status` remain the TS/JS dependency-aware
queue interface; the non-TS suite command does not certify or discharge that queue.
Active distributed pytest collection is currently unmeasured. Serial execution remains
supported when xdist is installed but inactive; no plugin is silently disabled to obtain a pass.

The default Python edit/commit coverage runner isolates each invocation's JSON report and
coverage.py database (`COVERAGE_FILE`) in an owned temporary subdirectory of the requested
report directory. Normalized results survive; those temporary files are cleaned after parsing,
including failure paths. Project cwd and pytest configuration remain in effect, and existing
caller coverage files are preserved. Custom command overrides retain their argv/report contract
and remain unqualified for concurrent report isolation and structured red/green verdicts.
Python CRAP attribution requires native function regions with declaration lines; unsupported,
ambiguous or wholly excluded functions remain explicitly unmeasured. A green suite with an
unmeasured enabled quality check does not discharge commit obligations. See the quality-gates
skill for the native coverage.py/Radon attribution contract.

For evolving requirements, distinguish newly required observable behavior from contracts
that should remain valid. Exercise representative successful, boundary, error and state-transition
cases from the public task before concluding the implementation is complete. Existing passing
tests can all remain green while the new feature is largely missing. Keep this proportional
to the change; do not create a mandatory test-authoring loop for trivial reversible edits.
Hidden evaluator cases are unavailable to product checks and must not shape harness rules.

Heavy runners retain at least the configured 2 GiB admission budget plus the host reserve;
the proportional ceiling does not reject an otherwise idle nominal 8 GiB Linux guest merely
because its reported usable RAM is slightly smaller. Insufficient available memory still defers.

The proposed qualification baseline is an 8 GB whole host shared with the user's
other applications. Its operator plan, `docs/plans/8gb-host-resource-plan.md`, is private
operator material and absent from public clones. Qualification requires aggregate measurements across owned
processes and useful completed checks, not merely successful resource deferrals. It does
not change today's verification contract: interrupted or partial work remains unmeasured,
and a constrained run cannot satisfy a required full scope by selecting fewer tests.

Cognitive-complexity, type-smuggling, and cast-justification diagnostics align snippets with TypeScript's line numbering,
including CRLF, lone CR, and Unicode line/paragraph separators. Preserve those
line endings when reproducing a warning; normalizing a fixture can hide a location bug.

For `[interlinked:hook-coverage] NOT CHECKED`, use `interlinked harness coverage verify
--json`. This starts one daemon-owned recovery run over the pending versions and waits
for completion; `--no-wait` returns after starting it. Use `harness coverage status
--progress --json` for cached progress: it reports generation, observation time, pending
count and job counters without rehashing files or returning historical receipts. This
is not a fresh coverage verdict. The waiting CLI uses this compact path and fetches a
fresh full status before reporting completion; it still accepts older daemons that
return full reports. Use plain `harness coverage status --json` for an explicit refresh,
pending identities and full receipt details. Checks reuse the configured PostToolUse battery in bounded
external batches. This does not replay PreToolUse guards or certify every hook phase.
While waiting, an unavailable status response is retried up to three consecutive
polls without restarting verification. A responsive report resets that counter.
Persistent unavailability exits nonzero with the original reason; the job may still
be running. Only a ready response with a missing or different job establishes that
the observed job changed or disappeared.
On Claude and Codex Stop/SubagentStop, advisory coverage feedback stays on exit-0 stderr and
does not request another agent turn. Only an explicit blocking decision requests
continuation. This delivery rule does not clear pending evidence or certify checks;
retry unavailable recovery after its prerequisites change, not merely because a
turn ended. Writer identity remains unknown after recovery.
An initially absent watched path contributes to policy identity but creates no write-check
obligation. Creation or deletion after observation still requires evidence; previously
recorded historical gaps are not cleared by this rule.
Recovery groups pending files by project and applicable checks, then checks up to 32
compatible files together. Documentation does not inherit an unrelated source-test
timeout, and nested projects acquire their own admission lane sequentially. Each
recovery related-test process gets at least 15 minutes and at most two workers, with
the complete union of related tests for up to 32 sources. This reduces repeated broad
suites without selecting a passing subset. Ordinary hook deadlines and source-count
limits remain unchanged; recovery still defers honestly on capacity or timeout.

Explicit recovery now waits up to 30 seconds for each external batch's existing project
lease. Its affected-test scheduler waits within the configured recovery deadline and
permits a necessary full-suite plan without the interactive test-count cap, retaining the
two-worker limit. Ordinary PostToolUse still uses immediate admission and its test-count
cap. Unsupported runners and exhausted capacity/time remain unmeasured; the shared named
test dispatcher supports TS/JS with Vitest and single-language Python/pytest, Rust/Cargo,
and Go project suites. Mixed-language batches remain explicitly deferred. Python no longer
guesses one companion file, Rust executes assertions instead of only compiling tests, and
Go covers the project packages. These project suites produce fresh execution evidence, not
reusable dependency-closure receipts. Missing runners, empty/unrecognized successful output,
and pytest collection/configuration errors are unmeasured. Current non-TS suite failures are
warnings; without a before result they are not classified as introduced regressions.
The external path cap applies separately to each check's applicable paths in the selected project.
An inapplicable binary path does not consume a TypeScript check slot; an applicable security
target still counts. This is not a blanket dependency/cache exclusion.

The daemon retains `automated_check` receipts with exact file identities, completed check
names and findings. Completed checks may have findings; a receipt is not a clean verdict.
Nonempty `unavailable` on a receipt means partial evidence: completed checks and their
findings are retained, but the file version stays pending. Multi-file per-file checks retain
partial receipts when shared checks defer. Shared receipts include per-check configuration
hashes and the request's captured file identities. File or policy changes prevent full discharge.
Legacy receipts
remain readable. These historical receipts are not yet a cache for skipping future work;
check-specific configuration/dependency/runtime identities and exact batch scope are still
required before safe reuse.
Ordinary single-file and multi-file PostToolUse checks consume their exact pending versions
when all applicable evidence completes without deferral. Explicit recovery uses the same
shared scope evidence. Recovery has a 30-minute job budget; cancellation reaches the job's
owned asynchronous subprocesses and capacity waits. Earlier recorded evidence survives.
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

SessionEnd maintenance, fuzz, and benchmark runners additionally share a host-wide background
lane owned by a detached supervisor. Duplicate jobs coalesce across daemon restarts; other jobs
wait at most two minutes. Memory admission can defer a job, and low memory or a ten-minute
deadline terminates the child group. Fuzz/benchmark worker counts are bounded by current CPU
and RAM capacity and rechecked before execution. A deferred or interrupted background job is
not a successful verification; use current completed reports and explicit checks for a verdict.
See **interlinked-setup** for the memory budget and its limits. Scheduled Vitest runs and
verify also acquire this host lane. Foreground requests close background admission while
waiting; the background monitor interrupts its child group to yield capacity. Verify waits
at most five seconds for the host lane, then exits 1 without a verdict.

Scheduled foreground test execution now checks host memory and runner-tree RSS throughout
the run. Its 4 GiB maximum tree budget includes workers; a sampled overrun, lost headroom,
or unavailable telemetry interrupts the process group and retains the request without a
pass receipt. Worker planning reads current CPU load as well as available memory. These are
sampled limits; see **interlinked-setup** for process-group and platform limitations.
Repository pre-push checks use the same admission lane and monitor. Do not respond to a
resource deferral by launching the full suite directly. Small checks can use the repository's
`scripts/run-resource-bounded.ts --light` supervisor with an enforced 1 GiB tree ceiling;
this does not replace required full verification.

Public `interlinked verify` and `interlinked tests` commands have an outer resource supervisor
as well: in-process planning/scanning is measured along with the runner tree. This supervisor
does not acquire a second host lease; the actual command keeps its existing admission protocol.
Memory interruption exits 75 without a verification verdict, even if partial output was printed.

The daemon's async project test gate and legacy affected-test process adapter also acquire
the shared host lane, even when their caller already owns project admission. They monitor
the runner tree and host reserve, set a 768 MiB Node heap limit, and pass
`VITEST_MAX_WORKERS=1` to prevent a second uncapped Vitest suite during a push. The current
Vitest adapter honors that variable; other runners still use their own worker controls
and remain subject to the memory monitor. Capacity loss is an explicit deferral.
Repository pre-push heavy commands wait at most ten minutes for that shared lane;
light diagnostic commands wait five seconds. This serializes an existing daemon push
check with the exact-revision repository gate without skipping either check.

## Select, explain and resume tests

```bash
interlinked tests plan --base HEAD --json
interlinked tests run src/lib/config.ts --workers 2 --timeout 120000
interlinked tests status --json
interlinked tests run --all --timeout 3600000
```

Paths are relative to `--cwd` (default cwd). With no paths, plan/run include staged,
unstaged, deleted and untracked inputs relative to `--base` (default HEAD), plus pending
requests. `--all` works without Git and asks the native runner for its full suite.
Plan loads the project's Vitest configuration in a bounded child but runs no assertions.
Status returns pending inputs and the last observed job ID, PID, snapshot and state; a
retained running observation is not proof its owner is still alive.

The TypeScript/Vitest hook paths use this same union: edited tests, static transitive
consumers, colocated and `__tests__` companions, declared inputs, and historical coverage
consumers. Estimates use existing per-shard durations and otherwise say unmeasured.
An opaque test runs on any input change; shared opaque setup/configuration, unknown/deleted
inputs, incomplete discovery or an explicit full request widen to the full suite.
Named/multiple Vitest projects currently use native full execution rather than selective
indexing. Python/Rust/Go retain their existing dispatchers; mixed-language batches defer.

Optional `.interlinked/test-dependencies.json` declares additive literal inputs:

```json
{"version":1,"tests":{"src/cli.test.ts":["src/templates/config.json","dist/index.js"]}}
```

Declarations never make uncontrolled I/O cacheable. Exact passing-result reuse is limited
to plans without uncertain dependencies and requires matching source/scope, captured runtime
bytes, runner/dependency/configuration inputs, platform/environment and worker count.
Opaque plans run fresh without the expensive reusable-evidence census. Their results say
`runtimeVerified:false`: the runner completed and the scheduler checked analyzed source
stability, but no exact runtime or coverage verdict exists. A failed bounded runtime census
also disables reuse and widens selection. No runtime values are persisted in receipts.
Failed, interrupted, missing-report, all-skipped and empty runs never create passing receipts.
Edits during execution trigger another plan; stale evidence cannot clear pending work.

For Python, check prerequisites in the selected project interpreter after creating a
venv. System pytest/coverage packages are not available in an ordinary isolated venv.
`interlinked tests readiness python --json` reports that distinction; install approved
test tools there rather than silently switching interpreters. Explicit test-first
enforcement requires the first companion even when the repository starts without tests.

Requests coalesce across nearby edits and identical in-flight subscribers. Cross-process
leases serialize execution. A waiting process can consume its request's completed result
after rechecking source, declared/requested inputs, environment and platform; exact-runtime
results also require a fresh matching runtime census. This request-specific sharing is
distinct from reusable passing-result caching. Hooks defer immediately when another process occupies capacity,
while explicit CLI runs wait within their deadline. A subscriber's timeout does not cancel
another caller's shared work. Durable requests survive timeout and process restart. The
queue reads at most 1,000 requests per batch and continues draining later batches.
TypeScript hooks use `max_dependent_tests` as a cap on the complete selected test-file
union (default 150). Full and over-budget plans defer intact; run `interlinked tests run`
to drain them with an explicit deadline. The external-tool batch releases its project lease
before entering the test scheduler. Capacity, path-cap and tool-cap deferrals retain inputs.

`affected_tests` remains opt-in. Its default empty filename suffix includes configuration
and fixtures in Node projects; explicit repository `file_types` and `skip_test_files`
settings still control which changes trigger it. After a triggered batch, all changed inputs
are considered. Raw `npm test` and independently launched tools do not use this scheduler.
The full pre-push/CI coverage gates remain authoritative; passing focused tests does not
satisfy them or re-enable a disabled local coverage policy.

Lease ownership binds the PID to an OS-derived process-start identity, so a live unrelated
process that reused the same PID cannot keep compiler or heavyweight capacity busy. Legacy
lockfiles without that identity remain compatible while fresh, but expire after 24 hours — well
beyond every minute-scale workload timeout — rather than starving a project indefinitely.

A compiler watch process that fails to spawn is unavailable. Shutdown waits for
its close event and releases the compiler lease without signaling a missing
process; callers can then use the normal cold compiler fallback.

There is **no** `--file`/`--changed`/`--staged` flag — verify always walks the whole discovered
set (or `target`/`--subdir`). Diff-awareness lives at the *edit-time* gate, not in verify.
Run verify to see **pre-existing** findings in a file you're about to touch (the edit gate
hides those as warnings).

## Check families & phases

`html_duplicate_id` is a default PostToolUse/verify warning for repeated static IDs in
an explicit `<body>` in `.html`/`.htm` files. It reports each later occurrence with the
first occurrence's line. IDs are case-sensitive; comments, script/raw-text contents,
inert `<template>` contents, and dynamic ID expressions are excluded. IDs on the body,
script, and template elements themselves still count. This is a lexical check, not a
browser DOM audit: it does not infer omitted body tags, normalize equivalent entity
spellings, evaluate template branches, or execute JavaScript. Rename duplicate IDs and
update links, labels, ARIA references, and selectors; use classes for shared styling.

### Adopt existing project linters

For expression-level review, run `interlinked metrics expressions <path> --json`
or `verify --all-checks`. `expression_size`, `inline_callback_count`,
`control_flow_depth`, `expression_measurement`, `required_braces`,
`statements_per_line`, `nested_ternaries` and `ubs_deeply_nested_callback` are advisory.
The callback check now uses exact syntax and defaults to >2 inline callback levels.
Generic brace advice accepts single-line guards, diagnoses multiline bodies, and
defers to detected target style configuration. Explicit imported brace rules retain
their native policy. Verify intended scope before adding braces; no bulk brace
autofix runs. Guard changes are handled before the edit by the prediction protocol
described in **interlinked-harness**. Physical file size (`large_files`) also belongs
to `--all-checks` advice, never a source-edit or verification block.
Missing parser/policy evidence produces NOT CHECKED, not a clean measurement. Use
**interlinked-quality-gates** for counting boundaries and `.interlinked/readability.json`.

Formatting requires explicit adoption of the project's formatter. `biome` imports
lint rules; `biome-format` imports read-only format checking with the same config and
inheritance tracking. Example: `lint import --config biome-format=biome.json
--target src/example.ts --only-selected --cadence audit --write`. Repeat `--target`
to bound rollout; targets are relative to `--scope` and require `--config`. `--gate errors`
keeps explicit native warnings advisory in `lint check`, while errors and unknown
severity remain gating. Default `all` preserves existing behavior. Both modes retain
all findings in JSON; cadence and gate survive re-import. Formatter-disabled or
zero-file runs cannot establish formatter compliance. Width is a formatting target,
not a hard maximum. Normalize a bounded scope first; avoid repo-wide churn or implicit
line-baseline resets. This repository's doctor pilot is enforced by CI through
`npm run format:check` and `npm run lint:readability`.

Biome sibling overlays can ignore literal-file overrides confined to another
directory. Overrides that may select the target or its temporary sibling still
require supported filename-invariant selectors; otherwise the overlay is unavailable.

`interlinked lint scan [directory] --json` inventories recognized lint configs,
manifest sections, declaration/selector candidates, ignores, scripts/aliases and task/CI evidence
across nested packages. `lint import` previews which sources can become imported
checks and which need review; `lint import --write --baseline` applies supported
scopes, enables `quality_checks.lint_import`, and measures existing debt.
Preview never executes configuration; the baseline run invokes installed analyzers.

The native adapters cover ESLint, Biome (lint and format), Oxlint, Ruff, Clippy, golangci-lint,
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
Use `--only-selected` with `--config` or `--eslint-config` when adding an isolated
profile: new automatic/inferred linters remain review items, all previously adopted
profiles remain, and `--cadence` changes only the explicit selections. Without that
flag, import still includes supported discovered profiles. Preview before adoption.
For this repo's focused anti-slop audit, select `--config oxlint=oxlint.anti-slop.json
--scope src --cadence audit --only-selected`, then `--write --baseline`. This enables
two complementary rules through the existing lint runner/baseline, not new native
checks. The separate all-18 research config is an explicit census only; its report
can exceed the runner's 10 MiB capture bound. Never promote a rule solely for zero hits.
Each config/scope/target/flag profile has its own
ratchet identity; re-import retains selected profiles without repeating flags.

PostToolUse and ordinary `verify` run hook profiles; `verify --all-checks` and
`lint check` run all profiles. Saved cadence survives re-import. Named/type/build-heavy
and CI profiles initially use audit cadence. Imported checks run asynchronously; hook findings
warn, never become automatic `pre_block` errors. `lint check` is the explicit
gate: exit 0 = complete/no new gating debt, 1 = new gating debt, 2 = incomplete/no verdict.
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
single-edit hook path does not launch the sidecar at all. It records scheduled work,
and the admitted PostToolUse path checks the on-disk result asynchronously. A scheduled
record is not a passing verdict; unavailable PostToolUse checks still surface missing evidence.

Full-project TypeScript children are serialized per project across concurrent
hook and CLI processes. Heavy verify/check/test/audit/sweep work uses one
project-scoped cross-process lease: contention is an explicit deferred/no-verdict result
for external-tool batches. Tests retain requests and use the bounded scheduler described
above. Each accepted request runs after its own edit is on disk; cached test results require
matching validated inputs.
A multi-file PostToolUse request also owns one external-tool batch for its
entire ChangeSet: project-capable compilers, linters, and security scanners run
at most once, then their findings are attributed back to the touched files.
Cheap inline checks still run once per file. A same-ecosystem dependency audit
runs once for the ChangeSet, and TypeScript/Vitest affected tests run once with
the union of changed inputs, including tests. Mixed-language affected-test sets,
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

Check-evidence stores must preserve complete result lists. A corpus record with
missing, non-array, or non-string `hits`, or an adversarial review with malformed
`findings`, is rejected and leaves its obligation unsatisfied. Re-run the scan or
review to replace that record; do not replace unknown results with `[]`. An explicit
empty list from a completed run remains valid evidence of no findings. Corpus
satisfaction also requires a positive integer `files_scanned`; an empty scan or
missing/invalid scan count cannot satisfy the obligation.

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
- **interlinked-quality-gates** — function-token/coverage/complexity ratchets and advisory file-size measurements.
- **interlinked-supply-chain** — the package-install gate.
