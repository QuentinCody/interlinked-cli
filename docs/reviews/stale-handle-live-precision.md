# Stale-handle detector — live precision (2026-11-05)

Detector: `detectStaleHandleHandlers` (`src/harness/jev/implicit-state-machine-stale.ts`),
AST only. Base: `origin/mutation-proof` @ `1c05597`. Driver: a 10-line tsx script calling
`detectStaleHandleHandlers(content, file)` on every non-test, non-`.d.ts` `*.ts` under the
listed root (dirs `node_modules`, `test(s)`, `__tests__`, `__fixtures__`, `dist` skipped).

## Corpus and fire rate

| Repo (commit) | Root | Files | Lines | Findings | per 1k lines |
|---|---|---|---|---|---|
| interlinked-cli (`1c05597`) | `src/` | 2298 | 423,792 | 2 | 0.005 |
| mqttjs/MQTT.js (`0ceae41`) | `src/` | 32 | 6,668 | 0 | 0 |
| redis/ioredis (`e85d81b`) | `lib/` | 61 | 20,368 | 0 | 0 |
| paulmillr/chokidar (`a9ef522`) | `src/` | 7 | 4,835 | 0 | 0 |
| pladaria/reconnecting-websocket (`05a2f7c`) | `.` | 2 | 557 | 0 | 0 |
| microsoft/node-pty (`35c28c7`) | `src/` | 13 | 1,653 | 0 | 0 |
| **Foreign total** | | 115 | 34,081 | 0 | 0 |

## Adjudication (every finding)

| # | file:line | Handler | Owner field | Reassigned at | Verdict |
|---|---|---|---|---|---|
| 1 | `src/harness/content-scanner/sidecar-manager.ts:319` | `child.on("exit")` → `rejectAllPending`, `this.child = null`, `dormant = true`, status `dormant` | `child` | `:284` (`ensureSpawned`), cleared in `shutdown` | **TRUE** |
| 2 | `src/harness/content-scanner/sidecar-manager.ts:307` | `child.on("error")` → same writes | `child` | `:284` | **UNSURE** |

**#1 TRUE.** `ensureSpawned` replaces the child when `this.child.killed` is true. The idle
close's SIGKILL fallback (`closeChildForIdle`, 1 s after the shutdown op is ignored) sets
`killed` synchronously while the `exit` event arrives later. A `send()` in that window spawns
child B; A's late `exit` then fails B's pending requests (`sidecar exited with code null`),
nulls `this.child` (orphaning a live B), and flips status to `dormant`. Reproduced:
`src/harness/jev/stale-handle-live.test.ts` `P1` fails on current code at its first
assertion (received `{ok:false, error:"sidecar exited with code null"}`).

**#2 UNSURE.** Same missing guard, but no path found where an already-replaced ChildProcess
emits `error`: spawn failure and `kill()` failure both fire before replacement can happen,
and there is no IPC channel. Recorded as `it.todo("UNSURE: …")`, no failing test claimed.

## Precision

| Scope | TRUE | FALSE | UNSURE | Precision (strict, UNSURE ≠ TRUE) | Conclusive only |
|---|---|---|---|---|---|
| interlinked-cli | 1 | 0 | 1 | 1/2 | 1/1 |
| foreign (5 repos) | 0 | 0 | 0 | 0/0 (undefined) | 0/0 |
| **overall** | 1 | 0 | 1 | **1/2** | 1/1 |

n = 2. That is not a precision measurement; it is two data points from one file.

## FP patterns (rules, not implemented)

No FALSE verdicts, so no observed FP pattern. One UNSURE pattern:
- **Non-terminal event on a replaced handle** — rule: count only terminal lifecycle events
  (`exit`, `close`, `end`, `disconnect`, `finish`) as stale-capable; report `error` handlers
  only when the same handler is also registered for a terminal event, or at lower confidence.

## Recall gaps seen while explaining the foreign zeros (not precision, but why n is tiny)

- Handler passed as a factory call / reference: ioredis `lib/Redis.ts:428-429`
  `stream.once("close", eventHandler.closeHandler(_this))` (KNOWN GAP in the header).
- `const _this = this` alias: ioredis `lib/Redis.ts:356` `_this.stream = stream` is not
  resolved as a field store, so inline arrows at `:366/:375/:407` are never considered.
- Registration on `this.f` instead of a local: MQTT.js `src/lib/client.ts:1124-1127`
  (exempt by design; whether those are guarded was not adjudicated).
- `addEventListener` is not in `REGISTER_METHODS`: reconnecting-websocket `:502-506`
  (method references, so also the by-reference gap).

## Recommendation

**Keep it internal for now; do not ship as `pre_block` or `pre_warn`, and do not demote it
for being quiet.** Fire rate measures the agent, not the check: 0.005/kloc here and 0 on
34k foreign lines says these codebases mostly clear it (and, from the recall gaps, that the
detector cannot see the idioms the foreign code uses), not that the class is rare — the one
conclusive finding is a real, reproduced bug. But `pre_block` needs ~zero FP proven on a
corpus, and 1 TRUE + 1 UNSURE from one file proves nothing either way. The next step is
not a ship decision but a bigger denominator: close the `_this`-alias and `addEventListener`
gaps (cheap, AST-only), then re-run on human-legacy and weak-agent JS/TS corpora. If
conclusive precision holds ≥ 80 % there, ship as a `post` advisory `[heuristic]` check
(Check Evidence Contract advisory tier: 1/1 cases, 80 % branch) with `error`-only handlers
down-ranked per the rule above.

## Commands run

- `npx tsx scan.mts <repo> <root>` ×6 (output above)
- `npx vitest run src/harness/jev/stale-handle-live.test.ts src/harness/jev/implicit-state-machine-stale.test.ts`
  → 1 failed (P1, intended), 8 passed, 1 todo
- `npm run typecheck` → exit 0; `npx biome check src/harness/jev/stale-handle-live.test.ts` → clean
