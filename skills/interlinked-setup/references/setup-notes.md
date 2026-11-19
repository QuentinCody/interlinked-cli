# interlinked-setup: setup notes

Reference for [SKILL.md](../SKILL.md). Read it for hook project discovery, skill refresh, provider qualification or frozen policy.

Hook project discovery walks up from the tool call's cwd to a configured ancestor:
`.interlinked/config.json`, `guard-rules.json`, `harness.pid`, or a socket marks a
project. A descendant directory containing only hook receipts or prediction state
does not shadow that ancestor. An explicitly marked nested project retains its own
identity. If no configured ancestor exists within the bounded walk, the nearest
`.interlinked/` remains the fallback; directory presence alone does not prove a live daemon.

The local guard-prediction oracle defaults to `shadow`, independently of the
optional Supermodel graph protocol. Shared `.interlinked/config.json` accepts
`harness.guard_prediction.mode: "enforced" | "shadow" | "off"`. Use
**interlinked-harness** for exact prediction/reconciliation receipts and limitations.
Receipts are required only in explicit enforced mode. Edit-time function token,
cyclomatic and cognitive cap crossings are advisory by default; shared
`harness.edit_metrics.mode: "enforced"` restores refusal, while `"advisory"`
states the default explicitly. Cap values and protected baselines do not change.
Native cold fallback can run this AST oracle; standalone generated hooks need the
daemon and report NOT CHECKED without it. Physical file size is advisory in both
warm and cold paths; rebuilding must not revive the old line-count block.

Claude compiler batching activates only after a session sends native `PostToolBatch`.
After daemon restart, edits use the ordinary compiler path until that boundary is
observed again; previously queued work remains durable and is checked at Stop/commit.
Keep the installed PostToolBatch hook current. It delivers repair context rather than
cancelling the agent loop for ordinary compiler findings. See **interlinked-verify**.

Skill refresh preserves modified installed copies. If they still describe sub-cap
complexity slew blocks, compare them with canonical `skills/*/SKILL.md`, retain local
customizations/backups, and reconcile deliberately. Restarting a daemon cannot erase
guidance already loaded into a model's conversation.

Non-gating native hook commands use a compact missing-runtime diagnostic and exit 1;
gating hooks retain the self-contained fail-closed fallback and exact repair allowlist.
After rebuilding, use `interlinked install-hooks --refresh --preserve-mode` to refresh
installed command text, then verify `interlinked harness status --json` shows the serving
build. Keep PostToolUse scoped to mutating tools; do not add PostToolUseFailure duplicates.

Provider qualification must exercise native edit routes, advisory file-size delivery,
and completion after ordinary Stop advisories. Claude and Codex keep those advisories on
stderr; explicit repair blocks still request continuation. Codex rewrites include
`permissionDecision: allow`. Retain registrations and native transcripts: an encoded
response alone does not prove native enforcement.

Before behavioral qualification, use `interlinked tests readiness <language> --json`, then
run a real project suite. Python readiness probes the selected environment for pytest,
pytest-cov and coverage; it does not install or infer passing tests. The hook installer also
ignores the named generated payload-key, enforcement-status and coverage-runtime-estimate
outputs. These ignore entries never exempt policy files or make runtime-input caching sound.

For an externally frozen policy, keep the policy files on read-only supervisor mounts and
pin their parent directories as mount points; a read-only file under a replaceable parent is
insufficient. Keep daemon sockets, atomic receipt writes, proposals and intended ratchet state
writable. Qualify CLI mutations, direct replacement, local overrides and daemon restart under
the actual non-root agent identity before claiming immutable effective policy. A same-UID
daemon and `--by` labels do not provide an authorization boundary.
