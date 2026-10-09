// ===========================================
// Tool Runners — Go (go build, golangci-lint)
// ===========================================

import { spawnSync } from "node:child_process";
import { hasErrorCode } from "../tool-errors.js";
import {
	filterResultsToFile,
	parseGoBuildOutput,
	parseGolangciLintJson,
} from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";
import {
	goBuildTagArgs,
	goPackagePattern,
	goToolTags,
	golangciBuildTagArgs,
	resolveGoEnv,
} from "./go-invocation.js";

/** golangci-lint v1 JSON flag. v2 removed it (`unknown flag: --out-format`, exit 3). */
const GOLANGCI_V1_JSON = "--out-format=json";
/** golangci-lint v2+ JSON flag. Text stays off stdout when only this path is set. */
const GOLANGCI_V2_JSON = "--output.json.path=stdout";

/**
 * Pick the JSON output flag from `golangci-lint version` text.
 * Unrecognized output stays on the v1 flag so older binaries keep working.
 */
export function golangciJsonFormatArg(versionOutput: string): string {
	const match =
		versionOutput.match(/\bversion\s+(\d+)\./i) ?? versionOutput.match(/\b(\d+)\.\d+\.\d+\b/);
	const major = match ? Number(match[1]) : 1;
	return major >= 2 ? GOLANGCI_V2_JSON : GOLANGCI_V1_JSON;
}

/**
 * golangci-lint `pkg/exitcodes` values that mean the analysis did not finish.
 * These are not an empty issue list. Exit 0 is clean. Exit 1 (IssuesFound)
 * and any other code still carry JSON issues.
 */
const GOLANGCI_NO_VERDICT_STATUS: Readonly<Record<number, string>> = {
	3: "analysis failed (exit 3)",
	4: "timed out (exit 4)",
	5: "no Go files to analyze (exit 5)",
	6: "no config file detected (exit 6)",
	7: "an error was logged (exit 7)",
};

function golangciNoVerdict(reason: string, detail?: string): CheckResult[] {
	const line = detail?.trim().split("\n").find((row) => row.trim().length > 0);
	const clipped = line === undefined ? undefined : line.trim().slice(0, 200);
	const suffix = clipped === undefined || clipped.length === 0 ? "" : ` (${clipped})`;
	return [
		{
			tool: "golangci-lint",
			severity: "warning",
			file: "",
			line: 0,
			message: `golangci-lint did not produce a verdict: ${reason}${suffix}`,
		},
	];
}

/** `null` means the caller should parse JSON issues. */
function golangciUnfinished(status: number | null, detail?: string): CheckResult[] | null {
	if (status === null) return golangciNoVerdict("process did not exit");
	const reason = GOLANGCI_NO_VERDICT_STATUS[status];
	if (reason === undefined) return null;
	return golangciNoVerdict(reason, detail);
}

function probeGolangciFormatArg(cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): string {
	try {
		const result = spawnSync("golangci-lint", ["version"], {
			cwd,
			timeout: Math.min(timeoutMs, 10_000),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		if (result.error) return GOLANGCI_V1_JSON;
		return golangciJsonFormatArg(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	} catch {
		return GOLANGCI_V1_JSON;
	}
}

// -------------------------------------------
// go build
// -------------------------------------------

export function runGoBuild(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// Scoped to the edited file's package when findings are filtered to
		// that file anyway (see goPackagePattern); project-wide otherwise.
		// Build tags + env come from the one Go invocation policy so this
		// compile shares a build-cache key set with `go test` / golangci-lint
		// instead of populating a third one.
		const args = ["build", ...goBuildTagArgs(goToolTags(process.env)), goPackagePattern(scope)];
		const result = spawnSync("go", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			env: resolveGoEnv(process.env),
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
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

// -------------------------------------------
// golangci-lint
// -------------------------------------------

export function runGolangciLint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// Same scope decision as runGoBuild: narrowed to the edited package
		// only where non-target findings are filtered out anyway. `--build-tags`
		// is threaded explicitly because golangci-lint does NOT read `-tags`
		// from GOFLAGS — without it its loader sees a different file set than
		// `go build` and pays for a separate type-check.
		const env = resolveGoEnv(process.env);
		const formatArg = probeGolangciFormatArg(scope.projectRoot, timeoutMs, env);
		const args = [
			"run",
			formatArg,
			...golangciBuildTagArgs(goToolTags(process.env)),
			goPackagePattern(scope),
		];
		const result = spawnSync("golangci-lint", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		if (hasErrorCode(result.error, "ETIMEDOUT")) {
			return golangciNoVerdict("timed out");
		}
		// Exit 0 = clean. Exit 1 = issues found (JSON on stdout).
		if (result.status === 0) return [];
		const unfinished = golangciUnfinished(result.status, result.stderr || "");
		if (unfinished !== null) return unfinished;

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
