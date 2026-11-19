// ===========================================
// Check Command — Python-aware structural scans
// ===========================================
// `interlinked check` builds its TypeScript/JavaScript results from the project graph.
// The checks named below also read Python source and merge their scan into the structural
// result of the same name. Six read the output of ONE Python child process for the run
// (broken-imports, cycles, any-types, duplicates, dead-imports, blast-radius); two read the
// git file list in TypeScript and start no process (missing-tests, secrets). Python importers
// join the file set, the evidence goes under a `python` key in `--json`, and a scan that could
// not run is described, never thrown. A tree without Python files is left untouched.

import type { JsonObject } from "../lib/json-types.js";
import type { StructuralCheckResult } from "./check-output.js";
import { describePythonAnyTypes, scanPythonAnyTypes } from "./check-python-any.js";
import { describePythonBlastRadius, scanPythonBlastRadius } from "./check-python-blast.js";
import { describePythonCycles, scanPythonCycles } from "./check-python-cycles.js";
import { describePythonDeadImports, scanPythonDeadImports } from "./check-python-dead-imports.js";
import { describePythonDuplicates, scanPythonDuplicates } from "./check-python-duplicates.js";
import { listProjectFiles } from "./check-python-files.js";
import { describePythonScan, importsFromRun } from "./check-python-imports.js";
import { describePythonMissingTests, scanPythonMissingTests } from "./check-python-missing-tests.js";
import { runPythonAnalysis, type PythonRun, type PythonSpawn } from "./check-python-run.js";
import { describePythonSecrets, scanPythonSecrets } from "./check-python-secrets.js";

interface PythonScan {
	files: Set<string>;
	described: { details: JsonObject | null; notes: string[] };
}

/** What a scanner may ask for. Each source is made on first use, once per run. */
interface ScanSources {
	root: string;
	run: () => PythonRun;
	projectFiles: () => string[];
}

const SCANNERS: Record<string, (sources: ScanSources) => PythonScan> = {
	"broken-imports": ({ root, run }) => {
		const scan = importsFromRun(root, run());
		return { files: scan.files, described: describePythonScan(scan) };
	},
	"any-types": ({ root, run }) => {
		const scan = scanPythonAnyTypes(root, run());
		return { files: scan.files, described: describePythonAnyTypes(scan) };
	},
	duplicates: ({ root, run }) => {
		const scan = scanPythonDuplicates(root, run());
		return { files: scan.files, described: describePythonDuplicates(scan) };
	},
	cycles: ({ root, run }) => {
		const scan = scanPythonCycles(root, run());
		return { files: scan.files, described: describePythonCycles(scan) };
	},
	"dead-imports": ({ root, run }) => {
		const scan = scanPythonDeadImports(root, run());
		return { files: scan.files, described: describePythonDeadImports(scan) };
	},
	"blast-radius": ({ root, run }) => {
		const scan = scanPythonBlastRadius(root, run());
		return { files: scan.files, described: describePythonBlastRadius(scan) };
	},
	"missing-tests": ({ projectFiles }) => {
		const scan = scanPythonMissingTests(projectFiles());
		return { files: scan.files, described: describePythonMissingTests(scan) };
	},
	secrets: ({ root, projectFiles }) => {
		const scan = scanPythonSecrets(root, projectFiles());
		return { files: scan.files, described: describePythonSecrets(scan) };
	},
};

function once<T>(make: () => T): () => T {
	let made: { value: T } | undefined;
	return () => {
		made ??= { value: make() };
		return made.value;
	};
}

/** Merge the Python scans into `results` in place; returns the stderr notes to print. */
export function applyPythonChecks(results: StructuralCheckResult[], root: string, spawn?: PythonSpawn): string[] {
	const wanted = results.filter((result) => result.name in SCANNERS);
	if (wanted.length === 0) return [];
	let started: PythonRun | undefined;
	const run = once(() => {
		started = runPythonAnalysis(root, spawn);
		return started;
	});
	const sources: ScanSources = { root, run, projectFiles: once(() => listProjectFiles(root).files) };
	const notes: string[] = [];
	for (const result of wanted) {
		const scan = SCANNERS[result.name]?.(sources);
		if (!scan) continue;
		for (const file of scan.files) result.files.add(file);
		if (scan.described.details) result.details = scan.described.details;
		notes.push(...scan.described.notes);
	}
	if (started?.status === "ok" && started.data.files_truncated) {
		notes.unshift(`note: Python analysis stopped at its file-count bound (${started.data.files_py} files); later Python files were not analysed`);
	}
	return notes;
}
