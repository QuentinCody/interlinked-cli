// ===========================================
// Check Command — any-types scan for Python
// ===========================================
// The Python reading of `any-types`: a module that writes an explicit `typing.Any`
// (or `typing_extensions.Any`) in a function parameter, a return type or an annotated
// assignment, including inside a generic such as `dict[str, Any]`. It is a count of an
// escape hatch, not a defect. Out of scope: a string annotation, `Any` outside an
// annotation, a name that is not imported from typing, test modules (`test_*.py`,
// `*_test.py`, `conftest.py`, a `tests/` directory) and git-ignored files.

import type { JsonObject } from "../lib/json-types.js";
import { bump, ignoredByGit, pythonSourceWithoutInterpreter } from "./check-python-imports.js";
import type { PythonRun, RawAnyEntry } from "./check-python-run.js";

export interface PythonAnyScan {
	status: "ok" | "unavailable" | "failed" | "no-python-files";
	note?: string;
	files: Set<string>;
	entries: RawAnyEntry[];
	skips: Record<string, number>;
	pythonFiles: number;
}

function emptyAny(status: PythonAnyScan["status"], note?: string): PythonAnyScan {
	return { status, ...(note ? { note } : {}), files: new Set(), entries: [], skips: {}, pythonFiles: 0 };
}

/** The any-types scan from an analysis run the caller already made. */
export function scanPythonAnyTypes(root: string, run: PythonRun): PythonAnyScan {
	if (run.status !== "ok") {
		return pythonSourceWithoutInterpreter(root) ? emptyAny(run.status, run.note) : emptyAny("no-python-files");
	}
	if (run.data.files_py === 0) return emptyAny("no-python-files");
	const { ignored } = ignoredByGit(root, run.data.any_types.map((entry) => entry.path));
	const skips: Record<string, number> = {};
	const entries = run.data.any_types.filter((entry) => {
		if (!ignored.has(entry.path)) return true;
		bump(skips, "gitignored");
		return false;
	});
	return { status: "ok", files: new Set(entries.map((entry) => entry.path)), entries, skips, pythonFiles: run.data.files_py };
}

/** What the scan adds to the `any-types` output: a `python` detail object and stderr notes. */
export function describePythonAnyTypes(scan: PythonAnyScan): { details: JsonObject | null; notes: string[] } {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	if (scan.status !== "ok") {
		return { details: { python: { status: scan.status, note: scan.note ?? "" } }, notes: [`note: ${scan.note ?? "Python files were not analysed"}`] };
	}
	const occurrences = scan.entries.reduce((sum, entry) => sum + entry.count, 0);
	const python: JsonObject = { status: "ok", file_count: scan.entries.length, occurrences, python_files: scan.pythonFiles, skips: scan.skips, files: scan.entries };
	return { details: { python }, notes: [] };
}
