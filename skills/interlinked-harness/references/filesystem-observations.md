# interlinked-harness: filesystem observations and native control limits

Reference for [SKILL.md](../SKILL.md). Read it for `[interlinked:hook-coverage]` status, recovery or policy acceptance.

### Filesystem observations and native control limits

The daemon watches protected policy files and literal in-workspace reservation
paths, then reconciles content identities periodically and at delivery boundaries.
Writes by a shell, editor or agent can create durable pending verification entries.
Writer identity is `unknown`; a reservation is not proof that its holder performed
the write. Glob reservations, symbolic links, inaccessible or oversized files
remain explicitly unmeasured. A stopped or unavailable observer cannot certify coverage.

`harness coverage status --progress --json` reads cached observation time, generation
and recovery counts without reconciling files or returning receipt history. Use it for
progress, not to certify current bytes. Plain `harness coverage status --json` still
reconciles and returns full evidence. Neither status command starts recovery.
Starting verification returns a compact job acknowledgement. The waiting CLI refreshes
current pending versions and the matching job's detailed results before declaring success,
without copying historical receipts into each recovery response. An unmeasured check is
not a successful verification, even if no findings or pending versions remain.
While waiting, transient control outages are retried read-only for up to two
minutes per outage (plus an in-flight RPC deadline), rather than failing after
three timeouts. Terminal stderr reports the outage; JSON stdout remains one final
document. A responsive report resets that outage window. Host permission denial
and invalid control responses stop immediately; verification mutations are never
automatically resubmitted after an ambiguous response.
Receipts with nonempty `unavailable` retain completed checks as partial evidence while
keeping the version pending. Retrying is not made unnecessary merely by having a receipt;
safe cross-run reuse needs the relevant check input identities.

Background coverage recovery runs ShellCheck and Taplo in file mode, sequentially
under one project lease, with at most 32 inputs and a 30-second shared deadline
per tool. Interactive multi-file requests still defer these file-only runners.
Missing tools, truncated output, process failures and unparsed nonzero exits
remain unavailable evidence; they cannot clear a pending version. Recovery may
finish with pending versions when native test scopes or tools are missing, or
when an observed file was deleted. Inspect the retained reasons before retrying;
a completed job is not a claim that every version was checked.
If a nested project's imported lint policy belongs to an ancestor project,
background recovery waits for that policy project's lease within the existing
tool deadline. Foreground checks still report contention immediately. Time spent
waiting reduces the analyzer's remaining budget; it does not extend the job.

`harness coverage accept-policy <digest>` records an explicitly reviewed current
policy identity. It neither runs checks nor restores old policy bytes. A later
Claude ConfigChange can refuse application of a differing identity, after the disk
write has happened. This is not an immutable trust anchor or a universal policy
reload interlock. Do not describe watcher readiness as baseline-integrity enforcement.

Native translations are recorded in `.interlinked/hook-translations.jsonl` by the
compiled entry point. A post-tool refusal may become context, continuation or batch
cancellation; observational events cannot enforce a denial. Copilot/Gemini approval
requests conservatively deny where native approval is not certified. Experimental
Antigravity uses `force_ask`; Antigravity and Windsurf refuse a required input rewrite
that their hook cannot apply. Read translation status separately from native enforcement.
Harness-disable trajectory detection reads executable command positions, so a mutation-test
filename containing `kill` is not a process-kill event. Failed commands do not establish a
successful disable. A later event served by the daemon retires process/socket-outage suspicion;
it does not retire a recorded weakening of `disabled_rules`. Shadow verdicts remain advisory
and do not include a misleading `BLOCKED:` prefix.

The optional-chain check uses syntax grouping: passing `value?.field` to a function and then
accessing that function's result is different from `(value?.field).name`. Without optional
TypeScript syntax support it cannot establish this finding; silence is not a clean verdict.
SQL migration checks likewise cannot prove a column absent from an interpolated column list.
For `it.each(table)(name, callback)`, assertion checks inspect the callback, not functions
inside the data table. An unparsed callback cannot prove assertion absence; table assertions
also cannot satisfy an assertion-free callback. A call to a same-file helper that asserts
(directly or through another such helper), or to an `assertX(...)` function, counts as an assertion.
