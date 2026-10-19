// ===========================================
// TypeScript check scheduler (E21) — pure prediction
// ===========================================
// Predicts whether the synchronous PostToolUse `typescript` check will report
// anything for one edit, from 17 free edit features. When the prediction is
// confidently clean the server phase (`server/tsc-scheduler-phase.ts`) defers
// the tsc run; deferred files are checked at the next run the scheduler keeps
// and always at Stop / SessionEnd.
//
// The features, their regexes, the input caps and the logistic are ported
// VERBATIM from the E21 study (2026-10-08):
//   scratch/2026-10-08-decisions-orthogonal/e12-compile/build_compile.py meta_for
//   scratch/2026-10-08-decisions-orthogonal/activity_scan.py compact_input (caps)
//   scratch/2026-10-08-decisions-orthogonal/e21-check-schedule/fit_for_ship.py (fit)
// Weights + provenance: tsc-scheduler-weights.json (cohort sha256, holdout
// AUROC 0.805 on 234 edits, thresholds per train recall point).
//
// One deterministic rule sits on top of the logistic: an edit whose import
// lines differ between the old and new text is NEVER deferred. On the E21
// holdout that rule took the 0.90 point from 10/50 missed reports to 2/50.
//
// CALIBRATION: one repository (interlinked-cli). E23 measured this logistic
// on a second repo: AUROC 0.510. It is OFF by default for that reason.

import { isAbsolute, relative, resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import weightsJson from "./tsc-scheduler-weights.json" with { type: "json" };

export const TSC_SCHEDULER_FEATURES = [
	"edit_chars", "old_chars", "edit_lines", "old_lines", "net_lines", "import_lines_added",
	"has_any", "has_as", "has_optchain", "has_bang", "brace_imbalance", "is_test_file",
	"is_write", "is_apply_patch", "is_subagent", "is_claude", "hour",
] as const;

export type TscFeatureName = (typeof TSC_SCHEDULER_FEATURES)[number];
export type TscEditFeatures = Record<TscFeatureName, number>;

/** Logistic features plus the import rule's input (not a logistic term). */
export interface TscSchedulerFeatures extends TscEditFeatures {
	import_touched: 0 | 1;
}

export interface TscRecallPoint {
	recall_point: number;
	threshold: number;
}

export interface TscPrediction extends TscRecallPoint {
	/** P(the typescript check reports a finding for this edit). */
	p: number;
	defer: boolean;
	/** Why a below-threshold edit still runs. */
	override?: "import-touched";
}

/** The edit as the scheduler sees it. Paths are compared after `resolve(cwd, …)`. */
export interface TscEditInput {
	toolName: string;
	toolInput: JsonObject;
	/** Absolute or cwd-relative path of the edited file. */
	filePath: string;
	cwd: string;
	toolUseId: string;
	isSubagent: boolean;
	/** ISO timestamp of the event (UTC hour is a feature). */
	timestamp: string;
}

interface SchedulerWeights {
	features: readonly string[];
	mean: readonly number[];
	scale: readonly number[];
	weights: readonly number[];
	bias: number;
	default_recall_point: number;
	recall_points: readonly TscRecallPoint[];
}

/** Parse the committed weights once, at module load: a malformed file is a
 *  build defect, so it throws instead of silently deferring nothing. */
function loadWeights(raw: SchedulerWeights): SchedulerWeights {
	const n = TSC_SCHEDULER_FEATURES.length;
	const aligned = raw.features.length === n && raw.features.every((f, i) => f === TSC_SCHEDULER_FEATURES[i]);
	const sized = [raw.mean, raw.scale, raw.weights].every((v) => v.length === n && v.every(Number.isFinite));
	if (!aligned || !sized || !Number.isFinite(raw.bias) || raw.recall_points.length === 0) {
		throw new Error("tsc-scheduler-weights.json does not match TSC_SCHEDULER_FEATURES");
	}
	const points = raw.recall_points
		.map(({ recall_point, threshold }) => ({ recall_point, threshold }))
		.sort((a, b) => a.recall_point - b.recall_point);
	return { ...raw, recall_points: points };
}

const WEIGHTS = loadWeights(weightsJson);

// activity_scan.py caps (the E21 features were computed on capped input).
const INPUT_CAP = 8000;
const PATCH_CAP = 16000;

// build_compile.py regexes, verbatim.
const ANY_RE = /\bany\b/;
const AS_RE = /\bas /;
const BANG_RE = /[\w)\]]!(?=[.[);,\s])/;
const TEST_RE = /(\.test\.|\.spec\.|__tests__\/)/;
const IMPORT_RE = /^\s*import\b/;
const PATCH_HEADER_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/;
const PATCH_TRAILER_RE = /^\*\*\* (End Patch|Move to: .*)$/;

/** Python `str[:cap]` (code points, not UTF-16 units). */
function capText(text: string, cap: number): string {
	const points = Array.from(text);
	return points.length > cap ? points.slice(0, cap).join("") : text;
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function lineCount(text: string): number {
	return text ? text.split("\n").length : 0;
}

function countImports(text: string): number {
	return text.split("\n").filter((line) => IMPORT_RE.test(line)).length;
}

function braces(text: string): number {
	return text.split("{").length - text.split("}").length;
}

function sameFile(cwd: string, a: string, b: string): boolean {
	return resolve(cwd, a.trim()) === resolve(cwd, b.trim());
}

/** One body line of the matched section, as build_compile.patch_section. */
function addPatchLine(line: string, old: string[], next: string[]): void {
	if (!line || line.startsWith("@@") || PATCH_TRAILER_RE.test(line)) return;
	const tag = line[0];
	const rest = line.slice(1);
	if (tag === " " || tag === "-") old.push(rest);
	if (tag === " " || tag === "+") next.push(rest);
}

/** The apply_patch section for one file: context + removed lines → old,
 *  context + added lines → new. Null when no section names the file. */
export function patchSectionTexts(patch: string, filePath: string, cwd: string): { old: string; new: string } | null {
	let state: "before" | "inside" | "after" = "before";
	const old: string[] = [];
	const next: string[] = [];
	for (const line of patch.split("\n")) {
		const header = PATCH_HEADER_RE.exec(line);
		if (header) {
			if (state === "inside") state = "after";
			else if (state === "before" && sameFile(cwd, header[2] ?? "", filePath)) state = "inside";
			continue;
		}
		if (state === "inside") addPatchLine(line, old, next);
	}
	return state === "before" ? null : { old: old.join("\n"), new: next.join("\n") };
}

function multiEditTexts(toolInput: JsonObject): { old: string; new: string } {
	const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
	const pick = (key: string) => edits.map((e) => (isJsonObject(e) ? str(e[key]) : "")).join("\n");
	return { old: capText(pick("old_string"), INPUT_CAP), new: capText(pick("new_string"), INPUT_CAP) };
}

function rawTexts(toolName: string, toolInput: JsonObject, filePath: string, cwd: string): { old: string; new: string } | null {
	switch (toolName) {
		case "apply_patch": {
			const raw = str(toolInput.command) || str(toolInput.patch) || str(toolInput._raw_patch) || str(toolInput.content);
			return patchSectionTexts(capText(raw, PATCH_CAP), filePath, cwd);
		}
		case "Write":
			return { old: "", new: capText(str(toolInput.content), INPUT_CAP) };
		case "Edit":
			return { old: capText(str(toolInput.old_string), INPUT_CAP), new: capText(str(toolInput.new_string), INPUT_CAP) };
		case "MultiEdit":
			return multiEditTexts(toolInput);
		default:
			return null;
	}
}

/** (old, new) edit text for one file, or null when the tool carries none. */
export function editTextsFor(input: Pick<TscEditInput, "toolName" | "toolInput" | "filePath" | "cwd">): { old: string; new: string } | null {
	const texts = rawTexts(input.toolName, input.toolInput, input.filePath, input.cwd);
	return texts && (texts.old || texts.new) ? texts : null;
}

function importBag(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of text.split("\n")) {
		if (!IMPORT_RE.test(line)) continue;
		const key = line.trim();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** Import lines differ between old and new (multiset of trimmed lines). */
export function importLinesTouched(oldText: string, newText: string): boolean {
	const a = importBag(oldText);
	const b = importBag(newText);
	return a.size !== b.size || [...a].some(([line, n]) => b.get(line) !== n);
}

function utcHour(timestamp: string): number {
	const ms = Date.parse(timestamp);
	return Number.isFinite(ms) ? new Date(ms).getUTCHours() : 0;
}

function repoRelative(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? relative(cwd, filePath) : filePath.replace(/^(\.\/)+/, "");
}

/** E21 meta_for, verbatim. Null when the tool carries no edit text. */
export function extractTscEditFeatures(input: TscEditInput): TscSchedulerFeatures | null {
	const texts = editTextsFor(input);
	if (!texts) return null;
	const { old, new: next } = texts;
	const newLines = lineCount(next);
	const oldLines = lineCount(old);
	return {
		edit_chars: codePointLength(next),
		old_chars: codePointLength(old),
		edit_lines: newLines,
		old_lines: oldLines,
		net_lines: newLines - oldLines,
		import_lines_added: Math.max(0, countImports(next) - countImports(old)),
		has_any: Number(ANY_RE.test(next)),
		has_as: Number(AS_RE.test(next)),
		has_optchain: Number(next.includes("?.")),
		has_bang: Number(BANG_RE.test(next)),
		brace_imbalance: Math.abs(braces(next) - braces(old)),
		is_test_file: Number(TEST_RE.test(repoRelative(input.cwd, input.filePath))),
		is_write: Number(input.toolName === "Write"),
		is_apply_patch: Number(input.toolName === "apply_patch"),
		is_subagent: Number(input.isSubagent),
		is_claude: Number(input.toolUseId.startsWith("toolu_")),
		hour: utcHour(input.timestamp),
		import_touched: importLinesTouched(old, next) ? 1 : 0,
	};
}

/** The fitted point for a requested train recall: the smallest fitted point
 *  at or above it (stricter, never looser); above every point → the strictest. */
export function recallPointFor(minRecallPoint?: number): TscRecallPoint {
	const want = minRecallPoint ?? WEIGHTS.default_recall_point;
	const points = WEIGHTS.recall_points;
	const strictest = points[points.length - 1] as TscRecallPoint;
	return points.find((pt) => pt.recall_point >= want - 1e-9) ?? strictest;
}

/** Logistic probability that the typescript check reports for this edit. */
export function tscReportProbability(features: TscEditFeatures): number {
	let z = WEIGHTS.bias;
	TSC_SCHEDULER_FEATURES.forEach((name, i) => {
		z += (WEIGHTS.weights[i] as number) * ((features[name] - (WEIGHTS.mean[i] as number)) / (WEIGHTS.scale[i] as number));
	});
	return 1 / (1 + Math.exp(-z));
}

/** Defer iff p < threshold AND the edit leaves import lines unchanged. */
export function predictTscReports(features: TscSchedulerFeatures, minRecallPoint?: number): TscPrediction {
	const point = recallPointFor(minRecallPoint);
	const p = tscReportProbability(features);
	const below = p < point.threshold;
	if (below && features.import_touched === 1) return { ...point, p, defer: false, override: "import-touched" };
	return { ...point, p, defer: below };
}
