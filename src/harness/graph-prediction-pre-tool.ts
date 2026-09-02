// ===========================================
// Graph-prediction PreToolUse driver
// ===========================================
// Three modes (per `docs/design/graph-prediction-protocol.md`):
//
//   shadow    — never blocks; logs case observations only. Used to fill
//               cache and gather telemetry without disrupting users.
//
//   soft_gate — blocks once on first encounter of an E-fresh file with no
//               cached prediction (Fire 1: challenge). Reveals diff and
//               allows on retry (Fire 2), regardless of severity.
//
//   enforced  — soft_gate + ack-required (Fire 3) for high-severity
//               misses or full-abstention against high-impact oracle.
//
// Cases A/B/C/D/E-stale are observation-only in every mode — only Case
// E-fresh activates the predict/reveal/reconcile loop.
//
// Prediction submission goes through a sentinel path under
// `.interlinked/predictions/incoming/<session_id>/<slug>.yaml`. Agent
// writes the YAML there via the Write tool; this driver intercepts on
// PreToolUse, parses synchronously, persists to graph-predictions.jsonl,
// and returns specific parse errors. The agent's Edit retry then hits
// the disk cache deterministically. Replaces an earlier transcript-
// parsing fallback that was fragile in practice (fences could be stripped
// in display layers, transcript timing lagged the retry).
//
// The driver returns null when the event is out of scope (non-write
// tool, no Supermodel-active workspace) so callers can fall through to
// the rest of pre-tool.ts unchanged.

import { basename } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { isFileWrite } from "./evaluator/tool-classifiers.js";
import {appendObservationRow,
	appendReconciliationRow,
	findPredictionRow
} from "./graph-prediction-cache.js";
import {
	type CaseResult,
	classifyCase,
	type GraphPredictionCase,
	workspaceSupermodelActive,
} from "./graph-prediction-classifier.js";
// Flow helpers
import {
	buildAckReason,
	buildAckSentinelInstruction,
	buildChallengeReason,
	buildReconciliationRow,
	buildRevealText,
	buildShardInlineText,
	buildShardReadRequiredReason,
	collectCachedPredictions,
	isReadOfShard,
	type ReconciledTarget,
	reconcileEachTarget,
	recordShardRead,
} from "./graph-prediction-flow.js";
import type { SeverityResult } from "./graph-prediction-reconcile.js";
// Sentinel handlers
import {
	handleAckSubmission,
	handleSentinelSubmission,
	parseSentinelAckPath,
} from "./graph-prediction-sentinels.js";
import type { ProjectGraph } from "./project-graph.js";
import { extractAllEditedFilePaths } from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

export type GraphPredictionMode = "shadow" | "soft_gate" | "enforced";

const E_FRESH: GraphPredictionCase = "E-fresh";
const MODE_SHADOW: GraphPredictionMode = "shadow";
const MODE_ENFORCED: GraphPredictionMode = "enforced";
const ACK_REQUIRED = "ack_required" as const;

interface DriveArgs {
	event: HarnessEvent;
	cwd: string;
	mode: GraphPredictionMode;
	/** The harness's in-memory ProjectGraph, threaded from the PreToolUse
	 *  evaluator. Lets the reconciler fall back to the internal dependency
	 *  oracle when no fresh Supermodel shard exists. Optional: when absent,
	 *  only shard-backed (Case E-fresh) targets get an oracle. */
	graph?: ProjectGraph | undefined;
}

export interface DriveResult {
	decision: "block" | "allow";
	reason?: string | undefined;
	additional_context?: string | undefined;
	observation?: { file_path: string; case: GraphPredictionCase } | undefined;
	severity?: SeverityResult | undefined;
}

/** Sentinel-path branches: the agent submits structured artifacts by writing
 *  to fixed paths under `.interlinked/predictions/`. Two shapes:
 *    - `incoming/<session>/<slug>.yaml`  → graph_prediction submission
 *    - `ack/<session>/<slug>.yaml`       → graph_prediction_ack submission
 *  Ack path is checked first so an ack submission doesn't get rejected by the
 *  prediction parser for missing a `graph_prediction:` key. Returns null when
 *  the write doesn't target either sentinel shape. */
function handleSentinelWrites(event: HarnessEvent, cwd: string): DriveResult | null {
	const ackFilePath = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: "";
	const ackSentinel = parseSentinelAckPath(ackFilePath, cwd);
	if (ackSentinel) return handleAckSubmission(event, cwd, ackSentinel);

	const submission = handleSentinelSubmission(event, cwd);
	if (submission) return submission;

	return null;
}

/** Telemetry for every classified edited file (non-E-fresh + E-fresh alike),
 *  independent of mode or gating decisions. */
function emitObservationRows(cwd: string, event: HarnessEvent, classifications: CaseResult[]): void {
	for (const c of classifications) {
		appendObservationRow(cwd, {
			session_id: event.session_id,
			file_path: c.sourcePath,
			case: c.case,
			tool_input_hash: "",
			emitted_at: event.timestamp,
		});
	}
}

/** The observation summary carried on an "allow, no protocol engaged" result
 *  (shadow mode, or soft_gate/enforced with no E-fresh targets) — the first
 *  classified file, or undefined when nothing was classified. */
function firstObservation(
	classifications: CaseResult[],
): { file_path: string; case: GraphPredictionCase } | undefined {
	if (classifications.length === 0) return undefined;
	return { file_path: nonNull(classifications[0]).sourcePath, case: nonNull(classifications[0]).case };
}

/** Blocks when any E-fresh target has no cached prediction yet (Fire 1:
 *  challenge). Returns null when every target already has one cached. */
function checkMissingPredictions(
	eFreshTargets: CaseResult[],
	classifications: CaseResult[],
	predictionsByPath: ReturnType<typeof collectCachedPredictions>,
	event: HarnessEvent,
	cwd: string,
): DriveResult | null {
	const missingTargets = eFreshTargets.filter((c) => !predictionsByPath.has(c.sourcePath));
	if (missingTargets.length === 0) return null;
	return {
		decision: "block",
		reason: buildChallengeReason(missingTargets, classifications, event.session_id, cwd),
		observation: { file_path: nonNull(missingTargets[0]).sourcePath, case: E_FRESH },
	};
}

/** Re-blocks when a cached prediction violated format constraints at submit
 *  time (e.g. exceeded the 50-entry cap). Silently reconciling a
 *  non-conforming submission would teach the agent that hitting the cap is
 *  fine — it isn't. Ask for a narrower top-K or explicit `unknown`. Returns
 *  null when no cached prediction has a format violation. */
function checkFormatViolations(
	eFreshTargets: CaseResult[],
	predictionsByPath: ReturnType<typeof collectCachedPredictions>,
	event: HarnessEvent,
): DriveResult | null {
	const formatViolationTargets = eFreshTargets.filter((c) => {
		const p = predictionsByPath.get(c.sourcePath);
		return p?.parse_status === "format_violation";
	});
	if (formatViolationTargets.length === 0) return null;
	const first = formatViolationTargets[0];
	const slug = basename(nonNull(first).sourcePath).replace(/\.[^./]+$/, "");
	const reason = [
		`[interlinked:graph-pred] Cached prediction for ${nonNull(first).sourcePath} violated the format contract (per-section entry cap is 50).`,
		"Narrow your prediction to the entries that matter most, or use `unknown` for any list you can't bound.",
		`Re-submit by writing to .interlinked/predictions/incoming/${event.session_id}/${slug}.yaml`,
	].join("\n");
	return {
		decision: "block",
		reason,
		observation: { file_path: nonNull(first).sourcePath, case: E_FRESH },
	};
}

/** Appends one reconciliation row per reconciled target that still has a
 *  cached prediction (should always be all of them at this point). */
function appendReconciliationRows(
	cwd: string,
	event: HarnessEvent,
	reconciled: ReconciledTarget[],
	predictionsByPath: ReturnType<typeof collectCachedPredictions>,
	reconciledAt: string,
): void {
	for (const r of reconciled) {
		const prediction = predictionsByPath.get(r.classification.sourcePath);
		if (!prediction) continue;
		appendReconciliationRow(
			cwd,
			buildReconciliationRow({
				sessionId: event.session_id,
				classification: r.classification,
				prediction,
				severity: r.severity,
				oracle: r.oracle,
				reconciledAt,
			}),
		);
	}
}

/** Enforced-mode ack gate: blocks when a high-severity reconciliation is
 *  flagged `ack_required` and hasn't been acknowledged via the sentinel-path
 *  ack submission yet. Without this, `enforced` mode would loop forever: the
 *  cached prediction stays the same, reconciliation stays the same, and the
 *  ack_required severity keeps re-firing on retry. Returns null outside
 *  enforced mode, when nothing is flagged, or once everything is acked. */
function checkAckGate(
	mode: GraphPredictionMode,
	flagged: ReconciledTarget[],
	event: HarnessEvent,
	cwd: string,
	reconciled: ReconciledTarget[],
): DriveResult | null {
	if (mode !== MODE_ENFORCED || flagged.length === 0) return null;
	const flaggedNotAcked = flagged.filter((r) => {
		if (!r.classification.sourceMtime || !r.classification.shardMtime) return true;
		const row = findPredictionRow(cwd, {
			session_id: event.session_id,
			file_path: r.classification.sourcePath,
			source_mtime: r.classification.sourceMtime,
			shard_mtime: r.classification.shardMtime,
		});
		return !row?.acknowledged_at;
	});
	if (flaggedNotAcked.length === 0) return null;
	return {
		decision: "block",
		reason: buildAckReason(flaggedNotAcked) + buildAckSentinelInstruction(flaggedNotAcked, event.session_id),
		additional_context: buildRevealText(reconciled),
		observation: { file_path: nonNull(flaggedNotAcked[0]).classification.sourcePath, case: E_FRESH },
	};
}

/** Enforced-mode "Option A" shard-read gate. After reconciliation has
 *  produced the comparison, the agent must call Read on each E-fresh
 *  target's oracle shard before the retry Edit can land. The first reveal
 *  carries the diff; the agent then reads the shard; the gate clears (via
 *  `shard_read_at` on the row); the next retry proceeds. Returns null
 *  outside enforced mode or once every target's shard has been read. */
function checkShardReadGate(
	mode: GraphPredictionMode,
	eFreshTargets: CaseResult[],
	event: HarnessEvent,
	cwd: string,
	reconciled: ReconciledTarget[],
): DriveResult | null {
	if (mode !== MODE_ENFORCED) return null;
	const needsRead = eFreshTargets.filter((c) => {
		if (!c.sourceMtime || !c.shardMtime) return false;
		const row = findPredictionRow(cwd, {
			session_id: event.session_id,
			file_path: c.sourcePath,
			source_mtime: c.sourceMtime,
			shard_mtime: c.shardMtime,
		});
		return !row?.shard_read_at;
	});
	if (needsRead.length === 0) return null;
	return {
		decision: "block",
		reason: buildShardReadRequiredReason(needsRead),
		additional_context: buildRevealText(reconciled),
		observation: { file_path: nonNull(needsRead[0]).sourcePath, case: E_FRESH },
	};
}

/** Final allow: builds the reveal text. In soft_gate mode, the oracle shard
 *  bytes are appended inline (Option B) so the agent updates its mental
 *  model from the source of truth without an extra tool call. In enforced
 *  mode the shard contents are surfaced via the explicit-Read gate (Option
 *  A) above, so the inline append is skipped to avoid redundant context. */
function buildFinalAllow(
	mode: GraphPredictionMode,
	reconciled: ReconciledTarget[],
	eFreshTargets: CaseResult[],
): DriveResult {
	const reveal = mode === MODE_ENFORCED
		? buildRevealText(reconciled)
		: buildRevealText(reconciled) + buildShardInlineText(reconciled);
	return {
		decision: "allow",
		additional_context: reveal,
		observation: { file_path: nonNull(eFreshTargets[0]).sourcePath, case: E_FRESH },
	};
}

export function driveGraphPrediction(args: DriveArgs): DriveResult | null {
	const { event, cwd, mode, graph } = args;

	// Enforced-mode "Option A" shard-read tracking. The Read tool itself is
	// NOT a file write — handle it before the isFileWrite() gate so reads
	// of `.graph.*` files for which there's a pending prediction get
	// recorded as satisfying the read requirement.
	if (isReadOfShard(event)) {
		const recorded = recordShardRead(event, cwd);
		if (recorded) return recorded;
		// Read of a non-protocol shard or unmatched session — pass through.
		return null;
	}

	if (!isFileWrite(event.tool_name)) return null;

	const sentinelResult = handleSentinelWrites(event, cwd);
	if (sentinelResult) return sentinelResult;

	if (!workspaceSupermodelActive(cwd)) return null;

	const editedPaths = extractAllEditedFilePaths(event);
	if (editedPaths.length === 0) return null;

	const classifications = editedPaths.map((p) =>
		classifyCase(p, cwd, {
			toolInputContent:
				typeof event.tool_input?.content === "string" ? event.tool_input.content : undefined,
		}),
	);

	// Always emit observation rows — telemetry for non-E-fresh + E-fresh.
	emitObservationRows(cwd, event, classifications);

	const eFreshTargets = classifications.filter((c) => c.case === E_FRESH);

	// Shadow mode: log observation, allow.
	if (mode === MODE_SHADOW) {
		return { decision: "allow", observation: firstObservation(classifications) };
	}

	// soft_gate / enforced: only E-fresh activates the protocol.
	if (eFreshTargets.length === 0) {
		return { decision: "allow", observation: firstObservation(classifications) };
	}

	const predictionsByPath = collectCachedPredictions(cwd, event.session_id, eFreshTargets);

	const missingResult = checkMissingPredictions(eFreshTargets, classifications, predictionsByPath, event, cwd);
	if (missingResult) return missingResult;

	const formatViolationResult = checkFormatViolations(eFreshTargets, predictionsByPath, event);
	if (formatViolationResult) return formatViolationResult;

	// All E-fresh files have predictions — reconcile each.
	const reconciled = reconcileEachTarget(cwd, eFreshTargets, predictionsByPath, graph);
	const reconciledAt = event.timestamp || new Date().toISOString();
	appendReconciliationRows(cwd, event, reconciled, predictionsByPath, reconciledAt);
	const flagged = reconciled.filter((r) => r.severity.decision === ACK_REQUIRED);

	const ackResult = checkAckGate(mode, flagged, event, cwd, reconciled);
	if (ackResult) return ackResult;

	const shardReadResult = checkShardReadGate(mode, eFreshTargets, event, cwd, reconciled);
	if (shardReadResult) return shardReadResult;

	return buildFinalAllow(mode, reconciled, eFreshTargets);
}

// ── Re-exports for consumers that imported from this module ──────────────────
// These keep the public API surface identical after the extraction.
export type { ReconciledTarget };
