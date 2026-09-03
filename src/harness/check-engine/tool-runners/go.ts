// ===========================================
// Tool Runners — Go (go build, golangci-lint)
// ===========================================

import { spawnSync } from "node:child_process";
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

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
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
		const args = [
			"run",
			"--out-format=json",
			...golangciBuildTagArgs(goToolTags(process.env)),
			goPackagePattern(scope),
		];
		const result = spawnSync("golangci-lint", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			env: resolveGoEnv(process.env),
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
