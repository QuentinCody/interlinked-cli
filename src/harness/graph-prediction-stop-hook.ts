// ===========================================
// Stop-hook prediction harvest
// ===========================================
// On Stop, walks the Claude Code transcript JSONL backwards, pulls the
// most recent assistant messages' text, and runs the parser to extract
// any `graph_prediction:` blocks. For each parsed prediction whose
// target file is currently Case E-fresh, persists a row to
// `.interlinked/graph-predictions.jsonl` keyed by current source/shard
// mtimes.
//
// Non-E-fresh predictions are reported as `skipped` with their case so
// future phases (Phase 5 deferred-comparison) can route Cases B/C
// voluntary predictions through the deferred mechanism.

import { existsSync, readFileSync } from "node:fs";
import { isJsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import {
	appendPredictionRow,
	type GraphPredictionRow,
	type PredictionContent,
} from "./graph-prediction-cache.js";
import { type CaseResult, classifyCase } from "./graph-prediction-classifier.js";
import {
	type ParsedGraphPrediction,
	parseGraphPredictionsFromText,
} from "./graph-prediction-parser.js";

const RECENT_ASSISTANT_MESSAGE_LIMIT = 10;

export interface HarvestArgs {
	cwd: string;
	sessionId: string;
	transcriptPath: string | undefined;
}

export interface HarvestedPersisted {
	file_path: string;
	case: "E-fresh";
}

export interface HarvestedSkipped {
	file_path: string;
	case: "A" | "B" | "C" | "D" | "E-fresh" | "E-stale";
	reason: "non_authoritative_case" | "parse_failed" | "format_violation";
}

export interface HarvestResult {
	persisted: HarvestedPersisted[];
	skipped: HarvestedSkipped[];
}

export function harvestPredictionsFromTranscript(args: HarvestArgs): HarvestResult {
	const result: HarvestResult = { persisted: [], skipped: [] };
	if (!args.transcriptPath || !existsSync(args.transcriptPath)) return result;

	const recentTexts = readRecentAssistantTexts(args.transcriptPath);
	const allPredictions: ParsedGraphPrediction[] = [];
	for (const text of recentTexts) {
		allPredictions.push(...parseGraphPredictionsFromText(text));
	}
	if (allPredictions.length === 0) return result;

	const now = new Date().toISOString();
	for (const pred of allPredictions) {
		processPrediction(pred, args, now, result);
	}
	return result;
}

function processPrediction(
	pred: ParsedGraphPrediction,
	args: HarvestArgs,
	now: string,
	result: HarvestResult,
): void {
	if (pred.parse_status === "parse_failed") {
		// Don't even know which file — can't classify; ignore silently.
		return;
	}
	// Parser finalization marks a missing file as parse_failed, handled above.

	const classification = classifyCase(pred.file, args.cwd);
	if (classification.case !== "E-fresh") {
		result.skipped.push({
			file_path: classification.sourcePath,
			case: classification.case,
			reason: pred.parse_status === "format_violation" ? "format_violation" : "non_authoritative_case",
		});
		return;
	}

	if (pred.parse_status === "format_violation") {
		// E-fresh but the prediction itself is malformed; skip persistence
		// rather than poisoning the cache. Phase 4 may surface this back to
		// the agent as a re-emit-with-narrower-top-K request.
		result.skipped.push({
			file_path: classification.sourcePath,
			case: classification.case,
			reason: "format_violation",
		});
		return;
	}

	const row = buildPredictionRow(pred, classification, args.sessionId, now);
	appendPredictionRow(args.cwd, row);
	result.persisted.push({ file_path: classification.sourcePath, case: "E-fresh" });
}

function buildPredictionRow(
	pred: ParsedGraphPrediction,
	classification: CaseResult,
	sessionId: string,
	now: string,
): GraphPredictionRow {
	// Only an E-fresh classification reaches this helper; classifyCase builds
	// that case with a shard path and both successful filesystem timestamps.
	const content: PredictionContent = {
		deps: pred.deps,
		calls: pred.calls,
		impact: pred.impact,
	};
	return {
		session_id: sessionId,
		file_path: classification.sourcePath,
		source_mtime: nonNull(classification.sourceMtime),
		shard_mtime: nonNull(classification.shardMtime),
		shard_path: nonNull(classification.shardPath),
		emitted_at: now,
		tool_input_hash: "",
		case: "E-fresh",
		prediction: content,
		comparison_status: "pending",
	};
}

/** Public — also consumed by `graph-prediction-pre-tool.ts` for the §5.3
 *  same-turn transcript fallback. Reads the Claude Code transcript JSONL
 *  backwards, returning up to RECENT_ASSISTANT_MESSAGE_LIMIT recent
 *  assistant-message text bodies. Returns [] when the path is missing /
 *  unreadable / contains no assistant messages. */
export function readRecentAssistantTexts(transcriptPath: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(transcriptPath, "utf-8");
	} catch {
		return [];
	}
	const texts: string[] = [];
	const lines = raw.split("\n");
	// Walk backwards so we get the most recent assistant text first; cap
	// at RECENT_ASSISTANT_MESSAGE_LIMIT to keep parsing cheap.
	for (let i = lines.length - 1; i >= 0; i--) {
		if (texts.length >= RECENT_ASSISTANT_MESSAGE_LIMIT) break;
		const line = nonNull(lines[i]);
		if (!line.trim()) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		const text = extractAssistantText(obj);
		if (text) texts.push(text);
	}
	return texts.reverse();
}

function extractAssistantText(obj: unknown): string | null {
	if (!isJsonObject(obj)) return null;
	const o = obj;
	if (o.type !== "assistant") return null;
	if (!isJsonObject(o.message)) return null;
	const content = o.message.content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (!isJsonObject(block)) continue;
		const b = block;
		if (b.type !== "text") continue;
		if (typeof b.text === "string") parts.push(b.text);
	}
	if (parts.length === 0) return null;
	return parts.join("\n");
}
