// ===========================================
// PostToolUse — E18 false-positive filter phase
// ===========================================
// Wires the pure scorer (`../fp-filter.ts`) into the per-file quality phase.
// Two steps, both no-ops unless `fp_filter.enabled`:
//   1. annotateFpFilter — on the RAW quality results, before they are recorded:
//      scores every eligible finding and stamps `fpFilter {p, suppressed}` so
//      `collectQualityResultEntries` writes `fp_filter_p` / `fp_filter_suppressed`
//      into check-results.jsonl (auditable; the E18 label can be re-derived).
//   2. splitFpSuppressed — at delivery: withholds suppressed findings and
//      returns ONE trailer line in their place.
// Eligible = the agent sees it tagged `[heuristic]`, it is not a `pre_block`
// registry check, and it is not a no-verdict deferral. `[proven]` findings and
// blocking results are never touched.

import { CHECK_REGISTRY } from "../check-registry/index.js";
import { FP_FILTER_DEFAULT_THRESHOLD, formatFpFilterTrailer, normalizeFindingPath, scoreFinding } from "../fp-filter.js";
import { isOperationalCheckDeferral } from "../operational-check-deferrals.js";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import { classifyDeterminism } from "../quality-checks/warning-formatter.js";
import type { FpFilterConfig, HarnessEvent } from "../types.js";

const PRE_BLOCK_IDS: ReadonlySet<string> = new Set(
	CHECK_REGISTRY.filter((c) => c.phase === "pre_block").map((c) => c.id),
);

/** Bound on remembered (session, file, check) chains; oldest evicted first. */
const MAX_REPEAT_KEYS = 20_000;
const repeatCounts = new Map<string, number>();

/** True when the filter may score this check id. */
export function isFpFilterEligible(checkId: string): boolean {
	if (PRE_BLOCK_IDS.has(checkId) || isOperationalCheckDeferral(checkId)) return false;
	return classifyDeterminism(checkId) === "heuristic";
}

function nextRepeatCount(key: string, record: boolean): number {
	const seen = repeatCounts.get(key) ?? 0;
	if (!record) return seen;
	repeatCounts.delete(key);
	if (repeatCounts.size >= MAX_REPEAT_KEYS) {
		const oldest = repeatCounts.keys().next();
		if (!oldest.done) repeatCounts.delete(oldest.value);
	}
	repeatCounts.set(key, seen + 1);
	return seen;
}

/**
 * Score eligible findings in place. `repeat_count` follows E18: prior
 * occurrences of the same (session, file, check) in this daemon's lifetime.
 * A dry run reads the count but does not advance it.
 */
export function annotateFpFilter(
	results: QualityCheckResult[],
	config: FpFilterConfig | undefined,
	event: HarnessEvent,
	cwd: string,
): void {
	if (!config?.enabled) return;
	for (const r of results) {
		if (r.severity !== "warning" && r.severity !== "error") continue;
		if (!isFpFilterEligible(r.name)) continue;
		const path = normalizeFindingPath(r.file, cwd);
		const repeatCount = nextRepeatCount(`${event.session_id}\0${path}\0${r.name}`, event.dry_run !== true);
		const score = scoreFinding({ check: r.name, file: path, severity: r.severity, message: r.message, repeatCount }, config.min_p);
		r.fpFilter = { p: score.p, suppressed: score.suppress };
	}
}

/** Withhold suppressed findings; return the rest plus the trailer line. */
export function splitFpSuppressed(
	results: QualityCheckResult[],
	config: FpFilterConfig | undefined,
): { shown: QualityCheckResult[]; trailer: string | null } {
	if (!config?.enabled) return { shown: results, trailer: null };
	const shown: QualityCheckResult[] = [];
	const suppressed: { check: string; p: number }[] = [];
	for (const r of results) {
		if (r.fpFilter?.suppressed) suppressed.push({ check: r.name, p: r.fpFilter.p });
		else shown.push(r);
	}
	const threshold = config.min_p !== undefined && Number.isFinite(config.min_p) ? config.min_p : FP_FILTER_DEFAULT_THRESHOLD;
	return { shown, trailer: formatFpFilterTrailer(suppressed, config.mode ?? "downgrade", threshold) };
}
