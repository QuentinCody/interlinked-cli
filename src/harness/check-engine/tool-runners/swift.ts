// ===========================================
// Tool Runners — Swift (swiftlint, swift build)
// ===========================================

import { spawnSync } from "node:child_process";
import { nonNull } from "../../../lib/non-null.js";
import { filterResultsToFile } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

// -------------------------------------------
// SwiftLint JSON output parser
// -------------------------------------------
// SwiftLint --reporter json produces:
// [{ "file": "/path/file.swift", "line": 10, "character": 5,
//    "severity": "Warning", "type": "Force Cast", "rule_id": "force_cast",
//    "reason": "Force casts should be avoided." }]

// Untrusted swiftlint --reporter json output — only `character` was
// previously marked optional, but `severity` is read defensively below
// (f.severity?.toLowerCase()) because real swiftlint output can omit it too.
interface SwiftLintFinding {
	file: string;
	line: number;
	character?: number;
	severity?: string;
	type: string;
	rule_id: string;
	reason: string;
}

function parseSwiftLintJson(output: string): CheckResult[] {
	try {
		const findings: SwiftLintFinding[] = JSON.parse(output);
		if (!Array.isArray(findings)) return [];

		const results: CheckResult[] = [];
		for (const f of findings) {
			results.push({
				tool: "swiftlint",
				severity: f.severity?.toLowerCase() === "error" ? "error" : "warning",
				file: f.file,
				line: f.line || 0,
				column: f.character ?? undefined,
				message: `${f.rule_id}: ${f.reason}`,
				ruleId: f.rule_id,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// swiftlint lint
// -------------------------------------------

export function runSwiftLint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const args = ["lint", "--quiet", "--reporter", "json"];

		if (scope.mode === "file" && scope.targetFile) {
			args.push("--path", scope.targetFile);
		}

		const result = spawnSync("swiftlint", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}

		const output = result.stdout || "";
		if (!output.trim()) return [];

		const results = parseSwiftLintJson(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

/** Async variant — Phase A.1. */
export async function runSwiftLintAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const args = ["lint", "--quiet", "--reporter", "json"];
	if (scope.mode === "file" && scope.targetFile) {
		args.push("--path", scope.targetFile);
	}
	const result = await runProcessAsync("swiftlint", args, {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	if (result.code === null) return [];
	const output = result.stdout;
	if (!output.trim()) return [];
	const results = parseSwiftLintJson(output);
	if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
		return filterResultsToFile(results, scope.targetFile);
	}
	return results;
}

// -------------------------------------------
// swift build (SPM type check)
// -------------------------------------------
// Output format: /path/file.swift:line:col: error: message
// or:            /path/file.swift:line:col: warning: message

function parseSwiftBuildOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^(.+?\.swift):(\d+):(\d+):\s*(error|warning):\s*(.+)/);
		if (match) {
			results.push({
				tool: "swift-build",
				severity: match[4] === "error" ? "error" : "warning",
				file: nonNull(match[1]),
				line: Number.parseInt(nonNull(match[2]), 10),
				column: Number.parseInt(nonNull(match[3]), 10),
				message: nonNull(match[5]),
			});
		}
	}
	return results;
}

export function runSwiftBuild(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const result = spawnSync("swift", ["build", "--skip-update"], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		if (result.status === 0) return [];

		// Swift compiler outputs diagnostics to stderr
		const output = (result.stderr || "") + (result.stdout || "");
		const results = parseSwiftBuildOutput(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}
