// ===========================================
// Check Engine — Unified types
// ===========================================

/** Canonical tool identifiers across the check engine. */
export type ToolId =
	| "tsc"
	| "biome"
	| "eslint"
	| "semgrep"
	| "gitleaks"
	| "dep-audit"
	| "mypy"
	| "ruff"
	| "ruff-format"
	| "cargo-check"
	| "cargo-clippy"
	| "rustfmt"
	| "go-build"
	| "golangci-lint"
	| "go-test"
	| "c-compile"
	| "clang-tidy"
	| "oxlint"
	| "knip"
	| "shellcheck"
	| "actionlint"
	| "hadolint"
	| "taplo"
	| "swiftlint"
	| "swift-build"
	| "lizard"
	// Project-local check: `node scripts/check-docs.mjs` validates that
	// `gen:*` markers in README/landing/etc. match the source-of-truth
	// counts (rule_count, runner_count, …). Mirrors the same CI step
	// (`npm run docs:check`) and the pre-push hook. Drift here is what
	// caused the red-CI incident on commit 5452fac.
	| "docs-check";

/** A single finding from any check tool. */
export interface CheckResult {
	tool: ToolId;
	severity: "error" | "warning" | "info";
	file: string; // relative path from projectRoot
	line: number; // 0 if unknown
	column?: number | undefined;
	message: string;
	ruleId?: string | undefined; // e.g. "TS2345", "lint/suspicious/noDoubleEquals"
}

/** Controls WHAT gets checked. */
export interface CheckScope {
	/** Project root (where tsconfig.json, package.json etc live). */
	projectRoot: string;
	/** "project" = scan all files; "file" = scope to targetFile. */
	mode: "project" | "file";
	/** When mode="file", the absolute path to the file to check. */
	targetFile?: string;
	/** When mode="file", filter project-wide tool output to only this file's results. */
	filterToFile?: boolean;
}

/** Controls HOW checks run. */
export interface CheckOptions {
	/** Maximum time per tool in ms. */
	timeoutMs?: number;
	/** Which tools to run (undefined = all available). */
	tools?: ToolId[];
	/** Which tools to skip. */
	skipTools?: ToolId[];
	/** Internal composition seam: the caller already owns the project's
	 * cross-process heavyweight lease across a larger verification run. */
	admissionAlreadyHeld?: boolean;
}

/** Result of tool availability detection. */
export interface ToolAvailability {
	id: ToolId;
	available: boolean;
	version?: string | undefined;
	reason?: string | undefined; // why unavailable (e.g. "not installed", "no config file")
}

/** Full report from a check run. */
export interface CheckReport {
	results: CheckResult[];
	toolsRun: ToolAvailability[];
	toolsSkipped: ToolAvailability[];
	/** Structured skip reasons for CI visibility. */
	skipped: SkipEntry[];
	elapsedMs: number;
	/** Per-tool execution metrics (timing, cache hits, finding counts). */
	metrics: ToolMetrics[];
	/** Number of duplicate results removed during deduplication. */
	deduplicatedCount: number;
}

/** SCA audit result (structured vulnerability counts). */
export interface AuditResult {
	tool: string;
	total: number;
	critical: number;
	high: number;
	moderate: number;
	low: number;
	detail: string;
}

/** Input for a tool runner function. */
export interface ToolRunnerInput {
	scope: CheckScope;
	timeoutMs: number;
	/** Resolved `.interlinked/tool-commands` override for this tool (see
	 *  check-engine/tool-commands.ts). Runners merge it with their fixed
	 *  prefix when present; when a full `argv` is supplied the runner uses it
	 *  verbatim (the caller owns the command). */
	commandOverride?: ResolvedToolCommand | undefined;
}

/** Resolved per-tool command override. Produced by `resolveToolCommand` in
 *  check-engine/tool-commands.ts from the two-tier tool-commands config. */
export interface ResolvedToolCommand {
	/** Full argv override — the runner performs no merge (project owns argv). */
	argv?: string[] | undefined;
	/** base_args appended after the runner's fixed prefix, replacing its
	 *  default scope. Empty when no base_args were configured. */
	baseArgs: string[];
	/** Extra/overriding env vars for the spawned process. */
	env?: Record<string, string> | undefined;
	/** Per-run cap in ms, already bounded by the hard CLI ceiling. */
	timeoutMs?: number | undefined;
}

/** Raw per-tool entry from `.interlinked/tool-commands.json` /
 *  `.interlinked/tool-commands.local.json`. Field names stay snake_case to
 *  match the rest of the two-tier config vocabulary. */
export interface ToolCommandConfig {
	command?: string[] | undefined;
	base_args?: string[] | undefined;
	env?: Record<string, string> | undefined;
	timeout_ms?: number | undefined;
}

/** A tool runner function: spawn tool, parse output, return results.
 *  Synchronous variant — kept for back-compat with `runChecks` (the
 *  existing sync entry point). New runners should also expose a
 *  `ToolRunnerAsync` if they want to run truly in parallel under
 *  `runChecksAsync`. */
export type ToolRunner = (input: ToolRunnerInput) => CheckResult[];

/** Async variant of a tool runner. Used by `runChecksAsync` for true
 *  concurrent execution under the limiter — `runProcessAsync` does the
 *  non-blocking subprocess spawn under the hood. When a tool only exposes
 *  the sync `runner`, `runChecksAsync` wraps it in `Promise.resolve` for
 *  backward compatibility (cost: still blocks the event loop, but stays
 *  ordered with other parallel-safe tools' awaits). */
export type ToolRunnerAsync = (input: ToolRunnerInput) => Promise<CheckResult[]>;

/** Metadata about a tool runner for scheduling decisions. */
export interface ToolRunnerMeta {
	runner: ToolRunner;
	/** Optional async variant — when present, `runChecksAsync` calls this
	 *  instead of `runner` so the subprocess spawn doesn't block the event
	 *  loop. Phase A.1 of the Free CLI Phase-2 roadmap migrates the 14
	 *  concurrency-safe tools incrementally; tools without an async variant
	 *  fall back to the sync `runner` wrapped in `Promise.resolve`. */
	runnerAsync?: ToolRunnerAsync;
	/** True if this tool can safely run in parallel with other tools. */
	concurrencySafe: boolean;
}

/** Per-tool execution metrics collected during a check run. */
export interface ToolMetrics {
	tool: ToolId;
	elapsedMs: number;
	findingCount: number;
	cacheHit: boolean;
}

/** A check that was skipped with a structured reason. */
export interface SkipEntry {
	check: string;
	reason: string;
	category:
		| "tool_missing"
		| "config_disabled"
		| "file_type_mismatch"
		| "resource_busy"
		| "timeout"
		| "error";
}
