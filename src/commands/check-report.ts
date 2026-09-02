// ===========================================
// Check Command — CLI-flag dispatch helpers
// ===========================================
// Small, independently-testable pieces of `checkCommand`'s flag handling and
// output dispatch, extracted to keep the orchestrator's own cyclomatic
// complexity down. No state beyond process.stdout/stderr side effects.

import { CheckEngine, type CheckReport } from "../harness/check-engine/index.js";
import {
	emitEngineOnly,
	emitFullSummary,
	emitJsonOutput,
	emitStructuralOnly,
	type StructuralCheckResult,
} from "./check-output.js";

// --tools: warn (don't fail) on discovery-only ids dropped from the filter so
// the run never prints a misleading "0 findings" row for a check that did not
// run; these run under `interlinked verify`.
export function warnDroppedDiscoveryTools(
	tools: boolean | string | undefined,
	isDiscoveryOnlyTool: (id: string) => boolean,
): void {
	if (typeof tools !== "string") return;
	const dropped = tools.split(",").map((t) => t.trim()).filter(isDiscoveryOnlyTool);
	if (dropped.length > 0) {
		process.stderr.write(
			`Skipping discovery-only tool(s) ${dropped.join(", ")} from --tools — no interlinked check runner; run interlinked verify instead.\n`,
		);
	}
}

// Prints the tool report when --report is set. Returns true when the caller
// should return immediately afterward (no --tools/--only follow-on run).
export function printToolReportIfRequested(
	cwd: string,
	report: boolean | undefined,
	tools: boolean | string | undefined,
	onlyCheck: string | undefined,
): boolean {
	if (!report) return false;
	const engine = new CheckEngine(cwd);
	process.stderr.write(`\n  ${engine.formatToolReport()}\n\n`);
	return !tools && !onlyCheck;
}

export interface CheckOutputPlan {
	onlyCheck: string | undefined;
	isStructuralOnly: boolean;
	isEngineOnly: boolean;
}

// Dispatches final output: JSON, a single-check (`--only`) view, or the full
// human-readable summary.
export function emitCheckOutput(
	json: boolean | undefined,
	plan: CheckOutputPlan,
	results: StructuralCheckResult[],
	engineReport: CheckReport | null,
	fileCount: number,
): void {
	if (json) {
		emitJsonOutput(results, engineReport);
		return;
	}

	if (plan.onlyCheck) {
		if (plan.isStructuralOnly) {
			emitStructuralOnly(results, plan.onlyCheck);
		} else if (plan.isEngineOnly && engineReport) {
			emitEngineOnly(engineReport, plan.onlyCheck);
		}
		return;
	}

	emitFullSummary(results, engineReport, fileCount);
}
