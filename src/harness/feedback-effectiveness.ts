// ===========================================
// Interlinked Harness — Feedback Effectiveness
// ===========================================
// Tracks whether agents resolve warnings and computes resolution
// statistics. Used to measure how effective harness feedback is
// at driving agent behavior toward fixes (vs. ignoring or suppressing).

import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import type { FeedbackEffectivenessSummary, SessionTrajectory, WarningRecord } from "./types.js";

/**
 * Minimal shape `recordWarningsIssued` needs from a check result — the
 * check name plus optional finding line. Avoids importing the whole
 * `CheckResultEntry` type and keeps the function easy to call from tests.
 */
export interface WarningEvidence {
	name: string;
	line?: number;
}

/**
 * Fold one evidence item into the per-check line accumulator, skipping
 * operational deferrals (see `recordWarningsIssued`).
 */
function accumulateWarningEvidence(
	linesByCheck: Map<string, number[]>,
	item: string | WarningEvidence,
): void {
	const name = typeof item === "string" ? item : item.name;
	// A capacity/backpressure notice is operational telemetry, not feedback
	// the agent can resolve by changing this source file.
	if (isOperationalCheckDeferral(name)) return;
	const line = typeof item === "string" ? undefined : item.line;
	if (!linesByCheck.has(name)) linesByCheck.set(name, []);
	if (typeof line === "number" && Number.isFinite(line)) {
		const list = linesByCheck.get(name);
		if (list) list.push(line);
	}
}

/**
 * Record that warnings were issued for specific checks on a file.
 * Called after PostToolUse checks produce warnings.
 *
 * Accepts either the legacy shape (array of check names) or the post-2026-05
 * shape (array of {name, line} so the escalation check can suppress FPs that
 * fire on lines the current edit didn't touch). Names-only callers keep
 * working — line info is just absent.
 */
export function recordWarningsIssued(
	session: SessionTrajectory,
	filePath: string,
	evidence: ReadonlyArray<string | WarningEvidence>,
): void {
	const linesByCheck = new Map<string, number[]>();
	for (const item of evidence) {
		accumulateWarningEvidence(linesByCheck, item);
	}

	for (const [checkName, lines] of linesByCheck) {
		const key = `${filePath}::${checkName}`;
		const existing = session.warnings_issued.get(key);

		if (existing) {
			existing.issue_count++;
			existing.last_issued_at = session.tool_call_count;
			existing.resolved = false; // re-opened
			if (lines.length > 0) existing.last_lines = lines;
		} else {
			const record: WarningRecord = {
				check_name: checkName,
				issue_count: 1,
				first_issued_at: session.tool_call_count,
				last_issued_at: session.tool_call_count,
				resolved: false,
				last_lines: lines.length > 0 ? lines : undefined,
			};
			session.warnings_issued.set(key, record);
		}
	}
}

/**
 * Mark warnings as resolved when the agent re-edits a file and the
 * check no longer fires. Called after PostToolUse checks complete
 * for a file — any previously-issued warning whose check is no
 * longer in the current set is considered resolved.
 */
export function recordWarningResolutions(
	session: SessionTrajectory,
	filePath: string,
	currentCheckNames: Set<string>,
): void {
	// A no-verdict result cannot prove any earlier source warning was fixed.
	// Conservatively defer resolution for this file until every attempted check
	// represented by the call has a real verdict.
	if ([...currentCheckNames].some(isOperationalCheckDeferral)) return;
	const prefix = `${filePath}::`;

	for (const [key, record] of session.warnings_issued) {
		if (!key.startsWith(prefix)) continue;

		const checkName = key.slice(prefix.length);
		if (!currentCheckNames.has(checkName) && !record.resolved) {
			record.resolved = true;
		}
	}
}

/**
 * Compute aggregate effectiveness statistics for the current session.
 * Groups warnings by check name and computes resolution rates.
 */
export function computeEffectivenessSummary(
	session: SessionTrajectory,
): FeedbackEffectivenessSummary {
	// Group by check_name
	const byCheck = new Map<string, { issued: number; resolved: number }>();

	for (const record of session.warnings_issued.values()) {
		const existing = byCheck.get(record.check_name);
		if (existing) {
			existing.issued += record.issue_count;
			existing.resolved += record.resolved ? 1 : 0;
		} else {
			byCheck.set(record.check_name, {
				issued: record.issue_count,
				resolved: record.resolved ? 1 : 0,
			});
		}
	}

	// Build per-check stats
	const perCheck = Array.from(byCheck.entries()).map(([checkName, stats]) => ({
		check_name: checkName,
		times_issued: stats.issued,
		times_resolved: stats.resolved,
		resolution_rate: stats.issued > 0 ? stats.resolved / stats.issued : 0,
	}));

	// Compute overall
	let totalIssued = 0;
	let totalResolved = 0;
	for (const stats of byCheck.values()) {
		totalIssued += stats.issued;
		totalResolved += stats.resolved;
	}

	return {
		per_check: perCheck,
		overall_resolution_rate: totalIssued > 0 ? totalResolved / totalIssued : 0,
		total_issued: totalIssued,
		total_resolved: totalResolved,
	};
}
