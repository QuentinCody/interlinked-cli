// ===========================================
// Check Command — secrets scan for Python
// ===========================================
// The TypeScript `secrets` scan reads only `.ts .tsx .js .jsx .mjs .cjs` files, so a Python
// repository got no result. This scan applies the SAME detector (`containsSecrets`: pattern
// plus entropy floor) to Python modules (`.py`, `.pyi`) and to the common Python config files
// (`pyproject.toml`, `setup.cfg`, `tox.ini`, `pytest.ini`, `requirements*.txt`,
// `constraints*.txt`, `Pipfile`), and it skips test files as the TypeScript scan does. It needs
// no interpreter. The output names the kind of secret and the file, never the value. Config
// files are read only in a tree that holds at least one `.py` file.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { containsSecrets } from "../harness/quality-checks.js";
import type { JsonObject } from "../lib/json-types.js";
import { pythonRole } from "./check-python-files.js";
import { bump } from "./check-python-imports.js";

export interface PythonSecretsScan {
	status: "ok" | "no-python-files";
	files: Set<string>;
	/** One entry per flagged file: the kinds of secret found (labels only). */
	entries: { path: string; kinds: string[] }[];
	scannedFiles: number;
	skips: Record<string, number>;
	pythonFiles: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
const CONFIG_NAMES = new Set(["pyproject.toml", "setup.cfg", "tox.ini", "pytest.ini", "Pipfile"]);
const CONFIG_PATTERN = /^(requirements|constraints)[^/]*\.txt$/;

function isScanned(path: string): boolean {
	const name = path.split("/").pop() ?? "";
	return name.endsWith(".py") || name.endsWith(".pyi") || CONFIG_NAMES.has(name) || CONFIG_PATTERN.test(name);
}

/** The secrets scan over a project file list (relative paths) read from `root`. */
export function scanPythonSecrets(root: string, files: string[]): PythonSecretsScan {
	const pythonFiles = files.filter((path) => path.endsWith(".py")).length;
	const result: PythonSecretsScan = { status: pythonFiles === 0 ? "no-python-files" : "ok", files: new Set(), entries: [], scannedFiles: 0, skips: {}, pythonFiles };
	if (pythonFiles === 0) return result;
	for (const path of files.filter(isScanned).sort()) {
		if (pythonRole(path) === "test") {
			bump(result.skips, "test_file");
			continue;
		}
		try {
			if (statSync(join(root, path)).size > MAX_BYTES) {
				bump(result.skips, "too_large");
				continue;
			}
			const kinds = containsSecrets(readFileSync(join(root, path), "utf-8"));
			result.scannedFiles += 1;
			if (kinds.length > 0) {
				result.files.add(path);
				result.entries.push({ path, kinds });
			}
		} catch {
			bump(result.skips, "unreadable");
		}
	}
	return result;
}

/** What the scan adds to the `secrets` output: a `python` detail object and stderr notes. */
export function describePythonSecrets(scan: PythonSecretsScan): { details: JsonObject | null; notes: string[] } {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	const python: JsonObject = {
		status: "ok",
		python_files: scan.pythonFiles,
		scanned_files: scan.scannedFiles,
		file_count: scan.entries.length,
		skips: scan.skips,
		files: scan.entries,
	};
	return { details: { python }, notes: [] };
}
