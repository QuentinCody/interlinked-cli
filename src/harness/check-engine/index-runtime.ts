import { buildConfigToTool, buildToolRegistry } from "./tool-catalog.js";
import { withProcessCaptureLimit } from "./process-capture-policy.js";
import { PartialToolReportError, ToolDeadlineError } from "./tool-errors.js";
import { runTypedEslintForeground } from "./tool-runners/generic.js";
import type {
	CheckOptions,
	CheckReport,
	CheckResult,
	CheckScope,
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

function toolRunnerMetaFor(id: ToolId): ToolRunnerMeta | undefined {
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
    options?: CheckOptions,
): Promise<{ results: CheckResult[]; metric: ToolMetrics; skipped?: SkipEntry }> {
	const meta = toolRunnerMetaFor(tool.id);
	const typedForeground = tool.id === "tseslint-types" && scope.mode === "project" && options?.resourcePolicy === "foreground-verify";
	const runnerAsync = typedForeground ? runTypedEslintForeground : meta?.runnerAsync;
	if (!runnerAsync) {
		return {
			results: [],
			metric: { tool: tool.id, elapsedMs: 0, findingCount: 0, cacheHit: false },
			skipped: {
				check: tool.id,
				reason: meta
					? "async runner unavailable for this tool; no verification verdict"
					: "no async check runner is registered for this tool; no verification verdict",
				category: "error",
			},
		};
	}
	const toolStart = Date.now();
	try {
		const run = () => runnerAsync({ scope, timeoutMs,
			...(options?.gitleaksScope ? { gitleaksScope: options.gitleaksScope } : {}),
			...(options?.onInputScope ? { onInputScope: options.onInputScope } : {}),
            ...(options?.waitForCapacity ? { waitForCapacity: true } : {}),
            ...(options?.resourcePolicy ? { resourcePolicy: options.resourcePolicy } : {}),
        });
		const results = await (options?.resourcePolicy === "foreground-verify" ? withProcessCaptureLimit(null, run) : run());
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
		const results = error instanceof PartialToolReportError ? error.results : [];
		return {
			results,
			metric: {
				tool: tool.id,
				elapsedMs: Date.now() - toolStart,
				findingCount: results.length,
				cacheHit: false,
			},
			skipped: {
				check: tool.id,
				reason: error instanceof Error ? error.message : "external tool failed",
				category: error instanceof ToolDeadlineError ? "timeout" : "error",
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
