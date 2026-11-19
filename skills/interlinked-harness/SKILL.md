---
name: interlinked-harness
description: "Respond to the Interlinked PreToolUse guard, the local daemon that BLOCKS dangerous tool calls before they run. Load when a Bash command or edit was refused with \"BLOCKED: … Suggestion: …\", when an `[interlinked:check-id]` warning tagged `[proven]` or `[heuristic]` appears, when a destructive-command, force-push, protected-file, secret, or repo-confinement rule fired, when the index answered a grep, or to suppress a false positive or disable a guard rule legitimately. Covers suppression grammar, determinism tags, and the degraded cold fallback."
---

# interlinked-harness — the guard: what blocks you & how to respond

Interlinked runs a **local daemon** that evaluates each pre-execution event the installed
runner exposes to its hook surface (PreToolUse). It is **default-permit with targeted
forbid**: it allows everything except known-dangerous shapes, which it refuses with an
actionable reason and a safer alternative.
It is a fast deterministic guardrail, **not** a security trust boundary (it's local and
bypassable) — so the right instinct when blocked is to take the suggested safe path, not to
defeat the pattern.

## Load this when

For the experimental Cowork plugin, first load **interlinked-cowork**. Its portable
guard is a subset of this daemon: exact tool/path denials and the shared destructive
command guard. Native crashes/timeouts were observed to fail open; the plugin's
launcher mitigates child failure but cannot enforce an absent/provider-killed hook.
Host file policies require explicit bridge mapping and matching file snapshots.
- A tool call was refused: `BLOCKED: <reason>` / `Suggestion: <safer alternative>`.
- You see an `[interlinked:<check>]` warning (tagged `[proven]` or `[heuristic]`).
- A destructive command, `git push --force`, protected-file, secret, repo-confinement, or
  bash-redirect-bypass rule fired.
- You need to legitimately suppress a check false-positive, or disable a wrong guard rule.

## When you're BLOCKED: what to do

Distinguish a hook rejection from a command that executed and then failed. OS `EPERM`,
DNS failure or a host proxy denial after Interlinked allowed a command requires runtime
network diagnosis: `interlinked network check <http(s)-endpoints...> --json` in that agent
shell. Follow **interlinked-setup** for reusable host permission profiles. Do not clear
guard state, disable hooks or restart the daemon to repair an external sandbox restriction.

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
   The `ubs_hardcoded_localhost` check distinguishes Git's `-c user.email=…`
   identity argument from a remote endpoint passed to the same command.
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
     state. Since 2026-10-08 `secret_read_then_network_call` is default-off: sensitivity is
     tracked and warned, never blocked, on outbound network calls.

5. **When NOT to suppress:** `[proven]` findings (tsc/biome/gitleaks/semgrep actually ran) and
   any destructive/security **guard-rule** block. Suppression directives affect **checks**, not
   **rules** — you cannot `// interlinked-ignore` a `git push --force` block. If a *rule* is
   wrong for your repo, the fix is config (below), not a comment. Don't add
	`@ts-ignore`/`biome-ignore` to silence a `[proven]` check — that trips `suppressions-unjustified`.

**Loopback requests after a sensitive read.** Since 2026-10-08 the sensitivity guard
tracks and warns, but never blocks, outbound network calls; the rules below apply when
`secret_read_then_network_call` is enabled. It uses destination-aware classification. Explicit HTTP(S)
curl requests to `localhost`, IPv4 loopback (`127.0.0.0/8`), or IPv6 loopback (`::1`)
are exempt, including ordinary request/data/header flags. Simple nc/ncat/netcat loopback
connections are also exempt. Wget requires `--max-redirect=0` and a supported simple
invocation. Each network command and destination must qualify: a local request never
exempts another remote request in the same shell command. Sensitivity remains unchanged.
LAN/private addresses, unknown destinations/options, shell expansions, curl redirect flags,
explicit proxies, alternate resolution and config-file options retain guarding. Explicit
environment assignments selecting proxies or client configuration also retain guarding.
This is a static command classifier; it does not inspect ambient client configuration or
prove what a local service does with received data. Other guards continue to apply.

Sensitivity follows the acting worker and its ancestors. An already-running clean sibling
keeps its own sensitivity; new children inherit their parent's current sensitivity. This
also applies to the optional content scanner. Unknown actors and legacy state retain the
conservative session-level fallback.

All sensitivity levels have unlimited tool-call budgets by default. Long sessions do not
enter read-only mode or receive budget warnings merely because of their call count. After
rebuilding and restarting, the next event applies current step-limit policy even to a
restored session with an older finite cap, preserving its sensitivity and trajectory.

Git scope checks normalize absolute session write paths and Git's repository-relative
paths against the repository root, including commands invoked from subdirectories.
Unowned files still require review; matching a path does not authorize a commit by itself.

**Inspecting the sensitivity level.** `interlinked harness taint status [--session <id>]
[--json]` reports the level, the step limit, the source that SET the level (proven from the
`escalated` flag, or `inferred` as the earliest source at that level on a pre-flag snapshot)
and the last sources; it reads live daemon state when a daemon answers, otherwise
`.interlinked/sessions/<id>.live.json`, and says which.
Lowering a level is **operator-only**: `interlinked harness taint clear --session <id>
--reason "<text>"` needs a real terminal on stdin and stdout plus a typed session-id prefix,
has no `--yes`/`--force`, and appends an audit row to `.interlinked/taint-clears.jsonl` — so
ask the operator to run it from their own shell rather than trying to clear your own taint
(like every local check, the TTY gate is a convenience, not a trust boundary).

**Commit-risk nudge.** On a real Bash `git commit`, `[interlinked:jit][heuristic]` warns
when the currently staged diff ranks at p90 or above against recent commits in this repo.
It is advisory, never blocks, and does not replace subsequent commit gates. Inspect it with
`interlinked metrics jit --staged --message '<planned subject>'`; see
**interlinked-quality-gates** for calibration, interpretation and snapshot limits.

An agent must not create a Git worktree to route around shared-workspace policy. Use the
current workspace. If isolation is genuinely required, ask a human operator to provision an
approved worktree; listing and cleanup of existing worktrees remain allowed.

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
| **Bash-edit obligation** (`bash-edit-obligation`) | a bash-channel edit left an INTRODUCED `pre_block`-class finding on disk; the owning session's write-class calls to OTHER files are refused until it is fixed (edits to the flagged file and reads stay allowed; the gate re-checks and self-releases) | fix the flagged file first; unknown-writer findings do not acquire a guessed session owner |
| **Hand-rolled patch applier** | a throwaway script in the scratchpad or `scratch/` that calls `writeFileSync`/`appendFileSync`/`write_text` on a path outside its sandbox (`"src/…"`, `process.cwd()`, `../`) — a re-implementation of Edit with the gates removed | probes that only READ repo source; scripts writing beside themselves; committed codegen under `scripts/` |
| **Content pre_block** (introduced-only) | edit that *introduces* merge-conflict markers, `eval()`, and other zero-FP checks | pre-existing instances (warn, not block) |

Inline interpreter writes (`builtin-interpreter-write`) require evidence about the
write's own destination: a literal source path or a simple variable binding to it.
Reading or hashing a source file while writing a JSON ledger does not establish a
source edit. The guard does not pair unrelated filenames with writes elsewhere in
the program. Reassigned, shadowed or otherwise unresolved destinations are not
grounds for this hard block; computed-write warnings remain advisory. Actual
source writes still belong in Write/Edit or the supported Interlinked write flow.

## Mental model
- Each installed hook event ships its payload to the daemon over a Unix socket. The daemon runs an
  ordered set of phases; **the first phase that returns a terminal decision wins**.
- Framed daemon RPC validates each method's request shape, including nested hook metadata
  and administrative arguments, before dispatch. The client accepts only matching-id responses
  with the expected method result shape. Malformed frames do not become successful decisions;
  the existing timeout and fallback behavior still applies.
- Raw hook events also validate consumed field shapes before dispatch. The generated
  hook's documented null optional fields normalize to absence; malformed identities,
  controls and collections still fail closed. Future provider names and extra fields
  remain supported. Replay records retain their stricter captured-record contract.
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
  bare command blocks. A quote around ONE shell word is an operand, not a mention: it stays
  visible, so `truncate -s 0 "src/app.ts"` blocks like its unquoted twin, while a quoted body
  with whitespace or a metacharacter (`git commit -m 'rm -rf /'`) stays masked. A quoted
  argument of `eval` (or of `bash -c`, `python -c`, `node -e`) is code and is scanned. Compound
  commands (`&&`, `||`, `;`, `|`, newline) are decomposed and each part checked.
- If a stopping rule matches only data, you get `[interlinked:guard] rule <id> matched inside a
  string literal (…); not blocked` instead of a block. Data here is a `harness test` argument, a
  grep/rg pattern, an echo/printf argument, or a string in a `node -e`/`python3 -c` program with
  no `child_process`/`subprocess`/`system`/`exec`. If the text can reach `sh`, `bash`, `eval`,
  `xargs`, or a script that the same command runs, the block stands.
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

## Warnings: `[proven]` vs `[heuristic]`

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

Codex `Stop` and `SubagentStop` request continuation only for an explicit harness
`block`. Its reason is preserved before any additional context or warnings. An
`allow` or `ask` decision emits no stdout; diagnostics stay on exit-0 stderr for
operator inspection, not model-visible continuation. These events have no native
approval channel. Pending hook-coverage evidence alone does not force another turn
or become checked by allowing completion; inspect coverage status separately.

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
| `self_import` cannot place the file in ONE project | the same `NOT MEASURED` warning on that edit only (for a probe under the repo-root `scratch/` it is a one-line notice with no remedy, because no tsconfig includes `scratch/` by design), naming the cause: a tsconfig on the walk (nearest config, its `extends`, its `references`, its sibling `tsconfig*.json` files) could not be parsed; two projects both claim the file; the reference walk hit its 32-project bound with projects unvisited; no config in reach claims the file by a `files`/`include` pattern (a `.js`/`.jsx`/`.mjs`/`.cjs` importer is matched by pattern even when the project never enables `allowJs` — a JS self-import is a runtime fact); or the importer's directory is not on disk yet. The check resolves with the project's own compiler options and caches nothing, so fixing the config applies on the next edit. In a batch (`write --batch`, `multi-edit`, `verify-changeset`) it sees the whole proposed batch, and the baseline is judged against the disk |
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

With explicit `structural_checks.test_first_mode: "enforce"`, an empty repository
does not exempt new JS/TS or Python source from companion-test requirements. Write
the first meaningful test, observe its failure, then implement the behavior. Existing
pair-debt workflow remains available after a suite exists; warning mode stays advisory.
This creation gate does not itself prove that every later change followed red–green TDD.

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

## Instruction packets: `[interlinked:packet]` (opt-in; warn, or ask at cosign)

An instruction-file rule that no regex can decide alone (CLAUDE.md, AGENTS.md,
memory) can be compiled into a *packet*: a deterministic trigger, a regex
decider for what IS decidable, and one Jev yes/no question for the residue
(`docs/design/instruction-jev-evaluator.md`). Off unless `packets.enabled` and
`jev.enabled` are set in `guard-rules.local.json` with an explicit
`evidence_consent`. Nothing a packet says ever blocks; only a `cosign` packet can turn an allow into an ask.

A delivered line looks like:

```
[interlinked:packet] [heuristic] prefer-rg p=0.91 ≥ τ 0.85 — "Prefer `rg` over `grep`/`find` …" (CLAUDE.md)
  ↳ evidence: grep -rn "foo" src
  ↳ adjudicate: interlinked packets adjudicate prefer-rg:3f9a1c2e:248:1a2b3c4d:5e6f7a8b true|false|unsure
```

It appears only for a packet at `warn` or `cosign` whose judgment crossed its
measured tau on THIS runner and model, or whose deterministic `violated`
pattern matched. A trajectory finding (a rule over a whole turn, judged at Stop;
the line names the call by seq) rides the NEXT tool call's warnings, because a
Stop warning reaches no agent. Read it as a `[heuristic]` finding: follow the quoted rule if
it applies; if the warning is wrong, say so with the printed adjudicate command
(`true` = the rule was violated, `false` = false positive). Adjudications feed
`interlinked packets calibrate score` as a labeler and demote a packet whose
precision falls. A packet promoted to `cosign` (explicit, after enough
adjudications) can turn an `allow` into an `ask` before a call runs, but only while one of its
`cosignals` names a rule the guard runs here (the rule whose allow it tightens; the ask names that
rule). `interlinked packets status` shows each cosign packet's pair, or `UNPAIRED`, with its asks
delivered and withheld. A cosign packet never turns anything into a block, and never loosens a block or an ask. Do not edit `.interlinked/instruction-packets.json` by hand:
it is a water-line; `packets compile`, `packets calibrate score --apply`,
`packets release` and `packets restore` are the only writers.

A line of the form `[interlinked:packet <id>] not live here (<reason>); instruction released from <file>, verbatim:` followed by
rule text means that rule's words were RELEASED from the instruction file (`interlinked packets release <file>`, allowed only
for a packet at warn/cosign, never from a global `~/` file) and the packet is not enforcing it in this session (Jev off, no key, the file changed since
compile, demoted, another runner, daemon down, spend cap). Follow the quoted text exactly as if it were still in the file. It arrives at SessionStart on Claude Code, Codex and Factory Droid, and
on the first model-visible tool call of the session on Copilot, Gemini, Cursor, OpenCode and Pi (their SessionStart hook is not model-visible).
It arrives again on a later tool call when a packet stops being live mid-session (spend cap, Jev outage, a slow judgment),
and on every model-visible PostToolUse with the daemon down (and at every SessionStart) until the hook records that the model received it
(`.interlinked/packet-fallback-delivered.jsonl`; the hook writes a receipt only when the line reached a model-visible channel whole).
`interlinked packets budget [--runner <id>]` shows, per instruction file, what is held by Pass 1 rules, by live packets
(net releasable characters, or 0 with the reason the release would refuse), by releases (live, or `released_fallback` when not live
for that runner), and by shadow packets; `interlinked packets restore <file>` puts released text back byte-for-byte.
If release or restore reports an interrupted run, run `interlinked packets restore <file>`: the words are always in at least one place.
If release, restore, `packets compile` or `packets calibrate score --apply` reports that another run holds `.interlinked/instruction-packets.json.lock`, or is taking over a stale lock, run it again when that run ends; a dead holder's lock is taken over.
If one reports that a killed run left a takeover guard (`…lock.takeover-<hex>`) and no packet command is running, delete that file and run again.
If release or restore reports that the instruction file is not valid UTF-8, fix the bytes first; neither command changes a file it cannot decode exactly.
If a release reports that a span holds another packet's pointer line, restore that packet first, then release.
A write that clears a release while the instruction file still holds only its pointer is refused (`release-removed`): run `interlinked packets restore <file>` instead.
Judgment ids carry an 8-hex token of the whole session id; labels saved under the older session-prefix form still join where unambiguous.

## Compiler acceleration

The separate Bash compiler accelerator recognizes `tsc` / `npx tsc` only in
executable positions of flat, quote-aware command lists. Quoted search patterns
and look-alike names are never compiler invocations. Commands with comments,
newlines, substitutions, or grouping run unchanged through the normal tool.

## TypeScript check scheduler (off by default)

`[interlinked:typescript] deferred by scheduler (p=0.xx)` means the daemon
did not run tsc for that edit. A logistic over free edit features predicted a
clean result. This is not a pass. The file stays in a per-session deferred set
until tsc runs. The next edit that the scheduler runs checks the set, and Stop
always checks it. A Stop drain with type errors or without a verdict blocks
Stop. Do not describe a deferred edit as type-checked. The scheduler is OFF by
default. It is calibrated on one repository (interlinked-cli) and does not
transfer across repositories. Only `guard-rules.local.json` can enable it:
`{"quality_checks":{"typescript":{"scheduler":{"enabled":true}}}}`. An edit that
changes an import line is never deferred. To list the deferred runs, use
`interlinked query checks --where scheduler.deferred=true`.

## False-positive filter for `[heuristic]` findings (off by default)

`[interlinked:fp-filter] [heuristic] N findings suppressed by fp_filter (p<…)`
means the daemon withheld N `[heuristic]` findings that a free logistic (check
id, path class, severity, repeat count, message length) scored as probably not
worth a fix. It never touches `[proven]` findings, `pre_block` checks or blocking
results. The filter is OFF by default. It is calibrated on one repository
(interlinked-cli: holdout AUROC 0.906, kept 26/26 true positives, suppressed
66/122 false positives). Only `guard-rules.local.json` can enable it:
`{"fp_filter":{"enabled":true,"mode":"downgrade"}}` (`"hide"` gives the count
only; `min_p` moves the cut). Each suppressed finding is still recorded in
`check-results.jsonl`. To audit them, use
`interlinked query checks --where fp_filter_suppressed=true`.

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

Hook invocations record their transport outcome in
`.interlinked/hook-transport.jsonl`: `daemon` means a valid daemon response,
`cold` means fallback, and `suppressed` means intentional repeated-Stop
suppression. Correlate `event_id`, `session_id`, `native_event`, `hook_pid`,
`socket_path` and `protocol`. The hook PID identifies the receipt writer;
verify daemon PID ownership separately. Daemon activity rows carry
`writer: "daemon"`; the generated hook also writes activity, so an unmarked
activity row is not proof of daemon handling.
If the configured daemon socket is unreachable — including a **zombie** with a live process but
dead listener — every ordinary hook phase enters a cross-process, single-flight recovery path.
Daemon absence alone does **not** blanket-block safe reads, diagnostics, or repair work. The
current call proceeds in degraded mode after the inline deterministic subset runs:
merge-conflict markers, **destructive commands**, **package installs**, graph-shard protection,
and file-dump limits. Native fallback also enforces local guard-prediction reconciliation;
physical file size only advises. Checks needing the full evaluator are explicitly
unavailable rather than silently reported clean.

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
- **Shadow trajectory observations** are recorded in `check-executions.jsonl` as
  `hook-observation.v1` rows (`kind: trajectory`), without model warnings. They preview
  possible rules and do not enforce the reported action. Enforced trajectory rules remain active.
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
  Toggle commands fail and preserve malformed or non-object local guard rules for repair.
  Review selects the newest pending item when `--key` is omitted. Explicit empty or
  whitespace-only keys fail before writing a decision.
- **Decision shadows** (opt-in `decision_shadow` in guard-rules.local.json) log a model's
  second opinion and never change a verdict. A `guard_block` row means a shell block was
  asked "is this destructive as written?": `would_release` (p < 0.1476) says the model saw
  no destructive action, and `would_hold` says it agrees with the block. A `secret_hit` row
  means a secret signature was asked "is this a real credential?": `would_clear`
  (p < 0.479) says it is likely a placeholder or fixture, and `would_keep` says it is
  likely real. Release rate = `would_release` rows / all `guard_block` rows; read them with
  `interlinked query .interlinked/decision-shadow.jsonl --where surface=guard_block`
  (add `--by verdict` for the split). A release is NOT permission: the block still stands.
  The same ledger holds the edit-shadow rows (`surface=edit`, question
  `edit_needs_verification_v1`); every row kind keys its session as `session_id`.
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

## References

Read a reference file only when the task needs it.

- [references/guard-prediction.md](references/guard-prediction.md): the guard-prediction oracle, its receipts and reveals, `PostToolBatch` check coalescing, Stop advisories, external-path checks and warning-occurrence records.
- [references/managed-push.md](references/managed-push.md): the managed push handoff for protected pushes, its typed fallbacks and the trace variables.
- [references/guard-notes.md](references/guard-notes.md): commit-time function-token diagnostics, `INTERLINKED_RUNTIME_POLICY=local-restricted`, remote-pipe detection and `[interlinked:decision-metrics]` advice.
- [references/filesystem-observations.md](references/filesystem-observations.md): watched policy files, `harness coverage status`, background coverage recovery, `accept-policy`, native translations and the optional-chain check.
- [references/bash-effects.md](references/bash-effects.md): Bash effect ChangeSets, `[interlinked:effect-residue]` and `[interlinked:sandbox]` evidence.
- [references/permission-proposals.md](references/permission-proposals.md): permission-learner proposals, dormant `active_when` predicates, the baseline-effect guard and NOT CHECKED detector failures.
- [references/typescript-history.md](references/typescript-history.md): the opt-in `session_tsc_history` Stop check.

## Related skills
- **interlinked-verify** — the check catalog behind the warnings, `interlinked verify`, and how to land edits through the gates.
- **interlinked-quality-gates** — advisory file size and the coverage/complexity/function-token ratchets.
- **interlinked-supply-chain** — the package-install gate in detail.
- **interlinked-setup** — starting/restarting the daemon, `doctor`, config.
