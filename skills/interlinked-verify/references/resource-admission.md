# interlinked-verify: resource admission and verification cost

Reference for [SKILL.md](../SKILL.md). Read it when verify or tests print `deferred`, exit 75, or when a push needs `tests trace`.

## Resource admission, host lanes and pre-push outcomes

Whole-project heavyweight work is admitted once per canonical project across CLI and agent
processes. Foreground verify waits for an existing verify/check/test owner to release that
project lane before scanning. It prints a waiting notice after one second. The wait has no
default deadline, and acquisition uses the existing polling lease. Cancellation or an explicit
whole-command `--timeout` interrupts admission with an unavailable verification verdict while
the active owner keeps its lane. A genuine lease error reports the admission failure and its
reason. Different project roots use independent project lanes. The compiler has a separate
nested lease so `--only tsc` can run while
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
for both project and host admission, and prints a waiting notice for either lane when
acquisition takes more than a second. Cancellation remains available throughout both waits.

Scheduled foreground test execution now checks host memory and runner-tree RSS throughout
the run. Its 4 GiB maximum tree budget includes workers; a sampled overrun, lost headroom,
or unavailable telemetry interrupts the process group and retains the request without a
pass receipt. Worker planning reads current CPU load as well as available memory. These are
sampled limits; see **interlinked-setup** for process-group and platform limitations.
The scheduled Vitest coordinator uses a 1536 MiB V8 old-space ceiling. Built-in
`forks`/`vmForks` workers receive an explicit cap after project resolution, preserving
smaller supported absolute limits from worker arguments or `NODE_OPTIONS`;
thread pools inherit it from the coordinator. Existing worker arguments and reporters
are retained. Custom pools are not given an inferred heap contract, but remain inside
the combined process-tree monitor. A heap limit is not an RSS limit: the 4 GiB tree
budget still includes native memory and subprocesses. Receipt identities include the
coordinator and fork heap settings.
Percentage heap settings and ambiguous quoted/escaped heap overrides are unsupported
and produce unavailable/deferred evidence, never a passing receipt. Unrelated runtime
arguments are retained; prefer an unambiguous absolute heap setting when one is needed.
Repository pre-push checks use the same admission lane and monitor. Do not respond to a
resource deferral by launching the full suite directly. Small checks can use the repository's
`scripts/run-resource-bounded.ts --light` supervisor with an enforced 1 GiB tree ceiling;
this does not replace required full verification.

Public `interlinked verify` keeps process-tree cancellation, but has no default command
deadline, cumulative inline-check time budget or external-analyzer deadline. It does
not require memory admission, impose a Node heap cap, or kill scans on an RSS budget.
The same policy reaches its Gitleaks scan, including JSON output. Tools still run sequentially
inside the host lane. Explicit Node settings, analyzer configuration, and operating-system limits still
apply; no CLI can guarantee completion after an OS out-of-memory kill. Verify timing rows
record absent memory caps as null rather than pretending to have measured a budget.

Use `verify --timeout <ms>` for an optional whole-command deadline and
`--tool-timeout <ms>` for an optional external-analyzer deadline. Omitted values
and explicit zero mean no deadline; positive values are bounded by JavaScript's
supported timer range (2147483647 milliseconds). An explicit deadline can produce
incomplete verification and is never a passing check receipt. Foreground capture
retains complete analyzer output; default capture and execution limits remain in
place for background/runtime callers. Semgrep's implicit per-rule time and
target-size limits are disabled for foreground verification, while genuine
analyzer errors remain incomplete scopes alongside any valid findings.

The foreground deadline policy also reaches version probes and compiler admission.
Verify does not inherit the short background compiler wait or a cached negative
OSV probe from a bounded caller. Failed availability probes remain unknown rather
than being labelled as missing installations. A matching live compiler lease is
not reclaimed merely because it is old; cancellation remains available while waiting.

Source inventory and inline admission no longer discard files because they cross
a byte or population threshold. Intentional generated/ignored scope stays separate
from unreadable paths, unsupported links and parser failures. Removing admission
cutoffs does not establish that every language or individual detector supports
every possible input; coverage and unavailable evidence remain part of the report.

Full scans share invocation-local source, import and type evidence for export
ripple, unused value/type exports and duplicate types. These paths retain their
full result population; runtime hooks keep their per-call bounds. Generated files
can establish that an export is used while remaining excluded from findings.
Unreadable source and unresolved namespaces remain explicit coverage gaps. Other
detectors can still have narrower recognition or traversal limits; full file
admission does not imply complete semantic coverage.

Foreground result collection now covers 40 participating detectors: 28 mapped to
the pinned standards profile and 12 additional scored checks. All 16 scored checks
participate, and verify uses 37 existing result integrations. The current
registry-only exceptions are `public_api_leaks_internal_type`, `jsdoc_param_drift`
and `unvalidated_input_boundary`. Their registry-backed survey and hook surfaces
provide the corresponding analysis. The quality skill's standards reference
lists the participating IDs. Runtime hooks retain their per-edit match limits.

This result policy controls collection guards. Recognition uses bounds such as the API's
12-line signature window, the input check's two-line validator lookahead and the
semantic 15-line boundary window. Own-barrel foreground traversal completes its
scoped static graph; the 64-node bound is runtime-only and exhaustion is unknown.
Fallback-only foreground sibling lookup has no 12-file or six-round cutoff;
runtime retains those limits. Filename-based applicability remains heuristic. Verify
appenders and inline suppression processing retain complete mapped result arrays
without relying on JavaScript's finite function-argument capacity. Advisory
selection and explicit exclusions continue to determine which checks run.

Gitleaks reports use its supported stdout destination (`--report-path -`) with
redaction. A malformed report, failed analyzer or partial report never becomes a
clean result; valid findings survive alongside the unavailable scope.

Public `interlinked tests` retains its outer memory supervisor: in-process planning/scanning
is measured along with the runner tree. It does not acquire a second host lease; the actual
command keeps its existing admission protocol. Memory interruption exits 75 without a verdict,
even if partial output was printed. Memory-bounded interrupted runs print peak RSS (or unavailable), budget and reserve bytes and
retain a deferred `cli:<command>` verification-stage row without a passing identity.
This includes a null child exit status from an external signal even when the local
supervisor did not initiate cancellation. A child's own numeric exit 75 remains a
completed child exit and does not acquire that interruption diagnostic or fallback row.
The fallback ledger follows `tests --cwd`; an explicit stage-ledger override still wins.
Exit 75 alone cannot say what happened — admission that never happened, a child killed
mid-run and a child that itself exits 75 all surface as 75 — so the bounded runner
(`scripts/run-resource-bounded.ts`, used by every pre-push gate step) writes a VERDICT
record to `INTERLINKED_BOUNDED_OUTCOME` beside its status (2026-09-28): `not-run`
(capacity timeout, memory budget unavailable, or cancelled while waiting; stderr
`[resources] NOT RUN: …` with the wait), `interrupted` (started, then killed or timed
out; `[resources] INTERRUPTED: …`), or `exit` (ran to completion; the child's own code,
including its own 75). The pre-push hook reads the record: `not-run` prints
`[pre-push] NOT RUN (host capacity or memory unavailable; nothing failed): <command>`,
`interrupted` prints `[pre-push] INTERRUPTED (killed or timed out; no verdict): <command>`,
and only `exit` (or a missing record) prints `<gate> failed`. The stage ledger row carries
the matching `reuse_denied_reason`. The push is blocked in every non-zero case — nothing
was verified — but only a real verdict names a failed gate.

The daemon's async project test gate and legacy affected-test process adapter also acquire
the shared host lane, even when their caller already owns project admission. They monitor
the runner tree and host reserve, set a 768 MiB Node heap limit, and pass
`VITEST_MAX_WORKERS=1` to prevent a second uncapped Vitest suite during a push. The current
Vitest adapter honors that variable; other runners still use their own worker controls
and remain subject to the memory monitor. Capacity loss is an explicit deferral.
Repository pre-push heavy commands wait at most ten minutes for that shared lane;
light diagnostic commands wait five seconds. The same admission deadline includes
temporary memory shortages. Interactive scheduled tests may wait for a worker within
their existing request deadline; edit callers that decline waiting still defer promptly.
Waiting supplies no verdict. The bounded wrapper preserves smaller absolute
`NODE_OPTIONS` heap limits and refuses ambiguous or percentage overrides.

For this repository's protected pushes, the managed push handoff can make the
exact-revision Git gate the single validation owner on native clients that support
command replacement. Unknown hooks, unsupported commands or an unavailable handoff
retain the legacy checks, and a fallback of a recognized push is recorded with its
cause and shown to the agent. See **interlinked-harness** and
`docs/verification-efficiency.md` for the recognition and fallback boundaries.

Two read-only commands explain verification cost (2026-11-05):

- `interlinked tests trace [--trace <id>] [--json]` folds one request's stage-ledger
  rows (joined on `INTERLINKED_VERIFICATION_TRACE`, which the daemon mints for a
  judged push, hands to the native command, and the pre-push hook prints and
  exports) into owners, phase costs, the wall-clock wait (overlapping waits counted
  once), the handoff fallback cause, and every check that ran fresh or produced no
  verdict. Default: the newest push trace; exit 2 when none exists. A push from a
  plain shell, or a client that never received the native replacement, has a
  hook-only trace. Test-file counts come from runner reports, not planned scope;
  `unmeasured_runs` retains missing counts in JSON and the human summary.
- `interlinked tests opacity [--limit n] [--json]` ranks the modules whose unhashed
  reads or unresolved imports make test results non-reusable by the recorded
  duration of the tests that reach them, with one import chain each. Durations come
  from the coverage index's accepted manifest; a test without one is unmeasured,
  never free. Native Vitest discovery supplies the test universe and shared setup
  and configuration inputs. Discovery unavailable means exit 2, not zero opaque
  tests. It changes no selection or reuse decision.

The repository gate builds the E2E-capable CLI once, then runs
`node scripts/e2e-preflight.mjs` before the full unit suite. This checks inventory,
baseline, declared moves, build maps and report destinations; it does not measure
coverage. The E2E execution and final strict measured coverage gate still run afterward.
Optional coverage-index comparison now requires
`INTERLINKED_PRE_PUSH_COVERAGE_COMPARE=1`; its existing skip flag takes precedence.
It supplies advisory comparison evidence and cannot replace the full suite.
