# interlinked-verify: notes on individual checks

Reference for [SKILL.md](../SKILL.md). Read it when one of the named checks needs explanation.

## False-positive filter audit and duplicate HTML IDs

`interlinked verify --fp-filter` (also on when `fp_filter.enabled` is set in
`guard-rules.local.json`) adds an `fp_filter` section: per check, how many
`[heuristic]` findings the E18 false-positive filter would withhold at
PostToolUse. The same counts are the `fp_filter` key of `--json`. Verify hides
nothing; it is the audit surface. The filter is a free logistic
(`src/harness/fp-filter.ts`) calibrated on one repository (holdout AUROC 0.906,
26/26 true positives kept, 66/122 false positives suppressed), so it is off by
default and its counts in another codebase are a prior, not a verdict. Verify
scores with repeat count 0 and the per-issue message, so its counts approximate
the hook. To audit what the hook actually withheld, use
`interlinked query checks --where fp_filter_suppressed=true`.

`html_duplicate_id` is a default PostToolUse/verify warning for repeated static IDs in
an explicit `<body>` in `.html`/`.htm` files. It reports each later occurrence with the
first occurrence's line. IDs are case-sensitive; comments, script/raw-text contents,
inert `<template>` contents, and dynamic ID expressions are excluded. IDs on the body,
script, and template elements themselves still count. This is a lexical check, not a
browser DOM audit: it does not infer omitted body tags, normalize equivalent entity
spellings, evaluate template branches, or execute JavaScript. Rename duplicate IDs and
update links, labels, ARIA references, and selectors; use classes for shared styling.

## Test legitimacy, effect cleanup and type-discipline advisories

`test_legitimacy` is one of those advisory test heuristics. It runs as immediate PreToolUse
coaching and under `verify --all-checks`. For each case in a
`*.mutation-kill.*`, `*.mutation-hardening.*`, or `*.survivor(s).*` JS/TS test, put an adjacent
contract receipt immediately before the case:

```ts
// test-contract: boundary — parseWindow rejects the documented zero-width interval
it("rejects a zero-width interval", () => { /* precise public-behavior assertion */ });
```

Kinds are `public-api`, `invariant`, `bug`, `security`, or `boundary`; the rationale must be
specific, not “kills the mutant.” The check also reviews broad `toBeTruthy`/`toBeFalsy`,
incidental call-order assertions, and explicitly private/internal imports, including multiline
named imports such as `__test_only__`. Cast-based private-member access is a companion warning. These shapes are not
automatically wrong, so this check stays heuristic: exact CLI/help/policy strings are legitimate
compatibility assertions, while unpromised internal formatting usually is not.

The React `missing_effect_cleanup` advisory recognizes cleanup-shaped returns rather
than arbitrary component render returns. Shared full-component examples in
`src/harness/checks/__fixtures__/effect-cleanup-cases.ts` exercise the detector and real
hook delivery. It still scans to the next effect or EOF; unrelated cleanup-shaped
returns can hide findings, so do not treat this heuristic as proof of correct disposal
or promote it to a deterministic block.

Two newer TS type-discipline advisories, both AST-parsed and both `[heuristic]`:

- **`unknown_type_alias`** — a named alias resolving to exactly `unknown`, chased through
  same-file non-generic aliases (`type Foo = unknown; type Bar = Foo;` flags both). Name the
  real shape, or keep `unknown` at the boundary and narrow with a parser/guard.
- **`conditional_empty_object_spread`** — `{ ...(cond ? {} : { field: v }) }`, the spread-a-
  ternary trick for omitting a field. The idiomatic guarded passthrough
  `guard ? { key: guard } : {}` is exempt.

## Suppression hygiene, checker availability and warning delivery

### API, documentation and numeric input advisories

`verify --all-checks` includes `public_api_leaks_internal_type`, `jsdoc_param_drift`,
`unvalidated_input_boundary` and `numeric_zero_default`. Default verification skips
these four checks. An explicit `--skip` excludes their execution before parser or
project-provider work. Inline rationale comments and persisted suppressions apply
through the ordinary verification collector. Raw JSON retains their complete findings,
source locations and action observations. Human output retains counts and its existing
detail previews.

`public_api_leaks_internal_type` recognizes same-file internal types referenced by
exported signatures. Its column-zero declaration and signature-window rules remain
advisory recognition boundaries. Review the intended public API before exporting a type.
`jsdoc_param_drift` compares supported JSDoc parameter names with exact JS/TS signatures.
Destructured/rest parameters, overloads and other existing ambiguous cases retain their
exceptions. An absent optional compiler or recovered syntax produces a named unavailable
input and partial-verification status for this check.

`unvalidated_input_boundary` recognizes `.json()` calls without nearby recognized
validation and direct `process.argv` indexing outside entry files. Its validator vocabulary,
lookahead window and entry-file exceptions retain their existing contract. Unavailable
discarded-validator AST evidence remains visible alongside retained lexical candidates.

`numeric_zero_default` advises when a supported numeric coercion, alias or resolved helper
feeds `||` with a different fallback. Numeric zero can be intentional caller policy, so
review the required default contract. Same-zero fallbacks, nullish defaults, shadowed
builtins and recognized normalized results retain their exceptions. Selected project
evidence supplies supported helper relationships. Opaque numeric returns and unavailable
relevant inputs retain gaps alongside independently supported observations. Supplied
producer/consumer hashes and locations remain under `sourceEvidence` in raw details and
actions. They bind captured source bytes without rereading dependencies during output.

**Stale suppressions (2026-10-05).** The `suppression hygiene` row lists
suppressions that matched nothing. It is report-only and does not change the
exit code. The two kinds have different strength:
- `stale_file_suppression` `[proven]`: a `verify-suppressions.json` entry whose
  literal path does not exist. Remove the entry. Glob keys are not judged.
- `unused_inline_suppression` `[heuristic]`: an `interlinked-ignore` directive
  that suppressed no finding within ±1 line in this run. verify does not record
  which checks ran on each file, so this means EITHER the finding is gone OR
  verify does not run that check here (hook-only checks, advisory checks
  without `--all-checks`). Before you remove the directive, run the named
  detector on the file; remove it only when the detector finds nothing.

**Checker availability is a first-class state (2026-08-27).** The tsc overlay
returns one of three outcomes: `ok` (it RAN — empty findings = checked clean),
`skipped` (it deliberately did not apply: non-TS file or operator `mode: off` —
nothing was verified, and nothing claims to be), or `unavailable` (it SHOULD
have run and could not: sidecar spawn failure, timeout, cooldown, or per-project
compiler backpressure). Unavailable
is never clean: transactional paths — `interlinked write` (single AND
`--batch`), `multi-edit`, `verify-changeset` — ABORT with a
`tsc-overlay-unavailable` failure and leave files untouched; the ordinary
single-edit hook path does not launch the sidecar at all. It records scheduled work,
and the admitted PostToolUse path checks the on-disk result asynchronously. A scheduled
record is not a passing verdict; unavailable PostToolUse checks still surface missing evidence.

Full-project TypeScript children are serialized per project across concurrent
hook and CLI processes. Heavy verify/check/test/audit/sweep work uses one
project-scoped cross-process lease: contention is an explicit deferred/no-verdict result
for external-tool batches. Tests retain requests and use the bounded scheduler described
above. Each accepted request runs after its own edit is on disk; cached test results require
matching validated inputs.
A multi-file PostToolUse request also owns one external-tool batch for its
entire ChangeSet: project-capable compilers, linters, and security scanners run
at most once, then their findings are attributed back to the touched files.
Cheap inline checks still run once per file. A same-ecosystem dependency audit
runs once for the ChangeSet, and TypeScript/Vitest affected tests run once with
the union of changed inputs, including tests. Mixed-language affected-test sets,
multi-ecosystem audits, file/tool-cap overflow, a file-only external runner, or
a batch denied by capacity produce one aggregate `NOT CHECKED` result for the
request instead of N subprocesses or N warnings. Existing-file TypeScript
diagnostics from the batch warn without claiming they were introduced: only a
request-proven new file has an empty compiler baseline; the exact per-edit
introduction decision remains the PreToolUse overlay's responsibility.
When several PostToolUse checks defer for one edited file, the model-visible
output is one `[interlinked:checks-deferred]` NOT CHECKED warning with the
individual reasons; structured `check_results` still retain every deferral.
`checks_ran` lists only checks that completed with a real verdict; attempted
checks that throw or defer are recorded under a `deferred_<check>` timing
boundary instead of being reported as completed.
The same deferral is not repeated by the project-wide sweep, and a deferred
event never receives an `all clean` summary. Re-editing a file cannot repair
checker capacity, so operational deferrals also never become a
`persistent_warning_escalation` source error, recurrence signal, or
feedback-effectiveness warning/resolution. They remain structured operational
telemetry, and the NOT CHECKED notice remains visible until a real verdict
exists. Retry every named check before claiming the edit is verified.

PostTool warning delivery is request-owned. Each daemon check pass writes its
own tokenized active/ready record under `.interlinked/quality-warning-spool/`;
both installed hook runtimes acknowledge a synchronous result before showing
it, while a result that finishes after the hook timeout is atomically claimed
and shown once on that same session's next PreToolUse. The originating hook's
PID preserves its first-delivery right without making another hook wait.
Parallel agents cannot overwrite or unlink one another's work, clean results
create no replay record, and a PreToolUse never force-removes a live check
marker. A PostTool pipeline exception publishes an explicit `NOT CHECKED`
diagnostic instead of an empty record, and an abandoned active-only marker is
claimed only after its hook process is gone (or the marker expires); live
markers are preserved. The old shared `pending-quality-warnings.json` file is read only as a
one-time rolling-upgrade migration path; when request-owned evidence exists,
unscoped legacy text is discarded rather than mixed into another request.

Because the synchronous overlay path cannot wait without blocking the daemon
from reaping an async compiler, contention returns `unavailable` immediately;
retry after the active check finishes instead of treating the edit as verified.
The synchronous export-ripple advisory follows the same rule: it reports an
explicit `export_ripple_compilation_deferred` info finding and launches no
second compiler while same-project compiler work is active.
Different project roots remain independent and may compile concurrently.

## `interlinked check --only broken-imports` on Python

`broken-imports` also reads `.py` files. One `python3 -I -S -B -c` child process parses
them with the standard library `ast` (the code under analysis is never imported or run;
`python3` 3.8 or newer is needed). Without `python3`, Python files are skipped, stderr
says so, and the TypeScript and JavaScript result is unchanged.

A result is a CANDIDATE, never a verified defect. It is a first-party import whose module
does not exist (`missing_module`) or whose name is not bound at the target's top level and
is not a submodule (`missing_name`). Third-party and standard-library imports are never
judged. The scan stays silent, and counts the reason under `python.skips` in `--json`, for:
a `try/except ImportError` guard, a target with module `__getattr__`, a star import or a
dynamic surface (`globals()`, `setattr`, `__path__`, `sys.modules[...]`), generated names
(`_pb2`, `version`), `.pyi` stubs and extension-module sources, namespace packages, an
importer that edits `sys.path`, a name found in several roots but resolved in none, and an
importer or target that `git check-ignore` reports as ignored.

Resolution roots (static files in the repository only; nothing is executed, no environment is
read, no build backend runs). Directory names are simple string literals, relative to the
file that names them, and a directory that does not exist or leaves the repository is ignored:
- the repository root, every `src` directory, every manifest directory (`pyproject.toml`,
  `setup.py`, `setup.cfg`). A directory that holds `__init__.py` is never a root: its parent is
  (a `pyproject.toml` inside a package makes the parent the project root; a `setup.py` or
  `setup.cfg` inside a package is a module, not a manifest);
- `pyproject.toml`: pytest `pythonpath`, setuptools `package-dir` (`"" = dir`; `name = dir`
  gives the parent when the directory carries the name, else an alias that is not judged,
  counted as `package_dir_alias`) and `packages.find.where`, poetry `packages[].from`, hatch
  `build` and `build.targets.*` `sources` (list or table keys) and `packages` (parent of each
  directory), pdm `build.package-dir` and `build.includes`, uv `build-backend.module-root`,
  maturin `python-source`, and `[tool.pytest] pythonpath`; `pytest.toml` and `.pytest.toml`;
- `pytest.ini` and `tox.ini` `[pytest] pythonpath`, `setup.cfg` `[tool:pytest] pythonpath`,
  `[options] package_dir` and `[options.packages.find] where`;
- `setup.py`: literal `package_dir={...}` of the `setup(...)` call and `where` of
  `find_packages` or `find_namespace_packages` (the file is parsed, never run);
- `.pth` files (path lines, relative to the file or absolute inside the repository; `import`
  lines are ignored), `.egg-link` files (first line), and a directory that holds a
  `*.egg-info` directory (a `setup.py develop` layout); these serve the whole project;
- directories holding `conftest.py` (for files below them), the first directory above the
  package chain of a test module that pytest collects (`test_*.py`, `*_test.py`,
  `conftest.py`; a helper script in a tests package is not collected, so it gets no such
  root), and the importer's own directory (`sys.path[0]`, the rule for a file run by path):
  in a plain directory, for tests, examples, scripts, docs and files with a `__main__` guard;
  in a package directory (`__init__.py`), only for a test, example, script or doc file that
  also has a `__main__` guard (a module of a package is imported from the root above the
  package chain, and a guard on any other module means `python -m`).

A standard-library name (`sys.stdlib_module_names`; Python 3.10 and later) resolves to a
first-party file only through the importer's own roots, which are first on `sys.path`. A
project, `src` or declared root cannot shadow it; the statement is counted as
`stdlib_name_not_shadowed` and not judged.

Native extensions: a build file that names the module makes an import of it a non-candidate,
counted as `declared_native_extension`: maturin `module-name`, `[[tool.setuptools.ext-modules]]`
`name`, a literal first argument or `name=` of an `*Extension(...)` call in `setup.py`, a
`set_source("pkg._x", ...)` literal of a `cffi_modules` build script, and a literal
`py.extension_module('_x', ..., subdir: 'pkg')` in `meson.build`. A `.pyx` next to the package
is already an unchecked source. A native-build signal (`Cargo.toml`, `CMakeLists.txt`, `.c`
files) on a module that no file names stays a candidate with the tag `repo_native_build`.

A name that resolves in any valid root is not broken. A directory named `<package>_tests` or
`<package>-test` counts as a tests directory; a directory whose name has `example`, `sample`,
`demo` or `tutorial` as a word (`example-project`, `sample_code`) counts as examples.
`--json` keeps `{count, files}` and adds a `python` key with each candidate (importer, line,
statement, kind, tags, paths tried), `stats`, `skips`, `in_scope_share` and `import_roots`.
Known gaps: `PYTHONPATH` set outside the tree, an editable install that maps a name to a
directory outside the tree, `pyproject.toml` read on Python older than 3.11 (no `tomllib`;
counted as `pyproject_unread`), values that are not string literals, and type-checker path
settings (pyright `extraPaths`, mypy `mypy_path`, ruff `src`), which are not read.

The same child process also serves more checks, each a candidate list under a `python`
key (never a verdict). `--only cycles`: strongly connected groups over top-level first-party
imports (not function-body, not `if TYPE_CHECKING:`, not ambiguous); `through_package_init`
marks the usual tolerated shape. `--only any-types`: non-test modules with an explicit
`typing.Any` in a parameter, return or annotated assignment. `--only duplicates`: non-test
functions or methods of 40 or more syntax nodes with the same parameters and body (names,
comments and docstrings ignored; this is not the TypeScript same-export-name meaning).

`--only dead-imports` on Python: an import binding that the module never reads (any scope).
Reads include string annotations, nested forward references (`Callable[["Foo"], "Foo"]`),
`cast("X", ...)`, `TypeVar(bound="X")`, `# type:` comments, `__all__` (list, tuple, `+=`,
`.extend`, `.append`), `del`, and augmented assignment; in a test module a function parameter
also counts (pytest fixtures). Docstrings and comments are not reads. Not reported, counted
under `python.dead_skips` by reason: `package_init` (`__init__.py` re-exports),
`conftest`, `future_import`, `dunder_name`, `explicit_reexport` (`import x as x`), `noqa`
(`# noqa`, `# noqa: F`, `F4`, `F40`, `F401` in a list, `# pylint: disable=unused-import`,
file-level `# ruff: noqa`), `try_importerror_guard`, `dynamic_namespace` (a call to
`globals()`, `locals()`, `eval()` or `exec()`, not a method with that name),
`imported_by_other_module` (another first-party module imports that name from this one).
`python.files[]` holds `{path, count, imports[{name, line, end_line, module, statement,
type_only, in_function, bare_import}]}`; a `bare_import` (`import a.b`) may be kept for its
side effect. Known gap: a use through `module.attr` of a module that the importer binds, and a
name that only a `mock.patch("pkg.mod.name")` string mentions.

`--only blast-radius` on Python: a file that at least 5 other files import (the same
threshold as TypeScript, one constant). Importers count once per file over every static
import (function bodies, `TYPE_CHECKING`, tests included) of a parsed first-party module; a
package `__init__.py` counts when an importer reads a name that it binds. An import that
resolves in several roots, third-party and standard-library imports and modules that do not
parse build no edge. `python.files[]` holds `{path, dependents, importers}` (up to 10
importers), most dependents first.

`--only missing-tests` on Python (file names only, no interpreter): a product module that no
test file names. Not product: `__init__.py`, `__main__.py`, `conftest.py`, `setup.py`,
`manage.py`, `wsgi.py`, `asgi.py`, `apps.py`, generated `*_pb2.py` and `_version.py`,
`migrations` and dot-directories, files under `tests`, `examples`, `docs`, `scripts`, `tools`,
`benchmarks`, `fixtures` or `templates`. A test is `test_<name>.py` or `<name>_test.py` in the
module's directory or in a `tests`/`test`/`<package>_tests` directory of that directory or of
an ancestor (any depth below it); extra words in the test name are allowed when each is a word
of a directory in the module's path (`test_mcp_server.py` for `mcp_server/server.py`). A
module that a test imports under another name is still listed in `files`. `python` holds
`product_modules`, `missing_count` and `exempt` by reason.

`--only missing-tests` also carries `layout` (Python and JS/TS; `files` and `python` above keep their meaning, so
baselines and consumers do not change). `layout.rule` prints the rules; per language (`python`, `javascript`):
`by_name_mapping` (a test file by name in the module's directory or in a tests / test / `__tests__` / spec directory
of the module's directory or any ancestor, `<name>[.<qualifier>].test|spec.<ext>` for JS/TS, case and `-`/`_` ignored),
`imported_by_tests` (a test file imports the module: Python import, from-import, `mock.patch` target, plain `import pkg`
plus `pkg.name` use, relative imports and `__init__` re-exports; JS/TS import, require, dynamic import, `vi.mock` /
`jest.mock`, relative, `@/`-style and scoped workspace aliases, directory-index barrels by the names taken),
`covered_by_either` and `no_test_import_candidates` (`candidate_count`: covered by neither; `[heuristic]`, a module that
tests reach only by a dynamic string name, a package name or a tsconfig alias is listed). Product means the v5 source
role. `status: "cannot-judge"` with `cannot_judge_reason` appears when the repository has no test file of that language
or sets test discovery the rule does not support (pytest `python_files`, jest `testMatch` / `testRegex`, vitest
`include` without a `test` or `spec` in the pattern); no candidates are listed then. `untested_files` and
`no_test_file` (verify, baseline-gated) are unchanged.

`--only secrets` on Python (no interpreter): the same detector as TypeScript (patterns plus
the entropy floor) over `.py`, `.pyi`, `pyproject.toml`, `setup.cfg`, `tox.ini`, `pytest.ini`,
`requirements*.txt`, `constraints*.txt` and `Pipfile`, in a tree that holds a `.py` file. Test
files and tests directories are skipped. `python.files[]` holds `{path, kinds}`: the kind of
secret, never its value. A key-shaped literal in a detector's own pattern table or a dummy key
in a test helper outside a tests directory is still flagged.

For all Python-aware checks the file list is `git ls-files --cached --others
--exclude-standard` (a bounded walk outside a repository), `python.status` says `ok`,
`unavailable` or `failed` (with a `note`), and a tree with no `.py` file gets no `python` key.

## `check --only duplicates` on TypeScript and JavaScript

A file counts only for exports it declares itself. A barrel (`index.ts` with `export * from` or
`export { x } from`) is not a duplicate of the module it re-exports. A name that a framework reads
from a route file (`load`, `actions`, `prerender`, `GET`, `POST`, `default`, `getStaticPaths`, ...
in SvelteKit `+page`/`+layout`/`+server`, Next `app/**` and `pages/**`, Nuxt `pages`/`server`, Astro
`src/pages`, SvelteKit `hooks.*`) is a convention, not a duplicate; the same name in an ordinary
module still fires. The table is `src/lib/import-resolution/framework-entries.ts`. Also dropped
(`src/commands/check-duplicates-rules.ts`): `import { X } from ...; export { X }` (a re-publish), a
`X.d.ts` beside its implementation, index modules that only collide with other index modules, and
`[heuristic]` three or more modules with one file name that export one name (`FIELDS` in every
`fields.ts`); two same-named modules still fire.
`broken-imports` stays silent on a missing name when the target, or a module it re-exports with
`export * from`, has a multi-name `export const A = 1, B = 2`: the export parser reads the first name only. The import graph behind `--only cycles`,
`broken-imports` and `blast-radius` now resolves tsconfig `paths`, workspace packages and
`$lib`-style aliases and reads `.svelte`, `.vue` and `.astro` script blocks as importers.
