// ===========================================
// Evidence-classed local impact report — observed sources
// ===========================================
// Readers for the recorded local observations: baseline folds, session
// activity, finding lifecycle states, and manual debt marker snapshots.
// Every value here is an observed fact, never a causal claim.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_FOLD_LOG_REL } from "../harness/baseline-autofold.js";
import { findingsCorpusPath, loadFindings } from "../harness/findings/corpus.js";
import {
	loadReconciliation,
	reconciliationPath,
	reconciliationStateOf,
} from "../harness/spec/reconciliation.js";
import type {
	ActivityEvidence,
	BaselineFoldEvidence,
	FindingsEvidence,
	ImpactAvailability,
	ManualDebtLifecycleEvidence,
} from "./impact-evidence-types.js";
import { isJsonObject } from "./json-types.js";
import { readLocalSessions } from "./local-activity.js";
import { getSessionsDir } from "./local-activity-paths.js";
import {
	loadManualDebtMarkerSnapshotReceipts,
	manualDebtMarkerSnapshotsPath,
} from "./manual-debt-marker-record.js";

function emptyFoldEvidence(availability: ImpactAvailability, reason?: string): BaselineFoldEvidence {
	return {
		availability,
		evidence_class: "observed",
		events: 0,
		malformed_rows: 0,
		by_kind: {},
		scope: "append-only SessionEnd tighten-only baseline fold audit rows",
		...(reason ? { reason } : {}),
	};
}

function foldNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function readBaselineFoldEvidence(cwd: string): BaselineFoldEvidence {
	const path = join(cwd, BASELINE_FOLD_LOG_REL);
	if (!existsSync(path)) return emptyFoldEvidence("not-recorded");
	const result = emptyFoldEvidence("available");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return emptyFoldEvidence("unavailable", error instanceof Error ? error.message : String(error));
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isJsonObject(parsed) || typeof parsed.kind !== "string") {
				result.malformed_rows++;
				continue;
			}
			const row = result.by_kind[parsed.kind] ?? { events: 0, changed: 0, refused: 0 };
			row.events++;
			row.changed += foldNumber(parsed.changed);
			row.refused += foldNumber(parsed.refused);
			result.by_kind[parsed.kind] = row;
			result.events++;
		} catch {
			result.malformed_rows++;
		}
	}
	return result;
}

function safeCount(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function readActivityEvidence(cwd: string): ActivityEvidence {
	const sessions = readLocalSessions(cwd);
	const totals: ActivityEvidence = {
		availability: existsSync(getSessionsDir(cwd)) ? "available" : "not-recorded",
		evidence_class: "observed",
		sessions: sessions.length,
		ended_sessions: 0,
		tool_calls: 0,
		errors: 0,
		edit_events: 0,
		lines_added: 0,
		lines_removed: 0,
		tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
		scope: "retained local session summaries; edit rows are gross events and may overlap git deltas",
	};
	for (const session of sessions) {
		if (session.phase === "ENDED") totals.ended_sessions++;
		totals.tool_calls += safeCount(session.tool_count);
		totals.errors += safeCount(session.error_count);
		const edits = session.edits ?? [];
		totals.edit_events += edits.length;
		for (const edit of edits) {
			totals.lines_added += safeCount(edit.lines_added);
			totals.lines_removed += safeCount(edit.lines_removed);
		}
		totals.tokens.input += safeCount(session.tokens_total?.input);
		totals.tokens.output += safeCount(session.tokens_total?.output);
		totals.tokens.cache_read += safeCount(session.tokens_total?.cache_read);
		totals.tokens.cache_creation += safeCount(session.tokens_total?.cache_creation);
	}
	return totals;
}

export function readFindingsEvidence(cwd: string): FindingsEvidence {
	const corpus = loadFindings(cwd);
	const rows = corpus.filter((finding) => finding.bug_class.startsWith("review_"));
	const simplificationRows = corpus.filter(
		(finding) => finding.extensions?.simplification !== undefined,
	);
	const reconciliation = loadReconciliation(cwd);
	const result: FindingsEvidence = {
		availability:
			existsSync(findingsCorpusPath(cwd)) || existsSync(reconciliationPath(cwd))
				? "available"
				: "not-recorded",
		evidence_class: "observed",
		review_findings: rows.length,
		reconciliation: { open: 0, touched: 0, acked: 0 },
		lifecycle: { candidate: 0, approved: 0, distilled: 0, superseded: 0 },
		simplification: {
			findings: simplificationRows.length,
			reconciliation: { open: 0, touched: 0, acked: 0 },
			lifecycle: { candidate: 0, approved: 0, distilled: 0, superseded: 0 },
		},
		scope: "review and simplification finding workflow states; touched and acked are lifecycle facts, not proof that a defect or simplification was fixed",
	};
	for (const finding of rows) {
		result.reconciliation[reconciliationStateOf(reconciliation, finding.id)]++;
		result.lifecycle[finding.status]++;
	}
	for (const finding of simplificationRows) {
		result.simplification.reconciliation[
			reconciliationStateOf(reconciliation, finding.id)
		]++;
		result.simplification.lifecycle[finding.status]++;
	}
	return result;
}

export function readManualDebtLifecycleEvidence(cwd: string): ManualDebtLifecycleEvidence {
	const path = manualDebtMarkerSnapshotsPath(cwd);
	const snapshots = loadManualDebtMarkerSnapshotReceipts(cwd);
	const latest = snapshots.at(-1) ?? null;
	const transitions = { opened: 0, changed: 0, closed: 0 };
	for (const snapshot of snapshots) {
		for (const transition of snapshot.transitions) transitions[transition.action]++;
	}
	const fileExists = existsSync(path);
	return {
		availability: snapshots.length > 0 ? "available" : fileExists ? "unavailable" : "not-recorded",
		evidence_class: "observed",
		snapshot_count: snapshots.length,
		transitions,
		current_markers: latest?.materialized_markers.length ?? 0,
		path,
		latest_scope: latest
			? {
				repository_root: latest.scan.repository.root,
				tree_sha: latest.scan.repository.tree_sha,
				roots: [...latest.scan.coverage.roots],
				files_scanned: latest.scan.coverage.files_scanned,
			}
			: null,
		scope: "Valid append-only manual debt marker snapshots; transition totals span retained snapshots and current marker count comes from the latest scope-aware materialized state.",
		...(snapshots.length === 0
			? { reason: fileExists ? "No valid manual debt marker snapshot is readable." : "No manual debt marker snapshot is recorded." }
			: {}),
	};
}
