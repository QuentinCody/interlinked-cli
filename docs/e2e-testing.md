# E2E testing

The e2e lane runs built hook processes against a fresh daemon and temporary git
repository. It never needs the developer's daemon. Base/unit/integration runs
exclude `*.e2e.test.ts`; Vitest discovery tests enforce the partition.

```sh
npm run build:e2e
npm run test:e2e
npm run test:e2e:coverage
node dist/index.js coverage check --lane e2e --strict --require-measured
```

`build:e2e` emits source maps and a metafile. The collector assigns every run a
private V8 directory, starts the CLI once, and records clean child exits. It
loads otherwise orphaned writer bundles to retain their uncalled functions in
the zero-hit model. The merger requires every executable boundary file to have
a loaded source map. Daemon-only and hook-entry-only coverage must be positive;
the uncalled functions in `break-glass.ts` must remain zero-hit. Missing models
are errors. Generated hook strings have behavioral proof cases instead of line
coverage. No additional package is required: conversion uses the converter in
the repository's locked `@vitest/coverage-v8` installation.

The collector invalidates the previous canonical success before starting.
`coverage-e2e/run.json` is published last and binds a passing run to build and
test inputs, the discovered test set/import closure, inventory and report.
Inputs are checked again after collection and conversion. Reports from a failed
or stale run cannot initialize or update a baseline.

## Fixture and assertions

Use `interlinked e2e scaffold <name> [--event Stop] [--tool Bash] [--dry-run]`.
The scaffold deliberately fails until an author supplies a behavioral assertion.
The fixture supplies raw, framed and dual listeners, deterministic config,
sanitized child environments, isolated ledgers and clean shutdown. Graph
prediction is explicitly enabled in its shared config. Fixture activity rows
are assertion subjects; the repository's `test-events.jsonl` records test runs.

Every daemon-backed hook assertion calls `fixture.assertServed(result)`. That
requires a fresh matching `hook-transport.jsonl` receipt with outcome `daemon`
and verifies the fixture's PID owns the socket. Receipt `hook_pid` is the hook
process, not the daemon. Cold and repeated-Stop cases must assert `cold` and
`suppressed` respectively and cannot claim daemon service. Daemon activity
additionally carries `writer: "daemon"` and correlates through `event_id`.

For a paired PreToolUse/PostToolUse cycle, send the same native `tool_use_id`.
This is essential for the baseline effect guard's before/after pairing. Stop
output is compacted; full details remain in the fixture's `stop-digest.jsonl`.

The former live probes are covered by protocol, graph-protocol, hook-script,
cold-fallback, pulse, verify-stop and stability e2e suites. The mutation probe
was a direct library call, so its real Stryker clean/uncovered/test-first/red/
oversize scenarios are an isolated integration test; mutation availability
also has real daemon e2e cases. No test overlays the repository's product files.
`E2E_STABILITY=1 npm run test:e2e` enables the 5,000-event/100-session case;
the ordinary lane retains a 100-event latency check.

## Baseline transactions

Initialize once using a current measured run:

```sh
node dist/index.js coverage check --lane e2e --init-baseline
```

The command refuses an existing baseline. `--update-baseline` saves only a
passing result. All writers share one cross-process lease, re-read inside it,
and publish by atomic rename. Failed/unmeasured operations preserve the bytes.
All four per-file percentages plus touched-file share and weighted line coverage
must meet their floors. Counts are measurements, not independently monotonic.

Deletion retires the deleted code's obligation without forgiving any surviving
file's decrease. Deletion plus addition requires an explicit identity decision:

```sh
node dist/index.js coverage move --lane e2e src/old.ts src/new.ts
node dist/index.js coverage retire --lane e2e src/deleted.ts
node dist/index.js coverage check --lane e2e --map A=B --map B=C --update-baseline
```

Moves preserve entries. Atomic measured mappings must meet the transferred,
destination pre-write and base floors; they allow recovery chains that a plain
move cannot satisfy. Intent and effect guards check these values and tree
evidence even when the caller is the CLI. `--changed-files` is rejected.

`interlinked coverage status` lists quality coverage lanes, while
`interlinked harness coverage status` reports filesystem observation coverage.
Local comparisons use HEAD. CI computes the PR merge base or the push event's
previous SHA and passes `--base`. Missing history, a zero predecessor and a
non-ancestor predecessor fail. Pre-push mirrors the lane; the explicit
`INTERLINKED_PRE_PUSH_SKIP_E2E=1` opt-out writes a skipped e2e event.

The initial measured baseline contains 167 executable boundary files, with
163 touched and 3,202 of 8,377 lines covered (38.2237% weighted). It was created
through `coverage check --lane e2e --init-baseline` after a passing 54-test lane,
then accepted by a separate strict comparison. These are starting floors;
uncovered code remains visible in the inventory.

## Stop calibration evidence

On 2026-09-22, a fixed-size replay of the live `activity.jsonl` scanned
1,348,136,108 bytes and 332,572 complete rows with a 2026-08-23 date cutoff.
It used explicit ceilings of 2 GiB, one million rows and 1 MiB per row.
There were **26 candidate warnings / 124 observed sessions (21.0%)**.
The newest 20 candidates were manually reviewed against their boundary edits;
all 20 were appropriate e2e requests (20/20 in this sample, above the 80% bar).

| Session prefix | Boundary change warranting an e2e test |
| --- | --- |
| `01a0c9fa` | Remove the Jev consumer from daemon Stop dispatch |
| `01a0a08c` | Codex native Stop and post-tool dispatch |
| `30b4226d` | Jev Stop integration and lifecycle wiring |
| `30dbf703` | Capture a zero-valued pre-edit baseline for new files |
| `e4ae1501` | Carry disabled-coverage reasons through lifecycle evidence |
| `01a0964b` | Isolate local capture from remote failures |
| `db061734` | Content-scan tool-name handling |
| `b7f34ab0` | Hook coverage scheduling and dispatch |
| `01a075ff` | Pre-tool stages, daemon client and mutation receipts |
| `01a0814b` | Cowork native events and transport |
| `01a07209` | Provider hook contracts and decision translation |
| `01a0721d` | Evidence and execution-journal writers |
| `01a07d50` | Generated destructive-command parsing |
| `344d9ff3` | Daemon startup dependency diagnostics |
| `620ab0be` | Actor/session propagation through pre/post hooks |
| `3dc1bfce` | Ledger paths and daemon/hook imports |
| `01a072b5` | Async file leases across capture writers |
| `01a030ba` | Coverage gates, installed hook commands and startup locking |
| `7e2d474d` | Audit-chain head recovery |
| `01a0540e` | Metric-gate helpers across hook entry and daemon dispatch |

Scope limits: 369 oversized rows were omitted; retained archives and native
transcripts were not scanned. The evidence index was stale (last indexed
September 6), so this replay read the live file directly. Its edit-path and
command reconstruction is a retrospective approximation, not an assertion
that every session or invocation was captured. Missing capture is not proof
that tests never ran. Local reproducibility artifacts are
`scratch/e2e-stop-replay.mjs` and `scratch/e2e-stop-calibration.json`.
The nudge remains advisory. Executable MUST-FIRE and MUST-NOT-FIRE cases cover
session attribution, adapters, ordinary files and test files.
