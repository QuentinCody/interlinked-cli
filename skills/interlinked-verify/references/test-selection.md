# interlinked-verify: select, explain and resume tests

Reference for [SKILL.md](../SKILL.md). Read it for `interlinked tests plan`, `run` or `status`.

## Select, explain and resume tests

When a bounded edit request already requires the full suite, the scheduler retains
its durable obligation and records `budget-exceeded` before project/host admission,
test discovery or runtime hashing. This preserves the existing full-suite budget
policy; it is not a test pass. An already valid shared completion is checked first,
and an unbounded `tests run` can still discharge the pending request.

For substantial changes, identify the required verification scope before executing it.
Record completed checks, the inputs they covered and unresolved work in the task plan.
Repeat checks after relevant edits, failures, stale evidence or changed prerequisites;
once the required checks pass on the final inputs, proceed to the handoff. Intentional
flakiness/repetition experiments and required CI/coverage gates still need their own runs.
Group related edits through the existing batch commands when they form one consistent change.

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

Normal `tests plan`, `run` and `status` output bounds each plan-reason, test-entry and
pending-input listing to 12 entries, shortening entries over 320 characters. Display
elision is labeled separately from tests omitted from execution. `--details` expands
the listings; `--json` retains all structured evidence. Runner diagnostics and execution
reasons remain visible in full. Use `plan --details` for inspection; `run --details`
still requests execution. A run's `Evidence:` line distinguishes completed/shared runs
from reused receipts and reports missing runtime validation explicitly. A plan alone,
an empty selection, a deferred run or a stale result never certifies a passing test run.

**Static selection and result reuse are OFF by default (operator decision 2026-10-06).** Three
review rounds found escapes in the effect classifier below (`mkdirSync`, aliased or
parenthesized `vi.importActual`, escaped `Function`/`eval`, `import.meta["url"]`, environment
keys the receipt identity does not hash) that produced false-green plans: a cached pass for a
test that now fails, or an affected test left out. So every `tests run` / scheduled run executes
the whole universe and certifies nothing reusable; the run is still validated before and after
(runtime hash) and still binds measured sources for the commit coverage gate. The classifier
remains TELEMETRY: `tests plan` prints `Classifier estimate (not applied unless
--static-selection)`, and the CI comparison job (`scripts/ci-select-compare.mjs`) plans with
`--static-selection` to keep measuring it. Pass `--static-selection` only to experiment; do not
make it the default before a runtime-traced design exists.

Planning indexes companion prefixes once and retains a bounded, process-local cache
of module-analysis summaries keyed by source bytes and path. Imports are resolved
against the current inventory on every plan; changed/deleted files, extra fixtures,
syntax failures and uncertainty retain their existing behavior. This cache holds
neither test results nor reusable execution evidence and does not enable static
selection. The first plan after a daemon restart still pays the analysis cost.

The TypeScript/Vitest hook paths use this same union: edited tests, static transitive
consumers, colocated and `__tests__` companions, declared inputs, and historical coverage
consumers. Estimates use existing per-shard durations and otherwise say unmeasured.
Each module is classified per OPERATION (`src/harness/runtime-effects.ts`, 2026-10-02):
OPAQUE when executing it may read inputs the identity does not hash (an `fs` READ —
`readFileSync`, `existsSync`, `stat`, a namespace or default `fs` import; `child_process`,
`worker_threads`, `vm`, `module`, network builtins, `fetch`; package code; dynamic
`import()`/`require`, `eval`, `Function`; a computed `global[...]` access);
NONDETERMINISTIC when its result may not repeat (the clock, `performance`, `Math.random`,
crypto randomness, timers, `Buffer.allocUnsafe`); neither for the environment (`process.env`,
`cwd()`, `os.*` — already in the identity's environment hash), pure builtins, and `fs`
WRITES (outputs, not inputs). An opaque test runs on any input change; a nondeterministic
one is selected only by its real dependencies but its run is never reused. src/ fixture
modules (`__fixtures__/`, `fixtures/`) are import targets in the graph, so a changed fixture
selects its importers instead of widening; they are outside the identity hash, so a closure
that reaches one is never reused. Shared opaque setup/configuration, unknown/deleted inputs,
incomplete discovery or an explicit full request widen to the full suite.
Named/multiple Vitest projects currently use native full execution rather than selective
indexing. Python/Rust/Go retain their existing dispatchers; mixed-language batches defer.

Selection is measured in CI before it decides anything (Unit 8, comparison mode). The
`select-compare` job plans against the event's base (`scripts/ci-select-compare.mjs select`,
base from the shared `resolveCiBase`) and runs only the must-run files (`run-selected`, which
refuses an empty list: `vitest run` without filters runs everything). The full unit and
integration lanes upload their vitest JSON reports, and `select-compare-report` writes one
row per run: `SELECTION_MISS` when a file failed in the full lanes but was in the plan's
omitted set; `widened` when the plan omitted nothing; `incomplete` when a lane, the
selection or the selected run left no report (a miss already seen still reports as a miss).
The serial comparison job has a 40-minute total budget because broad selections can
include most unit and integration files. Cancellation still produces incomplete evidence;
the extra time does not change selection, assertions, worker limits, or coverage policy.
Neither job is a required check and neither fails on a miss. Promotion needs zero misses over
at least 30 rows that are SELECTIVE and complete; a widened row proves nothing. Measured
2026-10-02 in a clean clone after the per-operation rule: the setup and config are
transparent and the last three commits each plan `selected`, running 1978 and omitting 547
of 2526 test files (most remaining closures are opaque through `fs` reads); a commit that
changes shared configuration still widens.

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
If the execution itself fails or is deferred, concurrent source/environment changes
do not trigger an automatic retry: the command returns that result with the input-change
reason and retains pending requests. Fix the reported failure or capacity issue before
retrying. A failure observed on older inputs does not certify the current checkout.

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
queue reads at most 1,000 requests per batch. A caller returns once its own request has
a validated completion; it does not wait for unrelated requests added during its run.
Later subscribers schedule their remaining work separately, and unattended requests
stay queued for the next drain. Actual input drift still requires a fresh execution.
A passing run is certified by a RECEIPT keyed by its CHECK IDENTITY (2026-09-28,
`src/harness/check-identity.ts`): the plan snapshot and runtime hash (inputs), the logical
runner argv (mode, workers, `--coverage`, extra reporters), the toolchain (node plus the
installed vitest and typescript versions), the normalized environment, the platform and
the POLICY digest (`.interlinked/coverage-baseline.json`, `coverage-edit-baseline.json`,
`metric-caps.json` and every `vitest*.config.*` at the root). Changing any dimension is a
new check: a raised coverage baseline re-runs the same tests. The environment component
drops ONLY variables proven not to reach a verdict — the shell's cwd bookkeeping (`PWD`,
`OLDPWD`, `SHLVL`, `_`), git's hook-only variables (`GIT_EXEC_PATH`, `GIT_PREFIX`,
`GIT_CONFIG_PARAMETERS`) and this route's own bookkeeping (`INTERLINKED_STAGE`,
`INTERLINKED_STAGES_LEDGER`, `INTERLINKED_BOUNDED_OUTCOME`, `INTERLINKED_LEASE_ANCESTORS`,
`INTERLINKED_COVERAGE_SCOPE_FILE`, `INTERLINKED_TEST_CAPACITY_SCOPE`); `PATH`, toolchain
paths, `CI`, `NODE_ENV`, `NODE_OPTIONS`, `TMPDIR`, every other `INTERLINKED_*` and any user
variable stay in the hash because a test may read them. The child still receives the exact
environment, and the shared-completion path keeps the exact hash. A full run is reusable
evidence only when every closure resolves inside the inventory, repeats and nothing is
untracked: an opaque test (an `fs` read, dynamic import, `fetch`, package code), a
nondeterministic one (the clock, randomness, timers), a closure that reaches a fixture
module, or a test outside the inventory makes the run fresh-only, because hashing repository
bytes cannot see what those tests read or pin what they draw; an opaque or nondeterministic
SHARED setup or configuration file (it runs in every test) makes every run fresh-only,
selected or full, changed or not. A reporter module run
from outside the checkout (`--coverage-reporter`) is bound by the digest of its bytes and
of every dependency it loads. Loads are read from the PARSED source (a specifier that is
not one string literal — `import("./x" + ext)`, a template — is a computed load, never a
prefix match), and each is resolved by its OWN loading mode from the importing module's
location: `require("x")` by CommonJS rules, `from "x"` / `import "x"` / `import("x")` by
ESM rules (a conditional `exports` map is read under the `import` condition, so the entry
Node executes is the entry that is bound; a relative ESM import must name an exact file).
A dependency inside `node_modules` is bound by its COMPLETE installed contents plus,
transitively, the installed contents of every package it declares (a version pins
nothing — an edited internal helper is a different reporter). A computed load, an
unparseable or unresolvable module, an `exports` shape the resolver does not model
(patterns, arrays, an unexported subpath), a declared dependency that is not installed,
or a closure over 400 files is UNRESOLVED. And the reporter is held to a STRICTER rule
than a test or setup file (the pre-2026-10-02 text rule, `runtimeOpacity`), and so is every
installed code file of a bound package (declaration files never run); a stricter reporter
rule can only make a run fresh-only, never reuse wrong bytes: a module that names a runtime read the
bytes cannot pin — `process`, `fetch`, `Date`, `Buffer`, timers, `require`/`createRequire`,
`import.meta`, `Math.random`, eval — or imports a builtin OPERATION that is not pure is
OPAQUE, because complete module hashing cannot cover external data, network responses,
the working directory or the clock. Purity is per operation, never module-wide: whole
modules only where every export is pure (`node:assert`,
`node:string_decoder`, `node:querystring`, `node:util/types`); otherwise named imports
from a short list (`path`: `join`, `basename`, `dirname`, `extname`, `normalize`,
`parse`, `format`, `isAbsolute`, `sep`, `delimiter`; `url`: `fileURLToPath`, `URL`,
`URLSearchParams`; `util`: `format`, `inspect`, `isDeepStrictEqual`, `promisify`,
`inherits`, `types`). Imports from `node:buffer` and `node:events` are opaque:
`File` defaults its timestamp from the clock, unsafe buffers expose untracked memory,
and `EventEmitterAsyncResource` captures async context. Global `Buffer` is opaque too.
`path.resolve` and `path.relative` read the working directory,
`url.pathToFileURL` resolves through it, and a default or namespace import of any
listed-by-name module reaches them, so all of those are opaque. Unresolved or opaque, the
run executes, exports its artifacts and certifies nothing reusable. CONSEQUENCE:
`scripts/pre-push-coverage.mjs` reads `process.env` and walks `src/` through `node:fs`
to ask the coverage provider for its inclusion scope, so every pre-push coverage run is
fresh-only today; a coverage run without an external reporter (vitest's own json-summary)
reuses across a byte-identical export. Re-establishing reuse for the scope needs the
inclusion decision computed OUTSIDE the run (the provider's `include`/`exclude` globs
re-evaluated deterministically), not a more permissive rule. Every identity input,
the reporter binding included, is re-read after the run: a change between hashing and
execution is `stale` and certifies nothing. In THIS repository about 1,980 of 2,526
test closures are still opaque (mostly through `fs` reads), so full-run receipts are not
produced here today. A subscriber that
shares a run but owns a different receipt store gets the artifacts materialized into its
own store (sha256-verified), so its export never depends on the producer's store. Receipts are v2 (`identity`, `platform`, `toolchain`,
`stages`, optional `artifacts`), unsigned and local; a v1 receipt is ignored.

`interlinked tests run --all --coverage [--coverage-reporter <module>]… [--receipt-store <dir>]
[--artifacts-out <dir>]` collects coverage (json-summary) INSIDE the run directory of the
receipt store, records the summary and the inclusion scope (`scripts/pre-push-coverage.mjs`
as the reporter; without explicit targets it records every `src/` code file, so the scope
serves any later changed-file set) as sha256-pinned artifacts on the receipt, and copies
them into `--artifacts-out` after a passing run — fresh or reused — refusing any file whose
bytes no longer match, and RE-ROOTED to the consuming checkout (the scope's `root` and the
summary's file keys name the run's absolute root; a reused run may come from another export
of the same bytes). The receipt's `artifactRoot` retains the source root even without a
scope reporter. Export relocates JSON path fields after verifying the stored bytes;
receipts containing artifacts but missing this root are ignored. Exit 1 is a failed run;
75 is deferred/stale (no verdict). A request
that needs coverage coalesces only onto a request that produces it, a batch produces what
every pending request requires, and a completion discharges only the requests whose
requirements the run met — a plain run never satisfies a coverage subscriber. The pre-push
hook's coverage branch runs exactly this with `--receipt-store` pointing at the SOURCE
checkout's `.interlinked/test-runs`. That shared store retains execution artifacts; it
does not make this path reusable. Static selection is opt-in, and the scope reporter
is opaque, so the current pre-push coverage path runs fresh even for the same revision.
A LOCAL `tests run --all --coverage` does not seed the export in practice: the runtime
snapshot hashes every on-disk byte outside `.git`, `.interlinked` and generated
directories, so gitignored local files (`scratch/`, `coverage/`, logs) enter the local
identity but not the export's — and honouring gitignore alone would not prove those
ignored inputs irrelevant, so this stays an unmet acceptance criterion (recorded in the
campaign file). The export's `node_modules` is a symlink to the source's: the runtime
snapshot hashes the canonical path of the mounted dependency tree, so a copied
`node_modules` is a different runtime and never reuses. That step is not `bounded` (the
scheduler owns admission and supervision).
Requests coalesce at write time (2026-09-28): a new request that a pending one already
covers returns that request's id, and a wider request retires the narrower pending
requests that no caller in its process still awaits (subscriptions are reference-counted,
so a shared id stays protected until its last caller leaves) — a full request is never
retired by a selected one (an empty-path full request keeps its obligation), and each
retirement is recorded in `.interlinked/test-runs/requests/superseded.jsonl`. Request
files are immutable: a request that adds a path to covering work is stored as its own
file (never merged into an in-flight request, whose completion would otherwise discharge
an input it never tracked), and a replacing request absorbs the retired requests' paths,
so no path is ever dropped — those paths are the inputs the freshness check re-hashes
after a run. Concurrent writers in separate processes therefore cannot lose paths. Between batches the
drain YIELDS all three leases (scheduler, project, host) for a short window, so a same-root
`interlinked tests run` or another repository's pre-push export takes the next slot instead
of waiting for the whole queue. Hook-originated work (stage `edit`) runs at `background`
priority and never blocks a waiting interactive caller at the host gate; CLI and pre-push
runs are `interactive` (`ScheduleTestsOptions.priority` overrides). A drain that cannot
re-acquire after yielding returns `deferred` with the work retained, and a queue another
drain emptied meanwhile resolves to that drain's shared completion.
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
