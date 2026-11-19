// ===========================================
// Check Command — blast-radius scan for Python
// ===========================================
// Same definition as the TypeScript scan: a file that at least BLAST_RADIUS_MIN_DEPENDENTS
// other files import. The graph is the first-party import graph of the broken-imports scan:
// every static import statement in a parsed module counts (function bodies and TYPE_CHECKING
// blocks included, test files included), once per importing file. A package `__init__.py` is a
// target when an importer reads a name that it binds. An import that resolves in several roots,
// a third-party or standard-library import and a module that does not parse build no edge.

import type { JsonObject } from "../lib/json-types.js";
import { bump, ignoredByGit, pythonSourceWithoutInterpreter } from "./check-python-imports.js";
import type { PythonRun, RawBlastEntry } from "./check-python-run.js";

export interface PythonBlastScan {
	status: "ok" | "unavailable" | "failed" | "no-python-files";
	note?: string;
	files: Set<string>;
	entries: RawBlastEntry[];
	threshold: number;
	skips: Record<string, number>;
	pythonFiles: number;
}

function emptyBlast(status: PythonBlastScan["status"], note?: string): PythonBlastScan {
	return { status, ...(note ? { note } : {}), files: new Set(), entries: [], threshold: 0, skips: {}, pythonFiles: 0 };
}

/** The blast-radius scan from an analysis run the caller already made. */
export function scanPythonBlastRadius(root: string, run: PythonRun): PythonBlastScan {
	if (run.status !== "ok") {
		return pythonSourceWithoutInterpreter(root) ? emptyBlast(run.status, run.note) : emptyBlast("no-python-files");
	}
	if (run.data.files_py === 0) return emptyBlast("no-python-files");
	const { ignored } = ignoredByGit(root, run.data.blast_radius.map((entry) => entry.path));
	const skips: Record<string, number> = {};
	const entries = run.data.blast_radius.filter((entry) => {
		if (!ignored.has(entry.path)) return true;
		bump(skips, "gitignored");
		return false;
	});
	return { status: "ok", files: new Set(entries.map((entry) => entry.path)), entries, threshold: run.data.blast_min, skips, pythonFiles: run.data.files_py };
}

/** What the scan adds to the `blast-radius` output: a `python` detail object and stderr notes. */
export function describePythonBlastRadius(scan: PythonBlastScan): { details: JsonObject | null; notes: string[] } {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	if (scan.status !== "ok") {
		return { details: { python: { status: scan.status, note: scan.note ?? "" } }, notes: [`note: ${scan.note ?? "Python files were not analysed"}`] };
	}
	const python: JsonObject = {
		status: "ok",
		file_count: scan.entries.length,
		threshold: scan.threshold,
		python_files: scan.pythonFiles,
		skips: scan.skips,
		files: scan.entries.map((entry) => ({ ...entry })),
	};
	return { details: { python }, notes: [] };
}
