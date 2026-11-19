# interlinked-harness: managed push handoff

Reference for [SKILL.md](../SKILL.md). Read it when a protected push is handed off or falls back.

For recognized protected pushes in this repository, Codex and Claude can receive a
native command replacement that makes Git's exact-revision pre-push hook the sole
owner of typecheck and test execution. The replacement pins Git/Node, verifies a
private snapshot of the recognized hook and its helper runtime, and forces Git to
use that hook. Git still supplies the actual ref updates and pushed SHAs. This is
not a cached passing verdict, and every other pre-tool guard remains active.

Recognition is intentionally narrow: a plain `git push <named-remote> <protected-ref>`
from the repository root, with supported literal output redirection. Compound
commands, environment/config overrides, unsupported clients, custom/missing/changed
hooks or unavailable snapshots retain legacy checks. A prepared command whose
snapshot or execution context changes refuses the push. Do not weaken guards or
use bypass flags to force the handoff. See `docs/verification-efficiency.md`.

Every fallback of a recognized push is typed and visible (2026-11-05). The daemon
writes a `pre-tool:managed-push` row with status `fallback` and
`reuse_denied_reason: handoff-fallback:<cause>` to the stage ledger, and the agent
sees one `[interlinked:managed_push_fallback] … (<cause>: <detail>)` warning. Causes:
`environment-override` (the detail names the variable keys, never values),
`repository-mismatch`, `hook-mismatch`, `stale-trust-map` (regenerate the map after
reviewing the change), `executable-identity`, `snapshot-failure`. A command or client
the handoff never covers (`unsupported-*`) leaves no fallback row; the legacy rows are
its record. The IDE prompt helpers `GIT_ASKPASS` and `GIT_EDITOR` are allowed at
preparation and execution (VS Code exports both in every terminal; neither selects
a repository, configuration, hook, exec path, transport or loader). Every other
`GIT_*` variable except `GIT_PAGER` still refuses the handoff. Explain a real push
from one trace with `interlinked tests trace` (see **interlinked-verify**).
For a recognized fallback on a client supporting command replacement, the response
adds only the trace environment assignment to the original push; the legacy checks
still run. If the client disconnects before receiving that response, the plain push
has a separate hook trace: do not infer a complete daemon/hook join. Unknown failures
use a bounded operation/error-code detail, never arbitrary exception or file contents.

A hook client that times out (240 s PreToolUse in the installed settings) and
cold-allows the push no longer leaves the daemon's legacy test gate holding the host
slot: both socket transports abort a request's signal when its client disconnects,
and the pre-tool git gate kills its child on it, recording `interrupted`.
Queued framed requests retain that aborted signal after disconnect as well.

Once the frozen hook is selected, it clears the launcher's command-scoped Git
configuration before verification. This keeps the forced `core.hooksPath` from
overriding nested fixture repositories; the outer push still executes its pinned
protected hook. Ordinary pushes retain their own command-scoped Git settings.

When maintaining this repository's gate or its helper runtime, regenerate the
reviewed trust map with `node scripts/generate-managed-push-manifest.mjs` and run
the same command with `--check`. A stale map disables recognition; it does not
authorize skipping the legacy checks. Native client approval policies still apply.
