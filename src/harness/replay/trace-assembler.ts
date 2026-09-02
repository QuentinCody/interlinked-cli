// ===========================================
// T1 trace assembler — the replay-trace.v1 spine
// ===========================================
// Joins the three capture surfaces into one step-per-tool-call trace
// (docs/design/reproducibility/README.md §Trace spine):
//   collection.jsonl  — the action (pre row) + result (post row), seq-ordered
//   inference/…       — the EXACT observation (G1 envelope), joined by
//                       tool_use_id, then stamped with session/seq and
//                       rewritten into inference/<session>.jsonl
//   snapshots/…       — pre/post working-tree shas (G2), joined by
//                       tool_use_id; state pointer ref when the archive exists
// Envelope-less steps still produce rows (observation_ref null): a session
// captured without the proxy is degraded, not empty. Assembly is idempotent —
// the trace and per-session envelope files are rewritten wholesale.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { sanitizeSessionId } from "../session-paths.js";
import {
	envelopeForToolUseId,
	type InferenceEnvelope,
	loadEnvelopes,
	pendingEnvelopePath,
} from "./inference-store.js";
import { loadSnapshotIndex, type TreeSnapshotRecord } from "./tree-snapshot.js";

interface TraceStepKey {
	session_id: string;
	seq: number | null;
	tool_use_id: string | null;
	ts: string;
}

interface TraceStep {
	schema: "replay-trace.v1";
	key: TraceStepKey;
	/** `inference/<session>.jsonl#seq=<n>` when the exact observation was
	 *  captured by the G1 proxy; null on degraded (proxy-less) steps. */
	observation_ref: string | null;
	action: { tool: string | null; input: JsonObject | null } | null;
	result: { outcome: string; observation: JsonObject | null } | null;
	pre_tree: string | null;
	post_tree: string | null;
	state_ref: string | null;
}

interface AssembleSummary {
	steps: number;
steps_with_envelope: number;
}

function safeId(sessionId: string): string {
	return sanitizeSessionId(sessionId) || "unknown-session";
}

function tracePath(cwd: string, sessionId: string): string {
	return join(cwd, ".interlinked", "replay", "trace", `${safeId(sessionId)}.jsonl`);
}

/** Where the assembler rewrites session-stamped envelopes; the eval runner
 *  reads its observations from here. */
export function perSessionEnvelopePath(cwd: string, sessionId: string): string {
	return join(cwd, ".interlinked", "replay", "inference", `${safeId(sessionId)}.jsonl`);
}

// Rule 3 (scratch/fleet-r2/CONTRACT.md): route the local narrower through the
// one canonical predicate instead of hand-rolling the object/array check.
function asObject(value: unknown): JsonObject | null {
	return isJsonObject(value) ? value : null;
}

/** Tolerant collection.jsonl reader scoped to one session's tool events. */
function readCollectionRows(cwd: string, sessionId: string): JsonObject[] {
	const path = join(cwd, ".interlinked", "collection.jsonl");
	if (!existsSync(path)) return [];
	const out: JsonObject[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = asObject(JSON.parse(line));
			if (
				row &&
				row.schema === "collection.v1" &&
				row.kind === "tool_event" &&
				row.session_id === sessionId
			) {
				out.push(row);
			}
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	return out;
}

function bySeqThenTs(a: JsonObject, b: JsonObject): number {
	const seqA = typeof a.seq === "number" ? a.seq : Number.POSITIVE_INFINITY;
	const seqB = typeof b.seq === "number" ? b.seq : Number.POSITIVE_INFINITY;
	if (seqA !== seqB) return seqA - seqB;
	return String(a.ts ?? "").localeCompare(String(b.ts ?? ""));
}

interface JoinContext {
	sessionId: string;
	postByToolUse: Map<string, JsonObject>;
	snapshots: TreeSnapshotRecord[];
	envelopes: InferenceEnvelope[];
	stateRefAvailable: boolean;
	stamped: InferenceEnvelope[];
}

function snapshotTree(
	snapshots: TreeSnapshotRecord[],
	toolUseId: string | null,
	phase: "pre" | "post",
): string | null {
	if (!toolUseId) return null;
	for (const s of snapshots) {
		if (s.tool_use_id === toolUseId && s.phase === phase) return s.tree;
	}
	return null;
}

function buildStep(preRow: JsonObject, ctx: JoinContext): TraceStep {
	const toolUseId = typeof preRow.tool_use_id === "string" ? preRow.tool_use_id : null;
	const seq = typeof preRow.seq === "number" ? preRow.seq : null;
	const envelope = toolUseId ? envelopeForToolUseId(ctx.envelopes, toolUseId) : null;
	if (envelope) {
		ctx.stamped.push({ ...envelope, session_id: ctx.sessionId, seq });
	}
	const postRow = toolUseId ? ctx.postByToolUse.get(toolUseId) : undefined;
	return {
		schema: "replay-trace.v1",
		key: {
			session_id: ctx.sessionId,
			seq,
			tool_use_id: toolUseId,
			ts: String(preRow.ts ?? ""),
		},
		observation_ref: envelope
			? `inference/${safeId(ctx.sessionId)}.jsonl#seq=${seq ?? "?"}`
			: null,
		action: {
			tool: typeof preRow.provider_tool === "string" ? preRow.provider_tool : null,
			input: asObject(preRow.action),
		},
		result: postRow
			? {
					outcome: typeof postRow.outcome === "string" ? postRow.outcome : "ok",
					observation: asObject(postRow.observation),
				}
			: null,
		pre_tree: snapshotTree(ctx.snapshots, toolUseId, "pre"),
		post_tree: snapshotTree(ctx.snapshots, toolUseId, "post"),
		state_ref: ctx.stateRefAvailable
			? `state/${safeId(ctx.sessionId)}.jsonl#seq=${seq ?? "?"}`
			: null,
	};
}

/** Assemble (or re-assemble) one session's trace. Rewrites the trace file and
 *  the stamped per-session envelope file wholesale — idempotent by design. */
export function assembleTrace(cwd: string, sessionId: string): AssembleSummary {
	const rows = readCollectionRows(cwd, sessionId);
	const preRows = rows.filter((r) => r.phase === "pre").sort(bySeqThenTs);
	const postByToolUse = new Map<string, JsonObject>();
	for (const r of rows) {
		if (r.phase === "post" && typeof r.tool_use_id === "string" && !postByToolUse.has(r.tool_use_id)) {
			postByToolUse.set(r.tool_use_id, r);
		}
	}

	const replayDir = join(cwd, ".interlinked", "replay");
	const ctx: JoinContext = {
		sessionId,
		postByToolUse,
		snapshots: loadSnapshotIndex(cwd).filter((s) => s.session_id === sessionId),
		envelopes: loadEnvelopes(pendingEnvelopePath(replayDir)),
		stateRefAvailable: existsSync(
			join(replayDir, "state", `${safeId(sessionId)}.jsonl`),
		),
		stamped: [],
	};

	const steps = preRows.map((row) => buildStep(row, ctx));

	const outPath = tracePath(cwd, sessionId);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, steps.map((s) => JSON.stringify(s)).join("\n") + (steps.length ? "\n" : ""));

	if (ctx.stamped.length > 0) {
		const envPath = perSessionEnvelopePath(cwd, sessionId);
		mkdirSync(dirname(envPath), { recursive: true });
		writeFileSync(envPath, `${ctx.stamped.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}

	return { steps: steps.length, steps_with_envelope: ctx.stamped.length };
}

function parseTraceStepKey(value: unknown): TraceStepKey | null {
	if (!isJsonObject(value)) return null;
	const { session_id, ts } = value;
	if (typeof session_id !== "string" || typeof ts !== "string") return null;
	const seq = value.seq ?? null;
	if (seq !== null && typeof seq !== "number") return null;
	const toolUseId = value.tool_use_id ?? null;
	if (toolUseId !== null && typeof toolUseId !== "string") return null;
	return { session_id, seq, tool_use_id: toolUseId, ts };
}

/** `raw` is already normalized to `T | null` by the caller (`?? null`); this
 *  returns `undefined` as an invalid-shape sentinel so the caller can tell
 *  "legitimately null" apart from "malformed, reject the whole step". */
function parseTraceAction(raw: unknown): TraceStep["action"] | undefined {
	if (raw === null) return null;
	if (!isJsonObject(raw)) return undefined;
	const tool = raw.tool ?? null;
	if (tool !== null && typeof tool !== "string") return undefined;
	const input = raw.input ?? null;
	if (input !== null && !isJsonObject(input)) return undefined;
	return { tool, input };
}

/** Same invalid-shape sentinel convention as {@link parseTraceAction}. */
function parseTraceResult(raw: unknown): TraceStep["result"] | undefined {
	if (raw === null) return null;
	if (!isJsonObject(raw)) return undefined;
	const outcome = raw.outcome;
	if (typeof outcome !== "string") return undefined;
	const observation = raw.observation ?? null;
	if (observation !== null && !isJsonObject(observation)) return undefined;
	return { outcome, observation };
}

/** Validates a `T | null`-shaped raw field: absent/null passes through as
 *  `null`, a string passes through unchanged, anything else is the same
 *  invalid-shape `undefined` sentinel used by {@link parseTraceAction} and
 *  {@link parseTraceResult}. */
function parseNullableStringField(raw: unknown): string | null | undefined {
	if (raw === undefined || raw === null) return null;
	return typeof raw === "string" ? raw : undefined;
}

/** The four optional string-or-null fields on a trace step, each validated
 *  with {@link parseNullableStringField}. `undefined` on any field means the
 *  whole step is malformed — the caller rejects on that sentinel. */
function parseTraceStepRefs(value: JsonObject):
	| { observationRef: string | null; preTree: string | null; postTree: string | null; stateRef: string | null }
	| undefined {
	const observationRef = parseNullableStringField(value.observation_ref);
	if (observationRef === undefined) return undefined;
	const preTree = parseNullableStringField(value.pre_tree);
	if (preTree === undefined) return undefined;
	const postTree = parseNullableStringField(value.post_tree);
	if (postTree === undefined) return undefined;
	const stateRef = parseNullableStringField(value.state_ref);
	if (stateRef === undefined) return undefined;
	return { observationRef, preTree, postTree, stateRef };
}

/** Validate one trace-file line. Exported for direct testing. */
export function parseTraceStep(value: unknown): TraceStep | null {
	if (!isJsonObject(value)) return null;
	if (value.schema !== "replay-trace.v1") return null;
	const key = parseTraceStepKey(value.key);
	if (!key) return null;
	const action = parseTraceAction(value.action ?? null);
	if (action === undefined) return null;
	const result = parseTraceResult(value.result ?? null);
	if (result === undefined) return null;
	const refs = parseTraceStepRefs(value);
	if (!refs) return null;

	return {
		schema: "replay-trace.v1",
		key,
		observation_ref: refs.observationRef,
		action,
		result,
		pre_tree: refs.preTree,
		post_tree: refs.postTree,
		state_ref: refs.stateRef,
	};
}

/** Tolerant reader for an assembled trace. */
export function loadTrace(cwd: string, sessionId: string): TraceStep[] {
	const path = tracePath(cwd, sessionId);
	if (!existsSync(path)) return [];
	const out: TraceStep[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = parseTraceStep(JSON.parse(line));
			if (parsed) out.push(parsed);
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	return out;
}
