// ===========================================
// Tool Runner — Hadolint
// ===========================================
// Dockerfile linter enforcing best practices. Catches missing USER
// directives, apt-get without --no-install-recommends, unpinned base
// images, and Dockerfile anti-patterns. JSON output via --format json.

import { spawnSync } from "node:child_process";
import { parseHadolintJson, relativeResultPaths } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

export function runHadolint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	// hadolint only works on individual files
	if (scope.mode !== "file" || !scope.targetFile) return [];

	try {
		const result = spawnSync("hadolint", ["--format", "json", scope.targetFile], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Exit 0 = no issues, exit 1 = issues found
		if (result.status === 0) return [];
		if (result.error) return [];

		const output = result.stdout || "";
		const results = parseHadolintJson(output);

		return relativeResultPaths(results, scope.projectRoot);
	} catch {
		return [];
	}
}

/** Async variant — Phase A.1. */
export async function runHadolintAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	if (scope.mode !== "file" || !scope.targetFile) return [];
	const result = await runProcessAsync(
		"hadolint",
		["--format", "json", scope.targetFile],
		{ cwd: scope.projectRoot, timeout: timeoutMs },
	);
	if (result.code === null || result.code === 0) return [];
	const results = parseHadolintJson(result.stdout);
	return relativeResultPaths(results, scope.projectRoot);
}
