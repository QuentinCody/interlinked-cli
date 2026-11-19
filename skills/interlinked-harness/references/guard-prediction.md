# interlinked-harness: guard prediction

Reference for [SKILL.md](../SKILL.md). Read it for guard-prediction advice, receipts or reveals, or the related advisories.

## Predict changes to guards

The prediction phase includes a local JS/TS `if`-ownership oracle, independent of
Supermodel and `graph_prediction.enabled`. Its default mode is `shadow`;
`harness.guard_prediction.mode` in shared `.interlinked/config.json` accepts
`enforced`, `shadow` (record/reveal without refusing), or `off`.

In the default shadow mode, review concise scope-change advice and relevant tests;
no declaration receipt is required. Repeated unchanged advice is deduplicated.
Only with explicit `enforced` policy, before intentionally changing which `if`
guards an existing `return` or `throw`, declare the expected ownership change.
The raw before/after AST comparison runs
before content checks; do not brace or format away an unexpected change.
Unpredicted changes block as protocol mismatches, not proven bugs. Correct the
proposal, or reconcile the exact revealed change with a rationale and behavioral
validation. A matching prediction does not prove correctness.

Receipts are JSON at `.interlinked/predictions/guards/<sha256(session)>/<id>.json`.
Fields: `version: 1`, `session`, `id`, `file` (canonical repository-relative path),
`beforeSha256`, `afterSha256`, `nonce` (nonempty declaration identifier), and
`changes`: an array of `{owner, statement, before, after}`. Statement and condition
strings use parser token spellings joined by spaces. Each guard is
`{condition, branch: "then" | "else"}`; arrays list outer to inner guards. The ID is
SHA-256 of `JSON.stringify([1, file, beforeSha256, afterSha256])`, with UTF-8 hashes
of the exact source bytes. Use the native session identity printed in a reveal.
The reveal includes the measured fields and receipt path. After a reveal, include
`reconcile: id` and a nonempty `rationale`; a late prediction alone cannot pass.
Identical retries retain their declaration; changed bytes, file or session require
a matching receipt. Never use a wildcard acknowledgment.

The append-only `predictions/guard-events.jsonl` retains `reveal`, `predicted`, and
`reconciled` evidence; acceptance never erases a surprise. Dry runs do not persist
events. Invalid or inaccessible protocol state cannot authorize a changed proposal.
This is local intent bookkeeping, not an adversarial security boundary.

The initial oracle handles unique existing statements in identifiable function
scopes, plus unchanged complete function bodies. Changed ambiguous/anonymous
scopes and changed statement text produce partial/NOT CHECKED evidence. It does not
establish loop/switch/exception dominance, semantic predicate equivalence, deleted
statements, cross-file moves, or arbitrary shell effects. Native cold fallback runs
the same oracle; a standalone generated hook without the daemon reports NOT CHECKED
because it has no AST runtime. Restore the daemon or use `interlinked-hook` for
that check. Single-line guards remain valid code; brace style is a separate policy.

Claude's demonstrated native `PostToolBatch` boundary coalesces TypeScript checks for
declared single-file edits. The final tree is checked before the next model request;
security guards remain per edit; metric caps advise unless `harness.edit_metrics.mode`
is explicitly `enforced`. Final compiler findings are
repair context, with unresolved errors enforced at Stop/commit and work that could not
be checked enforced at commit (Stop reports it NOT CHECKED). See **interlinked-verify**
for fallback and recovery behavior. Merely using multiple Edit calls is not evidence
of a retry: correlate their emission time and assistant message with hook feedback.

Repeated pre-edit content advice, test-evidence limitations, and unchanged coverage
gaps are deduplicated for model delivery. Full observations remain in local evidence.
Deep-audit style/design findings are retained in raw check evidence and available
through `verify --all-checks`; ordinary hook feedback announces this once instead
of sending every finding. Errors and blocking decisions remain visible. A persistent
warning never becomes a proven error merely because it repeats.
Changing coverage counts alone do not repeat the same instruction; a recovered gap
that recurs or a different unavailable-check reason is announced again.

Claude and Codex Stop/SubagentStop advisories remain operator diagnostics on stderr.
Only explicit blocking repair decisions request another model turn. The Stop advice to
run the full `interlinked verify` suite counts product code files only: an edit under the
repo-root `scratch/` directory does not cause it, because the suite mirrors CI and CI
does not see `scratch/`. Source guidance is
sent during editing. File-size advice and per-function gates share native edit/patch content
projection; unreadable or invalid updates stay unmeasured. Shell effects remain
post-execution evidence unless a supported pre-write path is used.

PostToolUse classifies recognized untracked Python environments, installed Node dependency
trees and named harness outputs before authored-source checks. Explicit edits, tracked files,
protected policy and unsafe/symlink paths do not receive this exemption. Security scope stays
separate; excluded files are not passes and runtime-input fingerprints are not narrowed.
The same source role separates recovery batches. Repeated unavailable-check diagnostics are
deduplicated for delivery; raw findings and unresolved evidence remain. Retry when prerequisites
change, not merely because the same diagnostic repeats. Missing evidence cannot yield “all clean.”

For edits outside the guarded repository, both command-based and named external checks
(affected tests and dependency audit) skip this repository's runner. Inline content checks
remain available. Security findings on excluded dependency files retain normal severity and
enforcement; source-quality exclusion is not a security exemption.

The built-in generic `rm` prior-inspection rule is advisory. A recent literal `Read` event
does not prove inspection of the deletion targets, and clients may expose different read tools.
Inspect the intended targets using the available tools; this heuristic does not require a
particular invocation. Deterministic destructive-command, reservation and protected-file
decisions still apply. Do not infer safe deletion merely from a recent unrelated read.

The legacy `same_command_thrice_no_observe` advisory excludes simple read commands
such as `tail`, `rg`, and `git status`: polling their output is observation. Compound
commands, shell expansion and output redirection remain eligible. The advisory reports
matching command observations in session history; hook events do not prove distinct
executions or whether the agent read the output. This exception changes no execution gates.

Guard audit records retain references for repeated warning text. Use `interlinked data search
--source warning-occurrences` to inspect full first/changed messages, hashes and occurrence
counts; `data show ID` opens their raw evidence. This bounds repetition in the activity mirror
without changing the guard decision or the warning returned by the evaluator. A later
`not-reported` observation does not prove that the underlying issue was fixed.
