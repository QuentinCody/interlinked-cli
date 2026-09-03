// ===========================================
// Check Engine — Unified check orchestrator
// ===========================================
// Single source of truth for running external checks.
// Two modes: "project" (batch scan) and "file" (incremental).

import { extname } from "node:path";
import { discoverSingleTool, discoverTools, formatToolReport } from "./discovery.js";
import {
	clearCheckEngineDiagnosticCache,
	readDiagnosticCache,
	writeDiagnosticCache,
} from "./diagnostic-cache.js";
import { type DeduplicationResult, deduplicateResults } from "./index-dedup.js";
import { getToolsForExtension } from "./index-extension-tools.js";
import {
	defaultTimeoutFor,
	resourceBusyReport,
	runAsyncTool,
	toolRunnerFor,
} from "./index-runtime.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { runBiomeOverlay } from "./tool-runners/biome.js";
import { runDepAudit } from "./tool-runners/generic.js";
import {
	configNameForTool,
	loadToolCommands,
	toResolvedToolCommand,
} from "./tool-commands.js";
import {
	clearTscOverlayCache,
	runTscOverlayTyped,
	type TscOverlayOutcome,
} from "./tool-runners/tsc-overlay.js";
import type {
	AuditResult,
	CheckOptions,
	CheckReport,
	CheckResult,
	CheckScope,
	ResolvedToolCommand,
	ToolAvailability,
	ToolCommandConfig,
	ToolId,
	ToolMetrics,
} from "./types.js";

// Re-export types and utilities for consumers
export { formatToolReport } from "./discovery.js";
export type {
	CheckReport,
	CheckResult,
	ResolvedToolCommand,
	SkipEntry,
	ToolCommandConfig,
	ToolId,
	ToolMetrics,
} from "./types.js";
export type { DeduplicationResult };
export { deduplicateResults };

export { configNameToToolId } from "./index-runtime.js";
export { clearCheckEngineDiagnosticCache } from "./diagnostic-cache.js";

// -------------------------------------------
// CheckEngine
// -------------------------------------------

export class CheckEngine {
	readonly projectRoot: string;
	private toolsCache: ToolAvailability[] | null = null;
	private singleToolCache = new Map<ToolId, ToolAvailability>();
	private toolCommands: Record<string, ToolCommandConfig> | null = null;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	/** Lazy two-tier tool-commands view (loaded once per engine instance). */
	private loadCommands(): Record<string, ToolCommandConfig> {
		if (!this.toolCommands) this.toolCommands = loadToolCommands(this.projectRoot);
		return this.toolCommands;
	}

	/** Resolve the command override for one tool, if the project configured it. */
	private commandOverrideFor(tool: ToolAvailability): ResolvedToolCommand | undefined {
		const name = configNameForTool(tool.id);
		if (!name) return undefined;
		const entry = this.loadCommands()[name];
		return entry ? toResolvedToolCommand(entry) : undefined;
	}

	/**
	 * Default-gate participation for tools in an UNFILTERED run.
	 *
	 * `go-test` is deliberately opt-in: a whole-suite run is heavyweight and has
	 * no file-dispatch surface, so an unfiltered `interlinked check`/verify run
	 * does not suddenly execute the project's full test suite. It auto-runs only
	 * when the project configures `go_test` in `.interlinked/tool-commands*.json`
	 * (the repo declaring "this is my test command"), or when explicitly
	 * requested via options.tools. Discovery still lists it either way.
	 */
	private shouldRunByDefault(tool: ToolAvailability, options: CheckOptions | undefined): boolean {
		if (tool.id !== "go-test") return true;
		if (options?.tools?.includes("go-test")) return true;
		return Boolean(this.loadCommands()["go_test"]);
	}

	/** Discover which tools are available. Cached per engine instance. */
	discoverTools(): ToolAvailability[] {
		if (!this.toolsCache) {
			this.toolsCache = discoverTools(this.projectRoot);
			// Also populate the single-tool cache from the full discovery
			for (const t of this.toolsCache) {
				this.singleToolCache.set(t.id, t);
			}
		}
		return this.toolsCache;
	}

	/**
	 * Check if a single tool is available. Uses per-tool cache to avoid
	 * discovering all 20+ tools when only a few are needed (e.g., getDiagnostics).
	 */
	isToolAvailable(id: ToolId): boolean {
		// Check full cache first (populated by discoverTools)
		if (this.toolsCache) {
			return !!this.toolsCache.find((t) => t.id === id)?.available;
		}
		// Check per-tool cache
		const cached = this.singleToolCache.get(id);
		if (cached) return cached.available;
		// Discover just this one tool
		const result = discoverSingleTool(id, this.projectRoot);
		if (result) {
			this.singleToolCache.set(id, result);
			return result.available;
		}
		return false;
	}

	/** Resolve only explicitly requested tools. A focused PostToolUse check must
	 * not synchronously version-probe the entire 20+ tool catalog first. */
	private discoverRequestedTools(ids: readonly ToolId[]): ToolAvailability[] {
		const requested = new Set(ids);
		if (this.toolsCache) return this.toolsCache.filter((tool) => requested.has(tool.id));

		const tools: ToolAvailability[] = [];
		for (const id of requested) {
			const cached = this.singleToolCache.get(id);
			if (cached) {
				tools.push(cached);
				continue;
			}
			const discovered = discoverSingleTool(id, this.projectRoot);
			if (discovered) {
				this.singleToolCache.set(id, discovered);
				tools.push(discovered);
			}
		}
		return tools;
	}

	private toolsForRun(options?: CheckOptions): ToolAvailability[] {
		return options?.tools
			? this.discoverRequestedTools(options.tools)
			: this.discoverTools();
	}

	/** Format tool availability as a human-readable report. */
	formatToolReport(): string {
		return formatToolReport(this.discoverTools());
	}

	/**
	 * Run all applicable checks.
	 * - mode "project": scan everything, default 30s timeout per tool
	 * - mode "file": check a single file, default 5s timeout per tool
	 *
	 * Tools run in parallel when safe (most linters). Results are
	 * deduplicated by (file, line, normalizedMessage) so overlapping
	 * tools (e.g. biome + eslint, cargo-check + cargo-clippy) don't
	 * produce duplicate findings.
	 */
	runChecks(scope: CheckScope, options?: CheckOptions): CheckReport {
		const start = Date.now();
		const available = this.toolsForRun(options);
		const timeout = options?.timeoutMs ?? defaultTimeoutFor(scope);

		// Determine which tools to run
		const toolsToRun = available.filter((t) => {
			if (!t.available) return false;
			if (options?.tools && !options.tools.includes(t.id)) return false;
			if (!this.shouldRunByDefault(t, options)) return false;
			if (options?.skipTools?.includes(t.id)) return false;
			return true;
		});

		const toolsSkipped = available.filter((t) => !toolsToRun.some((r) => r.id === t.id));
		const allResults: CheckResult[] = [];
		const metrics: ToolMetrics[] = [];

		for (const tool of toolsToRun) {
			const runner = toolRunnerFor(tool.id);
			if (!runner) continue;

			const toolStart = Date.now();
			const results = runner({
				scope,
				timeoutMs: timeout,
				commandOverride: this.commandOverrideFor(tool),
			});
			metrics.push({
				tool: tool.id,
				elapsedMs: Date.now() - toolStart,
				findingCount: results.length,
				cacheHit: false,
			});
			allResults.push(...results);
		}

		const { deduplicated, removedCount } = deduplicateResults(allResults);

		const skipped: import("./types.js").SkipEntry[] = toolsSkipped.map((t) => ({
			check: t.id,
			reason: t.reason || (t.available ? "skipped by options" : "not installed"),
			category: t.available ? ("config_disabled" as const) : ("tool_missing" as const),
		}));

		return {
			results: deduplicated,
			toolsRun: toolsToRun,
			toolsSkipped,
			skipped,
			elapsedMs: Date.now() - start,
			metrics,
			deduplicatedCount: removedCount,
		};
	}

	/**
	 * Async variant of runChecks. Heavy tools run sequentially within one
	 * project-wide admitted batch so concurrent hook requests — including hooks
	 * served by other agent processes — cannot multiply compiler/test memory.
	 *
	 * Phase A.1 (Free CLI Phase-2): if a tool's meta has a `runnerAsync`
	 * field, this path uses it for true non-blocking parallelism via
	 * `child_process.spawn`. A tool with only a legacy sync runner is deferred
	 * explicitly on this daemon-safe path; callers can run the synchronous CLI
	 * command instead. One shared non-queueing cross-process project lease
	 * bounds quality tools, affected tests, and direct audits together.
	 */
	async runChecksAsync(scope: CheckScope, options?: CheckOptions): Promise<CheckReport> {
		const release = options?.admissionAlreadyHeld
			? undefined
			: tryAcquireProjectHeavyProcessLease(scope.projectRoot);
		if (!options?.admissionAlreadyHeld && !release) return resourceBusyReport(options);
		try {
			return await this.runChecksAsyncAdmitted(scope, options);
		} finally {
			release?.();
		}
	}

	private async runChecksAsyncAdmitted(
		scope: CheckScope,
		options?: CheckOptions,
	): Promise<CheckReport> {
		const start = Date.now();
		const available = this.toolsForRun(options);
		const timeout = options?.timeoutMs ?? defaultTimeoutFor(scope);

		const toolsToRun = available.filter((t) => {
			if (!t.available) return false;
			if (options?.tools && !options.tools.includes(t.id)) return false;
			if (!this.shouldRunByDefault(t, options)) return false;
			if (options?.skipTools?.includes(t.id)) return false;
			return true;
		});

		const toolsSkipped = available.filter((t) => !toolsToRun.some((r) => r.id === t.id));

		// One child at a time inside the admitted finite batch. `runOne` catches
		// runner failures and returns an explicit no-verdict skip, so the loop can
		// continue without either rejecting the batch or reading a crash as clean.
		const allRuns: Awaited<ReturnType<typeof runAsyncTool>>[] = [];
		// One child at a time inside the admitted finite batch. `runOne` catches
		// runner failures and returns an explicit no-verdict skip, so the loop can
		// continue without either rejecting the batch or reading a crash as clean.
		for (const tool of toolsToRun) {
			allRuns.push(await runAsyncTool(tool, scope, timeout, this.commandOverrideFor(tool)));
		}
		const allResults = allRuns.flatMap((r) => r.results);
		const metrics = allRuns.map((r) => r.metric);

		const { deduplicated, removedCount } = deduplicateResults(allResults);

		const skipped: import("./types.js").SkipEntry[] = toolsSkipped.map((t) => ({
			check: t.id,
			reason: t.reason || (t.available ? "skipped by options" : "not installed"),
			category: t.available ? ("config_disabled" as const) : ("tool_missing" as const),
		}));
		skipped.push(...allRuns.flatMap((run) => (run.skipped ? [run.skipped] : [])));
		const completedToolIds = new Set(
			allRuns.filter((run) => run.skipped === undefined).map((run) => run.metric.tool),
		);

		return {
			results: deduplicated,
			toolsRun: toolsToRun.filter((tool) => completedToolIds.has(tool.id)),
			toolsSkipped,
			skipped,
			elapsedMs: Date.now() - start,
			metrics,
			deduplicatedCount: removedCount,
		};
	}

	/**
	 * Run dependency audit (separate because it returns AuditResult, not CheckResult[]).
	 */
	runDepAudit(timeoutMs?: number): AuditResult | null {
		const available = this.discoverTools();
		const depTool = available.find((t) => t.id === "dep-audit");
		if (!depTool?.available) return null;

		return runDepAudit({
			scope: { projectRoot: this.projectRoot, mode: "project" },
			timeoutMs: timeoutMs ?? defaultTimeoutFor({ projectRoot: this.projectRoot, mode: "project" }),
		});
	}

	/**
	 * Get cached diagnostics for a single file.
	 * Used by PreToolUse to inject existing errors before an edit.
	 * Dispatches to language-appropriate tools based on file extension.
	 */
	getDiagnostics(filePath: string): CheckResult[] {
		// Mtime cache: skip if file hasn't changed
		const cached = readDiagnosticCache(filePath);
		if (cached.status === "hit") return cached.results;
		if (cached.status === "unavailable") return [];

		const scope: CheckScope = {
			projectRoot: this.projectRoot,
			mode: "file",
			targetFile: filePath,
			filterToFile: true,
		};

		const results: CheckResult[] = [];
		const toolsForFile = getToolsForExtension(extname(filePath));

		// Lazy per-tool discovery: only check tools relevant to this file extension.
		// This avoids spawning subprocesses for all 20+ tools when only 2-3 are needed.
		for (const toolId of toolsForFile) {
			const availability = this.isToolAvailable(toolId);
			if (!availability) continue;
			const runner = toolRunnerFor(toolId);
			if (!runner) continue;
			const toolResults = runner({ scope, timeoutMs: 5_000 });
			results.push(...toolResults);
		}

		// Update cache
		writeDiagnosticCache(filePath, results);

		return results;
	}

	/**
	 * Read a still-valid diagnostic cache entry without discovering or running
	 * any external tool. PreToolUse must stay deterministic and event-loop safe;
	 * a cache miss is therefore "no advisory context", not permission to spawn.
	 */
	getCachedDiagnostics(filePath: string): CheckResult[] {
		const cached = readDiagnosticCache(filePath);
		return cached.status === "hit" ? cached.results : [];
	}

	/** Clear the diagnostic cache (e.g. on session start). */
	clearCache(): void {
		clearCheckEngineDiagnosticCache();
	}

	/**
	 * Run biome against in-memory overlay content for a file path.
	 * Used by the PreToolUse diff-overlay pre-block to determine whether a
	 * proposed edit introduces NEW biome findings.
	 *
	 * Does NOT cache — overlay content is transient per-edit. Caller is
	 * responsible for budget (timeout).
	 *
	 * Returns only biome results for the target file path.
	 */
	getBiomeDiagnosticsForOverlay(
		filePath: string,
		content: string,
		timeoutMs = 500,
	): CheckResult[] {
		if (!this.isToolAvailable("biome")) return [];
		const results = runBiomeOverlay({
			projectRoot: this.projectRoot,
			timeoutMs,
			filePath,
			content,
		});
		// parseBiomeOutput emits relative paths. Filter to the overlaid file
		// (biome can incidentally emit cross-file findings from the same run).
		const rel = filePath.startsWith(this.projectRoot)
			? filePath.slice(this.projectRoot.length).replace(/^\/+/, "")
			: filePath;
		return results.filter((r) => r.file === rel || r.file === filePath);
	}

	/**
	 * Run the TypeScript LanguageService against in-memory overlay content
	 * for a file path. Returns syntactic + semantic diagnostics for THAT
	 * file (cross-file regressions are left to PostToolUse).
	 *
	 * First call per project is ~1-3s (LS warmup); subsequent calls are
	 * ~20-100ms on incremental analysis. The LS is cached on a
	 * module-level registry keyed by project root.
	 */
	getTscDiagnosticsForOverlay(
		filePath: string,
		content: string,
		siblings?: ReadonlyArray<{ filePath: string; content: string }>,
	): CheckResult[] {
		const outcome = this.getTscDiagnosticsForOverlayTyped(filePath, content, siblings);
		return outcome.status === "ok" ? outcome.findings : [];
	}

	/**
	 * Typed variant of `getTscDiagnosticsForOverlay`: "unavailable" means the
	 * checker never ran (sidecar spawn failure / timeout / cooldown), which is
	 * NOT the same as "no diagnostics". Transactional consumers (multi-edit,
	 * verify-changeset) branch on it; the legacy method collapses it to `[]`.
	 */
	getTscDiagnosticsForOverlayTyped(
		filePath: string,
		content: string,
		siblings?: ReadonlyArray<{ filePath: string; content: string }>,
	): TscOverlayOutcome {
		return runTscOverlayTyped({
			projectRoot: this.projectRoot,
			filePath,
			content,
			...(siblings ? { siblings } : {}),
		});
	}

	/** Clear both the diagnostic cache and the tsc LS cache (session reset). */
	clearAllCaches(): void {
		this.clearCache();
		clearTscOverlayCache(this.projectRoot);
	}
}

// -------------------------------------------
// Singleton helper for the harness server
// -------------------------------------------

let _engineInstance: CheckEngine | null = null;

/** Get or create a CheckEngine singleton for the given project root. */
export function getOrCreateEngine(projectRoot: string): CheckEngine {
	if (!_engineInstance || _engineInstance.projectRoot !== projectRoot) {
		_engineInstance = new CheckEngine(projectRoot);
	}
	return _engineInstance;
}
