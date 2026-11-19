// ===========================================
// Check Command — dead-imports scan for Python
// ===========================================
// The Python reading of `dead-imports`: an imported name that the module never uses. A use is
// a name read in any scope, a name inside a string annotation, a `cast("X", ...)` or
// `TypeVar(bound="X")` string, a `# type:` comment, or an entry of `__all__` (a list, a tuple,
// `+=`, `.extend`, `.append`). Docstrings and ordinary comments are not uses. In a test module a
// function parameter counts as a use (pytest fixtures). Not reported, and counted by reason:
// `__init__.py` (re-exports), `conftest.py`, `from __future__`, dunder names, `import x as x`,
// `# noqa: F401` (bare, with F, F4, F40 or F401 in the list), `# pylint: disable=unused-import`,
// a file-level `# ruff: noqa`, an import under try/except ImportError, a module that calls
// `globals()`, `locals()`, `eval()` or `exec()`, and a name that another first-party module
// imports from this one. KNOWN GAP: a use through `module.attr` of a module that the importer
// binds, and a name that only a `mock.patch("pkg.mod.name")` string mentions.

import type { JsonObject } from "../lib/json-types.js";
import { bump, ignoredByGit, pythonSourceWithoutInterpreter } from "./check-python-imports.js";
import type { PythonRun, RawDeadImportEntry } from "./check-python-run.js";

export interface PythonDeadImportsScan {
	status: "ok" | "unavailable" | "failed" | "no-python-files";
	note?: string;
	/** Relative paths of the modules that hold at least one unused import. */
	files: Set<string>;
	entries: RawDeadImportEntry[];
	importCount: number;
	/** Why an unused binding was not reported, from the analyzer. */
	deadSkips: Record<string, number>;
	/** Why a module was dropped on the TypeScript side. */
	skips: Record<string, number>;
	pythonFiles: number;
}

function emptyDead(status: PythonDeadImportsScan["status"], note?: string): PythonDeadImportsScan {
	return { status, ...(note ? { note } : {}), files: new Set(), entries: [], importCount: 0, deadSkips: {}, skips: {}, pythonFiles: 0 };
}

/** The dead-imports scan from an analysis run the caller already made. */
export function scanPythonDeadImports(root: string, run: PythonRun): PythonDeadImportsScan {
	if (run.status !== "ok") {
		return pythonSourceWithoutInterpreter(root) ? emptyDead(run.status, run.note) : emptyDead("no-python-files");
	}
	if (run.data.files_py === 0) return emptyDead("no-python-files");
	const { ignored } = ignoredByGit(root, run.data.dead_imports.map((entry) => entry.path));
	const skips: Record<string, number> = {};
	const entries = run.data.dead_imports.filter((entry) => {
		if (!ignored.has(entry.path)) return true;
		bump(skips, "gitignored");
		return false;
	});
	return {
		status: "ok",
		files: new Set(entries.map((entry) => entry.path)),
		entries,
		importCount: entries.reduce((sum, entry) => sum + entry.count, 0),
		deadSkips: run.data.dead_skips,
		skips,
		pythonFiles: run.data.files_py,
	};
}

/** What the scan adds to the `dead-imports` output: a `python` detail object and stderr notes. */
export function describePythonDeadImports(scan: PythonDeadImportsScan): { details: JsonObject | null; notes: string[] } {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	if (scan.status !== "ok") {
		return { details: { python: { status: scan.status, note: scan.note ?? "" } }, notes: [`note: ${scan.note ?? "Python files were not analysed"}`] };
	}
	const python: JsonObject = {
		status: "ok",
		file_count: scan.entries.length,
		import_count: scan.importCount,
		python_files: scan.pythonFiles,
		dead_skips: scan.deadSkips,
		skips: scan.skips,
		files: scan.entries.map((entry) => ({ ...entry })),
	};
	return { details: { python }, notes: [] };
}
