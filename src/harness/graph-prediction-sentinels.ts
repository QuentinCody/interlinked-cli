// ===========================================
// Graph-prediction — sentinel-path submission handlers
// ===========================================
// Two sentinel shapes:
//   - `incoming/<session>/<slug>.yaml`  → graph_prediction submission
//   - `ack/<session>/<slug>.yaml`       → graph_prediction_ack submission
// Both are intercepted on PreToolUse (Write/Edit) before the normal
// prediction-challenge flow runs. Parsing is synchronous; valid
// submissions are persisted to graph-predictions.jsonl and answered
// with an allow + additional_context so the agent can proceed.

import { isAbsolute, join, relative, resolve } from "node:path";
import { nonNull } from "../lib/non-null.js";
import {
	appendPredictionRow,
	findPredictionRow,
} from "./graph-prediction-cache.js";
import {
	type CaseResult,
	classifyCase,
} from "./graph-prediction-classifier.js";
import {
	parseBarePrediction,
} from "./graph-prediction-parser.js";
import type { HarnessEvent } from "./types.js";

// ── Re-exported types ────────────────────────────────────────────────────────

export interface DriveResult {
	decision: "block" | "allow";
	reason?: string | undefined;
	additional_context?: string | undefined;
	observation?: { file_path: string; case: import("./graph-prediction-classifier.js").GraphPredictionCase } | undefined;
	severity?: import("./graph-prediction-reconcile.js").SeverityResult | undefined;
}

// ── Internal constants ───────────────────────────────────────────────────────

const E_FRESH = "E-fresh" as const;
const SENTINEL_BASE = join(".interlinked", "predictions", "incoming");
const SENTINEL_ACK_BASE = join(".interlinked", "predictions", "ack");

// ── Exported types ───────────────────────────────────────────────────────────

export interface SentinelMatch {
	sessionId: string;
	absPath: string;
}

// ── Path parsers ─────────────────────────────────────────────────────────────

/** Match `.interlinked/predictions/incoming/<session_id>/<slug>.yaml` (or
 *  `.yml`). Returns the session_id captured from the path so the persisted
 *  cache row can use the same session as the submission. */
export function parseSentinelPath(filePath: string, cwd: string): SentinelMatch | null {
	if (!filePath) return null;
	const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
	const expectedPrefix = resolve(cwd, SENTINEL_BASE);
	if (!abs.startsWith(`${expectedPrefix}/`)) return null;
	const rel = relative(expectedPrefix, abs);
	const m = rel.match(/^([^/]+)\/[^/]+\.ya?ml$/);
	if (!m) return null;
	return { sessionId: nonNull(m[1]), absPath: abs };
}

/** Match `.interlinked/predictions/ack/<session_id>/<slug>.yaml`. Same
 *  shape as parseSentinelPath but for the ack sub-tree. The ack writer
 *  is how the agent breaks out of `enforced`-mode ack_required blocks. */
export function parseSentinelAckPath(filePath: string, cwd: string): SentinelMatch | null {
	if (!filePath) return null;
	const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
	const expectedPrefix = resolve(cwd, SENTINEL_ACK_BASE);
	if (!abs.startsWith(`${expectedPrefix}/`)) return null;
	const rel = relative(expectedPrefix, abs);
	const m = rel.match(/^([^/]+)\/[^/]+\.ya?ml$/);
	if (!m) return null;
	return { sessionId: nonNull(m[1]), absPath: abs };
}

// ── Ack submission ───────────────────────────────────────────────────────────

interface ParsedAckSubmission {
	file: string;
	acknowledged_triggers: string[];
	parse_error?: string;
}

interface AckParseState {
	inAck: boolean;
	inTriggers: boolean;
	file: string;
	triggers: string[];
}

/** Fold one raw YAML line into the running ack-parse state (mutates
 *  `state` in place). Pulled out of `parseAckSubmission`'s loop body so
 *  the line-by-line state machine reads at its own nesting level. */
function applyAckLine(raw: string, state: AckParseState): void {
	const line = raw.replace(/\r$/, "");
	if (/^\s*#/.test(line)) return;
	if (/^graph_prediction_ack:\s*$/.test(line)) {
		state.inAck = true;
		state.inTriggers = false;
		return;
	}
	if (!state.inAck) return;
	if (/^\S/.test(line)) {
		state.inAck = false;
		state.inTriggers = false;
		return;
	}
	const fileMatch = line.match(/^\s+file:\s*(.+?)\s*$/);
	if (fileMatch) {
		state.file = nonNull(fileMatch[1]).replace(/^["']|["']$/g, "");
		state.inTriggers = false;
		return;
	}
	if (/^\s+acknowledged_triggers:\s*$/.test(line)) {
		state.inTriggers = true;
		return;
	}
	if (state.inTriggers) {
		const itemMatch = line.match(/^\s+-\s+(.+?)\s*$/);
		if (itemMatch) state.triggers.push(nonNull(itemMatch[1]).replace(/^["']|["']$/g, ""));
		else if (/^\s+\S/.test(line)) state.inTriggers = false;
	}
}

/** Minimal block-style YAML parser for the ack submission shape:
 *    graph_prediction_ack:
 *      file: <path>
 *      acknowledged_triggers:
 *        - <name>
 *        - <name>
 *  Returns parse_error when the top key is missing or the file field is
 *  absent. Empty `acknowledged_triggers` is allowed (the agent may
 *  acknowledge the reveal without listing triggers explicitly — the act
 *  of writing the ack file is itself the acknowledgement). */
export function parseAckSubmission(yaml: string): ParsedAckSubmission {
	if (!yaml.includes("graph_prediction_ack:")) {
		return { file: "", acknowledged_triggers: [], parse_error: "missing `graph_prediction_ack:` top-level key" };
	}
	const lines = yaml.split("\n");
	const state: AckParseState = { inAck: false, inTriggers: false, file: "", triggers: [] };
	for (const raw of lines) {
		applyAckLine(raw, state);
	}
	if (!state.file) {
		return { file: "", acknowledged_triggers: state.triggers, parse_error: "missing `file:` field" };
	}
	return { file: state.file, acknowledged_triggers: state.triggers };
}

export function handleAckSubmission(event: HarnessEvent, cwd: string, sentinel: SentinelMatch): DriveResult {
	const content = typeof event.tool_input?.content === "string" ? event.tool_input.content : "";
	if (!content) {
		return {
			decision: "block",
			reason:
				"[interlinked:graph-pred][ack] Sentinel-path ack submission is empty. " +
				"Write the bare YAML (graph_prediction_ack: with `file:` + `acknowledged_triggers:`) as the file content.",
		};
	}
	const parsed = parseAckSubmission(content);
	if (parsed.parse_error) {
		return {
			decision: "block",
			reason: `[interlinked:graph-pred][ack] Ack submission did not parse: ${parsed.parse_error}.`,
		};
	}
	const absTarget = isAbsolute(parsed.file) ? resolve(parsed.file) : resolve(cwd, parsed.file);
	const classification = classifyCase(absTarget, cwd);
	if (classification.case !== E_FRESH) {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred][ack] Ack target ${parsed.file} classifies as Case ${classification.case}, ` +
				"not E-fresh. Only E-fresh files participate in the ack protocol.",
		};
	}
	if (!classification.shardPath || !classification.sourceMtime || !classification.shardMtime) {
		return {
			decision: "block",
			reason: `[interlinked:graph-pred][ack] Could not resolve shard metadata for ${parsed.file}.`,
		};
	}
	// Look up the most recent prediction row that this ack is for, so we
	// can carry forward its prediction content and just stamp the ack
	// fields. Without the prior row the ack would be free-floating.
	const priorRow = findPredictionRow(cwd, {
		session_id: sentinel.sessionId,
		file_path: classification.sourcePath,
		source_mtime: classification.sourceMtime,
		shard_mtime: classification.shardMtime,
	});
	if (!priorRow) {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred][ack] No prior prediction found for ${classification.sourcePath} ` +
				"in this session at the current source/shard mtimes. Submit the prediction first.",
		};
	}

	const ackText = parsed.acknowledged_triggers.length > 0
		? `triggers: ${parsed.acknowledged_triggers.join(", ")}`
		: "acknowledged";
	appendPredictionRow(cwd, {
		...priorRow,
		emitted_at: event.timestamp || new Date().toISOString(),
		ack_required: true,
		ack_text: ackText,
		acknowledged_at: event.timestamp || new Date().toISOString(),
	});
	return {
		decision: "allow",
		additional_context:
			`[interlinked:graph-pred][ack] Acknowledgement for ${classification.sourcePath} accepted` +
			(parsed.acknowledged_triggers.length > 0
				? ` (${parsed.acknowledged_triggers.join(", ")}).`
				: ".") +
			" You can now retry the original Edit.",
	};
}

// ── Prediction submission ────────────────────────────────────────────────────

/** Validate the raw submission content and parse it. Returns either a block
 *  `DriveResult` (content missing/malformed) or the parsed prediction. */
function parseSentinelSubmissionContent(
	content: string,
): DriveResult | ReturnType<typeof parseBarePrediction> {
	if (!content || !content.includes("graph_prediction:")) {
		return {
			decision: "block",
			reason:
				"[interlinked:graph-pred] Sentinel-path submission must contain a `graph_prediction:` block. " +
				"Write the bare YAML (no fences needed) as the file content.",
		};
	}

	const parsed = parseBarePrediction(content);
	if (parsed.parse_status === "parse_failed") {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred] Prediction did not parse: ${parsed.parse_error}. ` +
				"Re-write the submission with corrected YAML.",
		};
	}
	if (!parsed.file) {
		return {
			decision: "block",
			reason:
				"[interlinked:graph-pred] Prediction is missing the `file:` field — needed so the harness can " +
				"match this submission to the target edit.",
		};
	}
	return parsed;
}

/** Classify the prediction's target file and confirm it is E-fresh with
 *  resolvable shard metadata. Returns either a block `DriveResult` or the
 *  classification. */
function classifySentinelTarget(
	parsedFile: string,
	cwd: string,
): DriveResult | (CaseResult & { shardPath: string; sourceMtime: string; shardMtime: string }) {
	const absTarget = isAbsolute(parsedFile) ? resolve(parsedFile) : resolve(cwd, parsedFile);
	const classification = classifyCase(absTarget, cwd);
	if (classification.case !== E_FRESH) {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred] Prediction target ${parsedFile} classifies as Case ${classification.case}, ` +
				"not E-fresh. Only E-fresh files (source exists + fresh shard colocated) need predictions. " +
				"If you intended to edit a different file, retry the Edit and the harness will tell you which file is in scope.",
		};
	}
	if (!classification.shardPath || !classification.sourceMtime || !classification.shardMtime) {
		return {
			decision: "block",
			reason: `[interlinked:graph-pred] Could not resolve shard metadata for ${parsedFile}.`,
		};
	}
	// SAFETY: the two guards above prove case === E_FRESH and all three
	// fields are non-null, matching the narrowed return type exactly.
	return classification as CaseResult & { shardPath: string; sourceMtime: string; shardMtime: string };
}

/** Build the accepted-prediction acknowledgement message. */
function buildSentinelSubmissionAck(
	sourcePath: string,
	parsed: ReturnType<typeof parseBarePrediction>,
): string {
	const ackParts: string[] = [
		`[interlinked:graph-pred] Prediction for ${sourcePath} accepted.`,
	];
	if (parsed.parse_status === "format_violation") {
		ackParts.push(
			`Format violation noted (${parsed.parse_error ?? "exceeded entry cap"}); the prediction was persisted but the format is non-conforming.`,
		);
	}
	ackParts.push("You can now retry the original Edit; the cache will be consulted.");
	return ackParts.join("\n");
}

export function handleSentinelSubmission(event: HarnessEvent, cwd: string): DriveResult | null {
	const filePath = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: "";
	const sentinel = parseSentinelPath(filePath, cwd);
	if (!sentinel) return null;

	const content = typeof event.tool_input?.content === "string" ? event.tool_input.content : "";
	const parsed = parseSentinelSubmissionContent(content);
	if ("decision" in parsed) return parsed;

	const classification = classifySentinelTarget(parsed.file, cwd);
	if ("decision" in classification) return classification;

	appendPredictionRow(cwd, {
		session_id: sentinel.sessionId,
		file_path: classification.sourcePath,
		source_mtime: classification.sourceMtime,
		shard_mtime: classification.shardMtime,
		shard_path: classification.shardPath,
		emitted_at: event.timestamp || new Date().toISOString(),
		tool_input_hash: "",
		case: "E-fresh",
		prediction: {
			deps: parsed.deps,
			calls: parsed.calls,
			impact: parsed.impact,
		},
		comparison_status: parsed.parse_status === "format_violation" ? "parse_failed" : "pending",
	});

	return {
		decision: "allow",
		additional_context: buildSentinelSubmissionAck(classification.sourcePath, parsed),
	};
}

