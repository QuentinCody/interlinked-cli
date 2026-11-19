// ===========================================
// Check Command — broken-imports scan for Python
// ===========================================
// A CANDIDATE list, not a verdict: each entry is a first-party import whose target
// module does not exist, or whose imported name is neither bound at the target's top
// level nor a submodule. The analyzer (check-python-script-*.ts) errs toward silence:
// a try/except ImportError guard, a target with `__getattr__`, a star import or a
// dynamic module surface, a stub or extension-module source, a namespace package, an
// ambiguous resolution root and an importer that edits `sys.path` are all skipped and
// counted. Third-party and standard-library imports are never judged.
//
// Resolution roots: the repository root, every `src` directory, every directory with a
// manifest, the directories that `pyproject.toml` names as simple string literals
// (pytest `pythonpath`, setuptools `package-dir` and `packages.find.where`, poetry
// `packages[].from`), the directories that hold `conftest.py` (for the files below
// them), and the importer's own directory when the file is run by path (`sys.path[0]`):
// a test, example, script, doc file or `__main__` guard in a plain directory; in a package
// directory only a test, example, script or doc file WITH a `__main__` guard. A directory
// with `__init__.py` is never a root, and a standard-library name resolves first-party
// only through the importer's own roots. A build file that names a native extension module
// (maturin, setuptools, cffi, meson) takes that import out of the candidates.
//
// KNOWN GAPS: `.pth` files, `PYTHONPATH` set outside the repository, a setup.py or
// setup.cfg that names package directories, an editable install that maps a name to a
// directory outside the tree, a target that a build step generates without a `.gitignore`
// rule. The git-ignore test needs `git` on PATH and treats a non-repository as "nothing
// ignored".

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { runPythonAnalysis, type PythonRun, type PythonSpawn, type RawPythonCandidate } from "./check-python-run.js";

export interface PythonImportScan {
	status: "ok" | "unavailable" | "failed" | "no-python-files";
	/** Why Python was not analysed (status unavailable or failed). */
	note?: string;
	candidates: RawPythonCandidate[];
	/** Relative paths of the importers that hold at least one candidate. */
	files: Set<string>;
	stats: Record<string, number>;
	skips: Record<string, number>;
	unparsed: { path: string; reason: string }[];
	importRoots: string[];
	pythonFiles: number;
	/** True when `git check-ignore` answered; false outside a repository or without git. */
	gitIgnoreChecked: boolean;
}

const PRUNED = new Set([".git", "node_modules", "__pycache__", ".venv", "site-packages"]);
const WALK_ENTRY_CAP = 200_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export function emptyScan(status: PythonImportScan["status"], note?: string): PythonImportScan {
	return {
		status,
		...(note ? { note } : {}),
		candidates: [],
		files: new Set(),
		stats: {},
		skips: {},
		unparsed: [],
		importRoots: [],
		pythonFiles: 0,
		gitIgnoreChecked: false,
	};
}

/** True when the tree holds a `.py` file (bounded walk; used only when python3 is missing). */
function holdsPythonFile(root: string): boolean {
	const queue = [root];
	let seen = 0;
	for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > WALK_ENTRY_CAP) return false;
			if (entry.isDirectory() && !PRUNED.has(entry.name)) queue.push(join(dir, entry.name));
			else if (entry.isFile() && entry.name.endsWith(".py")) return true;
		}
	}
	return false;
}

/** The subset of `paths` that git ignores (one `check-ignore --stdin -z` call, no `-q`, neutral config). */
export function ignoredByGit(root: string, paths: string[]): { ignored: Set<string>; checked: boolean } {
	if (paths.length === 0) return { ignored: new Set(), checked: true };
	const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, "check-ignore", "--stdin", "-z"], {
		input: `${paths.join("\0")}\0`,
		encoding: "utf-8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_OUTPUT_BYTES,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
	// Exit 0 = some ignored, 1 = none ignored, 128 = fatal (not a repository). A fatal run
	// means "not ignored", never a finding.
	if (run.error || (run.status !== 0 && run.status !== 1)) return { ignored: new Set(), checked: false };
	return { ignored: new Set(run.stdout.split("\0").filter((item) => item !== "")), checked: true };
}

export function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

/** Drops candidates whose importer or target path git ignores; counts each drop under a named skip. */
function filterIgnored(root: string, candidates: RawPythonCandidate[], skips: Record<string, number>): { kept: RawPythonCandidate[]; checked: boolean } {
	const queried = new Set<string>();
	for (const candidate of candidates) {
		queried.add(candidate.importer);
		for (const path of candidate.ignore_paths) queried.add(path);
	}
	const { ignored, checked } = ignoredByGit(root, [...queried].sort());
	const kept: RawPythonCandidate[] = [];
	for (const candidate of candidates) {
		if (ignored.has(candidate.importer)) bump(skips, "importer_gitignored");
		else if (candidate.ignore_paths.some((path) => ignored.has(path))) bump(skips, "target_gitignored");
		else kept.push(candidate);
	}
	return { kept, checked };
}

function scanFromRun(root: string, run: Extract<PythonRun, { status: "ok" }>): PythonImportScan {
	const data = run.data;
	if (data.files_py === 0) return emptyScan("no-python-files");
	const skips = { ...data.skips };
	const { kept, checked } = filterIgnored(root, data.candidates, skips);
	return {
		status: "ok",
		candidates: kept,
		files: new Set(kept.map((candidate) => candidate.importer)),
		stats: data.stats,
		skips,
		unparsed: data.unparsed,
		importRoots: data.import_roots,
		pythonFiles: data.files_py,
		gitIgnoreChecked: checked,
	};
}

/** What the scan adds to the `broken-imports` output: a `python` detail object and stderr notes. */
export interface PythonCheckExtras {
	details: JsonObject | null;
	notes: string[];
}

function publicCandidate(candidate: RawPythonCandidate): JsonObject {
	const { ignore_paths: _ignorePaths, ...rest } = candidate;
	return { ...rest };
}

function importScope(stats: Record<string, number>): { targets: number; share: number } {
	const inScope = (stats.relative ?? 0) + (stats.absolute_first_party_checked ?? 0);
	const targets = inScope + (stats.absolute_not_first_party ?? 0);
	return { targets, share: targets === 0 ? 0 : inScope / targets };
}

/** The extra output of a Python scan; nothing at all for a tree without Python source. */
export function describePythonScan(scan: PythonImportScan): PythonCheckExtras {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	if (scan.status !== "ok") {
		return { details: { python: { status: scan.status, note: scan.note ?? "" } }, notes: [`note: ${scan.note ?? "Python files were not analysed"}`] };
	}
	const scope = importScope(scan.stats);
	const python: JsonObject = {
		status: "ok",
		candidate_count: scan.candidates.length,
		python_files: scan.pythonFiles,
		import_targets: scope.targets,
		in_scope_share: scope.share,
		import_roots: scan.importRoots,
		stats: scan.stats,
		skips: scan.skips,
		unparsed: scan.unparsed,
		git_ignore_checked: scan.gitIgnoreChecked,
		candidates: scan.candidates.map(publicCandidate),
	};
	const notes =
		scan.candidates.length === 0
			? []
			: [`note: ${scan.candidates.length} Python import candidates in ${scan.files.size} files; these are candidates to review and none is verified (see "python" in --json)`];
	return { details: { python }, notes };
}

/**
 * Broken first-party imports in the Python files under `root`, as candidates. TypeScript
 * and JavaScript files are not read here. `spawn` is injectable for tests.
 */
export function scanPythonBrokenImports(root: string, spawn?: PythonSpawn): PythonImportScan {
	return importsFromRun(root, runPythonAnalysis(root, spawn));
}

/** Same scan from an analysis run that the caller already made (one child process serves every Python check). */
export function importsFromRun(root: string, run: PythonRun): PythonImportScan {
	if (run.status === "ok") return scanFromRun(root, run);
	// Without a working interpreter, say so only when the tree really holds Python source.
	if (!holdsPythonFile(root)) return emptyScan("no-python-files");
	return emptyScan(run.status, run.note);
}

/** True when the tree holds Python source although the interpreter could not run. */
export function pythonSourceWithoutInterpreter(root: string): boolean {
	return holdsPythonFile(root);
}
