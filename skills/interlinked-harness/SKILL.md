---
name: interlinked-harness
description: "Understand and respond to the Interlinked PreToolUse guard — the local daemon that BLOCKS dangerous tool calls before they run. Load this when a Bash command or file edit was refused with \"BLOCKED: … Suggestion: …\", when you see an `[interlinked:check-id]` warning tagged `[proven]` or `[heuristic]`, when a destructive command / force-push / protected-file / secret / repo-confinement rule fired, when a grep was answered by the index, or when you need to know how to legitimately suppress a false positive or disable a guard rule. Covers what blocks, how to read the reason, suppression grammar, determinism tags, and the degraded cold fallback."
---

# interlinked-harness — the guard: what blocks you & how to respond

Guard audit records retain references for repeated warning text. Use `interlinked data search
--source warning-occurrences` to inspect full first/changed messages, hashes and occurrence
counts; `data show ID` opens their raw evidence. This bounds repetition in the activity mirror
without changing the guard decision or the warning returned by the evaluator. A later
`not-reported` observation does not prove that the underlying issue was fixed.

Interlinked runs a **local daemon** that evaluates each pre-execution event the installed
runner exposes to its hook surface (PreToolUse). It is **default-permit with targeted
forbid**: it allows everything except known-dangerous shapes, which it refuses with an
actionable reason and a safer alternative.
It is a fast deterministic guardrail, **not** a security trust boundary (it's local and
bypassable) — so the right instinct when blocked is to take the suggested safe path, not to
defeat the pattern.

## Load this when
- A tool call was refused: `BLOCKED: <reason>` / `Suggestion: <safer alternative>`.
- You see an `[interlinked:<check>]` warning (tagged `[proven]` or `[heuristic]`).
- A destructive command, `git push --force`, protected-file, secret, repo-confinement, or
  bash-redirect-bypass rule fired.
- You need to legitimately suppress a check false-positive, or disable a wrong guard rule.

## Mental model
- Each installed hook event ships its payload to the daemon over a Unix socket. The daemon runs an
  ordered set of phases; **the first phase that returns a terminal decision wins**.
- Framed daemon RPC validates each method's request shape, including nested hook metadata
  and administrative arguments, before dispatch. The client accepts only matching-id responses
  with the expected method result shape. Malformed frames do not become successful decisions;
  the existing timeout and fallback behavior still applies.
- Local quality-check overrides validate each supplied field before merging it. Malformed
  fields are ignored while valid fields and sibling checks survive; new checks require the
  complete mandatory configuration. Team overrides affect existing checks only. Default
  configuration copies preserve non-JSON values such as an unlimited (`Infinity`) step limit.
- Content-scanner allowlists skip malformed entries. Known entry kinds require their declared
  string fields; an unrecognized scanner runtime cannot select a backend. These checks apply
  to these boundaries and do not imply that every legacy configuration section has a schema.
- Decisions: `block` (tool refused, you see the reason), `ask` (human confirmation — Claude and
  supported Cursor gates can ask natively; interactive Pi calls `ctx.ui.confirm`; headless Pi,
  OpenCode's stable tool gate, Codex `PreToolUse`, Copilot, and Gemini deny instead;
  Claude/Codex `PermissionRequest` allow/ask abstain so the provider retains authority),
  or `allow` (may still carry non-blocking `warnings`, or an `updated_input` rewrite).
- Built-in rules are regex patterns on the command/tool-input. Use `interlinked harness checks`
  for the authoritative current inventory. Patterns are **ORed over positive entries;
  `negate:true` patterns are exceptions.** `executed_only` masks
  quoted/heredoc/comment text, so *mentioning* `rm -rf /` in an `echo` is allowed while the
  bare command blocks. Compound commands (`&&`, `||`, `;`, `|`, newline) are decomposed and
  each part checked.
- Python `open(...)` checks inspect executable calls and recognize write and append modes;
  read-only calls and quoted examples do not establish a file write. Keep malformed tool
  input tests at the raw hook-input boundary rather than passing invalid normalized events.
- The log-output guard measures ordinary single-file `head`/`tail` windows of up to 200
  lines before rejecting a file over 100 KiB. Small windows pass on large logs; a selected
  line over the byte budget still blocks. Signed counts and unfamiliar option combinations
  retain the file-size gate. Daemon and generated-hook paths use the same bounded reader.

> **Two unrelated things are called "guard".** This skill is the **PreToolUse guard** (the
> daemon, operated via `interlinked harness …`). `interlinked guard` is a separate **git
> pre-commit/pre-push hook** that checks staged files against file reservations — see
> **interlinked-coordination**.

## What gets blocked (with concrete examples)

| Category | Blocks (examples) | Allows (examples) |
|---|---|---|
| **Destructive fs** | `rm -rf /`, `rm -rf *`, `rm node_modules`, `sudo rm …`, `dd`, `mkfs`, `shred`, `chmod 777` | `rm -rf /tmp/x`, `rm -rf dist/`, `rm -rf .wrangler/cache` |
| **Process killing** | `pkill node`, `killall wrangler`, `kill -9 1234`, `kill $(pgrep …)`, `… \| xargs kill` | `pkill -f 'wrangler dev'`, `grep -rn "kill -9" src/` |
| **Git** | `git push --force`/`-f`, `git reset --hard`, `git clean -fd`, `git checkout -- .`, `git branch -D`, `git stash drop`/`clear`, agent-created worktrees (`git worktree add`; Claude `WorktreeCreate`) | `git push --force-with-lease`; `git worktree list/remove/prune` |
| **DB / cloud / IaC / containers** | `DROP DATABASE`/`TRUNCATE`/`DELETE`-without-WHERE, `docker … prune`/`rm -f`, `kubectl delete`, `terraform destroy`, `pulumi destroy` | — |
| **Info-flow / persistence** | env exfil (`env \| curl …`, `printenv \| nc …`), `.npmrc`/`.yarnrc` writes, `nohup curl … &`, `crontab -e`, `systemctl enable`, writes to `/etc/cron.d/`, `*.service` | — |
| **Protected files** | Read/Write of `*.pem`/`*.key`; Write of `*.env*` **only if secrets detected**; **Delete** of CI configs, `migrations/**`, `.gitignore`, lockfiles, `Dockerfile` | `.env.example` / `.sample` |
| **Sensitive-file read** | `Read` of `.env`, `credentials.json`, `service-account*.json`, `*.pem`/`*.key` | `.env.example` |
| **Repo confinement** | any Write/Edit whose real (symlink-resolved) target is outside the repo root | paths under the allowlist / session scratchpad |
| **Package installs** | any un-allowlisted `npm/pip/cargo/go/…` install; URL/git/tarball specs — see **interlinked-supply-chain** | allowlisted + exact-pinned |
| **Bash-routed write bypass** | a `>` / `tee` redirect, `sed -i` / `perl -pi` / `gawk -i inplace` / `ex` / `ed` in-place edit, `patch` / working-tree `git apply`, or a wrapped form (`xargs`, `find -exec`, `timeout`) writing a tracked source file (dodges the content gate) | Write/Edit, `interlinked write`, or index-only `git apply --cached <patch>` |
| **Applier-script execution** (`builtin-patch-applier`) | running an interpreter on a pre-existing throwaway script that writes into repo source | route the edit through Write/Edit; committed codegen belongs in `scripts/` |
| **Bash-edit obligation** (`bash-edit-obligation`) | a bash-channel edit left an INTRODUCED `pre_block`-class finding on disk; until it is fixed, write-class tool calls to OTHER files are refused (edits to the flagged file and reads stay allowed; the gate re-checks and self-releases) | fix the flagged file first |
| **Hand-rolled patch applier** | a throwaway script in the scratchpad or `scratch/` that calls `writeFileSync`/`appendFileSync`/`write_text` on a path outside its sandbox (`"src/…"`, `process.cwd()`, `../`) — a re-implementation of Edit with the gates removed | probes that only READ repo source; scripts writing beside themselves; committed codegen under `scripts/` |
| **Content pre_block** (introduced-only) | edit that *introduces* merge-conflict markers, `eval()`, and other zero-FP checks | pre-existing instances (warn, not block) |

## When you're BLOCKED: what to do
For selected-hunk staging, prepare and review a patch, then run `git apply --cached <patch>`.
It changes only the index and preserves other working-tree edits. `git add -p`, `-i`, and `-e`
remain blocked as interactive operations; use `git add <paths>` for whole files.
Flags on a later shell command do not make staging interactive; a backslash-escaped
newline continues the same command and retains its interactive restrictions. A normal
`git apply` or `git apply --index` still writes the working tree and must use the content gate.

1. **Read the `reason` and `Suggestion:`.** The suggestion is the intended path (force-push →
   `--force-with-lease`; `rm node_modules` → `npm cache clean --force && npm install`;
   `pkill node` → target the PID or `pkill -f 'wrangler dev'`). Take it — but the safe *flag* is
   not always the whole answer. For a destructive or history-rewriting op on a **shared** target
   (force-push to `main`, dropping data), the block is also a prompt to check *intent*: confirm
   the action is warranted and that you have explicit user authorization before proceeding.
2. **Don't rewrite to dodge the regex.** The pattern encodes a real hazard; evading it is the
   wrong move (and trajectory detectors watch for evasion).
3. **Content-check blocks are introduced-only.** A `pre_block` finding (`[check_id]` in the
   reason) blocks **only when your content has more instances of that finding's line text than
   the file already had** (multiset over whitespace-normalized text — moving a pre-existing
   finding doesn't count; a brand-new file counts everything). Fix the line(s) you *added*,
   then retry.
4. **Legitimate suppression** — only when a flagged line is genuinely deliberate:
   - Inline, on the line **above** the finding: `// interlinked-ignore: <check-id> — <why>`
     (reason separator ` — `, ` -- `, or `–`; comma-separate multiple check ids).
   - File/glob-level: an entry in `.interlinked/verify-suppressions.json`
     (`{ "<file-or-glob>": { "<check>": {"reason","by","at"} } }`).
   - Both are honored identically at pre_block, PostToolUse, and `interlinked verify`, and are
     **ratcheted/audited** (visible exceptions, not silent bypasses).
   - Distinct: `// interlinked: defer <check> -- reason` *acknowledges* a finding without
     suppressing it (still logged) — for pre-existing findings you're choosing not to fix now.
   - A **`[interlinked:sequence]` pre_block** (trajectory detectors such as
     `secret_read_then_network_call`) is deferred the same way, but the marker must sit in the
     call itself — the Bash command text, or the content you are writing — and must name the
     detector id **exactly**. The call then runs and the harness logs
     `[interlinked:sequence-deferred]` with your reason. These detectors latch on session
     state, so without the marker one confidential read can block every later network call.
5. **When NOT to suppress:** `[proven]` findings (tsc/biome/gitleaks/semgrep actually ran) and
   any destructive/security **guard-rule** block. Suppression directives affect **checks**, not
   **rules** — you cannot `// interlinked-ignore` a `git push --force` block. If a *rule* is
   wrong for your repo, the fix is config (below), not a comment. Don't add
	`@ts-ignore`/`biome-ignore` to silence a `[proven]` check — that trips `suppressions-unjustified`.

An agent must not create a Git worktree to route around shared-workspace policy. Use the
current workspace. If isolation is genuinely required, ask a human operator to provision an
approved worktree; listing and cleanup of existing worktrees remain allowed.

## Warnings: `[proven]` vs `[heuristic]`

### Filesystem observations and native control limits

The daemon watches protected policy files and literal in-workspace reservation
paths, then reconciles content identities periodically and at delivery boundaries.
Writes by a shell, editor or agent can create durable pending verification entries.
Writer identity is `unknown`; a reservation is not proof that its holder performed
the write. Glob reservations, symbolic links, inaccessible or oversized files
remain explicitly unmeasured. A stopped or unavailable observer cannot certify coverage.

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
also cannot satisfy an assertion-free callback.

Every warning is tagged. `[proven]` = a real compiler/linter/scanner/parser/test-runner
produced it — authoritative, fix it. `[heuristic]` = regex/AST-shape match that could be a
false positive — evaluate it. No tag = unknown check id (never guessed).

**Visibility varies by runner.** On the supported Claude and Codex gate surfaces, a block reason
is surfaced through the provider's blocking channel. Experimental adapters target their native
response or exit-code shapes, but registration is not proof that every provider version enforces
them identically. Claude and Codex use model-visible `additionalContext` only on events whose
contracts support it. A Claude PermissionRequest deny uses
`hookSpecificOutput.decision = { behavior: "deny", message }`, not PreToolUse's
`permissionDecision`; allow/ask abstain on stdout, and non-blocking PermissionRequest diagnostics
stay on stderr. Cursor uses `additional_context` on generic `postToolUse`. OpenCode
appends post-tool feedback to tool output; Pi appends it to `tool_result` and can notify an
interactive UI. Copilot remains stderr-only and some lifecycle events are observation-only.
Allow-warnings are easy to overlook — read them.

**Silence = no model-visible finding, NOT "everything was checked" (2026-08-27).** A served,
clean PostToolUse result writes ZERO BYTES — no `[interlinked:Bash] all clean (354ms)` row, not
even an empty `{}` envelope — because runners render one hook row per response and parallel tool
calls multiplied that into unusable noise. Outage visibility is phase- and runtime-specific:

| Result | What you see |
|---|---|
| Clean PostToolUse result served by the daemon | nothing (recorded locally only) |
| Findings | one compact `[interlinked:<check>]` block |
| Block | the reason plus the affected target — **including a block that carries no warnings** |
| Daemon unavailable, packaged PreToolUse runtime | an explicit `evaluator skipped` diagnostic; code edits also report function-token enforcement as not measured |
| Daemon unavailable, generated PostToolUse runtime | may remain model-silent while recording local `no_harness` status |
| `typescript` unresolvable (`--omit=optional` install) | a `[interlinked:self_import] NOT MEASURED` warning on every JS/TS edit — that pre_block check ran no scan and never guesses; the cyclomatic gate degrades to the regex walker; the daemon startup warning names both |
| `self_import` cannot place the file in ONE project | the same `NOT MEASURED` warning on that edit only, naming the cause: a tsconfig on the walk (nearest config, its `extends`, its `references`, its sibling `tsconfig*.json` files) could not be parsed; two projects both claim the file; the reference walk hit its 32-project bound with projects unvisited; no config in reach claims the file by a `files`/`include` pattern (a `.js`/`.jsx`/`.mjs`/`.cjs` importer is matched by pattern even when the project never enables `allowJs` — a JS self-import is a runtime fact); or the importer's directory is not on disk yet. The check resolves with the project's own compiler options and caches nothing, so fixing the config applies on the next edit. In a batch (`write --batch`, `multi-edit`, `verify-changeset`) it sees the whole proposed batch, and the baseline is judged against the disk |
| a batch rewrites a file of the project's configuration graph — the selected tsconfig, any file its `extends` chain reaches (whatever it is called, `base.json` included), or any `tsconfig*.json` / `jsconfig.json` / `package.json` | each TypeScript entry of that batch carries a `type checker cannot see the proposed configuration` row (error for transactional callers) — the checker reads the disk's config; land the configuration change first, then the sources |
| a batch includes a member whose bytes equal the disk beside members that differ | the unchanged member is still type-checked, against the proposed siblings (a changed exporter can break an untouched consumer); `multi-edit` validates every manifest member and writes only the changed ones. Only a batch whose members are ALL unchanged skips the check. A config member whose bytes equal the disk is not a configuration rewrite |
| the type checker cannot place the file in ONE project | `type checker unavailable (project_orphan: …)` or `(project_ambiguous: …)` on that edit — a warning on the hook path, an error for transactional callers. The compiler judges each file under the SAME project `self_import` selects (nearest config, `references`, sibling `tsconfig*.json`, membership by pattern; one program per governing config) and never under the project root's config by guess. Its disk baseline is recomputed on every check, so a dependency repaired or broken on disk is reflected the next time the file is judged. A warm compiler service is rebuilt when the CONTENT of any file of its configuration graph (the tsconfig or an `extends` target) changes on disk, re-reads the project's root files on every reuse (a declaration file added or removed on disk joins or leaves the program), sees a dependency rewritten on disk by its compiler TEXT (every UTF-16 code unit is preserved, including lone surrogates; a touch that changes no text does not count; each check reads a file once, so what it compiles is what it fingerprinted), forgets a proposal the moment its check ends (a refused proposal never colours a later check), and a configured project with no source on disk yet still measures the first source written into it |

No output therefore never proves the full daemon check set ran. To distinguish a served clean
result from a silent degraded PostToolUse path, ask `interlinked harness status` or
`interlinked doctor`; inspect `.interlinked/activity.jsonl` and the statusline for the per-call
state.

The block row is load-bearing: the response path decides on the DECISION, never on whether the
warning list happens to be non-empty. If you are about to rely on "the harness would have caught
it", confirm the daemon is answering first — silence is not evidence that it was.

**Test edits use the same hook loop.** Deterministic introduced test theatre (assertion-free or
tautological cases, SUT self-mocking, focus markers, unconditional skips) blocks before the write.
Lower-confidence but low-noise test-quality findings are PreToolUse warnings so even a small writer
can correct them immediately; context-heavier suite review stays in PostToolUse. Do not silence a
warning merely to land the edit—assert a precise observable behavior, or justify the actual public
compatibility contract.

**Test-discrimination advisories** are `post` warnings and also run under
`verify --all-checks`. They review fallback-only evidence, indistinguishable
positive/negative expectations, unpinned spy arguments, wildcard observables,
in-tree fixtures, fixed ports, ambiguous throw messages, unguarded catch assertions,
vacuous loops, mock return echoes, duplicate bodies, spies without restoration,
export existence smoke tests, and commented-out assertions. They never block.
Evaluate the intended contract: forwarding a mock value or preserving an export
can be legitimate. Fix a detector false positive before rewriting valid tests.
`spy_without_restore` recognizes applicable local cleanup and statically discovered
Vitest/Jest restoration settings; `clearAllMocks`/`resetAllMocks` are insufficient.
Fresh test-owned array literals are exempt, as are fresh test-owned objects;
module/suite arrays, shared aliases, and prototype methods still need restoration.
Source headers and `docs/design/test-discrimination-checks.md` describe limits and
calibration. A corpus hit count is not precision or proof of a surviving mutant.

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

A Stop-time `[interlinked:effect-residue]` warning means a
PostToolUse was missing/unreconciled; the observed files were added to the touched-file rescan.
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

## Grep acceleration
The guard intercepts `Grep` tool calls and Bash `rg`/`grep`, queries a trigram index for
candidate files, and can answer the search directly (block-and-answer) faster than a full
scan. It is **strictly never-worse-than-native**: on small/medium repos it declines and native
`rg` runs unaccelerated. It's a large-monorepo optimization; you don't manage it. Inspect what
it would match with `interlinked index query <pattern>`. Your own just-written edits are
immediately searchable (in-memory dirty layer).

## Configuring the guard (when a rule is genuinely wrong for the repo)
Config lives in `.interlinked/guard-rules.json` (team) + `.interlinked/guard-rules.local.json`
(personal, gitignored). Merge priority: local > team > built-in.
- `disabled_rules: ["builtin-git-force-push", …]` — turn a built-in rule off (built-ins can be
  disabled, never edited).
- `extra_exceptions: { "<rule-id>": ["substring", …] }` — the rule won't fire if the command
  contains a listed substring.
- Team/local/distilled files hot-reload within ~2s (`watchFile`); `interlinked harness restart`
  forces a full reload.

## The cold fallback (daemon outage degrades; deterministic gates stay closed)
If the configured daemon socket is unreachable — including a **zombie** with a live process but
dead listener — every ordinary hook phase enters a cross-process, single-flight recovery path.
Daemon absence alone does **not** blanket-block safe reads, diagnostics, or repair work. The
current call proceeds in degraded mode after the inline deterministic subset runs:
merge-conflict markers, **destructive commands**, **package installs**, graph-shard protection,
file-dump limits, and the **per-file line cap**. Those checks still block when proven; checks that
need the full evaluator are explicitly unavailable rather than silently reported clean.

`interlinked harness status`, `harness start` / `restart`, `doctor`, `disable`, and the exact
`interlinked install-hooks --refresh --preserve-mode` repair remain executable during an outage
and do not race the automatic launch. A recovery message says “launch attempted” only when this
hook actually spawned; lock/backoff/stand-down paths do not claim that a supervisor is bringing
anything back. A valid `guard-disabled.json` or `guard-disabled.local.json` marker suppresses
self-heal. `interlinked harness status` confirms recovery — a red `ZOMBIE` line means a live PID
is answering nothing, so trust the socket probe over the PID. See **interlinked-setup** for the
liveness states and startup-failure ledger.

If the installed hook binary itself is missing or broken, the self-contained wrapper follows the
same no-deadlock boundary: Claude/Codex reserved read builtins and Cursor's dedicated
`beforeReadFile` event proceed with an explicit degraded warning. Ambiguous generic names on
other gates do not. Exact build/status/repair/non-destructive-disable commands remain available,
while mutating and unknown tools receive the provider's native deny response. Shell commands are
never inferred read-only from their text. Restore the runtime before relying on the full evaluator.

## Gotchas
- **The "`sleep` is blocked" claim in old docs is stale** — there is no standalone `sleep`
  block in the current rule set. Don't rely on it.
- **`interlinked harness test "<cmd>"`** fires a synthetic event at the daemon to see if it
  would block — and is itself exempt from destructive rules so you can test them safely. A
  chained destructive tail still blocks; "test allowed it" ≠ "the real command is allowed".
- **`harness restart` clears per-session trajectory state** — soft_block "retry allowed" memory
  and trajectory detectors reset. A restart mid-task can change guard behavior.
- **SessionEnd heavy checks are single-flight per daemon** — a burst of agent shutdowns does not
  start duplicate recurrence scans or coverage ratchets. While one detached job is still active,
  later SessionEnd events log it as already running and skip that copy; the next run becomes
  eligible when the child exits or the daemon restarts.
- **`[interlinked:trajectory] …(shadow — would block)`** warnings are advisory only (shadow
  mode) — they preview a future gate; treat as signal, not a block.
- **PreToolUse blocking**: Claude Code and Codex are supported. Claude also registers
  PermissionRequest; Codex registers all twelve native lifecycle/tool events. Codex
  PreToolUse `ask` becomes deny, while both providers' PermissionRequest `ask` preserves the
  native user prompt. Codex `Interrupt` is asynchronous observation only: it emits zero stdout
  and never runs Stop/SessionEnd cleanup. Cursor, Copilot, and Gemini
  adapters can register and parse events, but their end-to-end provider enforcement remains
  experimental (no provider-level contract test). Copilot/Gemini collapse `ask` → deny.
  OpenCode and Pi are experimental managed bridges: OpenCode hard-gates generic tool execution
  but `ask` denies and its permission/Stop signals cannot control the provider; Pi gates both
  `tool_call` and direct `user_bash`, asks through an interactive UI, and denies headless.
  Neither has dedicated native MCP, subagent, or worktree lifecycle events. Do not infer an
  absent event from silence; the shared `git worktree add` shell block still applies.
- **PII content scanner** is separate and opt-in: `interlinked scanner on|off|toggle|status|review`.
- Env bypasses (logged, documented-flows only): `INTERLINKED_DISABLE_PACKAGE_GUARD=1`,
  `INTERLINKED_DISABLE_BASELINE_GUARD=1`, `INTERLINKED_DISABLE_SCRATCH_GUARD=1`.

## Quick reference
```bash
interlinked harness test "git push --force"   # would this block? (safe to run)
interlinked harness checks                     # authoritative check inventory
interlinked harness status --json              # liveness + socket_answered
interlinked index query "<pattern>"            # what the grep accelerator would match
interlinked harness restart                    # reload everything (clears trajectory)
```

## Related skills
- **interlinked-verify** — the check catalog behind the warnings, `interlinked verify`, and how to land edits through the gates.
- **interlinked-quality-gates** — the metric ratchets (line-cap / coverage / complexity) that also block edits.
- **interlinked-supply-chain** — the package-install gate in detail.
- **interlinked-setup** — starting/restarting the daemon, `doctor`, config.
