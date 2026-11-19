# interlinked-harness: Bash effects and sandbox evidence

Reference for [SKILL.md](../SKILL.md). Read it for `[interlinked:effect-residue]` or `[interlinked:sandbox]` output.

## Bash effects and sandbox evidence

Do not trust a tool name as proof that no file changed. For Bash and other potentially mutating
tools, the daemon snapshots Git-visible files plus standalone ignored local files (for example
`.env`, while collapsing bulk ignored directory trees) before the call and attaches the observed
created/modified/deleted ChangeSet after it. PostToolUse file checks prefer those observed paths over
command text or runner-declared paths.

**A read-only tool contributes no observed paths.** The ChangeSet is a diff of the window the call
occupied, not a record of what the call did, so on `Read` / `Glob` / `Grep` / `WebFetch` /
`WebSearch` / `TodoRead` / `NotebookRead` / `ListFiles` every path in it was written by somebody
else — another agent on the same tree, a background test run, a watcher. Those calls are charged
nothing and run no file checks. `Bash` is NOT in that set and keeps its ChangeSet (it is the
bash-edit obligation channel), and neither is an unknown tool, so a new writer cannot open the
bypass by using an unfamiliar name. The list is one definition, at
`src/lib/hook-read-only-tools.ts`. Claude Code's PostToolUse hook is also registered only for
`Write|Edit|MultiEdit|NotebookEdit|Bash`; Codex keeps the all-tools matcher because `apply_patch`
arrives through it. Reservation handling parses every `apply_patch` section destination and move
source once; PreToolUse grants and PostToolUse idle-release scheduling consume the same ordered,
de-duplicated path list. It preflights that full list before granting, so a later blocking path
cannot strand an earlier lease when the tool never runs and therefore has no PostToolUse.

A shell call whose command line is provably read-only owns none of the changes seen while it
ran. The test is a fail-closed allowlist (`rg`, `grep`, `cat`, `head`, `ls`, `wc`, a `sed -n`
line print, `git status|log|diff|show`, and similar) with no file redirect, substitution, or
background job; any other command keeps the window rule. Those changes are shadows
(`shadow_reason: read-only-command`): they are not recorded as the call's writes, and the call
runs no per-file checks on them. A shadow of any kind gets no per-file check from that call.

A Stop-time `[interlinked:effect-residue]` warning means a
PostToolUse was missing/unreconciled; the observed files were added to the Stop rescan as
observed-only: no tool call of the session declared them, so the writer is unknown. The rescan
reports their findings on a separate `unknown writer` line (detail: `interlinked query stop-digest
--where kind=unknown-writer`), never under "file(s) you touched", and `subagent_diverged_edit`
ignores them. Do not edit a file that you did not write. A later declared write by the session
makes the path its own.
Effects reconciled by another actor are excluded (the warning reports the excluded count) — this
includes another session and a sibling subagent that shares the same Codex session id, so one
parallel actor is not charged for another's work. Actor identity is evidence-bounded: Interlinked
uses the stable subagent id when Codex supplies one and otherwise stays at root-session scope.
Persisted pre-upgrade rows with no actor field remain conservatively session-scoped; new rows
distinguish a known root from a known child across daemon restarts.
The noisy `.interlinked/` runtime tree stays collapsed, but its exact local policy/control files are
observed and cannot be silenced by `skip_paths`.

Interpret `[interlinked:sandbox]` as evidence visible to the hook:

- `attested` — the runner marked this call sandboxed;
- `configured` — restrictive client config was found, but a CLI/profile override may differ;
- `disabled` — the call/config explicitly selected unsandboxed/escalated execution; or
- `unknown` — no trustworthy evidence reached the hook.

A workspace-write sandbox limits blast radius but still writes the real project, so it is
defense-in-depth, not rollback. Do not rerun or rewrite a command to evade this warning. For changes
that require rejection before disk, use Edit/Write or gated `interlinked write`/`multi-edit`.
The transactional commands share the content gate and commit lock. They capture target state
before checking, abort on target drift, preserve modes, and refuse rollback over newer edits.
Unavailable Biome or TypeScript checks abort a transaction. Re-read and re-gate a conflicted
proposal; consult **interlinked-verify** for the command contracts and transaction limits.
The observer is bounded ordinary-process evidence: concurrent writers can cause conservative extra
attribution, and an incomplete snapshot is never proof of absence.
