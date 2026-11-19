# interlinked-quality-gates: dead code

Reference for [SKILL.md](../SKILL.md). Read it before a dead-code scan or a deletion.

## Dead code: two controls, four evidence layers, buckets before deletion

Per-edit detection and repo scanning are SEPARATE controls (operator decision
2026-08-17). The config keys `structural_checks.dead_imports` /
`dead_exports` run on every edit (with `dead_code_action: "flag" | "delete"`
deciding whether the warning reports candidates or instructs the agent to
remove them in the same edit — the harness never deletes code itself). The
verb `interlinked deadcode` sweeps the whole repo on demand, in its own
process, and works with or without any of the per-edit checks enabled.

Four evidence layers, weakest claim first: unreachable files (nothing imports
them — the scan resolves `export … from` barrels and dynamic `import()` edges,
but runtime path-loading stays invisible, so every row is a CANDIDATE), unused
import bindings (same-file evidence, near-zero FP), unused exports (cross-file
inference, type-surface FPs are common), and behaviorally inert branches —
which only the MUTATION lane can prove (`interlinked mutation disposition
--list dead_code`; reachable code whose mutants change nothing observable).

**Never hand a raw candidate list to a deletion agent.** Run
`interlinked deadcode --categorize` first: every candidate buckets by
mechanical signals (git first-import probe, docs/plans references, seam-shaped
names, package.json published surface, test-only importers, re-export shape,
type-only shape). `future-scaffolding` (never imported + doc-referenced —
planned design) and `deliberate-seam` (test seams, published API) are KEEP
buckets; `reexport-residue` and `orphaned-type` are compiler-guarded
deletions; `superseded` carries git evidence of a successor; `ambiguous`
means review, not delete. The buckets exist because the costly error is
deleting planned or deliberate code — a candidate is a lead, a bucket is a
policy.

`interlinked simplify scan/review/audit` composes a bounded subset of these dead-code signals
with other advisory simplification evidence. Its local dead-code adapter deliberately skips
per-candidate Git archaeology for latency, so it does not replace `deadcode --categorize` before
deletion or mutation evidence for behaviorally inert branches. Load
**interlinked-simplification** for its evidence, coverage, recording, and deep-handoff contract.

## Python trees

`interlinked deadcode` also reads Python. One `python3 -I` process parses every `.py` file with `ast` (nothing is
imported or run), and the same resolver as `check --only broken-imports` builds one node per module and one edge per
static import (absolute, relative, `from pkg import submodule`, package `__init__.py`). Third-party and standard-library
imports are external; an import of a first-party module that does not exist is counted and listed under
`python.unresolvedImports`. The JSON keeps the TypeScript keys (`unreachableFiles`, `deadImportBindings`, `deadExports`,
`testOnlyImporterFiles`, `scannedFiles`, `scannedPaths`) with the Python rows added, plus `language`
(`typescript`, `python` or `mixed`) and a `python` object. `deadTypeExports` and `--categorize` stay TypeScript only,
and `interlinked simplify` still reads only the TypeScript half.

- **Reachability** runs from entry roots, each listed in `python.entryRoots` with its kind and the rule that named it:
  `console-script` and `entry-point-group` (pyproject, `setup.cfg`, `setup.py`), `main-module` (`__main__.py`),
  `main-guard` (`if __name__ == "__main__":`), `shebang`, `test` / `conftest`, `command` (a literal path or
  `-m module` or `module:app` in a Makefile, workflow, Dockerfile, shell script, tox/noxfile, or a Python import written
  inside a shell script), `documented-command` (`python file.py` in a README), `framework-file` (`manage.py`,
  `wsgi.py`, `asgi.py`, `setup.py`, `noxfile.py`, Sphinx `conf.py`), `django-settings` / `django-app` (Django settings
  strings; an installed app's `models.py`, `admin.py`, `apps.py`, `migrations/`, `management/commands/`),
  `pytest-plugin`, `alembic`, and `loader-glob` (a module that imports by a computed name and holds a glob such as
  `provider_*.py`: the files that match are loaded by it). Importing a module runs the `__init__.py` of each parent
  package, so those are reached too. A dotted module path in a string literal (`include("app.urls")`,
  `"pkg.mod.Class"`) is an edge of kind `string`. A file that only a test root reaches is in `testOnlyImporterFiles`.
- **Unused exports** are public module-level names (no leading underscore, or listed in `__all__`) that no other module
  imports, reads by attribute (`mod.name`, `getattr(mod, "name")`, `setattr`, `patch.object`), or reads through a
  star import, an enumeration (`dir(mod)`) or a string path. Entry-root modules and decorated definitions are not
  judged. Each row carries `weaker`, the evidence that makes it less certain: `dynamic_import_in_tree`,
  `getattr_on_module`, `star_import_of_module`, `module_used_as_value`, `listed_in_all`, `used_in_own_file`,
  `defined_in_package_init`. A row with an empty `weaker` list is the strongest claim.
- **Dynamic imports.** `importlib.import_module("literal")` is an edge. A computed argument, `pkgutil.iter_modules`
  and `entry_points()` mark the tree (`python.dynamicImports.treeHasDynamicImports`); every unreachable file then
  carries `dynamic_import_in_tree` and stays a candidate, never a proof. A directory loader whose path comes from
  configuration (a tools directory read with `os.scandir`) is still invisible.

## Alias imports, components and framework roots

The scan resolves `$lib/x`, tsconfig `paths`, workspace packages (`@scope/pkg/sub`) and framework
aliases the same way as `metrics score` (see `metrics.md`, revision `2026-11-16.2`). It reads the
`<script>` blocks of `.svelte`, `.vue` and `.astro` files as importers, so an export that only a
component imports is used. Framework entry files (SvelteKit `+page`, `+layout`, `+server`, hooks;
Next `app/**` and `pages/**`; Nuxt; Astro `src/pages`) are never listed as unreachable, and their
exports (`load`, `GET`, `default`) are not reported as dead exports. Components themselves are
importers only: they are not listed as unreachable. Still invisible: a custom routes directory, a
path built at run time, and any import written outside a script block.
