// ===========================================
// Graph-prediction cache I/O
// ===========================================
// Two append-only JSONL logs under `.interlinked/`:
//
//   graph-predictions.jsonl   — Case E-fresh predictions only (the cache
//                                that gates Fire 2 retry of the same edit).
//   graph-observations.jsonl  — Cases B/D/E-stale telemetry (no prediction
//                                content; just classification + timestamp).
//
// Cache lookup uses {session_id, file_path, source_mtime, shard_mtime}.
// `tool_input_hash` is logged for analysis but does NOT affect lookup —
// the prediction is about the file's neighborhood, not the proposed edit
// content. Subsequent edits to the same file (same source_mtime, same
// shard_mtime) hit cache.
//
// Reads scan the file last-line-first so the most recent entry wins —
// this lets a later "complete" status overwrite an earlier "pending"
// without rewriting the log. JSONL is line-delimited, append-only,
// crash-safe by construction.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PREDICTIONS_FILE = "graph-predictions.jsonl";
const OBSERVATIONS_FILE = "graph-observations.jsonl";
const RECONCILIATIONS_FILE = "graph-reconciliations.jsonl";
/** The only case that emits to graph-predictions.jsonl. Other cases write
 *  to graph-observations.jsonl. Pinned as a constant so the case-literal
 *  check at row-validation time reads as intent. */
const E_FRESH_CASE: "E-fresh" = "E-fresh";

export type GraphPredictionCase = "A" | "B" | "C" | "D" | "E-fresh" | "E-stale";

export interface PredictionDeps {
	imports: string[] | "unknown";
	imported_by: string[] | "unknown";
}

export interface PredictionCalls {
	callers: string[] | "unknown";
	callees: string[] | "unknown";
}

export interface PredictionImpact {
	risk: "low" | "medium" | "high" | "unknown";
	domains: string[] | "unknown";
	direct: number | "unknown";
	transitive: number | "unknown";
	affects: string[] | "unknown";
}

export interface PredictionContent {
	deps: PredictionDeps | null;
	calls: PredictionCalls | null;
	impact: PredictionImpact | null;
}

type ComparisonStatus = "pending" | "complete" | "parse_failed" | "deferred";

/** A miss in one section of a graph prediction. List-typed sections fill
 *  `missed` (oracle entries the agent didn't predict) and `over_predicted`
 *  (entries the agent predicted that aren't in the oracle). Scalar
 *  sections (`impact.risk`, `impact.direct`, etc.) fill `predicted` /
 *  `oracle`. Fields are optional so consumers can branch on shape rather
 *  than on always-present empty arrays. */
export interface SectionMissDetail {
	missed?: string[];
	over_predicted?: string[];
	predicted?: string | number;
	oracle?: string | number;
}

/** Fixed-key view of section names. The set is closed: every section the
 *  reconciler scores has its own optional slot here, so a typed map gives
 *  the cold reader the schema without needing to grep. */
export interface DiffMissSet {
	"deps.imports"?: SectionMissDetail;
	"deps.imported_by"?: SectionMissDetail;
	"calls.callers"?: SectionMissDetail;
	"calls.callees"?: SectionMissDetail;
	"impact.risk"?: SectionMissDetail;
	"impact.domains"?: SectionMissDetail;
	"impact.direct"?: SectionMissDetail;
	"impact.transitive"?: SectionMissDetail;
	"impact.affects"?: SectionMissDetail;
}

export interface PerSectionScore {
	"deps.imports"?: number;
	"deps.imported_by"?: number;
	"calls.callers"?: number;
	"calls.callees"?: number;
	"impact.risk"?: number;
	"impact.domains"?: number;
	"impact.direct"?: number;
	"impact.transitive"?: number;
	"impact.affects"?: number;
}

interface DiffSummary {
	per_section_score: PerSectionScore;
	weighted_avg: number;
	severity: "low" | "medium" | "high" | "full_abstention";
	high_impact_oracle: boolean;
	miss_set: DiffMissSet;
}

export interface GraphPredictionRow {
	session_id: string;
	file_path: string;
	source_mtime: string;
	shard_mtime: string;
	shard_path: string;
	emitted_at: string;
	tool_input_hash: string;
	case: "E-fresh";
	prediction: PredictionContent;
	comparison_status: ComparisonStatus;
	diff?: DiffSummary;
	ack_required?: boolean;
	ack_text?: string | null;
	acknowledged_at?: string | null;
	/** Set when the agent has read the oracle shard for this prediction
	 *  (enforced-mode gate, Option A). Last-write-wins: the latest row
	 *  with this set satisfies the read requirement until source_mtime or
	 *  shard_mtime changes. */
	shard_read_at?: string | null;
}

export interface GraphObservationRow {
	session_id: string;
	file_path: string;
	case: GraphPredictionCase;
	tool_input_hash: string;
	emitted_at: string;
}

/** Lean numeric snapshot of either oracle or prediction at reconcile time.
 *  Stored alongside the diff so analysts don't have to join back to the
 *  prediction or oracle to reconstruct what the row meant. */
export interface ReconciliationSummary {
	risk: string;
	direct: number | "unknown";
	transitive: number | "unknown";
	domains_count: number;
	importers_count: number;
	callers_count: number;
}

/** One row per successful reconciliation. Append-only at
 *  `.interlinked/graph-reconciliations.jsonl`. Lets you answer
 *  retrospective questions like:
 *    - within a session: do later predictions score higher than earlier?
 *    - across sessions: does the same file's prediction-quality drift up
 *      as the agent revisits the codebase?
 *  Schema is flat by design — JSONL grep + jq stay practical for ad-hoc
 *  analysis. */
export interface GraphReconciliationRow {
	session_id: string;
	file_path: string;
	source_mtime: string;
	shard_mtime: string;
	reconciled_at: string;
	severity: "low" | "medium" | "high" | "full_abstention";
	decision: "reveal_and_allow" | "ack_required";
	triggers: string[];
	high_impact_oracle: boolean;
	per_section_score: PerSectionScore;
	weighted_avg: number;
	oracle_summary: ReconciliationSummary;
	prediction_summary: ReconciliationSummary;
	miss_set: DiffMissSet;
}

export interface PredictionRowKey {
	session_id: string;
	file_path: string;
	source_mtime: string;
	shard_mtime: string;
}

function ensureInterlinkedDir(cwd: string, file: string): string {
	const path = join(cwd, ".interlinked", file);
	mkdirSync(dirname(path), { recursive: true });
	return path;
}

export function appendPredictionRow(cwd: string, row: GraphPredictionRow): void {
	const path = ensureInterlinkedDir(cwd, PREDICTIONS_FILE);
	appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export function appendObservationRow(cwd: string, row: GraphObservationRow): void {
	const path = ensureInterlinkedDir(cwd, OBSERVATIONS_FILE);
	appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Public — append a reconciliation row after a successful prediction-vs-
 *  shard comparison. One row per reconcile call. Used by retrospective
 *  analysis (per-session learning curves, per-file accuracy over time)
 *  rather than gating any live decision. */
export function appendReconciliationRow(cwd: string, row: GraphReconciliationRow): void {
	const path = ensureInterlinkedDir(cwd, RECONCILIATIONS_FILE);
	appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Last-write-wins lookup. Walks the file linearly and returns the most
 *  recent row matching the key, so a later "complete" overwrites an
 *  earlier "pending" without log rewrites. Tolerates malformed lines
 *  (parse errors are silently skipped — JSONL is append-only and a single
 *  partial-write does not invalidate the rest of the log). */
export function findPredictionRow(
	cwd: string,
	key: PredictionRowKey,
): GraphPredictionRow | null {
	const path = join(cwd, ".interlinked", PREDICTIONS_FILE);
	if (!existsSync(path)) return null;
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let latest: GraphPredictionRow | null = null;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isGraphPredictionRow(parsed)) continue;
		if (
			parsed.session_id === key.session_id &&
			parsed.file_path === key.file_path &&
			parsed.source_mtime === key.source_mtime &&
			parsed.shard_mtime === key.shard_mtime
		) {
			latest = parsed;
		}
	}
	return latest;
}

/** Loose-shape mirror of {@link GraphPredictionRow} used for narrowing
 *  arbitrary parsed-JSON values. Each field is `unknown` so the type
 *  guard's typeof checks are forced — no implicit trust of incoming
 *  log lines. */
interface MaybeGraphPredictionRow {
	session_id?: unknown;
	file_path?: unknown;
	source_mtime?: unknown;
	shard_mtime?: unknown;
	shard_path?: unknown;
	emitted_at?: unknown;
	tool_input_hash?: unknown;
	case?: unknown;
	prediction?: unknown;
	comparison_status?: unknown;
}

function isGraphPredictionRow(value: unknown): value is GraphPredictionRow {
	if (typeof value !== "object" || value === null) return false;
	const v = value as MaybeGraphPredictionRow;
	return (
		typeof v.session_id === "string" &&
		typeof v.file_path === "string" &&
		typeof v.source_mtime === "string" &&
		typeof v.shard_mtime === "string" &&
		typeof v.shard_path === "string" &&
		typeof v.emitted_at === "string" &&
		typeof v.tool_input_hash === "string" &&
		v.case === E_FRESH_CASE &&
		typeof v.prediction === "object" &&
		v.prediction !== null &&
		typeof v.comparison_status === "string"
	);
}
