# interlinked-setup: hook capability inventory and experimental clients

Reference for [SKILL.md](../SKILL.md). Read it for `interlinked harness capabilities --json` or an experimental client.

### Hook capability inventory and experimental clients

`interlinked harness capabilities --json` includes the sourced ecosystem catalog,
adapter event/control declarations, installer manifest, last provider emission and
filesystem coverage state. `selected` describes the adapter's subscription policy;
inspect the manifest to establish installation. An emitted response or matching
definition hash does not certify that the provider enforced it. Native enforcement
remains `unmeasured` until a provider/version/mode conformance run establishes it.

Factory Droid (`factory-droid`), Windsurf (`windsurf`), Google Antigravity
(`antigravity`) and Crush (`crush`) are explicit experimental adapters through
`interlinked install-hooks --runner <id>`. They require a built hook-entry runtime.
They are separate from the seven `enable --clients` integrations and do not expand
skill installation targets. Their command wrappers currently target POSIX shells;
Windows shell behavior and native headless behavior are not certified. Antigravity
uses `.agents/hooks.json`, separate from Gemini CLI's `.gemini/settings.json`.

Claude FileChanged installs without a static matcher. SessionStart, CwdChanged and
FileChanged responses publish the complete current `watchPaths` list. FileChanged
is an observation after a write; it cannot deny or undo that write. PostToolBatch
can cancel the loop before the next model request. Codex does not acquire either
native event merely because it uses Claude-shaped payloads; daemon filesystem
observation supplies a separate local fallback. Expanded boundary handling requires
the compiled runtime. The adapter installer refuses a generated compatibility script
instead of registering events that it cannot serve. Build the checkout and refresh
hooks; previously installed legacy scripts retain their older compatibility behavior.

The public `interlinked-cli/hook-bridge` export provides an application-owned Think
tool bridge and a Durable Object storage journal adapter. It is not installed with
coding-client command hooks. See the repository's `docs/hook-normalization.md` for
its admission, replay and deployment contract.

`interlinked doctor` is the first stop. It runs local + system + server checks and **exits
non-zero if any check fails**. `--fix` repairs common drift (regenerates a drifted hook
script, safely refreshes Interlinked-owned skill copies, strips malformed permission rules,
migrates legacy config).

```bash
interlinked doctor            # diagnose
interlinked doctor --fix      # auto-repair what it safely can
interlinked context --json    # show the effective merged config
interlinked env               # list supported env vars + current values
```

**What doctor's client rows do and do not prove (2026-08-30).** Doctor checks the hook-config
location for **every** client in the settings registry — Claude Code, Codex, Copilot, Gemini,
Cursor, OpenCode, and Pi — reading each path from that one registry instead of restating it (the hardcoded copy it
replaced pointed Codex at `.codex/config.toml`, which holds only the feature flag, so doctor
warned that every CORRECT Codex install was missing its hooks). Consequences worth knowing:

- **Codex gets three rows, deliberately.** The hooks row reads `.codex/hooks.json`; a second row
  reads the `[features] hooks = true` gate in `config.toml`, **table-aware** — a `hooks = true`
  under some other table does not count. Installed hooks with the flag off are reported as
  INERT, not missing, because those are different repairs. The third row checks
  `.interlinked/hook-runtime.json`: it passes only after Codex executes the current
  `hooks.json` definition hash. If it warns, open `/hooks`, review the definition, and run a
  hooked action.
- **The flag writer canonicalizes to a single `hooks` key.** Whatever mix of `hooks` /
  `codex_hooks`, true / false, duplicated or commented, `[features]` already holds, the writer
  leaves a single `hooks = true` — comments, unrelated tables and the file's line endings intact.
  Duplicate TOML keys are a parse error, so the old "add a canonical key beside what we found"
  behavior could report a successful migration for a config Codex then refused.
- **A failed post-install now fails the install.** Codex is the one runner whose hooks.json is
  inert without a second write, so when that write throws, `install-hooks` reports `ok: false`,
  lists the runner under `post_install_failures`, marks the manifest entry `post_install:
  "failed"`, exits non-zero, and `enable` reports the client as not installed. It used to log one
  stderr line and report success.
- **A passing hooks row means the config is present, not that execution is verified.** The
  Codex execution row is the stronger live proof for the current definition. Codex installs all
  twelve native events from the shared capability catalog. Copilot and Gemini adapter
  normalization and the Cursor duplicate-invocation question are open work; treat those three
  runners as unproven. OpenCode/Pi have managed-bridge execution tests, but their narrower native
  APIs still make them experimental rather than Claude/Codex-equivalent.

Likewise `enable --dry-run`'s per-client **event counts are computed from the adapter that
performs the install** (they were prose literals that had drifted, so the preview promised
numbers the install did not deliver). They count REGISTRATIONS, not verified provider
capabilities.

What "healthy" looks like in `doctor`: config dir + both config files present, hook script
present, per-client "Hooks installed", and **Harness server: Running (PID …) -- socket
answering**. A zombie is a **`fail`** here, never a pass. Hook detection shares one ownership
predicate with the installers, so an adapter (`hook-entry.js`) install is recognised as
installed rather than reported missing. A manifest-tracked hook binary that no longer exists is
a **`fail`**, even when the settings document still has the expected entries. A missing token on a non-localhost server is a `fail`;
on localhost it is only a `warn` (dev mode allows unauthenticated).
