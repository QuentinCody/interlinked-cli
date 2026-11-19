# interlinked-verify: adopt existing project linters

Reference for [SKILL.md](../SKILL.md). Read it before `interlinked lint scan` or `lint import`.

### Adopt existing project linters

For expression-level review, run `interlinked metrics expressions <path> --json`
or `verify --all-checks`. `expression_size`, `inline_callback_count`,
`control_flow_depth`, `expression_measurement`, `required_braces`,
`statements_per_line`, `nested_ternaries` and `ubs_deeply_nested_callback` are advisory.
The callback check now uses exact syntax and defaults to >2 inline callback levels.
Generic brace advice accepts single-line guards, diagnoses multiline bodies, and
defers to detected target style configuration. Explicit imported brace rules retain
their native policy. Verify intended scope before adding braces; no bulk brace
autofix runs. Guard changes are handled before the edit by the prediction protocol
described in **interlinked-harness**. Physical file size (`large_files`) also belongs
to `--all-checks` advice, never a source-edit or verification block.
Missing parser/policy evidence produces NOT CHECKED, not a clean measurement. Use
**interlinked-quality-gates** for counting boundaries and `.interlinked/readability.json`.

Formatting requires explicit adoption of the project's formatter. `biome` imports
lint rules; `biome-format` imports read-only format checking with the same config and
inheritance tracking. Example: `lint import --config biome-format=biome.json
--target src/example.ts --only-selected --cadence audit --write`. Repeat `--target`
to bound rollout; targets are relative to `--scope` and require `--config`. `--gate errors`
keeps explicit native warnings advisory in `lint check`, while errors and unknown
severity remain gating. Default `all` preserves existing behavior. Both modes retain
all findings in JSON; cadence and gate survive re-import. Formatter-disabled or
zero-file runs cannot establish formatter compliance. Width is a formatting target,
not a hard maximum. Normalize a bounded scope first; avoid repo-wide churn or implicit
line-baseline resets. This repository's doctor pilot is enforced by CI through
`npm run format:check` and `npm run lint:readability`.

Biome sibling overlays can ignore literal-file overrides confined to another
directory. Overrides that may select the target or its temporary sibling still
require supported filename-invariant selectors; otherwise the overlay is unavailable.

`interlinked lint scan [directory] --json` inventories recognized lint configs,
manifest sections, declaration/selector candidates, ignores, scripts/aliases and task/CI evidence
across nested packages. `lint import` previews which sources can become imported
checks and which need review; `lint import --write --baseline` applies supported
scopes, enables `quality_checks.lint_import`, and measures existing debt.
Preview never executes configuration; the baseline run invokes installed analyzers.
A lockfile or other dependency context file (`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock` and the like) over
1,000,000 bytes is not read: the scan skips it, stays complete, and lists it under `skipped` in the JSON and as a
`SKIPPED:` line in text, with the note that changes to it are not tracked. Lockfiles under the limit are still
digested as dependency context, and an oversized configuration file is still a named gap that makes the scan incomplete.

The native adapters cover ESLint, Biome (lint and format), Oxlint, Ruff, Clippy, golangci-lint,
SwiftLint, RuboCop, Stylelint, mypy, Pylint, Flake8, Standard Ruby, ShellCheck,
Hadolint, actionlint, PHPCS, PHPStan, Psalm, SQLFluff, Semgrep and Prettier.
Other analyzers can use reviewed SARIF stdout declarations in
`.interlinked/lint-adapters.json` (schema/example in `docs/lint-adoption.md`).
Unsupported flags, shell setup and dynamic invocations remain explicit
review items. Rules retain their original analyzer semantics and IDs; static
discovery does not resolve every dynamic preset or replace arbitrary rules with
native guards. See `docs/lint-adoption.md` for recognition and execution boundaries.

Oxlint adoption runs the installed `oxlint --format=json .`, including configured
JS plugin rules. Warnings from exit 0 remain findings; parse failures, invalid
reports and zero measured files produce no verdict. `.eslintignore` is tracked.
Select named ESLint files with repeatable `lint import --eslint-config <file>`;
add `--write --baseline` to apply and measure. Files are relative to the command
target, inspected as text in preview, and passed through ESLint's `--config`.
`--eslint-scope <directory>` sets the working directory/`.` lint target for those
selections (default: project root, not config directory). It requires a selector.
Named `eslint.<name>.config.*` profiles are automatic audit candidates; inspect their
inferred package scope. General repeatable `--config tool=file` and optional `--scope`
select arbitrary configs for any adapter supporting an explicit config flag.
`--cadence hook|audit` sets cadence for all profiles in the import plan.
Use `--only-selected` with `--config` or `--eslint-config` when adding an isolated
profile: new automatic/inferred linters remain review items, all previously adopted
profiles remain, and `--cadence` changes only the explicit selections. Without that
flag, import still includes supported discovered profiles. Preview before adoption.
For this repo's focused anti-slop audit, select `--config oxlint=oxlint.anti-slop.json
--scope src --cadence audit --only-selected`, then `--write --baseline`. This enables
two complementary rules through the existing lint runner/baseline, not new native
checks. The separate all-18 research config is an explicit census only; its report
can exceed the runner's 10 MiB capture bound. Never promote a rule solely for zero hits.
Each config/scope/target/flag profile has its own
ratchet identity; re-import retains selected profiles without repeating flags.

PostToolUse and ordinary `verify` run hook profiles; `verify --all-checks` and
`lint check` run all profiles. Saved cadence survives re-import. Named/type/build-heavy
and CI profiles initially use audit cadence. Imported checks run asynchronously; hook findings
warn, never become automatic `pre_block` errors. `lint check` is the explicit
gate: exit 0 = complete/no new gating debt, 1 = new gating debt, 2 = incomplete/no verdict.
`lint check --update-baseline` seeds new scopes and tightens existing allowances.
Ordinary complete checks also retire resolved debt; incomplete runs never do.
Analyzer report capture has a 10 MiB threshold per stream. A truncated report is
unavailable even if its captured prefix parses; it cannot seed or retire debt.
Stylelint's stderr fallback also requires completely captured, empty stdout.
Truncated diagnostic logging on stderr does not invalidate a complete stdout report.
Source snapshots before/after each analyzer and again at batch completion reject
changed, added, deleted or replaced files; stale clean reports cannot retire debt.
Snapshots stream SHA-256 over every regular file in the working scope, including
custom extensions, dependencies, generated files and Git-ignored output. They also
compare file identity, mode and nanosecond timestamps; metadata alone cannot
detect unflushed memory-mapped writes. This is observational before/after freshness,
not an atomic filesystem snapshot or proof of arbitrary reads outside that closure.
For native ShellCheck and Hadolint, explicit targets must name existing regular
files in the working scope; confined regular-file symlinks are supported. Each
target is checked independently, including files under `vendor` or other default
discovery exclusions. Missing files, directories, escaping links and explicit
glob patterns make the result unavailable; another valid target cannot hide them.
Default inferred targets still use the adapter's discovery exclusions. Expand
explicit globs into a reviewed literal file list before importing the command.
Regular symlink targets are hashed; confined directory links are traversed with
cycle detection. Escaping directory links are unavailable. Diagnostic anchors use
a checked stream matching the original digest; out-of-snapshot diagnostics fail.
The census omits `.git`, `.interlinked`, `__pycache__`, `.mypy_cache`,
`.ruff_cache`, `.pytest_cache`, `.eslintcache` and `.stylelintcache`; explicit
targets or ignore overrides intersecting omitted runtime state are unavailable.
Each snapshot permits 100,000 entries and 4 GiB total, streamed in 64 KiB chunks
within the shared batch deadline. Large files do not require whole-file allocation;
diagnostic anchor lines have a separate 1 MiB character limit. Unreadable inputs or
exhausted bounds mean unavailable, never clean. Large scopes incur repeated reads
and may need a longer timeout or narrower valid working scope. Native ignores are
not guessed to make a census fit.
Native Clippy runs use a unique temporary Cargo target/build directory outside
the project, removed when the process finishes; compiler caches start fresh on each
measurement. Cargo arguments and child
environment override configured output locations so normal compilation cannot
invalidate the source snapshot. Existing `target` files remain measured inputs;
source, lockfile or build-script writes inside the scope still make the result
unavailable. A temporary-directory setting inside the project is unavailable.
Other analyzers that write inside their scope can also invalidate
their snapshots; only the listed runtime/cache exclusions are omitted.
Config drift requires review with `lint import`, then `--write`. The default
batch budget is 30000 ms (`--timeout`, maximum 300000 ms, on lint commands).

Literal config/plugin imports and package/lock context are fingerprinted. Ruff's
`extend` and local Biome/Oxlint JSON `extends` paths also enter the transitive digest
closure, including bare relative names such as `base.toml`. Paths resolve from each
declaring config, not the analyzer's working directory. Missing, out-of-project or
unresolved literal inputs prevent measurement. Existing policies missing one of these
dependencies require re-import; checking does not silently approve the new input.
Ruff's reader handles ordinary literal strings and table/dotted/inline keys; unsupported
string escapes or multiline inline inheritance require review. Biome package presets
retain package/lock tracking. This is not general YAML or dynamic inheritance resolution.
Discovery
does not execute config or expand arbitrary environment/matrix/build expressions.
YAML task parsing needs the optional `yaml` package; unavailable/invalid YAML remains
review evidence. Follow the supply-chain skill if adding the parser is blocked;
do not silently approve a dependency. An inventory marked complete can still have
unadopted review items. Never describe it as universal effective-rule coverage.
