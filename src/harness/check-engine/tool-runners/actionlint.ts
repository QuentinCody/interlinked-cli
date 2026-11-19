// ===========================================
// Tool Runner — actionlint
// ===========================================
// GitHub Actions workflow file validator. Detects syntax errors,
// invalid expressions, unknown action versions, and type mismatches.
// Output format: "file:line:col: message [rule-name]"

import { spawnSync } from "node:child_process";
import { parseActionlintOutput, relativeResultPaths } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

export function runActionlint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const args = scope.mode === "file" && scope.targetFile ? [scope.targetFile] : ["-oneline"];

		const result = spawnSync("actionlint", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.status === 0) return [];
		if (result.error) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		const results = parseActionlintOutput(output);

		return relativeResultPaths(results, scope.projectRoot);
	} catch {
		return [];
	}
}

/** Async variant — Phase A.1. */
export async function runActionlintAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const args = scope.mode === "file" && scope.targetFile ? [scope.targetFile] : ["-oneline"];
	const result = await runProcessAsync("actionlint", args, {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	if (result.code === null || result.code === 0) return [];
	const results = parseActionlintOutput(`${result.stdout}${result.stderr}`);
	return relativeResultPaths(results, scope.projectRoot);
}
