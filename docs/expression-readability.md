# Expression readability and the project E2E doctor

Interlinked CLI now measures executable expressions independently of whole-function
complexity. The checks run through the shared registry and PostToolUse path, are
available in `verify --all-checks`, and have a direct inventory command:

```sh
interlinked metrics expressions src/example.ts --cwd /path/to/project --json
interlinked metrics expressions src --cwd /path/to/project
```

This is advisory JS/TS analysis. It does not invoke an agent, rewrite code, score
domain correctness, or add heuristic PreToolUse blocks. Installed agent clients
share the same checks and source skills.

## Measurement contract

The counter identity is `interlinked-expression-v1`. It uses the optional TypeScript
parser already shipped by the CLI. Parse recovery or a missing parser produces
NOT CHECKED; the inventory command exits 2 for unavailable, unsupported, or empty
scope, and 0 for a measured inventory even when findings exist.

| Check | Default advisory policy |
|---|---|
| `expression_size` | More than 60 non-trivia syntax tokens |
| `ubs_deeply_nested_callback` | More than 2 inline callback levels |
| `inline_callback_count` | At least 3 inline callbacks in an expression |
| `control_flow_depth` | More than 3 nested control-flow levels |
| `nested_ternaries` | A conditional expression contains another conditional expression |
| `required_braces` | A multiline control-flow body lacks braces; single-line guards and `else if` chains remain allowed |
| `statements_per_line` | Multiple sibling statements start on one physical line |
| `expression_measurement` | Syntax or policy could not be measured |

Boundaries include variable/property initializers, assignment RHS values, returns,
throws, expression-bodied arrows, conditions, individual call/new arguments, and
expression statements. An inline callback is an arrow/function expression passed
directly as a call/new argument, allowing transparent parentheses/assertion wrappers.
Its body contributes syntax tokens. Callback count/depth resets at other function
boundaries; control-flow depth resets at every function. Recognized test registration
calls (`describe`, `it`, `test`, lifecycle hooks, including member variants) in test
paths are excluded as containers; their bodies are still inspected.

Identifiers and literal tokens each count as one regardless of character length.
Comments and whitespace do not count. Template interpolations are executable syntax.
Literal-only arrays/objects are classified separately and do not receive token-budget
warnings. Type syntax within an executable expression still counts as syntax. This
first adapter does not infer whether arbitrary builders or object expressions are
declarative data.

Findings include line/end-line and UTF-16 half-open source offsets. The inventory
also supplies source hashes, effective limits, classifications and every measured
boundary. Per-check findings collapse into a containing actionable expression,
rather than warning for every ancestor. Directory completeness applies only to the
listed discovered JS/TS files; ignored/build paths and declaration-only files are
outside that directory inventory.

Optional project policy:

```json
{
  "version": 1,
  "limits": {
    "expressionTokens": 60,
    "callbackDepth": 2,
    "callbackCount": 3,
    "controlFlowDepth": 3
  }
}
```

Save this as `.interlinked/readability.json`. Omitted limits retain defaults.
Values must be integers from 1 to 10000; unknown fields are rejected. The nearest
ancestor policy applies, stopping at a git root. These preferences do not modify
protected complexity or coverage baselines.

PostToolUse compares whole expressions with captured pre-edit content, including
changes below an unchanged first line. Owner/label plus metric-value allowances
suppress held or reduced findings after movement/formatting. This matching is a
heuristic, not a semantic identity proof. Missing before-state yields an inventory,
not evidence that a finding was introduced. Presentation checks still inspect
whitespace-only edits because joining statements can introduce a finding.

## Enforce the presentation policy separately

Physical file size is advisory, including native cold fallback and
`verify --all-checks`; it is not a context-token budget. Historical line baselines
remain measurements, not reasons to compress source. See
[the cap decision and guard protocol](file-size-and-guard-prediction.md).

Generic brace advice defers to detected ESLint/Oxlint/Biome/Prettier configuration,
manifest style configuration, or an adopted lint policy. Detection does not execute
configuration or certify that a native rule ran; use the imported tool for that
evidence. The raw expression inventory still describes multiline unbraced bodies.
No brace autofix runs. Guard ownership is checked before the edit by the prediction
protocol, including single-line guard loss; adding braces afterward cannot repair
the lost intent.

`biome` adoption retains its lint-only behavior. The explicit `biome-format` adapter
runs read-only formatting checks, tracks configuration inheritance, and rejects
incomplete/zero-file output. Prettier adoption remains available for repositories
using Prettier. Interlinked does not install or replace the project's formatter.

`lint import --gate errors` preserves native ESLint/Oxlint/Biome severities. Warnings
remain visible in `introduced` JSON but do not enter `blocking`; errors and unknown
severity remain gating. Omitting `--gate` preserves the existing `all` policy.
`lint check` exits 0 for complete/no new gating findings, 1 for new gating findings,
and 2 when no complete measurement exists. Imported hooks continue to warn.

The doctor pilot is adopted with this bounded command:

```sh
interlinked lint import \
  --config biome-format=biome.json \
  --config oxlint=oxlint.readability.json \
  --scope src/harness/project-e2e \
  --target doctor.ts --target doctor-toolchain.ts \
  --cadence audit --gate errors --only-selected --write
interlinked lint check
```

Repeat `--target` to select files relative to `--scope`; it requires `--config`.
Existing imported profiles are retained, and re-import preserves targets, cadence
and gate policy. Working scope also bounds the runner's source snapshot: narrow
targets alone do not shrink a repository-root snapshot. No existing debt was
baselined for this pilot. The prior anti-slop profile remains adopted unchanged.

`biome.json` enables a four-space, 100-column formatter target for the two doctor
files. Other files keep their existing formatter policy. `oxlint.readability.json`
requires braces and warns on callback/control-flow nesting and nested ternaries.
CI and the exact-revision pre-push hook run `npm run format:check` and
`npm run lint:readability`. Formatting width is a target; long literal messages may
remain wider. A broader rollout should normalize a reviewed scope before extending
enforcement, without resetting protected line baselines implicitly.

## Exactly what the original doctor triggered

The input was the working-tree `src/harness/project-e2e/doctor.ts` saved before this
refactor, SHA-256 `dc92ffb4d5ea15e6a18ac89a636fe93ae776e240ec20834577a89eb20e1502e1`.
This is a file-specific example, not a repository-wide lint audit.

| Original line | Boundary | Finding |
|---|---|---|
| 37 | `contractsCheck` initializer `missing` | Callback depth 3; 4 callbacks; 46 tokens (no size warning) |
| 53 | `toolchainCheck` initializer `missing` | Callback depth 3; 3 callbacks; 62 tokens |
| 54 | `toolchainCheck` return | 62 tokens |
| 70 | `receiptsCheck` return | 63 tokens |
| 74 | `browserChecks` return | 85 tokens |
| 83 | `acceptanceCheck` return | 68 tokens |
| 100 | `doctorE2e` initializer `status` | Nested conditional depth 2 |

These are 10 expression findings: two callback-depth, two callback-count, five
token-size and one nested-ternary finding. Another 14 missing-brace findings occur
at lines 27, 28, 36, 41, 43, 51 (two), 52 (two), 61, 64, 81, 97 and 99.
There are no control-flow-depth or same-line-sibling findings in this original.
Formatting separately identifies the compressed layout.

The revised doctor and its command inspector have **zero findings** under these
budgets, pass Biome formatting, and pass the four-rule Oxlint profile. The imported
lint run also measures all three adopted profiles with zero findings.

## Behavioral changes and evidence

The doctor retains version 1 and adds optional `evaluation: "not-evaluated"` and
`prerequisites` fields. Absence of those fields means the check was evaluated.

| Requirement from the review | Implemented behavior and regression evidence |
|---|---|
| A caught ledger failure must not escape through receipt validation | One ledger read/reduction per run; receipt checks use that observation and report not evaluated after failure |
| Missing required contracts must not yield complete acceptance success | Resolve references first; acceptance identifies the contracts prerequisite instead of reporting success |
| Partial command knowledge must not yield complete toolchain success | Missing references prevent a complete toolchain success; independently known missing tools still fail |
| Preparation cannot excuse its own missing executable | Requirements retain phase and suite; preparation commands receive no artifact exemption |
| Unrelated suites cannot excuse absent commands | An expected generated command must match its own suite's declared artifact and preparation |
| Existence is not executability | POSIX inspection checks regular files and execution permission; directories/non-executable artifacts fail |
| Expected output is not verified availability | Same-suite missing generated commands warn explicitly that availability was not verified |

The focused cases live in `doctor-prerequisites.test.ts` and `doctor-toolchain.test.ts`,
alongside the existing `doctor.test.ts`. Playwright inspection is shared once per
project. Command inspection uses the runner's PATH/cwd, retains service PATH overrides,
and leaves placeholders/unsupported platform resolution unverified. It never runs
preparation and cannot guarantee a future execution will succeed.

These correctness fixes do not follow from expression metrics. Agent guidance now
asks reviewers to preserve provenance, model prerequisites explicitly and test
unsupported success claims. A named predicate hiding the same incorrect rule is
not a fix. Explicit loops and readable named pipelines are both acceptable.

The old generated cyclomatic description claiming every below-cap rise was forbidden
was corrected to match the cap/grandfather behavior. No cap was lowered to force
smaller functions, and no protected baseline was weakened.
