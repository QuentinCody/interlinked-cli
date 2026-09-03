// ===========================================
// Tool Runners — Go (go build, golangci-lint, go test)
// ===========================================

import { spawnSync } from "node:child_process";
import { runProcessAsync } from "../spawn-async.js";
import { buildToolCommandArgv } from "../tool-commands.js";
import {
	filterResultsToFile,
	parseGoBuildOutput,
	parseGoTestOutput,
	parseGolangciLintJson,
} from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput, ResolvedToolCommand } from "../types.js";

// The FIXED prefixes below pair with tool_commands base_args: the project
// config replaces the default scope ("./...") with its own flags/scope, e.g.
// go build → `go build -tags 'dev devaccounts' ./...`. base_args REPLACE the
// scope rather than append after it so flag ordering stays correct (Go flags
// must precede the package pattern).
const GO_BUILD_PREFIX = ["go", "build"] as const;
const GOLANGCI_PREFIX = ["golangci-lint", "run", "--out-format=json"] as const;
const GO_TEST_PREFIX = ["go", "test"] as const;
const DOT_SLASH = ["./..."] as const;

function effectiveTimeout(override: ResolvedToolCommand | undefined, base: number): number {
	return override?.timeoutMs ?? base;
}

/** timeout/killed/ENOENT all resolve to no-verdict, never clean. */
function goTimeoutFinding(
	tool: "go-build" | "go-test",
	reason: string,
): CheckResult[] {
	return [
		{
			tool,
			severity: "warning",
			file: "",
			line: 0,
			message: `${tool} did not produce a verdict: ${reason}`,
		},
	];
}

// -------------------------------------------
// go build
// -------------------------------------------

export function runGoBuild(input: ToolRunnerInput): CheckResult[] {
	const { scope } = input;
	const argv = buildToolCommandArgv(input.commandOverride, GO_BUILD_PREFIX, DOT_SLASH);
	const bin = argv[0];
	if (bin === undefined) return [];
	const args = argv.slice(1);

	try {
		const result = spawnSync(bin, args, {
			cwd: scope.projectRoot,
			timeout: effectiveTimeout(input.commandOverride, input.timeoutMs),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			...(input.commandOverride?.env ? { env: { ...process.env, ...input.commandOverride.env } } : {}),
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
			return goTimeoutFinding("go-build", "timed out");
		}
		if (result.status === 0) return [];

		// go build errors go to stderr
		const output = (result.stderr || "") + (result.stdout || "");
		const results = parseGoBuildOutput(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

export async function runGoBuildAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope } = input;
	const argv = buildToolCommandArgv(input.commandOverride, GO_BUILD_PREFIX, DOT_SLASH);
	const bin = argv[0];
	if (bin === undefined) return [];
	const args = argv.slice(1);

	const result = await runProcessAsync(bin, args, {
		cwd: scope.projectRoot,
		timeout: effectiveTimeout(input.commandOverride, input.timeoutMs),
		...(input.commandOverride?.env ? { env: input.commandOverride.env } : {}),
	});

	if (result.code === null || result.timedOut || result.killed) return [];
	if (result.code === 0) return [];

	const output = (result.stderr || "") + (result.stdout || "");
	const results = parseGoBuildOutput(output);
	if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
		return filterResultsToFile(results, scope.targetFile);
	}
	return results;
}

// -------------------------------------------
// golangci-lint
// -------------------------------------------

export function runGolangciLint(input: ToolRunnerInput): CheckResult[] {
	const { scope } = input;
	const argv = buildToolCommandArgv(input.commandOverride, GOLANGCI_PREFIX, DOT_SLASH);
	const bin = argv[0];
	if (bin === undefined) return [];
	const args = argv.slice(1);

	try {
		const result = spawnSync(bin, args, {
			cwd: scope.projectRoot,
			timeout: effectiveTimeout(input.commandOverride, input.timeoutMs),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			...(input.commandOverride?.env ? { env: { ...process.env, ...input.commandOverride.env } } : {}),
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = clean, exit 1 = issues found
		// Exit 3 = analysis failure, exit 4 = timeout — skip silently
		if (result.status === 0 || result.status === 3 || result.status === 4) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];
		const results = parseGolangciLintJson(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

export async function runGolangciLintAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope } = input;
	const argv = buildToolCommandArgv(input.commandOverride, GOLANGCI_PREFIX, DOT_SLASH);
	const bin = argv[0];
	if (bin === undefined) return [];
	const args = argv.slice(1);

	const result = await runProcessAsync(bin, args, {
		cwd: scope.projectRoot,
		timeout: effectiveTimeout(input.commandOverride, input.timeoutMs),
		...(input.commandOverride?.env ? { env: input.commandOverride.env } : {}),
	});

	if (result.code === null || result.timedOut || result.killed) return [];
	if (result.code === 0 || result.code === 3 || result.code === 4) return [];

	const output = (result.stdout || "").trim();
	if (!output) return [];
	const results = parseGolangciLintJson(output);
	if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
		return filterResultsToFile(results, scope.targetFile);
	}
	return results;
}

// -------------------------------------------
// go test (full suite)
// -------------------------------------------

export function runGoTest(input: ToolRunnerInput): CheckResult[] {
	const { scope } = input;
	const argv = buildToolCommandArgv(input.commandOverride, GO_TEST_PREFIX, DOT_SLASH);
	const bin = argv[0];
	if (bin === undefined) return [];
	const args = argv.slice(1);

	try {
		const result = spawnSync(bin, args, {
			cwd: scope.projectRoot,
			timeout: effectiveTimeout(input.commandOverride, input.timeoutMs),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			...(input.commandOverride?.env ? { env: { ...process.env, ...input.commandOverride.env } } : {}),
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
			return goTimeoutFinding("go-test", "timed out");
		}
		if (result.status === 0) return [];

		const output = combinedGoOutput(result.stdout || "", result.stderr || "");
		return parseGoTestOutput(output, result.status ?? -1);
	} catch {
		return [];
	}
}

export async function runGoTestAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope } = input;
	const argv = buildToolCommandArgv(input.commandOverride, GO_TEST_PREFIX, DOT_SLASH);
	const bin = argv[0];
	if (bin === undefined) return [];
	const args = argv.slice(1);

	const result = await runProcessAsync(bin, args, {
		cwd: scope.projectRoot,
		timeout: effectiveTimeout(input.commandOverride, input.timeoutMs),
		...(input.commandOverride?.env ? { env: input.commandOverride.env } : {}),
	});

	if (result.code === null || result.killed) return [];
	if (result.timedOut) return goTimeoutFinding("go-test", "timed out");
	if (result.code === 0) return [];

	const output = combinedGoOutput(result.stdout, result.stderr);
	return parseGoTestOutput(output, result.code ?? -1);
}

// -------------------------------------------
// Go test output helpers
// -------------------------------------------

function combinedGoOutput(stdout: string, stderr: string): string {
	return stdout.trim() ? `${stdout}${stderr.trim() ? `\n${stderr}` : ""}` : stderr;
}