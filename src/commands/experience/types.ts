// interlinked-tdd: exempt
// ===========================================
// Experience formats — agent-readable trajectory projections
// ===========================================
// Two formats, one spine (design: docs/design/reproducibility/trace-consumption.md,
// intake: docs/external-pulse/letta-trajectory.md):
//
// - `trajectory-v1` — Letta-compatible interop format (letta-ai/trajectory).
//   Flat, token-efficient records for agents reading past sessions. We EMIT
//   this shape from our own logs; we do not import the package.
// - `trajectory-ix.v1` — our extended format: the same spine plus an `ix`
//   annotation block per record carrying what only the harness capture has
//   (seq ordinal, tool class, outcome, guard verdicts, episode index,
//   verification classification, explicit truncation).
//
// Projection rule: these are VIEWS over timeline/collection/activity logs —
// never a store of their own. Full fidelity stays in replay-trace.v1
// (src/harness/replay/trace-assembler.ts). Distinct from the trajectory
// DETECTOR framework (src/harness/trajectory/) — that watches live sessions;
// this reads finished ones.

import type { ToolClass } from "../../lib/collection/types.js";

// --- Letta-compatible spine (trajectory-v1) ---

export interface ExperienceMetaRecord {
	role: "meta";
	source: string;
	cwd: string | null;
	git_branch: string | null;
	model: string | null;
}

export interface ExperienceUserRecord {
	role: "user";
	content: string;
	timestamp: string;
}

export interface ExperienceReasoningRecord {
	role: "reasoning";
	content: string;
	timestamp: string;
}

interface ExperienceToolCall {
	id: string;
	name: string;
	/** JSON-encoded arguments (string, per the Letta wire example). */
	args: string;
}

export interface ExperienceAssistantRecord {
	role: "assistant";
	content: string | null;
	tool_calls?: ExperienceToolCall[];
	timestamp: string;
}

export interface ExperienceToolResultRecord {
	role: "tool";
	tool_call_id: string;
	content: string;
	timestamp: string;
}

export type ExperienceSpineRecord =
	| ExperienceUserRecord
	| ExperienceReasoningRecord
	| ExperienceAssistantRecord
	| ExperienceToolResultRecord;

export type ExperienceRecord = ExperienceMetaRecord | ExperienceSpineRecord;

// --- ix annotations (trajectory-ix.v1) ---

/** Guard verdict joined from activity.jsonl by tool_use_id. */
export interface IxGuardAnnotation {
	decision: "block" | "warn";
	rule_id: string | null;
	reason: string | null;
}

export interface IxAnnotations {
	/** G3 per-session event ordinal (total ordering; ts collides in parallel). */
	seq?: number;
	tool_class?: ToolClass;
	outcome?: "ok" | "error";
	duration_ms?: number;
	guard?: IxGuardAnnotation;
	/** Path touched, for file-class tools. */
	file?: string;
	/** Shell command classified as a verifier run (test/typecheck/lint/build). */
	is_verification?: boolean;
	/** 0-based episode index; increments at each user record. */
	episode?: number;
	/** Subagent attribution (sidechain turns carry the parent session id). */
	agent_id?: string;
	/** A cap is never silent: original size of a truncated content field. */
	truncated_chars?: number;
}

/** Extended meta: session identity + deterministic corpus counts so a reader
 *  can size the session without opening it. */
export interface IxMetaExtras {
	session_id: string;
	agent_name: string | null;
	records: number;
	episodes: number;
	tool_calls: number;
	guard_blocks: number;
	truncate_chars: number | null;
}

export type IxExperienceRecord =
	| (ExperienceMetaRecord & { schema: "trajectory-ix.v1"; ix_meta: IxMetaExtras })
	| (ExperienceSpineRecord & { ix?: IxAnnotations });

export type ExperienceFormat = "letta" | "ix";

// --- Build output ---

interface ExperienceDiagnostics {
	timeline_records: number;
	collection_joined: number;
	guard_joined: number;
	truncated_records: number;
	/** True when a bounded scan stopped before the file head — the projection
	 *  may be missing the session's OLDEST records. Surfaced, never silent. */
	scan_truncated: boolean;
}

export interface BuiltExperience {
	records: (ExperienceRecord | IxExperienceRecord)[];
	diagnostics: ExperienceDiagnostics;
}
