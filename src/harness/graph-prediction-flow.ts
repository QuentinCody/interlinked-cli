// ===========================================
// Graph-prediction — core flow helpers
// ===========================================
// Extracted from graph-prediction-pre-tool.ts:
//
//  • collectCachedPredictions   — build Map<path, ParsedGraphPrediction>
//  • reconcileEachTarget        — run oracle reconcile per E-fresh target
//  • summarizeOracle            — collapse SupermodelGraph → ReconciliationSummary
//  • summarizePrediction        — collapse ParsedGraphPrediction → ReconciliationSummary
//  • buildReconciliationRow     — assemble GraphReconciliationRow for cache append
//  • slugFor                    — file-name → safe slug
//  • buildChallengeReason       — block text on missing prediction
//  • buildAckReason             — block text on ack_required severity
//  • buildAckSentinelInstruction — write-path YAML template per flagged file
//  • buildRevealText            — score comparison block
//  • isReadOfShard / recordShardRead  — enforced-mode Option A shard-read gate
//  • buildShardInlineText       — soft-gate Option B inline shard append
//  • buildShardReadRequiredReason — block text for missing shard read

import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { buildPredictionOracle } from "./dependency-view.js";
import {
	appendPredictionRow,
	findPredictionRow,
	type GraphReconciliationRow,
	type ReconciliationSummary,
} from "./graph-prediction-cache.js";
import {
	type CaseResult,
	classifyCase,
} from "./graph-prediction-classifier.js";
import type { ParsedGraphPrediction } from "./graph-prediction-parser.js";
import { reconcile, type SeverityResult } from "./graph-prediction-reconcile.js";
import type { ProjectGraph } from "./project-graph.js";
import type { SupermodelGraph } from "./supermodel-graph.js";
import type { HarnessEvent } from "./types.js";

// ── Shared constants ─────────────────────────────────────────────────────────

const E_FRESH = "E-fresh" as const;
const SENTINEL_BASE = join(".interlinked", "predictions", "incoming");

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReconciledTarget {
	classification: CaseResult;
	severity: SeverityResult;
	oracle: SupermodelGraph | null;
}

interface BuildReconciliationArgs {
	sessionId: string;
	classification: CaseResult;
	prediction: ParsedGraphPrediction;
	severity: SeverityResult;
	oracle: SupermodelGraph | null;
	reconciledAt: string;
}

// ── Cache helpers ────────────────────────────────────────────────────────────

export function collectCachedPredictions(
	cwd: string,
	sessionId: string,
	targets: CaseResult[],
): Map<string, ParsedGraphPrediction> {
	const map = new Map<string, ParsedGraphPrediction>();
	for (const t of targets) {
		if (!t.shardPath || !t.sourceMtime || !t.shardMtime) continue;
		const row = findPredictionRow(cwd, {
			session_id: sessionId,
			file_path: t.sourcePath,
			source_mtime: t.sourceMtime,
			shard_mtime: t.shardMtime,
		});
		if (!row) continue;
		// Honor comparison_status persisted at submission time. A row with
		// `parse_failed` came from `handleSentinelSubmission` flagging a
		// format violation (e.g. exceeded the 50-entry cap). Carrying that
		// state forward as `parse_status: "format_violation"` lets the driver
		// re-block with a specific "narrow your prediction" message instead
		// of silently reconciling a non-conforming submission.
		const cachedStatus =
			row.comparison_status === "parse_failed" ? "format_violation" : "ok";
		map.set(t.sourcePath, {
			file: row.file_path,
			deps: row.prediction.deps,
			calls: row.prediction.calls,
			impact: row.prediction.impact,
			parse_status: cachedStatus,
		});
	}
	return map;
}

// ── Reconciliation helpers ───────────────────────────────────────────────────

export function reconcileEachTarget(
	cwd: string,
	targets: CaseResult[],
	predictionsByPath: Map<string, ParsedGraphPrediction>,
	graph?: ProjectGraph,
): ReconciledTarget[] {
	const out: ReconciledTarget[] = [];
	for (const target of targets) {
		const prediction = predictionsByPath.get(target.sourcePath);
		if (!prediction) continue;
		// Resolve the oracle through the same freshness gate the impact path
		// uses: a fresh Supermodel shard when present, else the always-available
		// internal graph (with calls/domains/transitive marked unavailable so
		// the reconciler excludes rather than mis-scores them). On a fresh shard
		// this is byte-identical to the old loadGraphForFile path.
		const resolved = buildPredictionOracle(target.sourcePath, cwd, graph);
		if (!resolved) continue;
		const severity = reconcile({
			prediction,
			oracle: resolved.oracle,
			unavailable: resolved.unavailable,
		});
		out.push({ classification: target, severity, oracle: resolved.oracle });
	}
	return out;
}

function summarizeOracle(oracle: SupermodelGraph | null): ReconciliationSummary {
	if (!oracle) {
		return {
			risk: "unknown",
			direct: "unknown",
			transitive: "unknown",
			domains_count: 0,
			importers_count: 0,
			callers_count: 0,
		};
	}
	return {
		risk: oracle.impact?.risk ?? "unknown",
		direct: oracle.impact?.direct ?? "unknown",
		transitive: oracle.impact?.transitive ?? "unknown",
		domains_count: oracle.impact?.domains.length ?? 0,
		importers_count: oracle.deps?.importedBy.length ?? 0,
		callers_count: oracle.calls?.callers.length ?? 0,
	};
}

function summarizePrediction(p: ParsedGraphPrediction): ReconciliationSummary {
	const domains = p.impact?.domains;
	const imported_by = p.deps?.imported_by;
	const callers = p.calls?.callers;
	return {
		risk: p.impact?.risk ?? "unknown",
		direct: p.impact?.direct ?? "unknown",
		transitive: p.impact?.transitive ?? "unknown",
		domains_count: Array.isArray(domains) ? domains.length : 0,
		importers_count: Array.isArray(imported_by) ? imported_by.length : 0,
		callers_count: Array.isArray(callers) ? callers.length : 0,
	};
}

export function buildReconciliationRow(args: BuildReconciliationArgs): GraphReconciliationRow {
	return {
		session_id: args.sessionId,
		file_path: args.classification.sourcePath,
		source_mtime: args.classification.sourceMtime ?? "",
		shard_mtime: args.classification.shardMtime ?? "",
		reconciled_at: args.reconciledAt,
		severity: args.severity.severity,
		decision: args.severity.decision,
		triggers: args.severity.triggers,
		high_impact_oracle: args.severity.high_impact_oracle,
		per_section_score: args.severity.per_section_score,
		weighted_avg: args.severity.weighted_avg,
		oracle_summary: summarizeOracle(args.oracle),
		prediction_summary: summarizePrediction(args.prediction),
		miss_set: args.severity.miss_set,
	};
}

// ── Text builders ────────────────────────────────────────────────────────────

export function slugFor(targetPath: string): string {
	const base = nonNull(targetPath.split("/").pop());
	// Strip .ext and any extra dots, keep only safe chars
	return base.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_") || "target";
}

export function buildChallengeReason(
	missing: CaseResult[],
	all: CaseResult[],
	sessionId: string,
	cwd: string,
): string {
	const sentinelDir = relative(cwd, resolve(cwd, SENTINEL_BASE, sessionId)) || SENTINEL_BASE;
	const lines: string[] = [];
	lines.push("[interlinked:graph-pred] graph_prediction required before this edit can proceed.");
	lines.push("");
	lines.push("Authoritative oracle (Supermodel `.graph.*` shard, fresh) for:");
	for (const m of missing) {
		const slug = slugFor(m.sourcePath);
		lines.push(`  ${m.sourcePath}`);
		lines.push(`    → submit prediction by writing to: ${sentinelDir}/${slug}.yaml`);
	}
	const informational = all.filter((c) => c.case !== E_FRESH);
	if (informational.length > 0) {
		lines.push("");
		lines.push("Other files in this edit are observation-only (no challenge):");
		for (const i of informational) {
			lines.push(`  ${i.sourcePath} (Case ${i.case})`);
		}
	}
	lines.push("");
	lines.push("Use the Write tool. Bare YAML; no fences needed. Format:");
	lines.push("  graph_prediction:");
	lines.push("    file: <absolute or repo-relative path to the edit target>");
	lines.push("    deps:");
	lines.push("      imports: [<paths>] | unknown");
	lines.push("      imported_by: [<paths>] | unknown");
	lines.push("    calls:");
	lines.push("      callers: [<\"fn ← caller\">] | unknown");
	lines.push("      callees: [<\"fn → callee\">] | unknown");
	lines.push("    impact:");
	lines.push("      risk: low | medium | high | unknown");
	lines.push("      domains: [<strings>] | unknown");
	lines.push("      direct: <int> | unknown");
	lines.push("      transitive: <int> | unknown");
	lines.push("      affects: [<paths>] | unknown");
	lines.push("");
	lines.push("After the Write succeeds, retry the original edit. See");
	lines.push("`docs/design/graph-prediction-protocol.md §6` for full format spec.");
	return lines.join("\n");
}

export function buildAckReason(flagged: ReconciledTarget[]): string {
	const lines: string[] = [];
	lines.push("[interlinked:graph-pred] Acknowledge before proceeding.");
	for (const f of flagged) {
		const triggers = f.severity.triggers.join(", ");
		lines.push(`  ${f.classification.sourcePath}: ${triggers}`);
	}
	return lines.join("\n");
}

/** Per-target write-to-sentinel-path instruction used by the ack flow.
 *  Returned text is appended after `buildAckReason`'s summary, giving the
 *  agent a concrete path + minimal YAML template per flagged file. */
export function buildAckSentinelInstruction(flagged: ReconciledTarget[], sessionId: string): string {
	const lines: string[] = ["", "To acknowledge, Write the bare YAML below to the named sentinel path (one Write per flagged file):"];
	for (const f of flagged) {
		const slug = basename(f.classification.sourcePath).replace(/\.[^./]+$/, "");
		const ackPath = `.interlinked/predictions/ack/${sessionId}/${slug}.yaml`;
		lines.push("");
		lines.push(`  → ${ackPath}`);
		lines.push("    graph_prediction_ack:");
		lines.push(`      file: ${f.classification.sourcePath}`);
		lines.push("      acknowledged_triggers:");
		for (const t of f.severity.triggers) {
			lines.push(`        - ${t}`);
		}
	}
	lines.push("");
	lines.push("After all acks land, retry the original Edit. See `docs/design/graph-prediction-protocol.md §7.6`.");
	return `\n${lines.join("\n")}`;
}

export function buildRevealText(reconciled: ReconciledTarget[]): string {
	const lines: string[] = [];
	for (const r of reconciled) {
		lines.push(`[interlinked:graph-pred] Comparison for ${r.classification.sourcePath}:`);
		for (const [section, score] of Object.entries(r.severity.per_section_score)) {
			if (typeof score === "number") lines.push(`  ${section}: ${score.toFixed(2)}`);
		}
		if (r.severity.triggers.length > 0) {
			lines.push(`  triggers: ${r.severity.triggers.join(", ")}`);
		}
		lines.push(`  weighted_avg (telemetry): ${r.severity.weighted_avg.toFixed(2)}`);
		lines.push(`  severity: ${r.severity.severity}`);
	}
	return lines.join("\n");
}

// ── Option A — explicit-Read gate (enforced mode) ────────────────────────────
// `enforced` mode requires the agent to actually call `Read` on the oracle
// shard before the retry Edit can land.

const SHARD_PATH_RE = /\.graph(\.[a-zA-Z0-9]+)?$/i;

export function isReadOfShard(event: HarnessEvent): boolean {
	const name = event.tool_name;
	if (name !== "Read" && name !== "ReadFile" && name !== "read_file" && name !== "view") {
		return false;
	}
	const fp = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: typeof event.tool_input?.path === "string"
			? event.tool_input.path
			: "";
	return typeof fp === "string" && SHARD_PATH_RE.test(fp);
}

export function recordShardRead(event: HarnessEvent, cwd: string): { decision: "block" | "allow"; reason?: string; additional_context?: string } | null {
	const fp = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: typeof event.tool_input?.path === "string"
			? event.tool_input.path
			: "";
	if (!fp) return null;
	const shardAbs = isAbsolute(fp) ? resolve(fp) : resolve(cwd, fp);
	// Derive the paired source path: strip `.graph` from the extension stem.
	const m = shardAbs.match(/^(.+?)\.graph(\.[a-zA-Z0-9]+)?$/);
	if (!m) return null;
	const sourceAbs = m[1] + (m[2] ?? "");
	const classification = classifyCase(sourceAbs, cwd);
	if (classification.case !== E_FRESH) return null;
	if (!classification.shardPath || !classification.sourceMtime || !classification.shardMtime) {
		return null;
	}
	const priorRow = findPredictionRow(cwd, {
		session_id: event.session_id,
		file_path: classification.sourcePath,
		source_mtime: classification.sourceMtime,
		shard_mtime: classification.shardMtime,
	});
	if (!priorRow) return null;
	if (priorRow.shard_read_at) return null;
	const now = event.timestamp || new Date().toISOString();
	appendPredictionRow(cwd, { ...priorRow, emitted_at: now, shard_read_at: now });
	return {
		decision: "allow",
		additional_context:
			`[interlinked:graph-pred] Shard read recorded for ${classification.sourcePath}. ` +
			"You can now retry the Edit; the enforced-mode shard-read gate is satisfied.",
	};
}

/** Pretty-print the "you must Read the shard" block reason. One line per
 *  flagged target so the agent can grep `Read <path>` for each. */
export function buildShardReadRequiredReason(needsRead: CaseResult[]): string {
	const lines: string[] = [
		"[interlinked:graph-pred] Read the oracle shard before this Edit can proceed.",
		"Enforced mode requires the agent to actually consume the .graph.* file so its mental model updates from the source of truth, not just the diff summary.",
		"",
		"Call the Read tool on each shard listed below, then retry the Edit:",
	];
	for (const c of needsRead) {
		if (c.shardPath) lines.push(`  Read ${c.shardPath}`);
	}
	return lines.join("\n");
}

/** Soft-gate-only "Option B" reveal augmentation: append the oracle shard
 *  bytes after the comparison so the agent updates its mental model from
 *  the source of truth, not just the score summary. A 0.00 on
 *  `deps.imported_by` tells the agent it missed callers; only the shard
 *  tells it who the callers are. Capped at SHARD_BYTES_CAP so a pathological
 *  shard can't blow up the model context.
 *
 *  In `enforced` mode the agent is required to actually call `Read` on the
 *  shard path (Option A), so this inline append is skipped — forcing the
 *  pedagogic action creates an audit trail and avoids redundant context. */
const SHARD_BYTES_CAP = 4096;

export function buildShardInlineText(reconciled: ReconciledTarget[]): string {
	const lines: string[] = [];
	for (const r of reconciled) {
		const shardPath = r.classification.shardPath;
		if (!shardPath) continue;
		let body: string;
		try {
			body = readFileSync(shardPath, "utf-8");
		} catch {
			continue;
		}
		const truncated = body.length > SHARD_BYTES_CAP
			? `${body.slice(0, SHARD_BYTES_CAP)}\n... (truncated at ${SHARD_BYTES_CAP} bytes; read the file directly for full contents)`
			: body;
		lines.push("");
		lines.push(`[interlinked:graph-pred] Oracle shard for ${r.classification.sourcePath} (${shardPath}):`);
		lines.push(truncated.trimEnd());
	}
	return lines.join("\n");
}
