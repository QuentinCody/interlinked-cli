import type { ProjectWideSweepResult } from "../quality-checks.js";
import { formatQualityWarnings, runProjectWideChecksAsync } from "../quality-checks.js";
import { sweepExpiredTransientDebts } from "../transient-debt-expiry.js";
import type { HarnessDecision } from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import {
	formatQualityDecisionWarnings,
	isQualityDeferralName,
} from "./post-tool-file-checks-phases-quality.js";
import type { ServerRuntime } from "./runtime-context.js";

function sweepConfig(ctx: ServerRuntime, acc: PerFileCheckCtx): ServerRuntime["rules"]["project_wide_checks"] {
    const config = ctx.rules.project_wide_checks;
    const queued = acc.allCheckResults.some(result => result.message.startsWith("TypeScript scheduled for native PostToolBatch"));
    if (!config || !queued) return config;
    return { ...config, tools: config.tools.filter(tool => tool !== "tsc") };
}

/** Retire transient debts only when a whole-project tsc actually ran. */
function expireTransientDebtsAfterSweep(
	sweepResult: ProjectWideSweepResult,
	cwd: string,
	log: (message: string) => void,
): void {
	try {
		const expired = sweepExpiredTransientDebts(
			cwd,
			sweepResult.findings.map((finding) => ({
				file: finding.file,
				message: finding.message,
			})),
		);
		if (expired.length === 0) return;
		log(
			`Transient debt: expired ${expired.length} debt(s) a clean project typecheck no longer reproduces: ${expired
				.map((debt) => `${debt.file} [${debt.detector ?? "?"}]`)
				.join(", ")}`,
		);
	} catch {
		// Expiry is hygiene; it must never fail a PostToolUse response.
	}
}

function appendSweepDeferral(
	editedFilePath: string,
	deferredReasons: string[],
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const hasPerFileDeferral = acc.allCheckResults.some(
		(result) =>
			result.source === "quality" &&
			result.file === editedFilePath &&
			isQualityDeferralName(result.name),
	);
	if (hasPerFileDeferral) return;
	const deferred = {
		name: "external_check_deferred",
		severity: "warning" as const,
		message: `Project-wide external checks deferred for ${editedFilePath}`,
		file: editedFilePath,
		detail: `No project-wide verdict was produced: ${deferredReasons.join("; ")}`,
	};
	decision.warnings = [
		...(decision.warnings || []),
		...formatQualityDecisionWarnings([deferred]),
	];
}

function recordSweepResult(
	editedFilePath: string,
	sweepResult: ProjectWideSweepResult,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
	log: (message: string) => void,
): void {
	const deferredReasons = sweepResult.deferredReasons ?? [];
	if (deferredReasons.length > 0) {
		appendSweepDeferral(editedFilePath, deferredReasons, decision, acc);
		log(`Project-wide sweep: deferred without a verdict (${deferredReasons.join("; ")})`);
	}
	if (sweepResult.findings.length > 0) {
		decision.warnings = [
			...(decision.warnings || []),
			...formatQualityWarnings(sweepResult.findings),
		];
		log(
			`Project-wide sweep: ${sweepResult.findings.length} cross-file issue(s) from ${sweepResult.toolsRun.join(", ")} (${sweepResult.elapsedMs}ms)`,
		);
		return;
	}
	if (deferredReasons.length === 0) {
		log(
			`Project-wide sweep: clean (${sweepResult.toolsRun.join(", ")}, ${sweepResult.elapsedMs}ms)`,
		);
	}
}

/** Run the debounced cross-file tsc/biome sweep for one PostTool event. */
export async function runProjectWideSweepPhase(
	ctx: ServerRuntime,
	editedFilePath: string,
	editedFileInRepo: boolean,
	exportSurfaceChanged: boolean,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): Promise<void> {
	const config = sweepConfig(ctx, acc);
	if (config?.enabled && editedFilePath && editedFileInRepo) {
		ctx.projectWideSweepState.recordFileChecked(editedFilePath);
		if (!acc.projectWideSweepFired) {
			const intervalReached = ctx.projectWideSweepState.recordEdit(config);
			const shouldSweep =
				intervalReached || (config.on_export_change && exportSurfaceChanged);
			if (shouldSweep) {
				acc.projectWideSweepFired = true;
				const sweepResult = await runProjectWideChecksAsync(
					config,
					ctx.projectWideSweepState,
					ctx.cwd,
				);
				if (sweepResult.toolsRun.includes("tsc")) {
					expireTransientDebtsAfterSweep(sweepResult, ctx.cwd, ctx.log);
				}
				recordSweepResult(editedFilePath, sweepResult, decision, acc, ctx.log);
			}
		}
	}
	acc.markPhase("project_wide_sweep");
}
