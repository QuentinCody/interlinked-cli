// ===========================================
// Check Command — project file list and Python path roles
// ===========================================
// The Python-aware checks that need no interpreter (missing-tests, secrets) read the same
// file list as the analyzer: `git ls-files --cached --others --exclude-standard`, so ignored
// trees cost nothing. Outside a repository a bounded walk replaces it; the walk skips
// dot-directories and dependency directories. Nothing here opens a file.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface ProjectFiles {
	/** Paths relative to the root, `/`-separated. */
	files: string[];
	source: "git" | "walk";
}

const GIT_LIST_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const WALK_ENTRY_CAP = 200_000;
const PRUNED_DIRS = new Set(["node_modules", "__pycache__", "site-packages", ".git"]);

/**
 * Tracked plus untracked-but-not-ignored files under `root` (paths relative to it), or null
 * outside a git repository or when git cannot run.
 */
export function gitFileList(root: string): string[] | null {
	const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		encoding: "utf-8",
		timeout: GIT_LIST_TIMEOUT_MS,
		maxBuffer: GIT_OUTPUT_BYTES,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
	if (run.error || run.status !== 0) return null;
	return run.stdout.split("\0").filter((path) => path !== "");
}

function walkFiles(root: string): string[] {
	const found: string[] = [];
	const queue: string[] = [""];
	let seen = 0;
	for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		if (entries.some((entry) => entry.name === "pyvenv.cfg")) continue;
		for (const entry of entries) {
			seen += 1;
			if (seen > WALK_ENTRY_CAP) return found;
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!PRUNED_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(path);
			} else if (entry.isFile()) {
				found.push(path);
			}
		}
	}
	return found;
}

/** The files of the project: the git list when `root` is in a repository, else a bounded walk. */
export function listProjectFiles(root: string): ProjectFiles {
	const listed = gitFileList(root);
	if (listed !== null) return { files: listed, source: "git" };
	return { files: walkFiles(root), source: "walk" };
}

export type PythonRole = "test" | "example" | "docs" | "script" | "other";

const TEST_FOLDERS = new Set(["test", "tests", "testing", "unittests", "integration_tests", "e2e"]);
/** A `<package>_tests` or `<package>-test` directory. */
export const TEST_FOLDER_SUFFIX = /[-_]tests?$/;
const EXAMPLE_WORDS = new Set(["example", "examples", "demo", "demos", "sample", "samples", "tutorial", "tutorials", "cookbook", "notebooks"]);
const DOC_FOLDERS = new Set(["doc", "docs", "documentation"]);
const SCRIPT_FOLDERS = new Set(["script", "scripts", "tools", "bin", "benchmark", "benchmarks", "ci"]);
const SCRIPT_FILES = new Set(["setup.py", "noxfile.py", "tasks.py", "fabfile.py"]);

/** What a Python file is for, from its path alone. Same rule as `importer_role` in the embedded analyzer. */
export function pythonRole(path: string): PythonRole {
	const parts = path.toLowerCase().split("/");
	const name = parts[parts.length - 1] ?? "";
	const folders = parts.slice(0, -1);
	if (folders.some((f) => TEST_FOLDERS.has(f) || TEST_FOLDER_SUFFIX.test(f)) || name.startsWith("test_") || name.endsWith("_test.py") || name === "conftest.py") return "test";
	if (folders.some((f) => f.split(/[-_]/).some((word) => EXAMPLE_WORDS.has(word)))) return "example";
	if (folders.some((f) => DOC_FOLDERS.has(f))) return "docs";
	if (folders.some((f) => SCRIPT_FOLDERS.has(f)) || SCRIPT_FILES.has(name)) return "script";
	return "other";
}
