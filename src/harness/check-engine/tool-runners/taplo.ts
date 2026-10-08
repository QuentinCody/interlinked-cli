// ===========================================
// Tool Runner — Taplo
// ===========================================
// TOML toolkit — validates TOML files (Cargo.toml, pyproject.toml, etc.)
// for syntax errors and formatting issues. Errors output on stderr.

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { parseTaploOutput } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";
import { requireFileProcessVerdict } from "./file-process-verdict.js";

export function runTaplo(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	// taplo check works on individual files
	if (scope.mode !== "file" || !scope.targetFile) return [];

	try {
		const result = spawnSync("taplo", ["check", scope.targetFile], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.status === 0) return [];
		if (result.error) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		const results = parseTaploOutput(output, scope.targetFile);

		return results.map((r) => ({
			...r,
			file: r.file.startsWith("/") ? relative(scope.projectRoot, r.file) : r.file,
		}));
	} catch {
		return [];
	}
}

/** Async variant — Phase A.1. */
export async function runTaploAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	if (scope.mode !== "file" || !scope.targetFile) return [];
	const result = await runProcessAsync("taplo", ["check", scope.targetFile], {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	const output = `${result.stdout}${result.stderr}`;
	const results = result.code === 0 ? [] : parseTaploOutput(output, scope.targetFile);
    requireFileProcessVerdict("taplo", result, results.length);
	return results.map((r) => ({
		...r,
		file: r.file.startsWith("/") ? relative(scope.projectRoot, r.file) : r.file,
	}));
}
