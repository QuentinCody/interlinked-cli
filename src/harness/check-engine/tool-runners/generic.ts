// ===========================================
// Tool Runners — ESLint, Oxlint, Semgrep, Gitleaks, Dependency Audit
// ===========================================

import { spawnSync } from "node:child_process";
import { typedEslintArgs } from "../../../lib/lint-import/builtin-profiles.js";
import { hasErrorCode, PartialToolReportError } from "../tool-errors.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasOsvScanner } from "../../quality-checks/dependency-audit.js";
import {
	filterResultsToFile,
	parseGitleaksJson,
	parseKnipJson,
	parseNpmAuditJson,
	parseOsvScannerJson,
	parseOxlintJson,
	parseSemgrepJson,
} from "../output-parsers.js";
import { parseCompleteEslintJson, parseEslintJson } from "../output-parsers-eslint-json.js";
import { interlinkedSemgrepConfigArgs } from "../semgrep-rules.js";
import { runProcessAsync } from "../spawn-async.js";
import { readResourceBudget } from "../../resource-budget.js";
import type { AuditResult, CheckResult, ToolRunnerInput } from "../types.js";
import { parseCompleteGitleaksReport, parseCompleteSemgrepReport, readGenericProcessReport, requireGenericProcessVerdict } from "./generic-process-verdict.js";
import { runGitleaksForeground } from "./gitleaks-foreground.js";

// -------------------------------------------
// ESLint
// -------------------------------------------

const ESLINT_CONFIG_FILES = [
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.yml",
	".eslintrc.yaml",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
];

function findEslintConfig(startDir: string): boolean {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		for (const name of ESLINT_CONFIG_FILES) {
			if (existsSync(resolve(dir, name))) return true;
		}
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return false;
}

export function runEslint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;
	if (!findEslintConfig(scope.projectRoot)) return [];

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync(
			"npx",
			["eslint", "--no-error-on-unmatched-pattern", "--format", "json", target],
			{
				cwd: scope.projectRoot,
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		if (result.status === 0) return [];
		const output = (result.stdout || "") + (result.stderr || "");
		return parseEslintJson(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Oxlint (Rust-based JS/TS linter, ~100x faster than ESLint)
// -------------------------------------------

export function runOxlint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync("npx", ["oxlint", "--format=json", target], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		// Exit 0 = clean, exit 1 = issues found
		if (result.status === 0) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];
		return parseOxlintJson(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Knip (unused exports, files, dependencies)
// -------------------------------------------

export function runKnip(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const result = spawnSync("npx", ["knip", "--no-progress", "--reporter", "json"], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		// Exit 0 = clean, exit 1 = issues found, exit 2 = config error
		if (result.status === 0 || result.status === 2) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];

		const results = parseKnipJson(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// Semgrep
// -------------------------------------------

export function runSemgrep(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync(
			"semgrep",
			[
				"scan",
				"--quiet",
				"--no-git-ignore",
				"--metrics",
				"off",
				"--config",
				"p/default",
				...interlinkedSemgrepConfigArgs(),
				"--json",
				target,
			],
			{
				cwd: scope.projectRoot,
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		// Exit 2 = semgrep config/auth error — skip silently
		if (result.status === 2) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];
		return parseSemgrepJson(output, scope.projectRoot);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Gitleaks
// -------------------------------------------

function gitleaksEnvironment(): NodeJS.ProcessEnv {
    // Go otherwise uses every host core, even for a background recovery scan.
    return { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS === "1" ? "1" : "2" };
}

export function runGitleaks(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// Skip gitleaks on the per-edit hot path entirely: even targeted
		// single-file scans add latency to every PostToolUse cycle, and the
		// secrets-detection signal we care about is the project sweep run
		// from `interlinked verify`. Project-mode scans still run below.
		if (scope.mode !== "project") return [];

		const args = [
			"detect",
			"--no-git",
			"--no-banner",
			"--redact",
			"--report-format",
			"json",
			"--report-path",
			"-",
			"--source",
			".",
		];

		const result = spawnSync("gitleaks", args, {
			cwd: scope.projectRoot,
			env: gitleaksEnvironment(),
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}

		// Gitleaks: exit 0 = no leaks, exit 1 = leaks found (or fatal error).
		// Distinguish fatal errors by checking for FTL in output.
		if (result.status !== 1) return [];
		const combinedOutput = (result.stderr || "") + (result.stdout || "");
		if (combinedOutput.includes("FTL") || combinedOutput.includes("no such file")) {
			return [];
		}

		const output = (result.stdout || "").trim();
		if (!output) return [];
		return parseGitleaksJson(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Async runner variants — Phase A.1
// -------------------------------------------
// `runChecksAsync` calls these in preference to the sync runners above
// when the meta entry has `runnerAsync` set. Behavior is identical (same
// output parsers, same exit-code handling); only the spawn primitive
// differs — `runProcessAsync` doesn't block the event loop, letting the
// limiter actually run subprocesses concurrently.

export async function runTypedEslintForeground({ scope, timeoutMs }: ToolRunnerInput): Promise<CheckResult[]> {
	const result = await runProcessAsync("npx", typedEslintArgs(), { cwd: scope.projectRoot, timeout: timeoutMs, maxBufferBytes: null });
	return readGenericProcessReport("tseslint-types", result, stdout => parseCompleteEslintJson(stdout, "tseslint-types"));
}

export async function runEslintAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	if (!findEslintConfig(scope.projectRoot)) return [];
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	const result = await runProcessAsync(
		"npx",
		["eslint", "--no-error-on-unmatched-pattern", "--format", "json", target],
		{ cwd: scope.projectRoot, timeout: timeoutMs },
	);
	const results = parseEslintJson(result.stdout || result.stderr);
	requireGenericProcessVerdict("eslint", result, results);
	return results;
}

export async function runOxlintAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	const result = await runProcessAsync("npx", ["oxlint", "--format=json", target], {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	const results = parseOxlintJson(result.stdout.trim());
	requireGenericProcessVerdict("oxlint", result, results);
	return results;
}

export async function runKnipAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const result = await runProcessAsync(
		"npx",
		["knip", "--no-progress", "--reporter", "json"],
		{ cwd: scope.projectRoot, timeout: timeoutMs },
	);
	const output = result.stdout.trim();
	const results = parseKnipJson(output);
	requireGenericProcessVerdict("knip", result, results);
	if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
		return filterResultsToFile(results, scope.targetFile);
	}
	return results;
}

export async function runSemgrepAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	const result = await runProcessAsync(
		"semgrep",
		[
			"scan",
			"--quiet",
			...(input.resourcePolicy === "foreground-verify" && scope.mode === "project" ? [] : ["--no-git-ignore"]),
			"--metrics",
			"off",
			"--config",
			"p/default",
			...interlinkedSemgrepConfigArgs(),
			"--json",
			...(input.resourcePolicy === "foreground-verify" ? ["--timeout", "0", "--timeout-threshold", "0", "--max-target-bytes", "0"] : []),
			target,
		],
		{ cwd: scope.projectRoot, timeout: timeoutMs },
	);
	return readGenericProcessReport("semgrep", result, stdout => parseCompleteSemgrepReport(stdout, scope.projectRoot));
}

export async function runGitleaksAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	// Skip gitleaks on the per-edit hot path; project sweeps run from
	// `interlinked verify` are the secrets-detection signal we care about.
	if (scope.mode !== "project") return [];
	if (input.resourcePolicy === "foreground-verify") return runGitleaksForeground(scope.projectRoot, timeoutMs, input.onInputScope, input.gitleaksScope);
	const args = [
		"detect",
		"--no-git",
		"--no-banner",
		"--redact",
		"--report-format",
		"json",
		"--report-path",
		"-",
		"--source",
		".",
	];
	const resourceBudget = input.resourcePolicy === "foreground-verify" ? undefined : readResourceBudget("light");
	if (resourceBudget === null) throw new Error("Gitleaks scan lacks memory headroom; no complete security verdict");
	const result = await runProcessAsync("gitleaks", args, {
		cwd: scope.projectRoot,
		env: gitleaksEnvironment(),
		timeout: timeoutMs,
		...(resourceBudget ? { resourceBudget } : {}),
	});
	// An interrupted scan provides no security verdict. Throw so the engine
	// records an unavailable check and recovery can avoid repeating the failure.
	const results = readGenericProcessReport("gitleaks", result, parseCompleteGitleaksReport);
	if (/\bFTL\b|no such file/i.test(result.stderr)) throw new PartialToolReportError("Gitleaks failed-scope diagnostic; no complete security verdict", results);
	return results;
}

// -------------------------------------------
// Dependency Audit (npm audit, pip-audit, cargo audit, govulncheck)
// -------------------------------------------

export function runDepAudit(input: ToolRunnerInput): AuditResult | null {
	const { scope, timeoutMs } = input;

	// Prefer osv-scanner — single tool covers Go, npm, pip, cargo, Maven, etc.
	// with one JSON shape. Scans the whole project directory, recurses to find
	// all lockfiles, and exits non-zero when any vuln is found.
	if (hasOsvScanner()) {
		const osv = runOsvScanner(scope.projectRoot, timeoutMs);
		if (osv) return osv;
		// Fall through when osv-scanner is installed but returned null — e.g.
		// unsupported project (no recognised lockfile). Try the per-ecosystem
		// fallbacks so we don't silently drop a scan users would otherwise get.
	}

	// Fallback: per-ecosystem tools (current behavior pre-osv-scanner).
	if (existsSync(resolve(scope.projectRoot, "package.json"))) {
		return runNpmAudit(scope.projectRoot, timeoutMs);
	}

	// Go / Python / Rust when osv-scanner isn't installed: not wired through
	// the engine path today. The PostToolUse inline path (see quality-checks.ts
	// `dependency_audit` branch) covers those via govulncheck / pip-audit /
	// cargo audit on lockfile edits. `interlinked verify --all-checks` users
	// who want Go/Python/Rust SCA should install osv-scanner.
	return null;
}

function runOsvScanner(cwd: string, timeoutMs: number): AuditResult | null {
	try {
		const result = spawnSync(
			"osv-scanner",
			["scan", "source", "--format=json", "--recursive", "."],
			{
				cwd,
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		if (hasErrorCode(result.error, "ENOENT")) {
			return null;
		}
		// Exit 0 = clean. Exit 1 = vulns found (parse stdout). Other codes
		// (128 = scan error) → treat as unavailable rather than erroring.
		if (result.status === 0 || result.status === null) return null;
		if (result.status !== 1) return null;

		const output = (result.stdout || "").trim();
		if (!output) return null;
		return parseOsvScannerJson(output);
	} catch {
		return null;
	}
}

function runNpmAudit(cwd: string, timeoutMs: number): AuditResult | null {
	try {
		const result = spawnSync("npm", ["audit", "--json", "--audit-level=moderate"], {
			cwd,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return null;
		}

		const output = (result.stdout || "").trim();
		if (!output) return null;
		return parseNpmAuditJson(output);
	} catch {
		return null;
	}
}
