# interlinked-harness: guard notes

Reference for [SKILL.md](../SKILL.md). Read it for commit-time function-token diagnostics, the restricted runtime policy, remote-pipe detection or decision-metrics advice.

## Commit-time diagnostics, runtime policy and remote pipes

Commit-time function-token diagnostics compare against `HEAD` and name their scope:
staged index, tracked working tree, selected constructed paths, or a conservative
worktree scan. They do not identify the writer or when the changes were made.
Only the first eight findings are displayed; the full set still determines the block.
For unresolved compound staging scope, stage first and commit in a separate tool call
to check the exact index. This changes the observed scope, not the cap or enforcement.

`INTERLINKED_RUNTIME_POLICY=local-restricted` opts into a packaged local runtime
policy shared by the CLI, daemon and generated cold fallback. It denies network
calls and selected external commands, and refuses recognized agent reads of
`.interlinked/config.local.json`; internal configuration readers still work.
It is application policy, not a sandbox for arbitrary child code or computed paths.
Unavailable tools remain unmeasured; this mode does not certify skipped checks.

Remote-pipe detection permits interpreter inline programs preceded by bare flags
(for example, `curl URL | python3 -I -c '...'`), where stdin is data. Shell sinks
retain their existing remote-execution block.

## Decision-metrics advice

`[interlinked:decision-metrics]` is opt-in PostToolUse semantic advice. It can report
an adverse judgment, uncertainty, failure or missing evidence, but it never sets a
pre-execution block or authorizes an action. Both flags in
`.interlinked/decision-metrics.json` default off. The short inference deadline can
be followed by up to five seconds of local-model unload verification. Load
**interlinked-quality-gates** for configuration, replay and calibration; do not
weaken deterministic policy to satisfy a model's judgment.
