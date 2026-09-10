// ===========================================
// Tool Runners — Python (mypy, ruff lint, ruff format)
// ===========================================

import { spawnSync } from "node:child_process";
import { hasErrorCode } from "../tool-errors.js";
import { relative, resolve } from "node:path";
import {
	filterResultsToFile,
	parseMypyOutput,
	parseRuffFormatOutput,
	parseRuffJson,
} from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolId, ToolRunnerInput } from "../types.js";

// -------------------------------------------
// mypy
// -------------------------------------------

export function runMypy(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const args = ["--no-error-summary", "--no-color-output"];
		if (scope.mode === "file" && scope.targetFile) {
			args.push(scope.targetFile);
		} else {
			args.push(".");
		}

		const result = spawnSync("mypy", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		// Exit 0 = success, exit 1 = type errors found
		if (result.status === 0) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		return parseMypyOutput(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// ruff — shared helpers
// -------------------------------------------

// Rule categories the harness imposes ON TOP OF the project's Ruff config (or
// Ruff's minimal F + E4/E7/E9 default), whether or not the repo opted in —
// bare `ruff check` ships no security or bug-class linting at all, which is at
// odds with the maximal-local-enforcement house style
// (project_maximal_local_enforcement). `S` = flake8-bandit security rules (the
// per-edit non-negotiable: hardcoded secrets, eval, subprocess shell=True, weak
// hashing, SQL string-building); `B` = flake8-bugbear bug classes (mutable
// default args, unused loop vars, …). `S101` (assert-used) is dropped — it
// fires on every `assert`, ubiquitous in test files, and the harness owns
// assertion quality elsewhere. `# noqa: <CODE>` still suppresses any individual
// line. Tune the imposed policy here; drop `,B` for security-only.
const RUFF_ENFORCED_ARGS = ["--extend-select=S,B", "--extend-ignore=S101"];

/** Resolve a runner target ("." or an absolute file) to a project-relative
 *  display path for a finding's `file` field. */
function relTarget(target: string, projectRoot: string): string {
	return target === "." ? "." : relative(projectRoot, resolve(projectRoot, target));
}

/** A single loud "ruff could not run" finding. A tool failure (exit >= 2: bad
 *  flag, malformed pyproject, internal error) must never read as a clean pass —
 *  the check still carries its [proven] tag, so silence would be a lie. This
 *  generalizes the rustfmt round-6 fail-open fix to ruff and keeps the imposed
 *  flags above safe: if one is ever removed upstream, the run surfaces loudly
 *  instead of silently disabling Python linting/formatting. */
function ruffFailure(
	tool: ToolId,
	what: "lint" | "format",
	target: string,
	projectRoot: string,
	status: number | null,
	stderr: string,
): CheckResult {
	const firstLine = stderr.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "no stderr";
	return {
		tool,
		severity: "warning",
		file: relTarget(target, projectRoot),
		line: 1,
		message:
			`ruff ${what} failed (exit ${status ?? "none"}): ${firstLine.slice(0, 160)} — ` +
			`${what} NOT validated for this change`,
	};
}

// -------------------------------------------
// ruff check (lint)
// -------------------------------------------

/** Interpret a non-clean `ruff check` run: parse violations, else surface a
 *  loud tool-failure on exit >= 2. Shared by the sync + async lint runners so
 *  their fail-loud semantics can't drift. */
function ruffLintFindings(
	stdout: string,
	stderr: string,
	status: number | null,
	target: string,
	projectRoot: string,
): CheckResult[] {
	const output = stdout.trim();
	if (output) {
		const parsed = parseRuffJson(output);
		if (parsed.length > 0) return parsed;
	}
	// Exit 1 with no parseable JSON → treat as clean (historical behavior).
	// Exit >= 2 → ruff failed to run; surface loudly (fail-loud, not fail-open).
	if (status !== null && status >= 2) {
		return [ruffFailure("ruff", "lint", target, projectRoot, status, stderr)];
	}
	return [];
}

export function runRuff(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync("ruff", ["check", "--output-format=json", ...RUFF_ENFORCED_ARGS, target], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		// Exit 0 = clean, exit 1 = violations found, exit >= 2 = ruff itself errored.
		if (result.status === 0) return [];
		return ruffLintFindings(
			result.stdout || "",
			result.stderr || "",
			result.status,
			target,
			scope.projectRoot,
		);
	} catch {
		return [];
	}
}

// -------------------------------------------
// ruff format --check (formatting)
// -------------------------------------------

/** Interpret a non-clean `ruff format --check` run: per-file reformat findings
 *  (scoped to the edited file when filterToFile is set), else a generic dirty
 *  finding on exit 1, else a loud tool-failure. Shared by sync + async. */
function ruffFormatFindings(
	output: string,
	status: number | null,
	scope: ToolRunnerInput["scope"],
	target: string,
): CheckResult[] {
	const parsed = parseRuffFormatOutput(output, scope.projectRoot);
	const findings =
		scope.mode === "file" && scope.targetFile && scope.filterToFile
			? filterResultsToFile(parsed, relTarget(scope.targetFile, scope.projectRoot))
			: parsed;
	if (findings.length > 0) return findings;
	// Parsed reformat lines existed but all belonged to OTHER files → edited file clean.
	if (parsed.length > 0) return [];
	// Exit 1 with no "Would reformat" line still means this target would change —
	// emit one finding so a reformattable file never reads clean.
	if (status === 1) {
		return [
			{
				tool: "ruff-format",
				severity: "warning",
				file: relTarget(target, scope.projectRoot),
				line: 1,
				message: "not ruff-formatted — run `ruff format`",
			},
		];
	}
	// Exit >= 2 = a genuine tool failure (bad flag, parse error). Surface loudly.
	return [ruffFailure("ruff-format", "format", target, scope.projectRoot, status, "")];
}

export function runRuffFormat(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync("ruff", ["format", "--check", target], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		// Exit 0 = already formatted, exit 1 = would reformat, exit >= 2 = error.
		if (result.status === 0) return [];
		const output = (result.stdout || "") + (result.stderr || "");
		return ruffFormatFindings(output, result.status, scope, target);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Async variants — Phase A.1
// -------------------------------------------

export async function runMypyAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const args = ["--no-error-summary", "--no-color-output"];
	args.push(scope.mode === "file" && scope.targetFile ? scope.targetFile : ".");
	const result = await runProcessAsync("mypy", args, {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	if (result.code === null || result.code === 0) return [];
	return parseMypyOutput(`${result.stdout}${result.stderr}`);
}

export async function runRuffAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	const result = await runProcessAsync("ruff", ["check", "--output-format=json", ...RUFF_ENFORCED_ARGS, target], {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	if (result.code === null || result.code === 0) return [];
	return ruffLintFindings(result.stdout, result.stderr, result.code, target, scope.projectRoot);
}

export async function runRuffFormatAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	const result = await runProcessAsync("ruff", ["format", "--check", target], {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	if (result.code === null || result.code === 0) return [];
	return ruffFormatFindings(`${result.stdout}${result.stderr}`, result.code, scope, target);
}
