# interlinked-verify: Claude compiler batches

Reference for [SKILL.md](../SKILL.md). Read it when Claude defers TypeScript checks to a `PostToolBatch` boundary.

## Claude compiler batches

After a Claude session has delivered a native `PostToolBatch`, declared single-file
edits queue TypeScript checking until that boundary. Related edits in the same model
message are checked against the completed tree, once per project. Existing atomic
multi-file calls retain their shared check path. Other clients, unknown writers, and
Claude sessions that have not demonstrated the boundary keep per-edit checking.
Security, content guards and lint still apply per edit. Function-token and
complexity caps advise by default; `harness.edit_metrics.mode: "enforced"`
opts into their existing hard edit gate without changing limits or baselines.

Deep-audit findings follow `DEFAULT_ADVISORY_SKIPS` in ordinary hook feedback as
well as default verify. Run `verify --all-checks` for the full review; raw findings
remain in `check-results.jsonl`. Repeated warnings never gain severity or confidence
from repetition. Project-wide Gitleaks runs in explicit verify/background recovery,
not the interactive ChangeSet batch. Inline secret checks remain active. A deferred
Gitleaks scan is NOT CHECKED, never a passing security verdict.

Gitleaks subprocesses use at most two Go execution threads (`GOMAXPROCS`); an
existing value of `1` is preserved. Interrupted or truncated asynchronous scans
produce unavailable evidence. Recovery retains a failed scan per project for the
rest of that job in the current daemon, instead of repeating it for every receipt
batch. Successful scans are not cached across different inputs. A fresh explicit
recovery job or daemon replacement permits another attempt.

The idle drain does not restart a completed recovery plan while all pending
versions were already in that plan, including after daemon restart. New observed
versions permit automatic recovery again. After repairing a tool or capacity issue,
run `interlinked harness coverage verify --json` to retry unchanged pending work.
Pending evidence is retained; stopping automatic repetition does not certify it.

Final compiler errors arrive as batch context so Claude can repair them; a native batch
`block` would cancel its loop. Unresolved errors and unavailable compiler work remain
in `.interlinked/compiler-batches/` and are checked before Stop and commit, including
after daemon restart. An unresolved error blocks Stop and commit. Compiler work that
could not run (an operational deferral: project check capacity is held by another
session or by a running `interlinked verify`) with no known error blocks a commit but
not Stop. No edit resolves a deferral, so Stop reports NOT CHECKED, the batch stays
queued, and the next tool batch checks it. A tool batch states a deferral one time and
repeats it only when the set of pending files changes or after a check ran; the record
of each deferred run stays in `check-results.jsonl`. Do not delete this state to bypass verification. A queued edit
has no TypeScript verdict and must not be described as fully checked. Explicit verify
and commit checks remain necessary for the required repository validation scope.

The opt-in TypeScript scheduler (`quality_checks.typescript.scheduler`, OFF by
default, local tier only) can defer the synchronous tsc run for an edit that a
logistic predicts clean. The edit prints `[interlinked:typescript] deferred by
scheduler (p=0.xx)` and gets no TypeScript verdict. The deferred files are
checked together at the next edit that the scheduler runs and always at Stop. If
you must claim a clean tree, run `interlinked verify` or tsc yourself. The weights
were fitted on interlinked-cli only (holdout AUROC 0.805; AUROC 0.510 on a second
repository). Every decision is in `check-results.jsonl`; to list the deferred
runs, use `interlinked query checks --where scheduler.deferred=true`.

Scheduler obligations are scoped to the session and child actor. Stop, SubagentStop,
SessionEnd and commit drain that actor's pending work, even after the option is disabled.
Compiler errors remain pending across retries and daemon replacement until a later check
resolves them; diff filtering cannot demote an outstanding error into a pass. Work arriving
during a drain stays pending. An inapplicable project is reported without claiming tsc ran.
Unreadable deferred state is retained and continues to block completion. Restore that file
from a known-good backup before retrying; deleting it or renaming it is not verification.

Runner summaries from `rg -n`/`grep -n` are recognized with a single numeric line prefix.
A failure in any recognized summary takes precedence over a pass; shell success after
a pipe/trailing command alone still does not prove that tests passed.
