// ===========================================
// Session Snapshot Codec — serialize / hydrate coercion helpers
// ===========================================
// Lifted verbatim out of session-state.ts. SessionTracker.serialize() and
// .hydrate() delegate here for the field-by-field defensive coercion. Split
// into its own module purely to keep session-state.ts under the per-file line
// cap; the public behavior is unchanged. Every reader falls back to the same
// default `recordEvent` uses for a fresh session, so a file from an older
// harness version, a half-written snapshot, or a hand-edited file never
// crashes the daemon.

import type { JsonObject } from "../lib/json-types.js";
import type {
	CapturedPlan,
	PlanSource,
	PlanStep,
	PlanStepStatus,
} from "./types/plan.js";
import type {
	ActiveSkillRecord,
	AssertionCounts,
	FailedFileEntry,
	ObservedCheck,
	PendingCompletion,
	SensitivityLevel,
	TaintProvenance,
	TaintSource,
	TddCycle,
	WarningRecord,
} from "./types.js";

const SENSITIVITY_LEVELS: ReadonlySet<SensitivityLevel> = new Set([
	"Public",
	"Internal",
	"Confidential",
	"HighlyConfidential",
]);

// ===========================================
// Snapshot hydration helpers
// ===========================================
// Defensive coercion for fields read off `<id>.live.json`. We never trust
// the on-disk shape: a file from an older harness version, a half-written
// snapshot, or a hand-edited file should never crash the daemon — it should
// resolve to the same default `recordEvent` would use for a fresh session.

export function readString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

export function readNumber(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function readBoolean(v: unknown): boolean {
	return v === true;
}

export function readStringSet(v: unknown): Set<string> {
	if (!Array.isArray(v)) return new Set();
	const out = new Set<string>();
	for (const item of v) {
		if (typeof item === "string") out.add(item);
	}
	return out;
}

export function readStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

export function readNumberArray(v: unknown): number[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

export function readStubsIntroduced(
	v: unknown,
): Array<{ file: string; kind: string; snippet: string }> {
	if (!Array.isArray(v)) return [];
	const out: Array<{ file: string; kind: string; snippet: string }> = [];
	for (const e of v) {
		if (!e || typeof e !== "object") continue;
		const r = e as JsonObject;
		if (typeof r.file !== "string" || typeof r.kind !== "string" || typeof r.snippet !== "string") {
			continue;
		}
		out.push({ file: r.file, kind: r.kind, snippet: r.snippet });
	}
	return out;
}

export function readStringMap(v: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!isPlainObject(v)) return out;
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === "string") out.set(k, val);
	}
	return out;
}

export function readNumberMap(v: unknown): Map<string, number> {
	const out = new Map<string, number>();
	if (!isPlainObject(v)) return out;
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === "number" && Number.isFinite(val)) out.set(k, val);
	}
	return out;
}

export function readNumberRecord(v: unknown): Record<number, number> {
	const out: Record<number, number> = {};
	if (!isPlainObject(v)) return out;
	for (const [k, val] of Object.entries(v)) {
		const port = Number.parseInt(k, 10);
		if (Number.isFinite(port) && typeof val === "number" && Number.isFinite(val)) {
			out[port] = val;
		}
	}
	return out;
}

export function readSensitivity(v: unknown): SensitivityLevel {
	if (typeof v === "string" && SENSITIVITY_LEVELS.has(v as SensitivityLevel)) {
		return v as SensitivityLevel;
	}
	return "Public";
}

export function readConsecutivePattern(v: unknown): { pattern: string; count: number } | null {
	if (!isPlainObject(v)) return null;
	const pattern = readString(v.pattern);
	const count = readNumber(v.count, 0);
	return pattern ? { pattern, count } : null;
}

const TAINT_PROVENANCE_VALUES: ReadonlySet<TaintProvenance> = new Set<TaintProvenance>([
	"fetched_external",
	"mcp_remote",
	"document_content",
	"user_provided",
	"local_read",
]);

/** Coerce an unknown to a TaintProvenance, defaulting to "local_read" for
 *  older snapshots (pre-provenance field) and any malformed value. */
function readProvenance(v: unknown): TaintProvenance {
	if (typeof v === "string" && TAINT_PROVENANCE_VALUES.has(v as TaintProvenance)) {
		return v as TaintProvenance;
	}
	return "local_read";
}

export function readTaintSources(v: unknown): TaintSource[] {
	if (!Array.isArray(v)) return [];
	const out: TaintSource[] = [];
	for (const item of v) {
		if (!isPlainObject(item)) continue;
		const file = readString(item.file);
		if (!file) continue;
		out.push({
			file,
			level: readSensitivity(item.level),
			at_step: readNumber(item.at_step, 0),
			provenance: readProvenance(item.provenance),
		});
	}
	return out;
}

export function readFailedFiles(v: unknown): Map<string, FailedFileEntry> {
	const out = new Map<string, FailedFileEntry>();
	if (!isPlainObject(v)) return out;
	for (const [file, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		out.set(file, {
			failure_count: readNumber(raw.failure_count, 0),
			checks: readStringArray(raw.checks),
			recorded_at: readString(raw.recorded_at) ?? new Date().toISOString(),
			tool_call_count: readNumber(raw.tool_call_count, 0),
		});
	}
	return out;
}

export function readPendingCompletions(v: unknown): Map<string, PendingCompletion> {
	const out = new Map<string, PendingCompletion>();
	if (!isPlainObject(v)) return out;
	for (const [key, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const sourceFile = readString(raw.source_file);
		if (!sourceFile) continue;
		out.set(key, {
			source_file: sourceFile,
			affected_files: readStringArray(raw.affected_files),
			resolved_files: readStringSet(raw.resolved_files),
			recorded_at_tool_call: readNumber(raw.recorded_at_tool_call, 0),
			description: readString(raw.description) ?? "",
		});
	}
	return out;
}

export function readWarnings(v: unknown): Map<string, WarningRecord> {
	const out = new Map<string, WarningRecord>();
	if (!isPlainObject(v)) return out;
	for (const [key, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const checkName = readString(raw.check_name);
		if (!checkName) continue;
		out.set(key, {
			check_name: checkName,
			issue_count: readNumber(raw.issue_count, 0),
			first_issued_at: readNumber(raw.first_issued_at, 0),
			last_issued_at: readNumber(raw.last_issued_at, 0),
			resolved: readBoolean(raw.resolved),
		});
	}
	return out;
}

const TDD_STATES = new Set(["no_test", "red", "green", "regression"]);

/** Builds one {@link TddCycle} record from a raw snapshot entry, or returns
 *  `null` when the entry lacks a `source_file` (the caller's drop condition).
 *  Extracted from {@link readTddCycles} to keep that loop body flat. */
function buildTddCycle(raw: Record<string, unknown>): TddCycle | null {
	const sourceFile = readString(raw.source_file);
	if (!sourceFile) return null;
	const stateStr = typeof raw.state === "string" ? raw.state : "no_test";
	const state = (TDD_STATES.has(stateStr) ? stateStr : "no_test") as TddCycle["state"];
	const prevStr = typeof raw.previous_state === "string" ? raw.previous_state : undefined;
	const previous_state =
		prevStr && TDD_STATES.has(prevStr) ? (prevStr as TddCycle["state"]) : undefined;
	return {
		source_file: sourceFile,
		test_file: typeof raw.test_file === "string" ? raw.test_file : null,
		state,
		test_written_at: typeof raw.test_written_at === "number" ? raw.test_written_at : undefined,
		red_at: typeof raw.red_at === "number" ? raw.red_at : undefined,
		green_at: typeof raw.green_at === "number" ? raw.green_at : undefined,
		impl_edits_before_test: readNumber(raw.impl_edits_before_test, 0),
		previous_state,
	};
}

export function readTddCycles(v: unknown): Map<string, TddCycle> {
	const out = new Map<string, TddCycle>();
	if (!isPlainObject(v)) return out;
	for (const [key, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const cycle = buildTddCycle(raw);
		if (cycle) out.set(key, cycle);
	}
	return out;
}

const OBSERVED_CHECK_KINDS = new Set(["typecheck", "build", "lint"]);
const OBSERVED_CHECK_STATUSES = new Set(["red", "green"]);

/** Defensive read of `session.observed_checks`. Mirrors {@link readTddCycles}:
 *  validate the `kind` / `status` enums, coerce the optional step counters,
 *  and drop any entry whose kind/status is unknown. Optional `*_at` / `detail`
 *  fields are omitted (not set to undefined) to respect
 *  exactOptionalPropertyTypes. Returns an empty Map for non-object input so a
 *  snapshot predating this field hydrates cleanly. */
/** Builds one {@link ObservedCheck} record from a raw snapshot entry, or
 *  returns `null` when the entry's kind/status is unknown (the caller's drop
 *  condition). Extracted from {@link readObservedChecks} to keep that loop
 *  body flat. */
function buildObservedCheck(raw: Record<string, unknown>): ObservedCheck | null {
	const kindStr = typeof raw.kind === "string" ? raw.kind : "";
	const statusStr = typeof raw.status === "string" ? raw.status : "";
	if (!OBSERVED_CHECK_KINDS.has(kindStr) || !OBSERVED_CHECK_STATUSES.has(statusStr)) return null;
	const entry: ObservedCheck = {
		kind: kindStr as ObservedCheck["kind"],
		status: statusStr as ObservedCheck["status"],
	};
	if (typeof raw.red_at === "number" && Number.isFinite(raw.red_at)) entry.red_at = raw.red_at;
	if (typeof raw.green_at === "number" && Number.isFinite(raw.green_at)) {
		entry.green_at = raw.green_at;
	}
	const detail = readString(raw.detail);
	if (detail) entry.detail = detail;
	return entry;
}

export function readObservedChecks(v: unknown): Map<string, ObservedCheck> {
	const out = new Map<string, ObservedCheck>();
	if (!isPlainObject(v)) return out;
	for (const [key, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const entry = buildObservedCheck(raw);
		if (entry) out.set(key, entry);
	}
	return out;
}

export function readTestRuns(
	v: unknown,
): Map<string, { status: "pass" | "fail"; at_step: number }> {
	const out = new Map<string, { status: "pass" | "fail"; at_step: number }>();
	if (!isPlainObject(v)) return out;
	for (const [file, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const status = raw.status === "pass" || raw.status === "fail" ? raw.status : null;
		if (!status) continue;
		out.set(file, { status, at_step: readNumber(raw.at_step, 0) });
	}
	return out;
}

export function readAssertionCountsMap(v: unknown): Map<string, AssertionCounts> {
	const out = new Map<string, AssertionCounts>();
	if (!isPlainObject(v)) return out;
	for (const [file, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		out.set(file, {
			blocks: readNumber(raw.blocks, 0),
			assertions: readNumber(raw.assertions, 0),
		});
	}
	return out;
}

export function readGitSessionBaseline(v: unknown):
	| {
			modified: Set<string>;
			staged: Set<string>;
			untracked: Set<string>;
			head_sha: string;
		}
	| undefined {
	if (!isPlainObject(v)) return undefined;
	return {
		head_sha: readString(v.head_sha) ?? "",
		modified: readStringSet(v.modified),
		staged: readStringSet(v.staged),
		untracked: readStringSet(v.untracked),
	};
}

export function readActiveSkills(v: unknown): Map<string, ActiveSkillRecord> | undefined {
	if (!isPlainObject(v)) return undefined;
	const entries = Object.entries(v);
	if (entries.length === 0) return undefined;
	const out = new Map<string, ActiveSkillRecord>();
	for (const [name, raw] of entries) {
		if (!isPlainObject(raw)) continue;
		const recordName = readString(raw.name) ?? name;
		const source = raw.source === "cli" || raw.source === "hook" || raw.source === "manual"
			? raw.source
			: "cli";
		out.set(name, {
			name: recordName,
			entered_at: readNumber(raw.entered_at, 0),
			expires_at: readNumber(raw.expires_at, 0),
			source,
		});
	}
	return out;
}

// Internal to this module — every reader above narrows through it, but no
// external consumer references it (session-state.ts kept it private too).
function isPlainObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

// ===========================================
// Declared-plan serialize / hydrate
// ===========================================
// `session.declared_plan` is the latest `CapturedPlan` produced by
// plan-capture.ts. Round-trip support so a daemon restart doesn't drop
// the most-recent plan — item #6 (plan-drift) reads this field at Stop.

const PLAN_SOURCES: ReadonlySet<PlanSource> = new Set([
	"TaskCreate",
	"ExitPlanMode",
	"structured_userprompt",
]);

const PLAN_STEP_STATUSES: ReadonlySet<PlanStepStatus> = new Set([
	"pending",
	"executed",
	"skipped",
]);

/** Convert a CapturedPlan to a JSON-safe object. The plan shape is
 *  already plain JSON (no Maps, Sets, dates), so this is a deep copy
 *  that documents the shape in one place. */
export function serializeCapturedPlan(plan: CapturedPlan): JsonObject {
	return {
		session_id: plan.session_id,
		agent_name: plan.agent_name,
		created_at_iso: plan.created_at_iso,
		created_at_step: plan.created_at_step,
		source: plan.source,
		steps: plan.steps.map((s) => ({
			intent: s.intent,
			tool_hint: s.tool_hint ?? null,
			target_hint: s.target_hint ?? null,
			status: s.status,
		})),
	};
}

/** Defensive read of the serialized plan. Returns undefined for null,
 *  missing, or malformed shapes so older snapshots (predating this
 *  field) hydrate cleanly. Unknown step statuses default to "pending";
 *  unknown sources default to "TaskCreate" so we never crash. */
/** Builds one {@link PlanStep} from a raw serialized step, or returns `null`
 *  when the step carries no intent (the caller's drop condition). Unknown
 *  statuses default to "pending"; absent hints are omitted (not set to
 *  undefined) to respect exactOptionalPropertyTypes. */
function buildPlanStep(raw: JsonObject): PlanStep | null {
	const intent = readString(raw.intent);
	if (!intent) return null;
	const statusRaw = typeof raw.status === "string" ? raw.status : "pending";
	const status = PLAN_STEP_STATUSES.has(statusRaw as PlanStepStatus)
		? (statusRaw as PlanStepStatus)
		: "pending";
	const step: PlanStep = { intent, status };
	const toolHint = readString(raw.tool_hint);
	if (toolHint) step.tool_hint = toolHint;
	const targetHint = readString(raw.target_hint);
	if (targetHint) step.target_hint = targetHint;
	return step;
}

/** Coerces the serialized `steps` array, dropping non-object and
 *  intent-less entries. Returns an empty array for a missing/malformed field. */
function readPlanSteps(v: unknown): PlanStep[] {
	if (!Array.isArray(v)) return [];
	const steps: PlanStep[] = [];
	for (const raw of v) {
		if (!isPlainObject(raw)) continue;
		const step = buildPlanStep(raw);
		if (step) steps.push(step);
	}
	return steps;
}

export function readCapturedPlan(v: unknown): CapturedPlan | undefined {
	if (!isPlainObject(v)) return undefined;
	const sessionId = readString(v.session_id);
	const agentName = readString(v.agent_name);
	const createdAtIso = readString(v.created_at_iso);
	if (!sessionId || !agentName || !createdAtIso) return undefined;
	const sourceRaw = typeof v.source === "string" ? v.source : "";
	const source = PLAN_SOURCES.has(sourceRaw as PlanSource)
		? (sourceRaw as PlanSource)
		: "TaskCreate";
	return {
		session_id: sessionId,
		agent_name: agentName,
		created_at_iso: createdAtIso,
		created_at_step: readNumber(v.created_at_step, 0),
		source,
		steps: readPlanSteps(v.steps),
	};
}
