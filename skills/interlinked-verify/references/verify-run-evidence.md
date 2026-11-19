# Verification scope and evidence

Explicit `verify` has no Interlinked memory admission, imposed heap cap or RSS kill budget,
including its Gitleaks scan. It also has no default whole-command deadline,
cumulative inline-check time budget or external-analyzer deadline. `--timeout` and
`--tool-timeout` accept integer milliseconds from 0 through 2147483647; positive
values opt into those deadlines. It waits for the canonical project lane and the shared host lane,
prints a waiting notice after one second, and runs tools
sequentially; cancellation, configured analyzer settings and OS limits still apply. See
[resource admission](resource-admission.md) for project contention and the
separate memory policies retained by scheduled tests and background jobs.
Semgrep requires `interlinked verify --only semgrep`. Both default and
`--all-checks` skip its availability probe and scan. Verify JSON records
`tool_quality:semgrep` in `not_run` with reason `not_selected` and omits the
findings summary for the skipped scan. Verify also skips imported lint entries
that select Semgrep by tool ID or invoke its executable as a SARIF adapter.
`interlinked verify --skip gitleaks` also omits the Gitleaks probe and scan.
Foreground verify
does not currently schedule these scans or reuse saved security results.
`interlinked verify --gitleaks-scope git-visible` limits Gitleaks to tracked and
untracked Git-visible working files. It explicitly excludes Git-ignored files,
including ignored `.env`, and fails as unavailable when Git inventory cannot be
established. The default `working-tree` selection continues scanning ignored
working inputs. Both selections preserve explicit control-tree exclusions and
tracked exceptions below. The selected mode appears in the input-scope receipt.
JSON `external_diagnostics` retains every external tool's unsuppressed findings,
including tools without a named summary section, and feeds the complete action
inventory. `check_coverage.input_scopes` records tool-specific populations.
Human-readable external tools share the process-group runner with JSON mode.
Foreground analyzer capture retains complete output instead of stopping at the
default background capture ceiling. Semgrep's implicit per-rule timeout, file-skip
threshold and target-size cutoff are disabled for foreground verification. Valid
findings survive incomplete Semgrep reports; reported errors remain `NOT CHECKED`.
JSON reports are parsed from stdout separately from progress messages on stderr.
Project Semgrep scans respect Git ignore rules. Explicit file scans elsewhere in
the harness retain their own file-selection contract. Malformed Gitleaks reports
never establish that a security scan was clean. Malformed Semgrep result rows
also retain partial evidence and exit 75; valid findings survive alongside gaps.
Foreground Gitleaks scans working inputs through sequential, root-relative file
or safe-directory targets. It preserves root configuration/environment precedence,
custom rules, allowlists and fingerprint ignores. Git-ignored working files such as
`.env` remain included. Tracked files remain exceptions to generated/dependency
directory exclusions. Git storage is always excluded. The explicit scope excludes
untracked content beneath `.interlinked`, `.archive`, `.claude/worktrees`,
`.codex/worktrees`, `node_modules`, `dist`, `build`,
`coverage`, `target`, `__pycache__`, `.venv`, `venv` and root `scratch`.
Human output and JSON `check_coverage.input_scopes` report selected-file counts, native
targets, excluded paths and unavailable inputs. These counts describe the working
inventory. Native rules, allowlists, binary detection, archive traversal and
recursive decoding still determine analyzer coverage. Symlinks and non-regular
inputs report unavailable. An untracked `node_modules` symlink with no tracked
descendants is recorded as an excluded dependency path. Tracked dependency links
and links that replace a directory with tracked descendants report unavailable.
Working-input changes during the scan also invalidate
completion. External inherited configuration files are read by Gitleaks and remain
outside the adapter's source snapshot. Explicit `--tool-timeout` covers scope
discovery, all native targets and final source validation. The foreground runner
honors operator `GOMAXPROCS` and otherwise leaves Go's concurrency default intact.
A failed start, signal, timeout, truncated capture, unparseable report or nonzero
exit with no usable findings reports `NOT CHECKED`, keeps
the remaining checks running, and exits with partial-verification status rather
than displaying an empty successful result.

Verify records the catalog placement of each check under its result key or in
`not_run`. Read the placement before interpreting a legacy top-level counter.
Those counters retain their shape even when the effective selection excluded a check.

- `set_aside`: files that source roles classify as generated, vendor or `unlinted`
  (path, tool-path, `.gitattributes` linguist-generated, a generator config or
  command that names the path, repository linter exclude (role `unlinted`: "not
  linted by the owner", not a claim of generation), minified shape, or a
  generated-file marker)
  are not given to content checks. The block holds `files`, `by_role`, `by_evidence`
  and the largest `listed` rows (file, role, evidence kind and detail, bytes). A file
  type that no language table lists (html, css, txt) is read.
- `not_measured`: each (check, file) pair that went over its budget. One check on one
  file may use 15 s (`INTERLINKED_VERIFY_PAIR_BUDGET_MS`); one file may use 60 s in
  total (`INTERLINKED_VERIFY_FILE_BUDGET_MS`). The pair is recorded with its elapsed
  time, the run continues, and the exit code is 75. A synchronous detector cannot be
  interrupted, so the bound is one slow call per file.
- `partial` and `partial_detail`: with `--timeout`, verify stops itself before the
  deadline (20% of the timeout, at most 30 s, kept for printing), prints valid JSON
  with everything measured so far, and exits 75. Project-wide aggregates (parity,
  undocumented env vars, spec ledger, structural sweep) are not computed for a stopped
  run. The inline census runs before the external tools, so a deadline keeps it.
- `files_scanned` is the discovered population; `files_measured` is the number whose
  content checks ran.
- `not_run`: `"<family>:<id>"` to `{ reason, detail }`. Reasons: `needs_session`,
  `needs_diff`, `opt_in_only`, `external_tool_missing`, `measured_by_other_command`,
  `not_reported_by_verify`, `not_selected`, `not_applicable`,
  `external_tool_error`, `external_tool_timeout`, `resource_busy`,
  `execution_unavailable` (`language_not_present` and
  `security_scope` are reserved codes). Run `--all-checks` for the 60 sweep checks, the
  3 structural sweep checks (`hallucinated_imports`, `cross_package_imports`,
  `undefined_env_vars`) and the 5 spec-ledger checks; they land in the top-level key
  of the id, `structural_checks.<id>` and `spec_ledger_checks.<id>`. `--suggestions`
  adds `suggestion_checks.<id>`; external tools that ran add `tool_checks.<id>`.
  The default run gains no check: `not_run` lists these ids as `opt_in_only`.
  Effective exclusions receive `not_selected`. An interrupted external check with
  retained findings has a `tool_checks` result containing its observed count and
  an `incomplete` reason and detail. A missing completion and skip receipt gives
  `execution_unavailable`. The engine's structured skip category supplies the
  reason for failures, timeouts, resource deferrals and missing prerequisites.
  For `cross_package_imports`, compare the nearest `package.json` of the importer
  and resolved target. Imports that move through a shared package root stay within
  that package. A relative import into a distinct nested package can cross a
  boundary even when its specifier starts with `./`.
  `undefined_env_vars` checks direct uppercase `process.env.KEY` reads in JS/TS
  against the nearest example catalog. `KEY=`, `# KEY=` and `export KEY=` document
  a variable. The TypeScript parser skips literal text, comments, assignments
  and deletions, and counts reads inside template substitutions and compound
  assignments. Installs that omit the optional parser use text matching.

Foreground source discovery and inline admission have no file-size or file-count
cutoff. Both Git discovery and filesystem fallback retain large source files;
Git ignore rules still determine the Git inventory. Generated/codegen inputs and
known dependency/build/runtime trees remain explicit scope exclusions. Contained
regular-file symlinks retain their source paths; unsupported links, unreadable paths
and parse failures remain unavailable evidence. Timing coverage retains every known
unavailable input and separates intentional `excluded_inputs` from `unavailable_inputs`.
Large files are checked as whole bodies, not split into fragments that lose context.
Foreground setup presence probes also have no directory-entry or ancestor-depth
cutoff. Unreadable source or dependency metadata remains unavailable evidence;
dependency-read failures do not establish missing dependency declarations.
Selected repeated-implementation analysis uses full input/output and managed,
cancellable Python parsing without an implicit parser deadline. Its advisory
selection and bounded synchronous/runtime callers retain their separate behavior.
Foreground scan context collects full result populations for 40 participating
detectors: 28 standards-mapped checks and 12 additional scored checks. All 16
currently scored checks participate. Verify uses this policy for 37 existing
check integrations. The registry-only `public_api_leaks_internal_type`,
`jsdoc_param_drift` and `unvalidated_input_boundary` receive the policy through
registry-backed surveys and their existing hook surfaces. See the quality skill's
[standards reference](../../interlinked-quality-gates/references/standards.md) for the
participating IDs and surface coverage.
`--all-checks` includes advisory `json_stringify_error`, `catch_rewrap_loses_cause`
and `resource_handle_leak`; default verification skips these three checks.
Advisory selection and explicit skips determine execution. Runtime hooks use
their per-edit match limits. Recognition uses each detector's predicates and
windows, including the API signature window,
input-validator lookahead and semantic 15-line boundary window. Other detectors
have their own result caps.

The advisory `import_from_own_barrel` check follows resolved static value-form
module edges within the sibling index's directory subtree. Foreground scans
traverse that reachable population without the hook's 64-module cutoff. Runtime
budget exhaustion, unreadable or unresolved modules, unsupported loading syntax,
and declaration-only resolution retain unavailable evidence. Comments, strings and
explicit type-only edges do not establish reachability. A resolved cycle pattern
does not itself prove a runtime failure. An exact own-package specifier remains
separate syntactic policy advice. Missing graph evidence must not be interpreted
as a clean graph or a proven cycle; pre-write warnings retain that distinction.

Foreground `fallback_only_assertion` analysis examines all matching sibling test
files in its declared same-directory, child `__tests__` and parent scopes, and
finishes its suffix normalization. It uses selected project snapshot reads when
available. Unreadable, unselected or unclassifiable sibling evidence remains an
explicit gap while other readable evidence survives. Runtime keeps its 12-sibling
and six-normalization-round limits. Filename similarity and assertion recognition
remain heuristics; complete collection does not establish semantic test adequacy.
Foreground Rust formatting uses native `--check` without writing source or running
build scripts. A root Cargo manifest selects its declared crate/workspace members;
workspace metadata is resolved offline, and unrelated local dependency crates are
not added with `--all`. Standalone product and authored test Rust sources are also
eligible. Independent fixture, generated and vendor-only populations are explicit
scope exclusions. Inventory, native configuration and execution failures remain
partial evidence. Runtime formatting callers retain their existing bounds.

Foreground parity and type-smuggling scans no longer inherit the hook-size limits;
type-smuggling retains all matches and reports unavailable compiler/syntax evidence.
Export, type and circular-import analyses reuse invocation-local source evidence.
The circular-import report identifies each eligible module in a cyclic component;
it does not enumerate every possible cycle. Test, declaration and generated files
remain context when reached by eligible code. Lexical import-resolution gaps remain
`NOT CHECKED`, and runtime hooks retain their separate per-call bounds.

Biome foreground reports retain every emitted diagnostic, including warnings from
successful exits. Its default size ceiling is lifted when the configuration can be
resolved without replacing an explicit `files.maxSize`; configured size limits and
file selection remain native policy. Skipped or unsupported diagnostic scopes are
unavailable evidence. Tool availability probes follow the optional analyzer deadline;
probe failures are unknown, not proof that a tool is absent.

The C compiler still lacks a managed async runner. When selected and applicable,
the installed tool reports `NOT CHECKED` and partial-verification status in
default human scans, focused scans and JSON. A complete selected-file inventory
without matching source produces explicit inapplicability. Incomplete discovery
retains an unknown capability state. Tool availability is distinct from execution.
The local documentation checker runs only `scripts/check-docs.mjs` under the
selected project root, including through `interlinked check --only docs-check`.

The structural scans of `interlinked check` follow the import graph and give no
verdict when the evidence is incomplete. `--only broken-imports` reports a missing
target file, a RELATIVE import (`./` or `../`) that resolves to nothing, and a named
import the target does not export. It stays silent for default imports (a default
import is not matched against named exports), `import * as`, asset targets that
exist (`.svg`, `.css`, `.vue`, `.md`, `?raw`/`?url`), directories, targets that
`git check-ignore` reports as ignored (build output, generated clients), targets
in skipped directories (`build/`, `vendor/`, ...), CommonJS (`module.exports`,
`exports.x`, `export =`) and `.d.ts` targets, and `export *` chains that do not
fully resolve. It also stays silent for a `node_modules` path segment, a target in
a git submodule path, an unimported importer under a `fixtures`, `testdata` or
`template(s)` directory, and import text inside a template literal. A `.js`
specifier is judged against the `.ts` source beside it. `--only cycles` and the per-edit `circular_imports` and
`new_import_cycle` checks count only load-time edges: comment text (JSDoc
`{import('./x')}`), `import type`, and `import { type A }` with every specifier
typed are not edges, and a loop that needs a lazy `import()` is not a cycle
(dynamic edges stay in the graph for reachability, dead-code and blast radius).
Known gap: an `import { X }` without `type` that is used only as a type is elided
by TypeScript but still counts as a runtime edge.

Human and JSON dependency audits prefer recursive OSV scanning, with npm fallback
when the selected root has a Node manifest. Supported non-Node manifests and
lockfiles remain eligible without `package.json`. Missing OSV for those inputs,
incomplete processes and invalid reports retain unavailable evidence. A successful
npm fallback retains any OSV scope gap alongside its findings. Documentation
script selection is root-local. Dependency applicability follows the selected
repository inventory.
