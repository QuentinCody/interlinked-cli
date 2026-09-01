// ===========================================
// Tool Runner — ShellCheck
// ===========================================
// Shell script static analysis. Detects common shell scripting bugs,
// quoting issues, undefined variables, and POSIX compliance problems.
// Outputs JSON via --format=json1 for reliable parsing.

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { parseShellcheckJson } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

export function runShellcheck(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	// shellcheck only works on individual files, not directories
	if (scope.mode !== "file" || !scope.targetFile) return [];

	try {
		const result = spawnSync(
			"shellcheck",
			["--format=json1", "--severity=warning", scope.targetFile],
			{
				cwd: scope.projectRoot,
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		// Exit 0 = no issues, exit 1 = issues found, exit 2+ = error
		if (result.status === 0) return [];
		if (result.error || (result.status !== null && result.status > 1)) return [];

		const output = result.stdout || "";
		const results = parseShellcheckJson(output);

		// Make paths relative
		return results.map((r) => ({
			...r,
			file: r.file.startsWith("/") ? relative(scope.projectRoot, r.file) : r.file,
		}));
	} catch {
		return [];
	}
}

/** Async variant — Phase A.1. */
export async function runShellcheckAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	if (scope.mode !== "file" || !scope.targetFile) return [];
	const result = await runProcessAsync(
		"shellcheck",
		["--format=json1", "--severity=warning", scope.targetFile],
		{ cwd: scope.projectRoot, timeout: timeoutMs },
	);
	if (result.code === 0) return [];
	if (result.code === null || result.code > 1) return [];
	const results = parseShellcheckJson(result.stdout);
	return results.map((r) => ({
		...r,
		file: r.file.startsWith("/") ? relative(scope.projectRoot, r.file) : r.file,
	}));
}
