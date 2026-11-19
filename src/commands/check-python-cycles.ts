// ===========================================
// Check Command — cycles scan for Python
// ===========================================
// Candidates, not verdicts. An edge is a top-level (load-time) import that resolves,
// in exactly one resolution root, to a first-party module or package `__init__.py`.
// Not edges: an import inside a function, under `if TYPE_CHECKING:`, one whose name
// resolves in several roots, a third-party or standard-library import, and the implicit
// load of a parent package. A package submodule that is imported by name from its own
// package does not re-enter that package's `__init__.py`. A cycle that has a
// git-ignored member is skipped. KNOWN GAP: a cycle that Python tolerates because every
// name is read late is still listed; the scan cannot tell it from one that fails.

import type { JsonObject } from "../lib/json-types.js";
import { bump, ignoredByGit, pythonSourceWithoutInterpreter } from "./check-python-imports.js";
import type { PythonRun, RawCycleGroup } from "./check-python-run.js";

export interface PythonCycleScan {
	status: "ok" | "unavailable" | "failed" | "no-python-files";
	note?: string;
	/** Relative paths of every module that sits in a reported cycle. */
	files: Set<string>;
	groups: RawCycleGroup[];
	skips: Record<string, number>;
	pythonFiles: number;
}

function emptyCycles(status: PythonCycleScan["status"], note?: string): PythonCycleScan {
	return { status, ...(note ? { note } : {}), files: new Set(), groups: [], skips: {}, pythonFiles: 0 };
}

/** Cycles from an analysis run the caller already made (one child process serves every Python check). */
export function scanPythonCycles(root: string, run: PythonRun): PythonCycleScan {
	if (run.status !== "ok") {
		return pythonSourceWithoutInterpreter(root) ? emptyCycles(run.status, run.note) : emptyCycles("no-python-files");
	}
	if (run.data.files_py === 0) return emptyCycles("no-python-files");
	const members = [...new Set(run.data.cycle_groups.flatMap((group) => group.files))].sort();
	const { ignored } = ignoredByGit(root, members);
	const skips: Record<string, number> = {};
	const groups = run.data.cycle_groups.filter((group) => {
		const clean = !group.files.some((file) => ignored.has(file));
		if (!clean) bump(skips, "cycle_gitignored_member");
		return clean;
	});
	return {
		status: "ok",
		files: new Set(groups.flatMap((group) => group.files)),
		groups,
		skips,
		pythonFiles: run.data.files_py,
	};
}

/** What the scan adds to the `cycles` output: a `python` detail object and stderr notes. */
export function describePythonCycles(scan: PythonCycleScan): { details: JsonObject | null; notes: string[] } {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	if (scan.status !== "ok") {
		return { details: { python: { status: scan.status, note: scan.note ?? "" } }, notes: [`note: ${scan.note ?? "Python files were not analysed"}`] };
	}
	const python: JsonObject = { status: "ok", cycle_count: scan.groups.length, python_files: scan.pythonFiles, skips: scan.skips, groups: scan.groups };
	const notes =
		scan.groups.length === 0
			? []
			: [`note: ${scan.groups.length} Python import cycle candidates in ${scan.files.size} files; these are candidates to review and none is verified (see "python" in --json)`];
	return { details: { python }, notes };
}
