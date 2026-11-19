# interlinked-setup: daemon operations detail

Reference for [SKILL.md](../SKILL.md). Read it when the daemon restarts, backs off, stops at its memory ceiling, or the hook binary is missing.

### Restart defers to an in-flight start, and backs off under churn (2026-08-22)

`interlinked harness restart` used to stop-then-start unconditionally, so two overlapping
restart triggers (a build-refresh handover, an rss-ceiling recycle, a second manual restart)
could kill a successor the other had just spawned, before it finished binding. Now:

- If a start is already in flight (the daemon is mid-boot), `restart` waits for its socket
  instead of killing it — printing "already in flight" and doing nothing further once it
  answers.
- If too many restart attempts (any trigger) went unresolved in the last ~10 minutes, `restart`
  refuses and prints "Too many restart attempts … backing off" instead of adding to the churn.
  Check `.interlinked/daemon-events.jsonl` for the pattern before retrying by hand.

Neither path is silent: every deferral or backoff writes a `handover` row to the daemon ledger
(`daemon-ledger.ts` / `handover-churn.ts`), so `daemon-events.jsonl` always explains what
`restart` actually did.

Since 2026-08-29 every handover attempt is one ID across the whole chain: the parent daemon
writes `requested` → `launcher_spawned` (the restart CLI was launched), the restart CLI
adopts the id and writes its own `requested` intent, the actual daemon spawn writes the
COUNTING `daemon_spawned` row, and the successor's `listening` row acknowledges that exact
id — order-independent. Terminal rows (`refused` on backoff/deferral, `spawn_failed`,
`no_artifact`, `start_failed`, and a `startup-failed` exit stamped with the id) resolve the
attempt the same way. Only an unresolved `daemon_spawned` counts toward the backoff;
`explicit-restart` / `explicit-stop` / deferral rows are audit facts and never count. A
manual `interlinked harness start` (id-less `listening`) still pays off one preceding
unresolved attempt. If the backoff refuses `restart` during a genuine outage,
`interlinked harness stop` + `interlinked harness start` is the ungated recovery path.

### Over the memory ceiling, the daemon stops before replacement (2026-08-31)

Interlinked CLI's proposed design baseline is an 8 GB whole host, shared with the
editor, browser and coding agents. The operator plan is
`docs/plans/8gb-host-resource-plan.md` (private operator material, absent from public clones).
Its aggregate budgets and qualification criteria are not shipped defaults or a claim of
8 GB readiness. Keep the current limits below until retention improvements and constrained
workflow measurements justify replacing them; lowering heap flags alone can cause restart loops.

SessionEnd jobs now run through a detached supervisor with a 128 MiB V8 heap cap.
The supervisor holds a per-project/job lease through child cleanup, including when the
daemon exits, and admits only one background runner per host at a time.
Scheduled foreground Vitest runs and verify share this host slot. A waiting
foreground request prevents another background admission; the supervisor's monitor
aborts the active background child group so foreground work can proceed. The
daemon's async project-test and legacy affected-test processes share this slot too;
outer project admission does not exempt them from host admission. Their Node heap is
bounded at 768 MiB and `VITEST_MAX_WORKERS=1` bounds compatible Vitest runners.
Independent
`npm test` processes remain outside this admission system. A duplicate background job
is skipped; a different job waits at most two minutes. Each admitted runner has a ten-minute
deadline and a 768 MiB Node V8 heap cap. Fuzz and benchmark commands receive an explicit
`--maxWorkers` value, rechecked after waiting for admission.

Admission respects physical RAM and any process/container limit. On an unconstrained Mac,
available memory is estimated from free plus inactive pages (`vm_stat`), with native
`kern.memorystatus_vm_pressure_level` required to be normal. Node's free-page reading alone
does not account for reclaimable cache. Warning/critical pressure or unavailable telemetry
defers work. Samples are cached for at most 500 ms and commands have bounded time/output.
Managed test and background
runners budget at most 4 GiB or one quarter of total memory, whichever is smaller,
and preserve at least 1 GiB or one eighth of total memory as host
headroom. Worker planning budgets 1 GiB for coordination plus 1 GiB per worker. Thus an otherwise idle
8 GiB machine gets at most one worker and a 16 GiB machine at most three. Missing or
insufficient available-memory readings defer work. A 500 ms monitor measures runner and descendant
RSS with bounded, non-overlapping `ps` samples. It aborts the child process group when the runner
exceeds its budget, headroom disappears, or telemetry fails. Scheduled foreground tests use this
monitor too, and their coordinator receives a 1536 MiB V8 heap ceiling. Interruption retains
the pending request and produces no reusable pass. Timeout and termination reap the child process
group before releasing admission. This is sampled protection, not an OS-enforced RSS limit:
allocations can overshoot between samples, descendants that escape the process group are not
contained, and unsupported `ps` telemetry interrupts the run. Public `verify` and `tests`
CLI entry points additionally run under a separate supervising process, so a busy CLI event
loop does not prevent sampling. The child retains its normal project/host admission and
consumes the private parent marker before dispatch and evidence capture. These heavy CLI
commands wait within their command deadline, for at most ten minutes of admission, for a
heavy budget; they do not silently substitute a 1 GiB light budget. Admission and execution
share the deadline. Interrupted or unavailable runs exit 75 without a verdict.
These controls do not change the daemon's limits below or govern commands
launched independently by the user. `INTERLINKED_DISABLE_SESSION_END_JOBS=1` still opts out.

Indexed coverage checks and warm runs install a scoped cancellation owner through
discovery, capture and promotion. SIGINT/SIGTERM abort their children and prevent a
passing result from incomplete evidence. Lightweight status/help commands retain their
normal execution. The repository's optional post-push index comparison is default-off;
enable it explicitly with `INTERLINKED_PRE_PUSH_COVERAGE_COMPARE=1` when collecting
comparison evidence. See **interlinked-quality-gates** for its cost and limitations.

In this repository, pre-push heavy commands also use the host lane through
`scripts/run-resource-bounded.ts`. The supervisor retains ownership through child cleanup,
and heavy commands wait at most ten minutes for admission so an existing five-minute
daemon push check can finish first. Light diagnostics retain a five-second admission wait.
The supervisor
streams output, gives a heavy command's Node heap 80% of the admitted tree budget
(3276 MiB at the 4 GiB ceiling; light commands 512 MiB), and limits common native thread
pools. The heap share accommodates the repository's stable TypeScript compiler (about
2.9 GB of heap, measured 2026-10-02, past the former fixed 2560 MiB); the 4 GiB aggregate
tree ceiling remains enforced independently by the resident-memory watcher.
Resource interruptions exit 75 and block the push. For small diagnostic/test batches,
`node --max-old-space-size=128 --import tsx scripts/run-resource-bounded.ts --light <command> [args...]`
uses a stricter 1 GiB tree ceiling, a 512 MiB Node heap ceiling, and 2 GiB of host headroom.
It cannot run an oversized check successfully: the same monitor interrupts it. Pre-push
keeps the heavy profile and its full exact-revision test/coverage contract.

The default daemon V8 heap cap is 1536MB and the hard RSS recycle ceiling is 2048MB.
Repeated Gitleaks recovery scans are bounded to two Go execution threads (or one
when `GOMAXPROCS=1`). Interrupted scans remain NOT CHECKED and are not retried for
each receipt batch within the same daemon-owned recovery job. The idle drain does
not relaunch an unchanged completed plan, even after restart. Inspect
`interlinked harness coverage status --progress --json`; after resolving a tool or
capacity failure, explicitly retry with `interlinked harness coverage verify --json`.
New observed file versions can trigger another automatic plan. No pending evidence
is discarded by these limits.

`INTERLINKED_HARNESS_HEAP_MB` is accepted only when it is finite and at least 1; fractional
values are floored, and every invalid value falls back to 1536. The CLI, hook self-heal path,
and generated runtimes use that same parser. At the RSS
ceiling the daemon does **not** spawn a successor beside its already-bloated heap and does not
keep serving indefinitely. It first holds the project startup mutex under its own PID, then
shuts down gracefully. Cold hooks continue their bounded deterministic guards, see the live
owner during the short teardown, and do not spawn an overlapping daemon; after the old PID
exits, dead-owner reclamation opens the same single-flight self-heal path. A valid
`interlinked disable --reason …` stand-down marker suppresses that recovery entirely.

The dominant measured spike was an append-only activity log that had grown past 1GiB and was
being read into one JS string on daemon sequence checks. Live activity, daemon-ledger, and
timeline-dedup readers now read byte-bounded tails directly. Explicit history/backfill commands
may still scan complete logs; they are operator work, not the per-hook daemon path.

Idle and heap-pressure shrink now drops every reconstructible PostTool cache together: mutation
manifests, per-file external-check diagnostics, the TypeScript overlay service, and the trigram
index's dirty layer. This bounds retained state from long multi-file/parallel-agent sessions;
the next request rebuilds only what it needs.

### A missing or broken hook binary degrades reads and fails closed on writes (2026-08-31)

The installed hook command accepts its baked binary only when it is a regular, non-empty file.
When it is gone, empty, or fails to return an intentional allow/block status (unbuilt clone,
moved checkout, interrupted build, corrupt JavaScript), its self-contained wrapper still parses
the provider's native tool identity. Claude/Codex reserved read builtins and Cursor's dedicated
`beforeReadFile` event proceed with exit 0 and a degraded warning. Ambiguous generic names on
Copilot, Gemini, Cursor `preToolUse`, and MCP/custom events do not earn that exception. Mutating
tools and unknown future tool names receive the provider's native deny response (not a fictional
uniform exit-code contract), with the repair instruction on stderr. A shell command is never
inferred read-only from command text, even when it looks like `cat` or `git status`; only the exact
operator commands below escape. Claude's native
`WorktreeCreate` also stays fail-closed. Non-gating events normalize runtime failures to exit 1
(a logged failure that does not claim a block).

The standalone generated runtime has the same terminal boundary for the supported pair. Once a
parseable Claude/Codex `PreToolUse` or `PermissionRequest` payload identifies the native event, an
unexpected top-level exception emits that event's exact deny envelope; a non-gating exception
emits no stdout and exits 1. Provider stdout is staged until the surrounding audit work succeeds,
so a late exception discards the staged object before the terminal response and can never produce
partial or duplicate JSON. The installed foreground wrapper remains the outer fail-closed boundary
for experimental providers. Empty or malformed stdin cannot identify a native event and is treated
as an invalid hook invocation rather than guessed into a provider decision.

The foreground fail-closed wrapper keeps exact operator recovery commands executable before it
invokes even a present runtime: bounded `harness start` / `restart`, `harness status [--json]`,
read-only `doctor [--json]`, non-destructive `disable`, and
`interlinked install-hooks --refresh --preserve-mode`. Exact `node dist/index.js` and
`npx tsx src/index.ts` forms are recognized too; an arbitrary absolute `*/dist/index.js` is not.
The two source-build spellings (`npm run build` and `node scripts/build-atomic-cli.mjs`) are a
checkout-local exception only: the current directory must be the same checkout that owns the
baked `dist/hook-entry.js` path, its package must be named `interlinked-cli`, and it must carry
the canonical build declaration and script file. An application repo does not bypass its
installed hook merely because it happens to use either build spelling. This prevents a missing or stale runtime
from locking out its own diagnosis and repair. It is deliberately not a general shell allowlist:
prefixes, suffixes, extra flags outside the bounded command grammar, pipes, and compound commands
still run the normal hook and remain blocked. A matching string in a non-shell payload also runs
the normal hook; warn-open events never get this escape. If neither the installed command nor a
built checkout is available, reinstall or rebuild first, then run the preserve-mode refresh.

Claude `PreToolUse` and `PermissionRequest` are supported. On PermissionRequest, Interlinked
emits deterministic denies with Claude's dedicated
`hookSpecificOutput.decision = { behavior: "deny", message }` object; that is distinct from
PreToolUse's `permissionDecision`. Allow/ask abstain on stdout so Claude's configured policy and
native user prompt retain authority. Non-blocking PermissionRequest diagnostics stay on stderr
because that event does not accept generic `additionalContext`. Codex follows the same
abstain-on-allow/ask rule through its provider-specific PermissionRequest response path.

Codex `additionalContextLimit` applies only to `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, and `SubagentStart`. Permission decisions, Stop/SubagentStop
continuation reasons and compaction diagnostics use separate output channels. Installing
limits on those events causes Codex configuration warnings. Both install paths omit them;
reinstalling also removes obsolete limits from Interlinked-owned handlers while preserving
foreign hooks. Use the manifest-scoped refresh below for an existing adapter install.
Changed project hook definitions may need renewed review in Codex `/hooks`.
Stop/SubagentStop continuation is emitted only for an explicit harness `block`.
Allowed or approval-requested diagnostics stay on exit-0 stderr without restarting
the agent; Stop has no approval channel. Updating this translation requires the
compiled hook runtime to be rebuilt or upgraded, not a hook-matcher change.

Claude's installed `WorktreeCreate` hook is a deliberate hard stop: that native event replaces
Claude's default Git behavior, and Interlinked fails it without returning a path. Across every
client, the shared shell guard also blocks `git worktree add`; `list`, `remove`, and `prune`
remain available. Interlinked uses a ban rather than a race-prone concurrent-count cap.

Stale installed hooks (the pre-2026-08-28 SILENT fallback, a deregistered event entry, an old
binary path) are repaired with `interlinked install-hooks --refresh --preserve-mode` — the
hooks-only path (added 2026-08-29, hardened 2026-08-30). It re-renders ONLY the
Interlinked-owned entries already in `installer-manifest.json` at their recorded scopes. A
Codex install made before the 12-event `Interrupt` catalog also needs this refresh, followed by
review in Codex `/hooks`: adding the event changes the definition hash and therefore trust state.
A corrupt manifest refuses with the bytes preserved (strict per-row validation). Restore a
trusted backup or repair it to the valid schema; do not delete it and then run refresh, because
the missing ownership record also refuses and cannot identify which hooks are Interlinked-owned. Every file the
run can touch — project AND $HOME-scope settings, Codex's config.toml, the manifest — is
snapshotted (bytes + file mode) first; any install failure, any skipped target, or any failed
final-state verification restores the whole snapshot and fails. That rollback covers HANDLED
failures only — an OS crash mid-write cannot run the in-memory restore. Verification is
STRUCTURAL (shared with the doctor `install drift` check): each expected hook entry exactly
once at its native JSON path, any Interlinked-owned command outside the adapter's current
render fails (the canonical ownership recognizer, so old binaries and legacy `.mjs` installs
are caught whatever their quoting), and Codex's `[features] hooks = true` via the table-aware
reader — duplicate `[features]` tables or duplicate assignments fail. The manifest itself is
strictly validated: unknown runners, invalid scopes, prototype-chain path segments, duplicate
runner rows, and any settings path that does not match the adapter's own derivation all read
as CORRUPT, and install/uninstall/refresh refuse rather than overwrite the evidence.
Uninstall removes hooks by owned-entry recognition, never by stored array index — a user hook
added after install is safe wherever it sits. Ownership is shell-position parsed. An adapter
entry needs the exact `hook-entry.js` / `interlinked-hook` basename, a registered `--runner`,
and a present `--event`; legacy `.mjs` ownership needs the reserved
`.interlinked/hooks/interlinked-activity.mjs` path or its exact generated assignment form. A
command that only prints, comments on, looks like, or invokes a user script with the same basename
without those required shapes is not claimed. Project attribution reads the invoked script path, not
text elsewhere in the command. It NEVER writes enforcement mode, cloud
config, or guard rules. Do NOT repair with a plain `interlinked enable` or a plain
`install-hooks` — both also select and write an enforcement mode (the `--mode` default is
"balanced"). `--dry-run` previews; a second run reports `unchanged`.

A normal install replaces ownership only after the adapter finishes its semantic post-install
step. A selected runner that is skipped (for example, malformed project settings) cannot purge a
working hook at another scope. If a replacement's post-install step fails, its attempted settings
file is restored and the prior one-row manifest entry remains authoritative; a first-time failure
has no prior state to restore, so its partial hook and failed manifest row remain together for
`uninstall-hooks` to remove. In either case the command reports failure rather than claiming the
runner is ready.
