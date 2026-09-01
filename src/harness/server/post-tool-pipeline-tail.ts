import { getOrCreateEngine } from "../check-engine/index.js";
import {
	baselineCallKey,
	consumeBaselineSnapshot,
} from "../evaluator/baseline-effect-guard.js";
import type { ToolBreakdownEntry } from "../quality-checks.js";
import type {
	CheckResultEntry,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { consumeWorkspaceSnapshot } from "../workspace-effects.js";
import { pushWarnings } from "./post-tool-pipeline-tracking.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Attach actual repository effects before any tool-name/path-based routing. */
export function attachObservedChangeSet(event: HarnessEvent, cwd: string): void {
	if (event.dry_run) return;
	const observed = consumeWorkspaceSnapshot({
		toolUseId: event.tool_use_id,
		sessionId: event.session_id,
		subagentId: event.subagent_id,
		root: cwd,
	});
	if (!observed) return;
	event.change_set = observed;
	event.files_modified = observed.files.map((effect) => effect.path);
}

interface TailResults {
	postDecision: HarnessDecision;
	allCheckResults: CheckResultEntry[];
	checksRan: string[];
	postToolMetrics: ToolBreakdownEntry[];
	phaseBreakdown: Record<string, number>;
	elapsedMs: number;
}

/** Attach structured results and timing accumulated during the per-file fan-out. */
export function attachTailResults(results: TailResults): void {
	const {
		postDecision,
		allCheckResults,
		checksRan,
		postToolMetrics,
		phaseBreakdown,
		elapsedMs,
	} = results;
	if (allCheckResults.length > 0) postDecision.check_results = allCheckResults;
	if (checksRan.length > 0) {
		postDecision.checks_ran = [...new Set(checksRan)];
		postDecision.checks_timing_ms = elapsedMs;
	}
	if (postToolMetrics.length > 0) postDecision.tool_breakdown = postToolMetrics;
	postDecision.phase_breakdown = phaseBreakdown;
}

/** Warn once per session for each configured required tool that is unavailable. */
export function appendRequiredToolWarnings(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
): void {
	if (!ctx.rules.required_tools?.length) return;
	const engine = getOrCreateEngine(ctx.cwd);
	for (const reqId of ctx.rules.required_tools) {
		const skipKey = `required-tool-missing::${reqId}`;
		if (session.acknowledged_checks.has(skipKey)) continue;
		if (!engine.isToolAvailable(reqId)) {
			pushWarnings(
				postDecision,
				`[interlinked:required-tool] Required tool "${reqId}" is not available. Install it or remove from required_tools in guard-rules.json.`,
			);
			session.acknowledged_checks.add(skipKey);
		}
	}
}

function abbreviateCheckName(check: string): string {
	if (check === "structural") return "structural";
	if (check === "typescript") return "tsc";
	if (check === "biome_lint") return "biome";
	if (check === "secrets_in_source") return "secrets";
	if (check === "affected_tests") return "tests";
	return check.replace(/_/g, "-");
}

/** Emit the compact positive summary only when checks ran without warnings. */
export function emitAllCleanSummary(options: {
	postDecision: HarnessDecision;
	rules: ServerRuntime["rules"];
	checksRan: string[];
	elapsedMs: number;
}): void {
	const { postDecision, rules, checksRan, elapsedMs } = options;
	if ((postDecision.warnings || []).length !== 0 || checksRan.length === 0) return;
	const checkSummary = [...new Set(checksRan)].map(abbreviateCheckName).join(", ");
	postDecision.summary = `[interlinked] ✓ ${rules.rules.length} guard rules, ${checkSummary} — all clean (${elapsedMs}ms)`;
}

/** Append the loosening warning when this call moved a quality water-line. */
export function appendBaselineEffect(
	event: HarnessEvent,
	decision: HarnessDecision,
	cwd: string,
): void {
	if (event.dry_run) return;
	const key = baselineCallKey({
		toolUseId: event.tool_use_id,
		sessionId: event.session_id,
		timestamp: event.timestamp,
	});
	const warning = consumeBaselineSnapshot(key, cwd);
	if (warning) decision.warnings = [...(decision.warnings ?? []), warning];
}
