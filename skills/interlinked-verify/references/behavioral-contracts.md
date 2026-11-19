# interlinked-verify: behavioral contracts and hook-coverage evidence

Reference for [SKILL.md](../SKILL.md). Read it for `tests contracts`, `tests readiness`, `tests review`, `tests suite`, or `[interlinked:hook-coverage] NOT CHECKED`.

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
is not a fresh coverage verdict. Verification starts with a compact job acknowledgement.
When stderr is a terminal, the waiting command prints progress immediately and every ten
seconds, including in `--json` mode; stdout remains one final JSON document. Batch counters
can stay unchanged while a large test plan runs. The latest project test observation is
shown separately: it may belong to another request and is not a liveness or success claim.
Imported lint uses its asynchronous project runner during recovery; it is not a file-only
deferral. Its ordinary tool timeout and resource admission still apply.
Redirected stderr stays quiet. Ctrl-C stops the waiting CLI, not the daemon-owned job;
inspect it from another terminal with `harness coverage status --progress --json`.
If the daemon logs `[interlinked:hook-coverage] NOT MEASURED: Hook coverage history log …
holds N of M committed bytes`, the append-only history log was shortened or removed while
`hook-coverage.json` kept its pointer; the daemon refuses to report less history than it
committed. Run `interlinked harness coverage repair-history` (offline, explicit): it sets the
partial log aside as `hook-coverage-history.jsonl.orphan-<stamp>`, restarts the history at
zero and keeps the current state and pending obligations. Stop the daemon first with
`interlinked harness stop`; repair refuses an active daemon so its in-memory ledger cannot
overwrite the repair. Start it again after the repair. Lost history is not recovered evidence.
The waiting CLI refreshes pending identities and the matching job's detailed results before
reporting completion, without copying historical receipts. Older daemons returning full
reports remain supported. Incomplete or unmeasured checks exit nonzero even when findings
and pending counts are zero. Use plain `harness coverage status --json` for an explicit refresh,
all pending identities and recent receipt details. Status considers the newest 100 automated
receipts and 100 manual reviews, returning at most 1 MiB per kind. Oversized rows are omitted
whole; `history` reports total, returned and omitted counts, ordering, limits and `ledgerPath`.
Complete history stays in that on-disk ledger; omission from a status response never deletes
evidence or acknowledges pending work. Checks reuse the configured PostToolUse battery in bounded
external batches. This does not replay PreToolUse guards or certify every hook phase.
The test scheduler collapses wholly ignored dependency/build directories during checkout
pollution scans, while retaining individually ignored files such as `.claude/settings.json`.
It does not enumerate `node_modules` into the Git status buffer before every test batch.
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
Repository recovery observes only reservations lexically inside that repository. Reservations
for external memory files or other checkouts do not make this repository unmeasured and gain
no coverage receipt from it. In-repository symlinks and unsupported glob reservations remain
explicitly unmeasured.
When observer readiness interrupts recovery, the failed job retains the observer's
first three concrete reasons rather than only a generic filesystem-unavailable message.
Recovery groups pending files by project and applicable checks, then checks up to 32
compatible files together. Documentation does not inherit an unrelated source-test
timeout, and nested projects acquire their own admission lane sequentially. Receipt
batches share one fresh test scheduling request per project, language and check configuration
over the job's complete planned input cohort. This prevents an opaque full-suite plan
from running again for every 32 files. The shared request is queued once; later receipt
batches do not recreate completed test requests. The scheduler may retry actual input
drift within that request's deadline; unrelated requests arriving later cannot hold its
validated completion open or replace its result. Each recovery test process gets at
least 15 minutes and at most two workers within the original 30-minute job deadline.
Source inventory, all planned inputs, declared fixtures and environment must still
match before a later batch receives the result; a claimed validated runtime is checked
again too. Changed inputs remain pending for a fresh job. Failed and unavailable results
are retained for this job without repeated execution and are never promoted into passes.
This is one job's execution evidence, not a persistent test cache: another job or daemon
replacement executes a fresh test cohort for its remaining inputs. Ordinary hook deadlines,
source-count limits and unavailable-result semantics remain unchanged.

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
Automatic non-TS suites require a marker for their own language at the selected root.
A Python file under a TypeScript repository without a Python project marker stays
unmeasured rather than launching pytest over unrelated scratch projects. `pytest.ini`
and `.pytest.ini` identify Python project roots, alongside the existing Python markers.
Python/Rust/Go files are not enqueued as Vitest requests. Explicit `tests suite` commands
retain their selected-project contract; declare the intended test project before retrying
an automatic check with no qualified root.
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
produce exit 1. Re-run after the reported capacity/tool problem is resolved.
The current verification job is durable in `.interlinked/hook-coverage.json`: its exact
input plan, job ID, batch cursor, findings, unavailable details and original deadline
survive daemon replacement. The successor automatically resumes an interrupted batch
under the same job ID; completed batches are not repeated. File identities and current
policy are checked again before accepting new evidence. Receipts and batch progress
commit atomically, so a crash cannot advance progress without saving its evidence:
receipts append to `.interlinked/hook-coverage-history.jsonl` first, and the state write
that names the new log length commits them (a failed state write rolls the append back).
Completed job results also survive restart for waiting clients. Restart does not renew
the 30-minute budget; an expired job finishes with unmeasured work and pending versions.
An older daemon's memory-only job cannot be reconstructed during this upgrade: its saved
receipts survive, but a new verification run is needed after activating the updated daemon.
Filesystem reconciliation persists all observed changes in one atomic transaction, and
recovery persists each checker batch once. These writes retain the full receipt history
without cloning it or serializing it into one giant string. Generations still advance for
each changed observation or accepted receipt; partial and stale evidence cannot clear gaps.
Active recovery keeps the raw and framed listeners out of idle shutdown and delays
automatic build handover within its normal freshness deadline. Explicit restarts and
memory safety shutdowns still cancel owned subprocesses; the successor resumes durable
work within its original deadline. The CLI keeps following the same job across a short
transport interruption and still refuses a genuinely missing or different job.

Released reservations remain watched while pending, so review cannot acknowledge a stale
historical hash. `harness coverage acknowledge <id> <generation> <identity> <evidence>`
records an explicit manual review of the current version, including a reviewed deletion or
optional absence. It does not manufacture automated evidence. Do not bulk-acknowledge
unreviewed files. Checking/reviewing files never accepts protected policy; that is the
separate `harness coverage accept-policy <digest>` operation. Writer identity stays unknown.
