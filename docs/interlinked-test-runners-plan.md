# Custom build/test commands — design plan

Status: proposal (pre-PR design)
Target repo: `github.com/QuentinCody/interlinked-cli`
Updated: 2026-09-02 (trimmed to v1 scope: custom build/test commands)

Operator material — not part of the public docs tree. In-source citations use
repo-relative paths.

## 1. Goal

Let a project declare its own **build and test commands** once, and have
Interlinked honor them everywhere it spawns tooling — PostToolUse per-edit
checks, `affected_tests`, `interlinked verify`/`check`, and the per-edit
coverage gate.

Motivating case (an internal Go workspace): the project's verification must run
`go test -tags 'dev devaccounts' ./...` — the same tags `air` uses for the dev
build (`go build -tags 'dev devaccounts'`), so both share Go's build cache.
Today the CLI cannot express that: every runner hard-codes its argv, and there
is no full-suite test tool at all.

## 2. Current state (what must be reused, what's actually missing)

| Concern | Where it lives today | Reality |
|---|---|---|
| Per-check `command` config | `QualityCheckConfig.command` (`src/harness/types/config.ts`) | **Not a real override.** `tool-check-loop.ts` routes command-backed checks through `runCommandCheck`, which ignores the string and maps the check *name* to a catalog runner (`configNameToToolId`) running its **hard-coded** argv. |
| Build/lint/tool runners | `src/harness/check-engine/tool-runners/{go,rust,python,…}.ts` | Hard-coded argv (`go build ./...`, `golangci-lint run --out-format=json ./...`, …). |
| `affected_tests` test execution | `src/harness/quality-checks/test-dispatchers.ts` | Per-language dispatch (vitest/pytest/cargo/go) with hard-coded argv (`go test -count=1 ./<pkg>`, `pytest -x …`). |
| Full-suite test driver | — | **Missing.** No `*-test` tool id in the catalog; only the coverage gate runs suites. |
| argv-form suite override (the good precedent) | `CoverageRunOpts.testCommand?: string[]` (`src/harness/coverage-runner.ts`) + per-language defaults in `coverage-runner-commands.ts` | Correct shape (argv, no shell, bare-bin→`node_modules/.bin` resolution), but only exercised by tests — **never wired to config**. |
| Heavy lane + no-verdict semantics | `src/harness/project-heavy-process-lock.ts`, `verify.ts` (`verify deferred`), `test-process-gate.ts` | Present and reused as-is. |
| Tool catalog + surface guards | `src/harness/check-engine/tool-catalog.ts`, `check.ts` (`ALL_TOOL_IDS` drift guard), `verify/tool-ids.ts`, `verify/verify-tools.ts` | Adding one tool id is mechanical; guards catch missed wiring. |

**Delta:** (1) one config surface, (2) thread it through the three executors,
(3) one new full-suite test tool (`go-test`).

## 3. Config surface

Dedicated two-tier pair — `.interlinked/tool-commands.json` (team, committed)
+ `.interlinked/tool-commands.local.json` (personal, gitignored). Not
`guard-rules.json` (that is PreToolUse *guard* policy with a security
whitelist that forbids team commands — a different axis) and not
`check-policy.json` (per-check *action* policy).

Keyed by the existing **check/tool config names** (`go_build`, `go_test`,
`golangci_lint`, …), resolved to tool ids via the existing
`configNameToToolId` map. The shared vocabulary lets one key reach the check
engine, `interlinked verify`'s streaming phase, and the `affected_tests`
dispatchers.

```jsonc
// .interlinked/tool-commands.json
{
  "version": 1,
  "tool_commands": {
    "go_build": {
      "base_args": ["-tags", "dev devaccounts", "./..."],
      "timeout_ms": 300000
    },
    "go_test": {
      "base_args": ["-tags", "dev devaccounts", "./..."],
      "timeout_ms": 300000
    }
  }
}
```

Note the argv is NOT shell-interpolated: air's `-tags 'dev devaccounts'` is ONE
argv token (`-tags`, `dev devaccounts`) — two separate tokens would make
`devaccounts` a bogus package pattern.

Per-entry fields (all optional):

| Field | Meaning | Team tier? |
|---|---|---|
| `command` | Full argv override. Wins over default prefix + `base_args`. | **No** — arbitrary executable; personal-tier only (mirrors `QUALITY_CHECK_SAFE_FIELDS`). |
| `base_args` | Appended after the detected default prefix, REPLACING the default scope, e.g. `go build`/`go test` + `["-tags","dev devaccounts","./..."]`. | Yes (flags for a fixed binary — trusted like a committed Makefile). |
| `env` | Extra/overriding env vars for the spawned process. | **No** — can rewire the runtime; personal-tier only. |
| `timeout_ms` | Per-run cap, within a hard CLI ceiling (10 min) that config cannot exceed. | Yes (a bounded cap, never executable — same tier as `quality_checks.timeout_ms`). |

Precedence: `command` > default prefix + `base_args` > default.

Validation (enforced on load, surfaced by `interlinked doctor`):

- **Unknown tool keys allowed** (forward compat — a newer config on an older
  binary) → reported as `tool not available on this version`, never fails the
  whole verify.
- **Unknown fields inside a known tool are schema errors** naming the key
  (a `base_argz` typo fails loudly, not silently).
- **Team-tier trust violations** (`command`/`env` in the committed file) are
  errors telling the author to move them to `tool-commands.local.json`.
- Commands are argv arrays. No strings-in-shell, no `&&` chains — matches the
  `CoverageRunOpts.testCommand` contract.

## 4. Thread the override into the executors

One resolver, three consumers:

`resolveToolCommand(toolId, projectRoot, defaultPrefix)` — reads the two-tier
`tool-commands*.json` pair, applies the team/local trust split, and returns
`{ argv, baseArgs, env, timeoutMs }` (or the `defaultPrefix` when unconfigured).
Pure, unit-testable (`src/harness/check-engine/tool-commands.ts`).

1. **Check-engine catalog runners.** `ToolRunnerInput` (`src/harness/check-engine/types.ts`)
   gains the resolved command; `runGoBuild`/`runGolangciLint`/`runGoTest` spawn
   `override.argv ?? defaultPrefix + baseArgs`. `CheckEngine` resolves once per
   instance from `projectRoot`. Sync + async variants (`runGoBuildAsync` …) so
   PostToolUse's async engine path runs the configured command too.
2. **`affected_tests` dispatchers.** `runAffectedTests` (`tool-check-loop.ts`)
   feeds the resolved `go_test` entry (base_args, env, timeout) into the go
   dispatcher via its existing input shape, so PostToolUse on a `.go` edit runs
   `go test <tags> -count=1 ./<pkg>` — the full-suite `./...` scope token is
   replaced by the touched package. Other dispatchers unchanged in v1. The
   `runBoundedTestProcess` lane and pre-existing-failure classification stay
   as-is. An explicit `command` override is used verbatim (caller owns argv).
3. **Coverage gate.** Deferred in v1 — `CoverageRunOpts.testCommand` is not yet
   wired (the per-edit coverage gate covers js/ts/python only, which this Go
   feature does not touch).

## 5. New full-suite test driver: `go-test`

The genuinely new capability — nothing except the coverage gate can run a
project's test command today, and the coverage gate's shape isn't a
verification surface.

- **Catalog row** (`src/harness/check-engine/tool-catalog.ts`): id `go-test`,
  config name `go_test`, project-wide (no `extensions`), `concurrencySafe:
  false`, `requiresConfig: ["go.mod"]`, default prefix `["go","test","./..."]`,
  version probe `go version`. Follows the `go-build` row exactly.
- **Runner** (`tool-runners/go.ts` or a sibling `go-test.ts`): `defaultPrefix`
  + resolved `tool_commands.go_test.base_args`/`command`/`env`/`timeout_ms`,
  spawned argv-form via the existing process helpers.
- **Parsers** (`tool-runners/test-parsers.ts`): a **generic fallback** (exit
  code + last N stderr lines) so any test command yields a verdict, plus a
  **Go parser** (`--- FAIL: TestX`, `FAIL <pkg>` package trailers, `panic:`)
  for per-unit blame. Non-zero exit → one finding for the run plus one per
  parsed failing test.

Verdict semantics (shared with the existing surfaces):

| Outcome | Meaning | Report |
|---|---|---|
| `ok` | Ran; exit 0 | Checked clean (`[proven]`) |
| `skipped` | Not a Go project (`go.mod` absent — `requiresConfig` unmet), or a forward-compat key this version can't run | NOT CHECKED / skip entry |
| `unavailable` | Should have run but didn't (timeout, lane held, binary missing) | No verdict — never clean; deferred/exit 1 like today's `verify deferred` |

Full-suite runs ride the existing project heavy lane (`tryAcquireProjectHeavyProcessLease`);
a held lane yields `verify deferred` unchanged. `interlinked write` /
`verify-changeset` / `multi-edit` stay content gates and never run suites.

## 6. Surface wiring (mechanical)

- `ToolId` union (`src/harness/check-engine/types.ts`): `go-test`.
- `go-build`/`golangci-lint`/`go-test` rows honor `tool_commands` for build and
  test.
- `ALL_TOOL_IDS` (`src/commands/check.ts`): `go-test` — the compile-time
  `_MissingToolIds` guard fails the build if missed.
- `TOOL_IDS` (`src/commands/verify/tool-ids.ts`): `go-test`, so
  `verify --only go-test` works on streaming and `--json` paths.
- `TOOLS_TO_RUN` (`src/commands/verify/verify-tools.ts`): a `go-test` row with
  its resolved command, so the streaming phase runs it with the same
  spinner/summary treatment as tsc/biome.
- `check --report` / discovery: free, via the catalog row.
- `tool-catalog.test.ts` pins the new derivations; update in the same PR.

## 7. Milestones (PR-sized)

1. **Config:** `tool_commands` types + two-tier loader + precedence + validation
   (forward-compat unknown keys, schema errors on bad fields); `doctor`
   reporting. Unit tests.
2. **Build overrides:** `ToolRunnerInput` gains resolved command; `go_build`
   and `golangci_lint` honor it; `affected_tests` go dispatcher honors
   `go_test` tags. Integration tests assert the *spawned argv*, e.g. that a
   configured `-tags dev devaccounts` shows up in the actual command.
   (Coverage-gate wiring stays deferred — it covers js/ts/python only.)
3. **`go-test` tool:** catalog row + runner + generic/Go parsers + verdict
   semantics + `check`/`verify` wiring + `check --report`. Heavier-lane reuse.
4. **Docs/tests/changelog:** README example (the acceptance config below),
   `npm run docs` for any generated tool/reference output, registry-parity and
   catalog-drift test updates, CHANGELOG.

## 8. Deferred (explicitly out of v1)

- Full-suite runners for rust/python/node, and per-unit blame parsers for them
  (the generic fallback already yields an honest verdict for any language that
  gets a `command` override later).
- `verify --json` per-runner blocks, advisory/default-gate policy debates,
  consolidating `TOOLS_TO_RUN` onto `TOOL_CATALOG`.
- Go coverage in the per-edit gate (stays js/ts/python).

Extension path is unchanged: a new language = one catalog row + one resolver
lookup, no core rewiring.

## 9. Acceptance example

```jsonc
// .interlinked/tool-commands.json
{
  "version": 1,
  "tool_commands": {
    "go_build": {
      "base_args": ["-tags", "dev devaccounts", "./..."],
      "timeout_ms": 300000
    },
    "go_test": {
      "base_args": ["-tags", "dev devaccounts", "./..."],
      "timeout_ms": 300000
    }
  }
}
```

`interlinked verify`/`check` run `go build`/`go test` with the air-aligned
tags (sharing its Go build cache), PostToolUse on a `.go` edit runs the
touched package's tests with the same tags, and a failing test or package
produces `[proven]` findings — while a held lane or timeout reports deferred,
never clean.

Measured on the motivating Go workspace (isolated `GOCACHE`, 2026-09-03):

| Surface | Command | Cache state | Wall |
|---|---|---|---|
| BEFORE (stock install) | `check --only go-build` | untagged `go build ./...`, no shared cache | 8.7 s |
| AFTER (feature) | `check --only go-build` | tagged, air-warmed cache reused | 6.0 s |
| AFTER (feature) | `check --only go-test` | tagged, warm | 21.0 s |
| Reference | `go build -tags 'dev devaccounts' ./...` | no pre-warm | 29.3 s |
| Reference | `go test -tags 'dev devaccounts' ./...` | no pre-warm | 84.4 s |

The after-run hug the warm baselines (6.0 vs 5.5 s build; 21 vs 23 s suite)
because air's rebuild leaves the exact tagged cache the project commands reuse;
the cold references (29.3 s / 84.4 s) are what the same commands cost without
that reuse.