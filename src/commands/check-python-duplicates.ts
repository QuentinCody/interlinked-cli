// ===========================================
// Check Command — duplicates scan for Python
// ===========================================
// The Python reading of `duplicates`: two or more functions or methods, in non-test
// modules, whose parameter list and body are the same syntax tree. Function names,
// comments, docstrings and layout are ignored; a body under 40 syntax nodes, a dunder
// method and a test module are not compared. A group is a candidate for review: two
// copies may be deliberate (a vendored helper, a per-class override). Members in
// git-ignored files are dropped, and a group with one member left is not reported.
// This is not the TypeScript meaning (the same exported name in two files).

import type { JsonObject } from "../lib/json-types.js";
import { bump, ignoredByGit, pythonSourceWithoutInterpreter } from "./check-python-imports.js";
import type { PythonRun, RawDuplicateGroup } from "./check-python-run.js";

export interface PythonDuplicateScan {
	status: "ok" | "unavailable" | "failed" | "no-python-files";
	note?: string;
	files: Set<string>;
	groups: RawDuplicateGroup[];
	skips: Record<string, number>;
	pythonFiles: number;
}

function emptyDuplicates(status: PythonDuplicateScan["status"], note?: string): PythonDuplicateScan {
	return { status, ...(note ? { note } : {}), files: new Set(), groups: [], skips: {}, pythonFiles: 0 };
}

function withoutIgnored(group: RawDuplicateGroup, ignored: ReadonlySet<string>, skips: Record<string, number>): RawDuplicateGroup | null {
	const members = group.members.filter((member) => {
		if (!ignored.has(member.path)) return true;
		bump(skips, "gitignored_member");
		return false;
	});
	return members.length > 1 ? { ...group, members } : null;
}

/** The duplicates scan from an analysis run the caller already made. */
export function scanPythonDuplicates(root: string, run: PythonRun): PythonDuplicateScan {
	if (run.status !== "ok") {
		return pythonSourceWithoutInterpreter(root) ? emptyDuplicates(run.status, run.note) : emptyDuplicates("no-python-files");
	}
	if (run.data.files_py === 0) return emptyDuplicates("no-python-files");
	const paths = [...new Set(run.data.duplicate_groups.flatMap((group) => group.members.map((member) => member.path)))].sort();
	const { ignored } = ignoredByGit(root, paths);
	const skips: Record<string, number> = {};
	const groups = run.data.duplicate_groups.flatMap((group) => withoutIgnored(group, ignored, skips) ?? []);
	return {
		status: "ok",
		files: new Set(groups.flatMap((group) => group.members.map((member) => member.path))),
		groups,
		skips,
		pythonFiles: run.data.files_py,
	};
}

/** What the scan adds to the `duplicates` output: a `python` detail object and stderr notes. */
export function describePythonDuplicates(scan: PythonDuplicateScan): { details: JsonObject | null; notes: string[] } {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	if (scan.status !== "ok") {
		return { details: { python: { status: scan.status, note: scan.note ?? "" } }, notes: [`note: ${scan.note ?? "Python files were not analysed"}`] };
	}
	const python: JsonObject = { status: "ok", group_count: scan.groups.length, python_files: scan.pythonFiles, skips: scan.skips, groups: scan.groups };
	const notes =
		scan.groups.length === 0
			? []
			: [`note: ${scan.groups.length} Python duplicate function candidates in ${scan.files.size} files; these are candidates to review and none is verified (see "python" in --json)`];
	return { details: { python }, notes };
}
