# Adopting existing lint configurations

Interlinked CLI can discover existing lint setups and adopt supported analyzers
as a PostToolUse check and a CLI debt gate. The original configurations remain
the source of rule behavior: plugins, language semantics, overrides, and
suppressions are evaluated by their original analyzer.

```bash
interlinked lint scan                 # inventory configurations and scripts
interlinked lint scan --details       # include bounded declaration excerpts
interlinked lint import               # preview the import policy and review list
interlinked lint import --write --baseline
interlinked lint check                # gate new findings and retire resolved debt
```

Each command accepts an optional local directory target and `--json`.
`doctor` also detects existing lint sources and offers the import command.
The scan and import preview do not execute project code or write configuration.
`--write` applies the import; adding `--baseline` executes the supported linters
to record existing debt. Installed Interlinked hooks must already be enabled.

## Discovery and supported conversion

Discovery recognizes 29 tool families: ESLint, Biome, Oxlint, Ruff, mypy,
Pylint, Flake8, Clippy, golangci-lint, clang-tidy, Cppcheck, SwiftLint,
ShellCheck, RuboCop, Standard Ruby, Checkstyle, PMD, detekt, ktlint, Roslyn,
PHPCS, PHPStan, Psalm, Stylelint, SQLFluff, Hadolint, actionlint, Semgrep,
and Prettier. It inspects recognized standalone filenames, embedded manifest
sections, ignore/suppression files, package/composer scripts, Deno tasks, JSON/JSONC
task definitions, TOML/INI tasks, Make/Just recipes, CI files and shell/build evidence.
Literal local script aliases are resolved, including scripts with arbitrary names.
Each invocation records its source, working directory, arguments and review reason.
Shared `.gitignore` and `.ignore` files are also inventoried and fingerprinted
when they overlap an imported scope.

Nested packages and dotfiles are included. Dependencies, build output, common
agent state directories, and scratch directories are excluded. Symlinked
configurations, unreadable paths, malformed package manifests, oversized files,
and a bounded traversal limit produce explicit incomplete-inventory notices;
an incomplete inventory cannot be applied automatically. Configurations under
fixture, example, and documentation directories remain review items.

The 22 native execution adapters cover **ESLint, Biome, Oxlint, Ruff, Clippy,
golangci-lint, SwiftLint, RuboCop, Stylelint, mypy, Pylint, Flake8, Standard Ruby,
ShellCheck, Hadolint, actionlint, PHPCS, PHPStan, Psalm, SQLFluff, Semgrep and Prettier**.
The generated check preserves
their rule algorithms and exposes original rule IDs in Interlinked findings.
Other detected tools, unsupported command options, and configurations whose
invocation scope cannot be inferred appear in the review list. A preview with
review items is a partial conversion plan, not a claim that every source is
supported. No analyzer or plugin is installed automatically.

Static `rules` entries in the JSON output are declaration/selector candidates,
not a fully resolved effective rule inventory. Executable configuration, shared
presets, YAML anchors, and dynamic plugin rules remain owned by the analyzer.
Discovery does not evaluate JS/TS configurations. Analyzer execution can execute
the project's existing configuration/plugins and build machinery.

CI/task YAML parsing uses the optional `yaml` package. When it is unavailable or
the document cannot be parsed, lint-bearing lines remain unresolved review evidence.
With the parser present, literal command fields inherit working directories;
environment/matrix expansion, task dependencies and remote inheritance require review.
Maven/Gradle/CMake/Nox and staged-file command evidence also needs a declared adapter
when its build or generated-target context cannot be preserved. Inventory `complete`
means the bounded discovery finished; inspect `review` and `invocations[].reason`
to determine whether everything found can actually be adopted.

## Oxlint and named ESLint configurations

Recognized `.oxlintrc.json` and `oxlint.config.*` files now generate Oxlint entries.
The adapter runs the installed `oxlint --format=json .` in each adopted scope,
including configured JavaScript plugin rules. It retains native diagnostic codes
and warning findings even when Oxlint exits 0. Parse errors, missing locations,
invalid reports, and runs with no measured files produce no verdict. Oxlint's
`.eslintignore` inputs are inventoried and fingerprinted alongside its configs.
See the [Oxlint CLI contract](https://oxc.rs/docs/guide/usage/linter/cli).

Named `eslint.<name>.config.*` profiles are discovered automatically and default
to audit cadence. Their scope is the nearest package root, or the scan root;
inspect that choice in the preview. Interlinked's typed ESLint profile shares the
`tseslint-types` registry definition. Explicit selection supports arbitrary names:

```bash
interlinked lint import --eslint-config eslint.interlinked-types.config.mjs
interlinked lint import --eslint-config eslint.interlinked-types.config.mjs --write --baseline
interlinked lint check
```

`--eslint-config <file>` is repeatable. Paths are relative to the command's target
directory and must remain inside it. Arbitrarily named files are inspected as
bounded text during preview, even if automatic discovery does not recognize them.
Other alternate configurations remain review items. Selecting a canonical
config does not also create a new automatic entry for that same file; previously
adopted entries remain enforced.

Each selected configuration runs in its own ESLint invocation, using
[`--config`](https://eslint.org/docs/latest/use/command-line-interface#-c---config).
Its working directory and lint target default to the selected project root,
independently of where the configuration file lives. For a package-specific run:

```bash
interlinked lint import --eslint-config tools/typed.mjs --eslint-scope packages/api --write --baseline
```

`--eslint-scope` applies to every configuration selected in that command and
requires `--eslint-config`. The installed ESLint version resolves configuration
format, file patterns, plugins and ignores normally; Interlinked supplies an
absolute config path and lints `.` from the chosen scope. Re-importing without
repeating selectors retains saved profiles and refreshes their source digests.
A missing selected configuration must be restored before that import can proceed.

The general selector works for any native adapter with an explicit config option:

```bash
interlinked lint import --config ruff=tools/ruff.toml --scope packages/api
interlinked lint import --config oxlint=tools/strict.json --cadence audit --write
```

`--config tool=file` is repeatable. `--scope` requires it; paths are relative to the
selected project. `--cadence hook|audit` changes all profiles in that import plan.
Literal native command arguments preserve targets, rule selections, exclusions and
supported build flags. Unknown options, substitutions, shell setup and automatic
fix commands remain review items. The adapter owns the structured reporter.

## Additional analyzers through SARIF

A project can declare direct analyzer invocations in `.interlinked/lint-adapters.json`:

```json
{
  "version": 1,
  "adapters": [{
    "id": "java-pmd",
    "command": "pmd",
    "args": ["check", "-R", "config/pmd.xml", "-d", "src", "-f", "sarif"],
    "format": "sarif",
    "successCodes": [0, 4],
    "scope": ".",
    "configs": ["config/pmd.xml"],
    "cadence": "audit"
  }]
}
```

Preview with `lint import`, then apply with `--write --baseline`. Review the executable,
arguments and complete input list before applying a declaration. The executable must
emit a fresh [SARIF 2.1.0 report](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)
on stdout. Shell commands, automatic fixes, report-file reuse and downloads are not
supported. A wrapper executable can adapt another analyzer to this contract; include
that wrapper and its configs in `configs`. PMD's successful finding exit is 4; its
analysis-error exit 5 must not be accepted ([PMD CLI](https://pmd.github.io/pmd/pmd_userdocs_cli_reference.html)).
Declared profiles use stable `sarif:<id>` tool IDs and default to audit cadence.
Failed invocations, error notifications, malformed output, missing locations and
paths outside the project produce no verdict. Accepted suppressions and passed,
inapplicable or absent results do not create debt.

## Generated policy and baseline

`lint import --write` creates `.interlinked/lint-import.json` and enables
`quality_checks.lint_import` in team `guard-rules.json`, preserving unrelated
settings. A conflicting local disable is reported before writes. The import
records tool IDs, working scopes, explicit `config` paths, target/flag arrays,
cadence, discovery evidence, source paths, and configuration digests;
it does not accept arbitrary shell commands from committed configuration.

PostToolUse runs one admitted, asynchronous batch of `hook` profiles for its ChangeSet.
The wrapper warns about findings above the baseline; imported lint severity
does not become a PreToolUse block. `verify`, including JSON output, also exposes
the imported check. Ordinary `verify` runs hook profiles; `verify --all-checks`
includes audit profiles in both human and JSON output. New type/build-heavy profiles
and CI invocations default to audit cadence. Re-import preserves saved cadence.
`interlinked lint check` runs all profiles and supplies explicit gate semantics:

| Exit | Meaning |
|---|---|
| 0 | All imported scopes completed; no findings above baseline |
| 1 | New findings remain |
| 2 | Configuration, invocation, output, or capacity prevented a complete verdict |

The analyzer batch budget defaults to 30 seconds. CLI `--timeout <ms>` accepts
1–300000 milliseconds; the hook uses `quality_checks.lint_import.timeout_ms`.
Linters run sequentially within the admitted batch. This favors predictable
resource use over parallel startup. Project/package analyzers may be too slow
for the default hook budget; a timeout remains visible as NOT CHECKED.

`lint import --write --baseline` or `lint check --update-baseline` explicitly
seeds previously unadopted scopes. Existing allowances only decrease. Ordinary
complete checks, including hooks, retire resolved allowances automatically;
ordinary checks never silently adopt new debt. A failed/partial analyzer batch
does not update the baseline.

`.interlinked/lint-baseline.json` stores a multiset of content-anchored diagnostic
fingerprints per tool, scope, selected configuration, targets and semantic flags. Default entries retain
their existing `tool:scope` keys; explicit profiles use a separate key namespace.
Two ESLint configs over the same scope have independent allowances. Fingerprints
include selected config and invocation arguments when present, plus file, rule, diagnostic
message, and the trimmed source line, so moving a line preserves an allowance
and adding a duplicate consumes another allowance. Identical diagnostics on
identical source lines cannot distinguish relocation from replacement; this is
not an AST identity proof. File renames and changed diagnostic wording can
require fixes/review even when a developer considers the issue unchanged.

The shared baseline integrity guard rejects increased allowances in adopted
scopes and removal of scope history; first adoption of another scope is allowed.
The lint baseline reader validates its complete shape and uses recorded trusted
bytes while a detected loosening awaits restoration. Malformed state produces
no verdict. Re-importing retains previously
imported scopes and baseline history instead of silently dropping enforcement.

## Configuration and execution boundaries

Changed, removed, or newly detected configuration within an adopted tool scope
requires a fresh import preview and `--write`. Replacing a recognized config in
the same scope or removing an auxiliary ignore file refreshes its references.
An entirely removed adopted scope remains an error until its configuration is
restored; re-import does not silently unenforce that scope. This refreshes reviewed inputs;
it does not expand allowances in an existing baseline. Source digests follow bounded
literal local config/plugin imports and record ancestor package/lock inputs. New
invocation files also require review. Static inspection cannot fingerprint every
dynamic import, toolchain, environment variable or arbitrary file read. Keep those inputs pinned
in the project's existing dependency/build configuration.

Project-local node_modules/.bin, .venv/bin, vendor/bin and bin executables are preferred,
then PATH. Commands use argument arrays, never a shell or package-manager
download fallback. Biome's JSON reporter is version-sensitive and validated
before acceptance. golangci-lint uses its v2 JSON output flags. Clippy caps lint
levels at warning while measuring so lint errors do not truncate its build;
compiler/build failures still produce no verdict. Default Cargo targets and
features are used for configuration-only adoption; recognized command profiles retain
supported target/feature flags. Unsupported build operations remain review items.

The current conversion adds Interlinked scheduling and debt enforcement around
the original analyzers. It does not translate arbitrary language rules into
regex guards, change metric caps from similarly named rules, or remove the
original lint dependencies/configuration.
