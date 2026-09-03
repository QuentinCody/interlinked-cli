---
name: interlinked-setup
description: "Install, operate, and troubleshoot the Interlinked CLI harness in a repo — install/uninstall agent hooks, connect runners (Claude Code, Codex, Copilot CLI, Gemini, Cursor, OpenCode, Pi), start/stop/restart the local guard daemon, run `interlinked doctor`, switch server / sync-mode / check-policy, log in, and manage the two-tier `.interlinked/` config. Load when setting up Interlinked, when `interlinked doctor` reports problems, when the guard daemon is down or stale, when hooks are not firing, or when configuring or disabling Interlinked."
---

# interlinked-setup — install, operate & troubleshoot the harness

Interlinked is a **local, offline-first guard layer** for AI coding agents. Repository
config, logs, and daemon state live under `<repo>/.interlinked/`; installation also writes
selected providers' settings, managed bridge files, and installed skill directories at
their provider-specific project or user locations. A **local daemon** ("the harness", a
Unix-socket server) evaluates each event the installed runner exposes to its hook surface.
This skill covers turning it on, keeping the daemon healthy, configuring it, and turning it
off. The remote server is **optional** — hooks, guard, and activity capture work with zero
network.

## Load this when
- Installing Interlinked or connecting a runner (Claude Code / Codex / Copilot CLI / Gemini / Cursor / OpenCode / Pi).
- `interlinked doctor` reports failures, or hooks are not firing / not capturing events.
- The guard daemon is down, stale, a **zombie**, or hooks report degraded inline fallback.
- Changing the server URL, sync mode, or check-policy/operational tier.
- Disabling or fully removing Interlinked.

## Mental model
- **Per-`cwd`, offline-first.** Repository config and runtime state are rooted at
  `<cwd>/.interlinked/`: `config.json` is committed/shared and `config.local.json` is
  gitignored/personal. Provider hook settings, managed OpenCode/Pi bridges, statusline
  entries, and installed skill copies live in the provider's project or user directories;
  the installer manifest records the integration files it owns.
- **A daemon does the work.** `harness start` runs a background Unix-socket server. When it
  is up you get the full check set; when it is down the hook falls back to a small inline
	subset and **fails closed on the dangerous stuff** (destructive commands, agent-created
	worktrees, package installs, line-cap, merge conflicts).
- **The server is optional.** Auth / sync only matter for server-backed coordination
  (see `interlinked-coordination`). Skip it entirely for local-only use.
- **Semantic search is optional and local.** Setup never downloads model weights. The explicit
  `interlinked semantic install` command is the only model-acquisition path; see
  **interlinked-semantic-index**.

## Turning it on

| Command | What it does | When to use |
|---|---|---|
| bare `interlinked` (unconfigured repo) | **The harness-first setup wizard** (2026-08-16): six one-line decisions — runners to hook, enforcement mode (`strict` — the recommended default — /`lenient`/`balanced`), review scope (`diff`/`whole-file` → `guard-rules.json` `diff_aware.enabled`), cap overrides, brownfield `adopt`, and dead-code posture (2026-08-17: `flag` default / `delete` instructs the agent to remove flagged dead code in the same edit / `off`; writes `structural_checks` scoped to only the dead-code checks so the rest of the family stays a separate decision; the whole-repo sweep is `interlinked deadcode`) — each Enter-accepts a recommended default, shows the plan, then composes `enable` + `mode` + `caps set` + `adopt`. Local-first: never asks about a server. Non-TTY: env-driven (`INTERLINKED_MODE` / `INTERLINKED_SCOPE` / `INTERLINKED_ADOPT` / `INTERLINKED_CLIENTS`). A failed step reports and continues — every step is individually re-runnable via the owning command. Ends with a **posture receipt** (2026-08-17): one line per thing now enforced, each naming the command that changes it. | A new user's first touch; the fastest correct install. |
| `interlinked enable` | Full setup: writes `.interlinked/` config, installs per-client hooks, updates `.gitignore`, installs statusline (Claude/Copilot), installs every bundled Interlinked skill, **auto-starts the daemon**. Idempotent; re-running **clears any stand-down**. | The normal way to turn Interlinked on. |
| `interlinked setup` | Runs `enable`, then `login` if no token (skips login on localhost / when a token is present). | You also want server auth right away. |
| `interlinked init` | Interactive/auto onboarding wizard (`--yes` for non-interactive): installs hooks on its own path, logs in, attaches a workspace — and installs **no skills**. | Guided team/workspace setup only. |
| `interlinked install-hooks` | Adapter path: writes hook entries + `installer-manifest.json` and, unless `--preserve-mode`, applies the selected/default enforcement mode. `--refresh` is manifest-scoped hooks-only and implies preserve-mode; installs **no skills**. | Precise, manifest-tracked hook install or refresh. |

**A mode is a posture, not just check severities (2026-08-17).** `interlinked mode
strict|balanced|lenient` also ladders the philosophy-dependent gates into
`guard-rules.json` (merge-preserving; later hand edits win until the mode is
re-applied): the new-file TDD gate (`strict`=block, `balanced`=warn,
`lenient`=off), per-edit coverage (`strict`=no-debt blocking, `balanced`=debt
mode, `lenient`=off), and the session-end verification/commit-cadence nudges
(`lenient` turns them off). Security rails and tighten-only ratchets never
ladder. `custom` applies nothing.

**Folded into onboarding (2026-08-17), no longer separate steps:** `enable`
builds the trigram index when absent (grep acceleration works from session
one), and `adopt` step 6 snapshots existing manifests/lockfiles into the
install allowlist (`approved_by: "adopt"`) so the fail-closed install gate only
prompts on genuinely NEW packages.

> Bare **`interlinked` is the recommended human first run** because it shows the local posture
> decisions before composing them. `enable` is the canonical install primitive for automation
> or an already-chosen configuration. Prefer either over `install-hooks`: only the wizard and
> `enable` install the skills that teach an agent how to read a block. Without them the first
> block is a message the agent must guess at, and the likeliest guess is to work around the gate.

Key `enable` flags: `--server <url>` · `--agent <name>` · `--clients <list>`
(`claude,copilot,gemini,codex,cursor,opencode,pi`) · `--sync-mode <realtime|local|manual>` ·
`--data-dir <path>` · `--structure <mode>` · `--dry-run`.
`install-hooks` uses different vocabulary: `--runner <claude-code,copilot-cli,cursor,gemini-cli,codex,opencode,pi>`
· `--scope <user|project|local>` · `--mode <balanced|strict|lenient>`.
Explicit values are strict: an unknown client, sync mode, structure mode, install scope, or
enforcement mode exits nonzero before config, hook, manifest, stand-down, binary-fallback,
daemon, or login writes.
Only an omitted option receives its documented default.

```bash
interlinked enable --agent my-bot                 # detects clients, starts daemon
interlinked enable --clients claude --dry-run      # preview without writing
interlinked install-hooks --runner claude-code --scope project
```

> Client detection uses the registry's project directory/config markers and process environment,
> not a PATH probe for the binary. Codex automatically detects skill changes; if an active session
> does not, restart it. Copilot needs `/skills reload` to pick up skill changes. OpenCode/Pi native
> skill copies live under `.opencode/skills/` and `.pi/skills/`.

## Native shell sandbox posture

Enable each client's strictest usable native sandbox separately; Interlinked hook installation does
not turn the provider sandbox on. Bash PreToolUse reports `[interlinked:sandbox]` as `attested`,
`configured`, `disabled`, or `unknown`. Treat `configured` as weaker than per-call attestation because
CLI/profile overrides can change the active call. Explicit Codex escalated/`danger-full-access` calls
and Claude unsandboxed settings are reported as disabled evidence.

Native workspace-write sandboxes constrain host/network reach but still allow real writes inside the
project. They complement Interlinked's post-call filesystem ChangeSet and Stop residue backstop; they
do not provide rollback or replace the deterministic PreToolUse guards. See **interlinked-harness**
for interpreting the warning.

## Operating the daemon

| Command | Purpose |
|---|---|
| `interlinked harness start [--verbose] [--json]` | Start the daemon (background). Reaps orphans first and auto-rebuilds stale `dist/`, so a cold start can take a few seconds. Freshness recursively checks non-test product files, including edits to existing nested files. Readiness requires live connections to every required listener; a socket inode alone is not ready. |
| `interlinked harness stop` | Send SIGTERM, wait up to 3 seconds, then SIGKILL only verified surviving daemon targets; report any process that truly survives. |
| `interlinked harness restart` | Stop + fresh start; **the only way to pick up config/mode changes**. Note: clears per-session trajectory state. Defers instead of killing when a start is already in flight, and backs off with "Too many restart attempts" if too many restarts (any trigger) went unresolved recently — see below. |
| `interlinked harness status [--json]` | **Liveness** (three states, below) + socket, RSS, mode, orphan count, build staleness. `--json` adds `liveness` (is anything SERVING — raw StatusQuery or a framed `daemon.health`), `socket_answered`, and `pid_running` (alias of `running`; BOTH mean only "the legacy `harness.pid` names a live process" — a framed-only daemon can be `liveness: "listening"` while `running`/`pid_running` are false). Build staleness ignores test files (`*.test.*`, `__tests__/`) — they are not bundled into the daemon. |
| `interlinked daemons [--cleanup]` | List **all** per-session daemons; `--cleanup` purges dead-PID records. |
| `interlinked harness reap [--force] [--all]` | List (default) or kill orphan daemons. |

```bash
interlinked harness status --json      # is it up? which mode?
interlinked harness restart            # after editing config / changing mode
```

`harness restart` performs that recursive freshness check and any required
build **before** stopping the serving daemon, in normal and `--json` modes. A
failed build, or one that leaves `dist/` stale, aborts the restart and keeps the
incumbent serving; Interlinked never knowingly replaces it with stale code.

### Liveness is a round-trip, not a PID

`status` and `doctor` both send a real event and wait for the answer, because a daemon can stay
process-alive while its listener is dead. Three states, and both surfaces use the same words:

| `harness status` | `doctor` | Meaning |
|---|---|---|
| `running (PID …) — socket answering` | `pass` — `Running (PID …) -- socket answering` | Verified: something answered. |
| `ZOMBIE — process alive (PID …), no socket answering` | **`fail`** — same remedy line | Full evaluation is unavailable; deterministic inline gates remain active and ordinary work proceeds degraded. |
| `not running` | `warn` — inline fallback | Honest and expected; the inline subset still guards. |

Only an answered probe prints `running (PID …)`, so that line can no longer appear above
`Socket: not found`. **Fix a zombie with `interlinked harness restart`** — both surfaces print
that remedy inline. A pid-alive daemon gets one confirming re-probe, so a daemon still binding
right after `restart` is not mislabelled.

Every ordinary hook event may trigger bounded recovery; SessionStart is an opportunity, not a
prerequisite. The startup mutex collapses concurrent hooks to one launch. Startup and restart
wait for live connections rather than socket-file existence, and the startup lease is released
immediately after the final required listener binds or startup reaches a terminal failure. A
daemon quiescing for shutdown keeps the mutex under its own PID until it exits so a successor
cannot overlap its live heap. A dead owner is reclaimable immediately. A valid team or local guard-disable marker
suppresses auto-start; a malformed marker fails toward guarding. During the gap, safe reads,
diagnostics, and repairs proceed through the inline fallback while deterministic dangerous
operations can still be refused. Status/start/restart/doctor/disable and exact preserve-mode hook
refresh commands are excluded from auto-recovery so the hook never races the operator.

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

The default daemon V8 heap cap is 1536MB and the hard RSS recycle ceiling is 2048MB.
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

## Diagnosing problems

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

### When the daemon will not stay up

A daemon that fails **before** binding its socket exits **78** (`EX_CONFIG`) and appends an
`exit` row with `reason: "startup-failed"` to `.interlinked/daemon-events.jsonl`. It no longer
lingers as a zombie. Read that ledger before theorising — it separates a failed bind (78) from
a graceful stop, a lost ownership race (**0**, orderly, not a failure), and a crash.

```bash
tail -n 20 .interlinked/daemon-events.jsonl   # why did it leave?
interlinked harness reap                       # list orphan daemons (--force kills)
interlinked harness restart                    # the usual fix
```

Bind attempts are bounded with backoff, and a socket that **answers** is never unlinked — a
live incumbent wins and the newcomer exits instead of stomping it. Only a silent, stale socket
file is cleared and retried.

**Dev loop after editing the CLI source:** `interlinked reload` rebuilds the CLI in its own
checkout, refreshes this repo's hooks and deployed skills, and restarts the daemon **only if
something the daemon executes changed**.

The package build is runtime-preserving, not a whole-directory transaction. One repository-scoped
lease prevents concurrent compiler runs; an equivalent waiter coalesces after the owner finishes.
The owner bundles, repairs declarations, copies assets, and checks every shipped entry in a sibling
staging directory, then refuses publication if a product build input changed meanwhile. Publishing
atomically renames shared chunks/assets first and runtime entrypoints last (`hook-entry.js` last of
those and therefore the handled-failure runtime commit point). The entry phase snapshots existing
entries and rolls back anything already replaced if a later entry fails. This is not crash-atomic
across several entry renames; after process/OS loss, each old-or-new entry remains independently
runnable because both generations' hashed chunks stay present, and the next build converges the
entries. `dist/` itself is never removed, and prior
hashed chunks remain available to a running daemon's later lazy imports. A fault during shared-file
publication can therefore leave harmless new immutable files in `dist/`, but it leaves the previous
entry generation in place. Fix the reported error and retry instead of reconstructing `dist/` by
hand.

## Config & environment

- **`.interlinked/config.json`** (committed): `server_url`, `default_project`, `mode`
  (operational tier), `skip_paths`, `pii_patterns`, nested `harness` feature flags.
- **`.interlinked/config.local.json`** (gitignored): `access_token`, `agent_name`,
  `workspace_id`, `sync_mode`, `active_server` + `servers` map, `guard_mode`, `data_dir`.
- **`.interlinked/semantic.json`** (committed): optional semantic-index enablement, exact pinned
  model reference, and source/test include policy.
- **`.interlinked/semantic.local.json`** (gitignored): local-only CPU/runtime topology. Remote URLs,
  API tokens, and cloud fallbacks are rejected by the v1 schema.
- **`.interlinked/tool-commands.json`** (committed): per-tool argv overrides for build/lint/test
  runners (`go_build`, `go_test`, `golangci_lint`, …). Team tier may set `base_args` +
  `timeout_ms` only (flags for a fixed binary / a bounded cap); `command` (arbitrary executable)
  and `env` are personal-tier only — a violation is a `doctor` error.
- **`.interlinked/tool-commands.local.json`** (gitignored): trusted personal tier; may add a full
  `command` override or `env` wholesale, winning over the team entry for the same key. No shell
  interpolation — argv must be written as the executed argument list (`-tags 'dev devaccounts'` is
  one token `["-tags","dev devaccounts"]`).
- **Env overrides** (win over both files): `INTERLINKED_SERVER_URL`,
  `INTERLINKED_ACCESS_TOKEN` (alias `INTERLINKED_TOKEN`), `INTERLINKED_AGENT_NAME`,
  `INTERLINKED_WORKSPACE_ID`, `INTERLINKED_SYNC_MODE`, `INTERLINKED_HOME` (relocates the whole
  config dir), `INTERLINKED_DATA_DIR`, `INTERLINKED_CLIENTS` (non-interactive bootstrap only).

`enable`, `adopt`, `doctor`, metrics, hooks, and search do not auto-download embedding weights.
The experimental semantic commands also require compatible local `llama-embedding` and
`llama-tokenize` executables (override their command names only in `semantic.local.json`). Model
weights live in the platform user cache; project vectors live under the gitignored
`.interlinked/index/functions/` directory and are never synced.

**Two different `mode` commands — do not conflate them:**
- `interlinked mode <balanced|strict|lenient>` → per-check **policy** preset → `check-policy.json`,
  PLUS the preset's guard posture (TDD/test-first tier, per-edit coverage + debt mode,
  session-end nudges, commit cadence) into `guard-rules.json`. Since 2026-08-30 the loader
  actually honors that posture: the team tier merges the whitelisted safe fields (booleans +
  the three posture enums) and drops runtime knobs like `budget_ms`. `--local` writes BOTH
  halves to the personal tier (`check-policy.local.json` + `guard-rules.local.json`) — a
  personal mode switch never edits committed team policy. The wizard's scope
  (`diff_aware.enabled`) and dead-code writes load through the same whitelist. The mode
  switch is transactional in BOTH directions (a refused guard merge writes neither file; a
  failed check-policy write rolls the guard file back), and the three posture enums are
  value-validated at the final loader boundary for BOTH tiers — an invalid value is dropped
  (built-in default applies) and `interlinked doctor` names the file, field, and value.
- `interlinked harness mode <budget|quality|ci>` → operational **timeout tier** → `config.json`
  `mode` + regenerates the hook. Requires `harness restart` to take effect.

## Auth & server (optional)

```bash
interlinked login --server https://your-server.dev   # OAuth PKCE (opens browser)
interlinked login --token "$INTERLINKED_TOKEN"        # CI / headless
interlinked attach --agent my-bot --auto              # link identity + workspace
interlinked logout [--all]
```

- **localhost/127.0.0.1 = dev mode → auth skipped** (`setup`/`init` skip login for local servers).
- Token resolution: CLI token in `config.local.json` → auto-refresh → Claude Code
  credential fallback (`~/.claude/.credentials.json`).
- Sync modes: `realtime` (default; per-event post + session-end batch), `manual`
  (per-event only), `local` (no server posts at all).

## Turning it off

| Command | Effect |
|---|---|
| `interlinked disable [--reason <t>] [--until <dur>] [--team]` | **Non-destructive** stand-down: records a marker + stops the daemon. Hooks and config stay. Re-arm with `interlinked enable`. |
| `interlinked disable --uninstall [--keep-config]` | Destructive teardown: removes hooks + the installed skills **and deletes the `.interlinked/` config dir** — pass `--keep-config` to keep the config. |
| `interlinked reset --force` | **Nuclear**: delete the entire `.interlinked/` dir and strip hook entries. Irreversible; `--force` required. |
| `interlinked uninstall-hooks` | Remove **only** what `install-hooks` recorded in its manifest. |

> A valid stand-down marker suppresses hook self-heal. If `disable` reports the old daemon is
> still running, run `interlinked harness stop`: that already-running process may continue to
> evaluate calls until it exits, but hooks will not resurrect it afterward.

## Gotchas
- **`disable` is non-destructive by default now** — bare `disable` just stands down; use
  `--uninstall` (or `reset --force`) for real teardown.
- **`clean` defaults to dry-run**; `reset` requires `--force`.
- **Install paths have non-interchangeable uninstall semantics.** `uninstall-hooks` only cleans an
  `install-hooks`-style install; use `disable --uninstall` / `reset` to clean an `enable` install.
- **Claude Code merge-up dedup:** `enable` refuses to install Claude hooks when an ancestor
  `.claude/settings.json` already has them (would double-fire) — run `enable` from that ancestor.
- **Daemon discovery stops at a Git boundary.** A hook invoked in a linked worktree or submodule
  uses that worktree's `.interlinked/` runtime and never borrows a daemon socket from the parent
  checkout. Ordinary monorepo subdirectories still discover the nearest ancestor daemon.
- **Gemini is a compatibility lane, not the Antigravity adapter.** Consumer Gemini CLI service
  ended in June 2026, while enterprise and paid API-key Gemini CLI use remain supported. The
  current `gemini` client installs Gemini CLI hooks/skills; do not treat it as Antigravity.
- **OpenCode and Pi installs are managed source bridges.** Project scope writes
  `.opencode/plugins/interlinked.ts` or `.pi/extensions/interlinked.js` as an Interlinked-owned
  whole file; user scope uses `~/.config/opencode/plugins/interlinked.ts` and
  `~/.pi/agent/extensions/interlinked.js`. Install refuses to overwrite a foreign file at that
  path, and uninstall preserves a bridge whose bytes changed after install. A loaded bridge writes
  its provider row to `.interlinked/hook-runtime.json`, but only Codex currently has a dedicated
  doctor trust-verification row. Restart OpenCode after install (its plugin trust is implicit). In
  Pi, run `/reload` or restart and approve the project-extension trust prompt.
- **Their native parity is intentionally bounded.** OpenCode's stable tool-before hook cannot
  open confirmation, so `ask` denies; permission bus and `session.idle`/Stop are observation-only.
  Pi prompts through `ctx.ui.confirm` when interactive and denies headless; `user_bash` gates
  direct shell commands as well as model tool calls. Neither exposes dedicated native MCP,
  subagent, or worktree lifecycle hooks. The shared shell rule still blocks `git worktree add`.
- **`reload` needs a source checkout** — it rebuilds the CLI checkout the running binary
  resolves to (typically a `~/.local/bin` symlink), not the current repo.
- `--json` support is per-command; unknown flags error. `doctor` takes only `--fix`/`--json`.

## Related skills
- **interlinked-harness** — what the guard blocks and how to respond when a tool call is refused.
- **interlinked-observability** — inspect the activity the hooks capture (`status`, `activity`, `logs`).
- **interlinked-coordination** — the optional server-backed side (tasks, messages, workspaces).
- **interlinked-semantic-index** — explicitly install a model and build/query the local function index.
