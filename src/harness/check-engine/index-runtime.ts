import { buildConfigToTool, buildToolRegistry } from "./tool-catalog.js";
import type {
	CheckOptions,
	CheckReport,
	CheckResult,
	CheckScope,
	ResolvedToolCommand,
	SkipEntry,
	ToolAvailability,
	ToolId,
	ToolMetrics,
	ToolRunner,
	ToolRunnerMeta,
} from "./types.js";

const CONFIG_TO_TOOL: Record<string, ToolId> = buildConfigToTool();
const TOOL_REGISTRY: Record<string, ToolRunnerMeta> = buildToolRegistry();
const TOOL_RUNNERS: Record<string, ToolRunner> = Object.fromEntries(
	Object.entries(TOOL_REGISTRY).map(([id, meta]) => [id, meta.runner]),
);

const DEFAULT_TIMEOUT_PROJECT = 30_000;
const DEFAULT_TIMEOUT_FILE = 5_000;

export function configNameToToolId(name: string): ToolId | undefined {
	return CONFIG_TO_TOOL[name];
}

export function toolRunnerFor(id: ToolId): ToolRunner | undefined {
	return TOOL_RUNNERS[id];
}

export function toolRunnerMetaFor(id: ToolId): ToolRunnerMeta | undefined {
	return TOOL_REGISTRY[id];
}

export function defaultTimeoutFor(scope: CheckScope): number {
	return scope.mode === "project" ? DEFAULT_TIMEOUT_PROJECT : DEFAULT_TIMEOUT_FILE;
}

/** Run one async-capable external tool without letting its failure abort the batch. */
export async function runAsyncTool(
	tool: ToolAvailability,
	scope: CheckScope,
	timeoutMs: number,
	commandOverride?: ResolvedToolCommand,
): Promise<{ results: CheckResult[]; metric: ToolMetrics; skipped?: SkipEntry }> {
	const meta = toolRunnerMetaFor(tool.id);
	if (!meta?.runnerAsync) {
		return {
			results: [],
			metric: { tool: tool.id, elapsedMs: 0, findingCount: 0, cacheHit: false },
			skipped: {
				check: tool.id,
				reason: meta
					? "async runner unavailable; run `interlinked verify` for this tool"
					: "no async check runner is registered; run `interlinked verify` for this tool",
				category: "error",
			},
		};
	}
	const toolStart = Date.now();
	try {
		const results = await meta.runnerAsync({ scope, timeoutMs, commandOverride });
		return {
			results,
			metric: {
				tool: tool.id,
				elapsedMs: Date.now() - toolStart,
				findingCount: results.length,
				cacheHit: false,
			},
		};
	} catch (error) {
		return {
			results: [],
			metric: {
				tool: tool.id,
				elapsedMs: Date.now() - toolStart,
				findingCount: 0,
				cacheHit: false,
			},
			skipped: {
				check: tool.id,
				reason: error instanceof Error ? error.message : "external tool failed",
				category: "error",
			},
		};
	}
}

export function resourceBusyReport(options: CheckOptions | undefined): CheckReport {
	const reason = "external-tool capacity is busy; this check was deferred without a verdict";
	const requested = options?.tools ?? [];
	return {
		results: [],
		toolsRun: [],
		toolsSkipped: requested.map((id) => ({ id, available: true, reason })),
		skipped: (requested.length > 0 ? requested : ["external-tools"]).map((check) => ({
			check,
			reason,
			category: "resource_busy" as const,
		})),
		elapsedMs: 0,
		metrics: [],
		deduplicatedCount: 0,
	};
}
