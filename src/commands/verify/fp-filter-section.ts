// ===========================================
// verify — E18 fp_filter section (`--fp-filter` or `fp_filter.enabled`)
// ===========================================
// Reports, per check, how many of this run's `[heuristic]` inline findings the
// E18 false-positive filter WOULD withhold at PostToolUse. Verify itself hides
// nothing: it is the audit surface for the filter. Scoring uses repeat_count 0
// (verify has no session) and the per-issue verify message, whose length can
// differ from the per-file hook message — the counts approximate the hook.

import { FP_FILTER_DEFAULT_THRESHOLD, scoreFinding } from "../../harness/fp-filter.js";
import { loadRules } from "../../harness/rules-loader.js";
import { isFpFilterEligible } from "../../harness/server/fp-filter-phase.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { CodeQualityResults } from "./tool-results-types.js";

export interface FpFilterVerifyRequest {
	minP?: number;
}

export interface FpFilterVerifySummary {
	threshold: number;
	scored: number;
	suppressed: number;
	per_check: { check: string; scored: number; suppressed: number }[];
}

const CALIBRATION_NOTE =
	"calibrated on one repository (E18: holdout AUROC 0.906, kept 26/26 TPs, suppressed 66/122 FPs); counts approximate the hook surface";

/** The flag wins; otherwise honor `fp_filter.enabled` from the merged guard rules. */
export function resolveVerifyFpFilter(cwd: string, flag: boolean | undefined): FpFilterVerifyRequest | undefined {
	let config;
	try {
		config = loadRules(cwd).fp_filter;
	} catch (err) {
		void err; /* unreadable rules: the flag alone decides */
	}
	if (!flag && !config?.enabled) return undefined;
	return config?.min_p !== undefined ? { minP: config.min_p } : {};
}

/** Score every eligible issue in every bucket. */
export function summarizeFpFilter(cq: CodeQualityResults, cwd: string, minP?: number): FpFilterVerifySummary {
	const rows = new Map<string, { scored: number; suppressed: number }>();
	const threshold = minP !== undefined && Number.isFinite(minP) ? minP : FP_FILTER_DEFAULT_THRESHOLD;
	for (const bucket of Object.values(cq)) {
		for (const issue of bucket) {
			if (!isFpFilterEligible(issue.check)) continue;
			const score = scoreFinding({ check: issue.check, file: issue.file, severity: "warning", message: issue.message, cwd }, minP);
			const row = rows.get(issue.check) ?? { scored: 0, suppressed: 0 };
			row.scored++;
			if (score.suppress) row.suppressed++;
			rows.set(issue.check, row);
		}
	}
	const per_check = [...rows.entries()]
		.map(([check, r]) => ({ check, ...r }))
		.sort((a, b) => b.suppressed - a.suppressed || b.scored - a.scored || a.check.localeCompare(b.check));
	return {
		threshold,
		scored: per_check.reduce((n, r) => n + r.scored, 0),
		suppressed: per_check.reduce((n, r) => n + r.suppressed, 0),
		per_check,
	};
}

/** Human-readable streaming block. */
export function formatFpFilterSection(s: FpFilterVerifySummary): string[] {
	const lines = [
		"",
		`  \x1b[1mfp_filter\x1b[0m (p<${s.threshold.toPrecision(3)}) · ${s.suppressed} / ${s.scored} [heuristic] findings would be suppressed at PostToolUse`,
	];
	for (const r of s.per_check) lines.push(`    ${r.check}  ${r.suppressed}/${r.scored}`);
	lines.push(`  \x1b[2m${CALIBRATION_NOTE}\x1b[0m`);
	return lines;
}

export function streamFpFilterSection(cq: CodeQualityResults, cwd: string, request: FpFilterVerifyRequest): void {
	process.stderr.write(`${formatFpFilterSection(summarizeFpFilter(cq, cwd, request.minP)).join("\n")}\n`);
}

/** The `fp_filter` key of `verify --json`. */
export function fpFilterJson(s: FpFilterVerifySummary): JsonObject {
	return {
		threshold: s.threshold,
		scored: s.scored,
		suppressed: s.suppressed,
		per_check: s.per_check.map((r) => ({ check: r.check, scored: r.scored, suppressed: r.suppressed })),
		note: CALIBRATION_NOTE,
	};
}

/** JSON section for a run, or undefined when the filter was not requested. */
export function fpFilterJsonFor(cq: CodeQualityResults, cwd: string, flag: boolean | undefined): JsonObject | undefined {
	const request = resolveVerifyFpFilter(cwd, flag);
	return request ? fpFilterJson(summarizeFpFilter(cq, cwd, request.minP)) : undefined;
}
