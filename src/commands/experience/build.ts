// ===========================================
// Experience builder — timeline/collection/activity → trajectory records
// ===========================================
// Projects one session's logs into an agent-readable trajectory: the Letta
// trajectory-v1 spine, optionally annotated (trajectory-ix.v1) with the data
// only the harness capture has — G3 seq, tool class, outcomes, guard
// verdicts, episode indices, verification classification. Bounded scans only
// (scanJsonlTail); a stopped scan is surfaced in diagnostics, never silent.

import { join } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import {
	scanJsonlTail,
	type TailScanBudget,
} from "../query/reverse-reader.js";
import type {
	BuiltExperience,
	ExperienceFormat,
	ExperienceMetaRecord,
	ExperienceRecord,
	ExperienceSpineRecord,
	IxAnnotations,
	IxExperienceRecord,
	IxGuardAnnotation,
} from "./types.js";

/** Structural view of a timeline.v1 row — only the fields projected. */
interface TimelineRow {
	ts: string;
	category: string;
	provider?: string;
	model?: string;
	text?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_use_id?: string;
	cwd?: string;
	git_branch?: string;
	agent_id?: string;
}

/** Collection join payload for one tool_use_id (post phase). */
interface CollectionJoin {
	seq?: number;
	tool_class?: IxAnnotations["tool_class"];
	outcome?: "ok" | "error";
	duration_ms?: number;
	file?: string;
	command?: string;
}

interface BuildExperienceOptions {
	/** Repo root containing `.interlinked/`. */
	dir: string;
	sessionId: string;
	format: ExperienceFormat;
	/** Cap on tool-result content; null disables. Default 4000. */
	truncateChars?: number | null;
	budget?: TailScanBudget;
}

const DEFAULT_TRUNCATE_CHARS = 4000;
const DEFAULT_BUDGET: TailScanBudget = { maxRecords: 50_000, maxBytes: 64 * 1024 * 1024 };

/** Commands that constitute a verification run (test/typecheck/lint/build). */
const VERIFICATION_PATTERN =
	/\b(?:vitest|jest|pytest|tsc|tsgo|biome|oxlint|eslint|ruff|mypy|go\s+(?:test|vet)|cargo\s+(?:test|check|clippy)|npm\s+(?:test|run\s+(?:test[\w:-]*|typecheck|build|lint)))\b/;

export function buildExperience(opts: BuildExperienceOptions): BuiltExperience {
	const truncateChars =
		opts.truncateChars === undefined ? DEFAULT_TRUNCATE_CHARS : opts.truncateChars;
	const budget = opts.budget ?? DEFAULT_BUDGET;

	const timeline = loadTimeline(opts.dir, opts.sessionId, budget);
	if (timeline.rows.length === 0) {
		return {
			records: [],
			diagnostics: {
				timeline_records: 0,
				collection_joined: 0,
				guard_joined: 0,
				truncated_records: 0,
				scan_truncated: timeline.truncated,
			},
		};
	}

	const ids = new Set<string>();
	for (const row of timeline.rows) {
		if (row.tool_use_id) ids.add(row.tool_use_id);
	}
	const wantIx = opts.format === "ix";
	const collection = wantIx
		? loadCollectionJoin(opts.dir, opts.sessionId, ids, budget)
		: new Map<string, CollectionJoin>();
	const guards = wantIx
		? loadGuardJoin(opts.dir, ids, budget)
		: new Map<string, IxGuardAnnotation>();

	const state = { truncated: 0, episodes: 0, toolCalls: 0 };
	const spine = buildSpineRecords(timeline.rows, truncateChars, wantIx, collection, guards, state);

	const meta = buildMeta(timeline.rows, opts, state, spine.length, guards, truncateChars);
	return {
		records: [meta, ...spine],
		diagnostics: {
			timeline_records: timeline.rows.length,
			collection_joined: collection.size,
			guard_joined: guards.size,
			truncated_records: state.truncated,
			scan_truncated: timeline.truncated,
		},
	};
}

/** Projects timeline rows to spine records, annotating with ix data when requested; sets state.episodes. */
function buildSpineRecords(
	rows: TimelineRow[],
	truncateChars: number | null,
	wantIx: boolean,
	collection: Map<string, CollectionJoin>,
	guards: Map<string, IxGuardAnnotation>,
	state: { truncated: number; episodes: number; toolCalls: number },
): (ExperienceSpineRecord | IxExperienceRecord)[] {
	const spine: (ExperienceSpineRecord | IxExperienceRecord)[] = [];
	let episode = -1;
	for (const row of rows) {
		const record = spineFromTimeline(row, truncateChars, state);
		if (!record) continue;
		if (row.category === "user_prompt") episode++;
		if (wantIx) {
			const ix = ixAnnotationsFor(row, collection, guards, Math.max(episode, 0));
			if (Object.keys(ix).length > 0) (record as IxExperienceRecord & { ix?: IxAnnotations }).ix = ix;
		}
		spine.push(record);
	}
	state.episodes = episode + 1;
	return spine;
}

// --- Loaders (bounded scans, newest-first → reversed to chronological) ---

function loadTimeline(
	dir: string,
	sessionId: string,
	budget: TailScanBudget,
): { rows: TimelineRow[]; truncated: boolean } {
	const rows: TimelineRow[] = [];
	const stats = scanJsonlTail(join(dir, ".interlinked", "timeline.jsonl"), budget, (rec) => {
		if (rec.schema !== "timeline.v1" || rec.session !== sessionId) return true;
		if (typeof rec.ts !== "string" || typeof rec.category !== "string") return true;
		rows.push(rec as unknown as TimelineRow);
		return true;
	});
	rows.reverse();
	// Stable sort by timestamp; equal timestamps keep append order.
	rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	return { rows, truncated: stats.truncated };
}

function loadCollectionJoin(
	dir: string,
	sessionId: string,
	ids: Set<string>,
	budget: TailScanBudget,
): Map<string, CollectionJoin> {
	const joins = new Map<string, CollectionJoin>();
	scanJsonlTail(join(dir, ".interlinked", "collection.jsonl"), budget, (rec) => {
		if (rec.kind !== "tool_event" || rec.phase !== "post") return true;
		if (rec.session_id !== sessionId) return true;
		const id = rec.tool_use_id;
		if (typeof id !== "string" || !ids.has(id) || joins.has(id)) return true;
		joins.set(id, collectionJoinFrom(rec));
		return true;
	});
	return joins;
}

function collectionJoinFrom(rec: JsonObject): CollectionJoin {
	const join: CollectionJoin = {};
	if (typeof rec.seq === "number") join.seq = rec.seq;
	if (typeof rec.tool_class === "string")
		join.tool_class = rec.tool_class as IxAnnotations["tool_class"];
	if (rec.outcome === "ok" || rec.outcome === "error") join.outcome = rec.outcome;
	const action = isJsonObject(rec.action) ? rec.action : null;
	if (action && typeof action.path === "string") join.file = action.path;
	if (action && typeof action.command === "string") join.command = action.command;
	const obs = isJsonObject(rec.observation) ? rec.observation : null;
	if (obs && typeof obs.duration_ms === "number") join.duration_ms = obs.duration_ms;
	return join;
}

function loadGuardJoin(
	dir: string,
	ids: Set<string>,
	budget: TailScanBudget,
): Map<string, IxGuardAnnotation> {
	const guards = new Map<string, IxGuardAnnotation>();
	scanJsonlTail(join(dir, ".interlinked", "activity.jsonl"), budget, (rec) => {
		if (rec.type !== "guard_block" && rec.type !== "guard_warn") return true;
		const id = rec.tool_use_id;
		if (typeof id !== "string" || !ids.has(id) || guards.has(id)) return true;
		guards.set(id, {
			decision: rec.type === "guard_block" ? "block" : "warn",
			rule_id: typeof rec.guard_rule_id === "string" ? rec.guard_rule_id : null,
			reason: typeof rec.guard_reason === "string" ? rec.guard_reason : null,
		});
		return true;
	});
	return guards;
}

// --- Projection ---

function spineFromTimeline(
	row: TimelineRow,
	truncateChars: number | null,
	state: { truncated: number; toolCalls: number },
): ExperienceSpineRecord | null {
	switch (row.category) {
		case "user_prompt":
			return { role: "user", content: row.text ?? "", timestamp: row.ts };
		case "agent_thinking":
			return { role: "reasoning", content: row.text ?? "", timestamp: row.ts };
		case "agent_message":
			return { role: "assistant", content: row.text ?? "", timestamp: row.ts };
		case "tool_use":
			state.toolCalls++;
			return {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: row.tool_use_id ?? "",
						name: row.tool_name ?? "",
						args: JSON.stringify(row.tool_input ?? {}),
					},
				],
				timestamp: row.ts,
			};
		case "tool_result":
			return {
				role: "tool",
				tool_call_id: row.tool_use_id ?? "",
				content: truncateContent(row.text ?? "", truncateChars, state),
				timestamp: row.ts,
			};
		default:
			return null;
	}
}

/** A cap is never silent: truncation appends an explicit marker. */
function truncateContent(
	text: string,
	truncateChars: number | null,
	state: { truncated: number },
): string {
	if (truncateChars === null || text.length <= truncateChars) return text;
	state.truncated++;
	return `${text.slice(0, truncateChars)}\n[interlinked: truncated ${text.length} chars total]`;
}

function ixAnnotationsFor(
	row: TimelineRow,
	collection: Map<string, CollectionJoin>,
	guards: Map<string, IxGuardAnnotation>,
	episode: number,
): IxAnnotations {
	const ix: IxAnnotations = { episode };
	if (row.agent_id) ix.agent_id = row.agent_id;
	const id = row.tool_use_id;
	if (!id) return ix;
	const joined = collection.get(id);
	if (row.category === "tool_use") annotateCall(ix, row, joined, guards.get(id));
	if (row.category === "tool_result" && joined) annotateResult(ix, joined);
	return ix;
}

/** Intent-side annotations live on the call record. */
function annotateCall(
	ix: IxAnnotations,
	row: TimelineRow,
	joined: CollectionJoin | undefined,
	guard: IxGuardAnnotation | undefined,
): void {
	if (joined?.seq !== undefined) ix.seq = joined.seq;
	if (joined?.tool_class !== undefined) ix.tool_class = joined.tool_class;
	if (joined?.file !== undefined) ix.file = joined.file;
	if (guard) ix.guard = guard;
	const command = joined?.command ?? commandFromInput(row.tool_input);
	if (command !== undefined && VERIFICATION_PATTERN.test(command)) ix.is_verification = true;
}

/** Outcome-side annotations live on the result record. */
function annotateResult(ix: IxAnnotations, joined: CollectionJoin): void {
	if (joined.outcome !== undefined) ix.outcome = joined.outcome;
	if (joined.duration_ms !== undefined) ix.duration_ms = joined.duration_ms;
}

function commandFromInput(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const command = (input as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
}

// --- Meta ---

function buildMeta(
	rows: TimelineRow[],
	opts: BuildExperienceOptions,
	state: { episodes: number; toolCalls: number },
	spineCount: number,
	guards: Map<string, IxGuardAnnotation>,
	truncateChars: number | null,
): ExperienceRecord | IxExperienceRecord {
	const meta: ExperienceMetaRecord = {
		role: "meta",
		source: firstDefined(rows, (r) => r.provider) ?? "claude-code",
		cwd: firstDefined(rows, (r) => r.cwd) ?? null,
		git_branch: firstDefined(rows, (r) => r.git_branch) ?? null,
		model: firstDefined(rows, (r) => r.model) ?? null,
	};
	if (opts.format === "letta") return meta;
	let blocks = 0;
	for (const g of guards.values()) if (g.decision === "block") blocks++;
	return {
		...meta,
		schema: "trajectory-ix.v1",
		ix_meta: {
			session_id: opts.sessionId,
			agent_name: null,
			records: spineCount,
			episodes: state.episodes,
			tool_calls: state.toolCalls,
			guard_blocks: blocks,
			truncate_chars: truncateChars,
		},
	};
}

function firstDefined(
	rows: TimelineRow[],
	pick: (row: TimelineRow) => string | undefined,
): string | undefined {
	for (const row of rows) {
		const value = pick(row);
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}
