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

`interlinked enable` adds named daemon telemetry, capture state and test-run outputs to
`.gitignore`. Re-running setup updates older installations whose generated ignore list is
incomplete; otherwise harness bookkeeping can appear as new workspace edits and schedule
unnecessary checks. This does not ignore the entire `.interlinked` tree or change runtime-input
validation: shared policy/ratchet files remain observable, and deliberately tracked output
still participates in Git-visible change capture. Do not untrack files automatically.

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
- Classifier API-key lookup accepts nonempty strings from the configured environment variable
  first, then the exact or lowercase key in `config.local.json`. Malformed JSON roots and
  non-string local values do not become credentials.
- **Semantic search is optional and local.** Setup never downloads model weights. The explicit
  `interlinked semantic install` command is the only model-acquisition path; see
  **interlinked-semantic-index**.

## Turning it on

Cowork has a separate plugin workflow: `interlinked cowork package --output <directory>`.
Load **interlinked-cowork** for upload, native conformance, runtime failures and the
optional authenticated host bridge. It is not an `enable --clients` coding-client
target; editing Claude Code settings does not install the Cowork plugin.

`interlinked doctor` also inventories existing lint configuration and offers
`interlinked lint import`. Preview is read-only; `lint import --write` enables
the registered PostToolUse wrapper, and adding `--baseline` executes installed
linters to adopt existing debt. A local `lint_import.enabled:false` override
is reported before import writes. Hooks must already be enabled. Follow
**interlinked-verify** for supported adapters, unresolved configurations, and
the explicit `lint check` gate; the ordinary `adopt` command remains separate.

Oxlint and named ESLint configs are detected automatically; `lint import` previews
their scopes and hook/audit cadence. For arbitrary filenames, use repeatable
`--config tool=file` (or `--eslint-config file`), then `--write --baseline`.
Selectors are relative to
the target project; `--eslint-scope` optionally chooses a package working scope.
Saved profiles survive re-import without repeating these flags.

Script aliases, task/CI evidence and local config/plugin imports extend discovery.
Use `.interlinked/lint-adapters.json` for reviewed direct SARIF analyzers; follow
**interlinked-verify** for that contract. YAML task parsing requires the optional
`yaml` package; without it the evidence remains in the review list. Dependency
approval follows **interlinked-supply-chain**. Slow/type/CI profiles initially use
audit cadence; `lint check` or `verify --all-checks` includes them.


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

**Trigram indexing is opt-in:** `enable` installs hooks and starts the daemon
without building the repository's search index. Run `interlinked index build`
to enable grep acceleration. Its `--max-file-size` accepts a nonnegative safe
integer and `--stop-threshold` accepts a finite ratio between zero and one.
Explicit malformed numeric values fail before indexing. An existing index
continues to load normally.
Keeping the repository scan out of onboarding allows setup to finish on large
repositories without exhausting the CLI's heap. `adopt` still builds the index
and snapshots existing manifests/lockfiles into the install allowlist
(`approved_by: "adopt"`).

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

`init --dry-run` previews hooks and config without installing, logging in, onboarding,
or starting the daemon. `init --sync-mode` accepts exactly `realtime`, `local`, or
`manual`, including during preview. An explicit empty value is invalid.

```bash
interlinked enable --agent my-bot                 # detects clients, starts daemon
interlinked enable --clients claude --dry-run      # preview without writing
interlinked install-hooks --runner claude-code --scope project
```

> Client detection uses the registry's project directory/config markers and process environment,
> not a PATH probe for the binary. Codex automatically detects skill changes; if an active session
> does not, restart it. Copilot needs `/skills reload` to pick up skill changes. OpenCode/Pi native
> skill copies live under `.opencode/skills/` and `.pi/skills/`.

## Operating the daemon

`interlinked harness capabilities --json` reports runtime hook profiles, installation
and emission evidence, and filesystem coverage. `harness coverage status --json` shows
pending identities, manual reviews, automated check receipts, and any recovery job.
Coverage control calls allow ten seconds per transport. Verification start and final-job
responses omit retained receipt history; explicit full status still includes it.
Coverage persistence also batches filesystem observations and recovery receipts, retaining
history without copying it for each changed file. Repeated `rss-ceiling` exits during
recovery require fixing/updating the daemon, not repeatedly starting the same verification:
the memory ceiling remains enforced. Verification jobs now persist their plan, progress
and original deadline with batch receipts. A successor resumes an interrupted job under
the same ID, including after an explicit restart; expired jobs report incomplete evidence.
Completed results remain available after restart. Jobs started by older, memory-only
daemons need one new verification after upgrade; their existing receipts are preserved.
Inspect the recent daemon lifecycle log for the exit cause before treating a missing job
as a new session-policy block.
A timeout still means no verdict; inspect status before retrying a mutation,
since the daemon may have completed it before the response was lost.
`EPERM` / `EACCES` on a daemon socket is a host permission failure, not evidence that the
daemon or session policy needs resetting. Use a host-permitted terminal/session; changing
Interlinked rules cannot grant socket or `.git` access denied by the native sandbox.
For `[interlinked:hook-coverage] NOT CHECKED`, run `harness coverage verify --json` and
follow **interlinked-verify** for evidence scope, deferred checks and reviewed absences.
If a running daemon predates the verifier, rebuild/restart using the normal lifecycle.
Observing or checking protected files does not accept their policy digest.

Local data maintenance has its own `data.config.json` in the resolved data directory.
`interlinked data configure --auto-index on` enables bounded SessionEnd index jobs;
`--auto-compact on` also enables lossless collection/timeline rotation. Both default off.
These settings are reread per maintenance job and do not alter capture, sync, or guard policy.
Use `data health`/`data status` for producer coverage and index freshness; load
**interlinked-observability** for budgets, search, archive behavior and audit checkpoints.

| Command | Purpose |
|---|---|
| `interlinked harness start [--verbose] [--json]` | Start the daemon (background). Reaps orphans first and auto-rebuilds stale `dist/`, so a cold start can take a few seconds. Freshness recursively checks non-test product files, including edits to existing nested files. Readiness requires live connections to every required listener; a socket inode alone is not ready. |
| `interlinked harness stop` | Send SIGTERM, wait up to 3 seconds, then SIGKILL only verified surviving daemon targets; report any process that truly survives. |
| `interlinked harness restart` | Stop + fresh start; **the only way to pick up config/mode changes**. Note: clears per-session trajectory state. Defers instead of killing when a start is already in flight, and backs off with "Too many restart attempts" if too many restarts (any trigger) went unresolved recently — see below. |
| `interlinked harness status [--json]` | **Liveness** (three states, below) + socket, RSS, mode, orphan count, build staleness. `--json` adds `liveness` (is anything SERVING — raw StatusQuery or a framed `daemon.health`), `socket_answered`, and `pid_running` (alias of `running`; BOTH mean only "the legacy `harness.pid` names a live process" — a framed-only daemon can be `liveness: "listening"` while `running`/`pid_running` are false). Build staleness ignores test files (`*.test.*`, `__tests__/`) — they are not bundled into the daemon. |
| `interlinked daemons [--cleanup]` | List **all** per-session daemons; `--cleanup` purges dead-PID records. |
| `interlinked harness reap [--force] [--all]` | List (default) or kill orphan daemons. |
| `interlinked harness clean [--json]` | Remove stale socket and PID records after confirming the socket has no listener. A listening or ambiguously occupied socket refuses cleanup even when its PID record is missing or stale. |

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

## Diagnosing problems

Project E2E `interlinked tests e2e doctor` retains report version 1 and adds optional
`evaluation: "not-evaluated"` and `prerequisites` fields to dependent checks. A ledger
failure leaves receipt validation unevaluated; unresolved contract references prevent
complete acceptance/toolchain success. Known missing preparation tools can still fail
independently. POSIX command inspection checks regular executable files under the runner's
PATH/cwd. A same-suite artifact expected after preparation is a warning, not verified
availability; preparation commands never receive that exemption. Runtime placeholders or
unsupported platform lookup stay unverified. The doctor does not execute preparation.

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
If the nested restart fails, reload exits nonzero and reports `daemon.restarted:false`
in JSON output. Inspect the restart diagnostic before retrying.

Step budgets are unlimited at every sensitivity level. After reload, each session's next
event refreshes its stored limit from current policy, including sessions restored from old
snapshots with a 10,000-step cap. There is no need to delete snapshots or clear sensitivity.

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

## Native shell sandbox posture

For command-network failures, run `interlinked network check <http(s)-endpoints...> --json`
inside the affected agent shell. It makes bounded, credential-free HEAD requests to the
origins with curl, honors host proxy settings, and never follows redirects or performs
inference. HTTP 4xx/5xx from the service proves transport access, not service health or
authentication. Recognized proxy denials remain failures. The report records the current
thread/runtime markers; success in a host terminal does not attest another agent session.
DNS, OS permission, connection, timeout, TLS and missing-curl failures stay distinct.

Prepare a reusable Codex profile with:
`interlinked network codex-profile research --allow http://127.0.0.1:11434 https://api.typesafe.ai`.
The command previews by default; `--write` creates `$CODEX_HOME/research.config.toml`
(default `~/.codex`). It preserves existing differing files and rejects profile-file
symlinks. The profile extends `:workspace`, enables hooks and the native network proxy,
and allows only the supplied exact host rules (all ports for each host). No broad local
network exception or approval bypass is added. Other loaded configuration and managed
requirements can still affect the effective policy. Current Codex config-file profiles
and permission-profile support are required; validate against the installed CLI's help.

Select it with `codex --profile research`, or `codex --profile research resume <session-id>`.
Creating it does not change a running session or the user's default config. Legacy
`sandbox_mode`/`sandbox_workspace_write` settings and `--sandbox` can override profiles;
review those conflicts on the host instead of silently rewriting them. Managed requirements
remain authoritative. Recheck access from the resumed agent before claiming it unblocked.
Hook installation, daemon restarts and clearing Interlinked state cannot lift an OS sandbox.
See https://learn.chatgpt.com/docs/permissions for the native permission contract.

Enable each client's strictest usable native sandbox separately; Interlinked hook installation does
not turn the provider sandbox on. Bash PreToolUse reports `[interlinked:sandbox]` as `attested`,
`configured`, `disabled`, or `unknown`. Treat `configured` as weaker than per-call attestation because
CLI/profile overrides can change the active call. Explicit Codex escalated/`danger-full-access` calls
and Claude unsandboxed settings are reported as disabled evidence.

Native workspace-write sandboxes constrain host/network reach but still allow real writes inside the
project. They complement Interlinked's post-call filesystem ChangeSet and Stop residue backstop; they
do not provide rollback or replace the deterministic PreToolUse guards. See **interlinked-harness**
for interpreting the warning.

## Config & environment

`interlinked env` masks token values in normal, short and full human output.
`env --json` exports the current values for machine consumption.
`interlinked completions bash|zsh|fish` derives commands, nested subcommands,
aliases and visible flags from the registered CLI. Regenerate the shell script
after CLI updates. Bash and zsh support evaluation of the emitted setup script,
and fish supports piping it to `source`.

`interlinked sponsor enable --spinner --json` emits one JSON document on stdout,
including when the spinner verb is installed. Human diagnostics remain on stderr.
Sponsor disable retains managed spinner ownership when settings cleanup fails,
so a later retry can remove those entries. That partial cleanup exits nonzero
and JSON includes `cleanup_error` while the sponsor row is disabled.

- **`.interlinked/config.json`** (committed): `server_url`, `default_project`, `mode`
  (operational tier), `skip_paths`, `pii_patterns`, nested `harness` feature flags.
- **`.interlinked/config.local.json`** (gitignored): `access_token`, `agent_name`,
  `workspace_id`, `sync_mode`, `active_server` + `servers` map, `guard_mode`, `data_dir`.
- **`.interlinked/semantic.json`** (committed): optional semantic-index enablement, exact pinned
  model reference, and source/test include policy.
- **`.interlinked/semantic.local.json`** (gitignored): local-only CPU/runtime topology. Remote URLs,
  API tokens, and cloud fallbacks are rejected by the v1 schema.
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

- `setup` skips remote login and onboarding for resolved `localhost`, `127.0.0.1`,
  and IPv6 loopback servers. An explicit manual token still requests login.
  `init` also skips login for localhost and 127.0.0.1 servers.
- Token resolution: CLI token in `config.local.json` → auto-refresh → Claude Code
  credential fallback (`~/.claude/.credentials.json`).
- Sync modes: `realtime` (default; per-event post + session-end batch), `manual`
  (per-event only), `local` (no server posts at all).
- `login --token` and `setup --token` reject an empty or whitespace-only value before
  creating config or starting authentication. `logout --all` also clears an agent handle after the
  credentials have already been removed.

## Turning it off

`harness stop` exits nonzero when a verified daemon survives shutdown.
`disable --uninstall` confirms shutdown through the stop result, legacy process
state and daemon socket before removing hook or config ownership. A failed
confirmation preserves those files for inspection and retry.

| Command | Effect |
|---|---|
| `interlinked disable [--reason <t>] [--until <dur>] [--team]` | **Non-destructive** stand-down: records a marker + stops the daemon. Hooks and config stay. Re-arm with `interlinked enable`. |
| `interlinked disable --uninstall [--keep-config]` | Destructive teardown: removes hooks + the installed skills **and deletes the `.interlinked/` config dir** — pass `--keep-config` to keep the config. |
| `interlinked reset --force` | **Nuclear**: delete the entire `.interlinked/` dir and strip hook entries. Irreversible; `--force` required. |
| `interlinked uninstall-hooks` | Remove **only** what `install-hooks` recorded in its manifest. |

`uninstall-hooks --runner` rejects empty and unknown selections before removal.
Omitting the filter or supplying `all` selects every manifest runner.
`clean` previews by default. `clean --force` performs cleanup, and an explicit
`--dry-run` preserves preview behavior when both flags are supplied. If a stale
session file cannot be deleted, the text output identifies its path as
`could not remove`. The JSON `removed` list contains successful removals.

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

## Permission learner behavior

Repeated tool observations now generate bounded, conservative proposals only. The learner does not edit `.claude/settings.json` or expand guard permissions. Existing permission entries are left intact; repeated use, a non-blocked hook, and a proposal are not approval. No automatic migration or daemon restart is required by the schema. A running daemon continues using its loaded code until the normal explicit reload workflow.

Use `interlinked harness explain <topic> --client claude --json` (or another supported client) to inspect implementation, local policy, declared client capability and retained observations separately. Registration does not prove native activation. Use the native capability probes for that claim.

## References

Read a reference file only when the task needs it.

- [references/daemon-operations.md](references/daemon-operations.md): restart deferral and backoff, the memory ceiling, and a missing or broken hook binary.
- [references/hook-capabilities.md](references/hook-capabilities.md): `harness capabilities --json`, the hook capability inventory and experimental clients.
- [references/setup-notes.md](references/setup-notes.md): hook project discovery, the guard-prediction default, compiler batching, skill refresh, missing-runtime diagnostics, provider qualification, `tests readiness` and externally frozen policy.

## Related skills
- **interlinked-verify** — project e2e adoption after enable: `interlinked tests e2e discover --out report.json`, review, `tests e2e adopt --from report.json` (advisory unless `--mode required`), `tests e2e doctor`. Discovery proposes; it never accepts inferred behavior.
- **interlinked-harness** — what the guard blocks and how to respond when a tool call is refused.
- **interlinked-observability** — inspect the activity the hooks capture (`status`, `activity`, `logs`).
- **interlinked-coordination** — the optional server-backed side (tasks, messages, workspaces).
- **interlinked-semantic-index** — explicitly install a model and build/query the local function index.
