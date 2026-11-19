// interlinked-tdd: exempt
// Instruction packets — types only (docs/design/instruction-jev-evaluator.md §4).
//
// A packet is one non-deterministic imperative from an instruction file,
// compiled once by a large model into: a deterministic applicability trigger,
// an evidence selector, and typed Jev questions. The daemon evaluates packets
// without generating text. The packet file is a water-line
// (`evaluator/baseline-integrity-gate.ts`): status, tau, triggers and released
// text may not be loosened by a tool write.

import type { JevNoulQuestion } from "../jev/types.js";

export const PACKET_FILE_BASENAME = "instruction-packets.json";
export const PACKET_FILE_VERSION = 1;

export const PACKET_KINDS = ["call", "window", "session", "cross-session"] as const;
export type PacketKind = (typeof PACKET_KINDS)[number];

export const PACKET_PHASES = ["pre", "post", "stop", "session_start"] as const;
export type PacketPhase = (typeof PACKET_PHASES)[number];

export const EVIDENCE_KINDS = ["command", "hunks", "file", "final_message", "window_digest", "window_calls"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** What an operator may consent to send as derived evidence: a per-call evidence kind, or the window's
 *  call list (`window`) and the turn's prompt text (`prompts`) for the trajectory layer. */
export type ConsentKind = EvidenceKind | "window" | "prompts";

/** Ordered: a later status unlocks more (§8). */
export const PACKET_STATUSES = ["shadow", "score", "warn", "cosign"] as const;
export type PacketStatus = (typeof PACKET_STATUSES)[number];

/** The /enforce lexical ladder values a packet may carry. */
export const PACKET_STRENGTHS = ["never", "must-not", "must", "always", "should", "should-not", "prefer", "avoid"] as const;
export type PacketStrength = (typeof PACKET_STRENGTHS)[number];

export interface PacketSource {
	file: string;
	/** 1-based inclusive line span in the source file, or null when unknown. */
	span: [number, number] | null;
	quote: string;
}

/** Deterministic trigger; every non-null member must hold. */
export interface PacketApplies {
	phase: PacketPhase;
	tools: string[];
	command_regex: string | null;
	path_regex: string | null;
	exclude_path_regex: string | null;
	new_text_regex: string | null;
	role: string | null;
}

export interface PacketWhereQuestion {
	type: "choice";
	over: "hunks" | "window_calls";
	instructions: string;
}

export interface PacketQuestions {
	violated: JevNoulQuestion;
	where: PacketWhereQuestion | null;
}

/** Everything a promotion is bound to (§8, R5). */
export interface PacketBinding {
	packet_hash: string;
	renderer: string;
	redaction: string;
	/** The RESOLVED model id from a response, never an alias. */
	model: string;
	runner: string;
}

export interface PacketHoldout {
	n: number;
	pos: number;
	auroc: number | null;
	precision_at_tau: number | null;
	/** Holdout recall at tau; `cosign` needs it (a tightening that rarely fires is a weak one). Absent in older files. */
	recall_at_tau: number | null;
}

export interface PacketCalibration {
	status: PacketStatus;
	bound_to: PacketBinding | null;
	tau: number | null;
	holdout: PacketHoldout;
	/** Adjudicated SHOWN findings at warn (all time) behind a cosign grant: `n` adjudicated, `tp` true. Absent in older files. */
	adjudication: { n: number; tp: number } | null;
	measured_at: string | null;
}

/** A span released from the source file; the verbatim text is the fallback (§9, R2). */
export interface PacketRelease {
	text: string;
	released_at: string;
	span_hash: string;
}

/** Deterministic decider, applied to the rendered evidence BEFORE any model call (design §4):
 *  `compliant_regex` settles the event as compliant, `violated_regex` as violated; only an
 *  event neither settles reaches Jev. The model is for the residue a regex cannot decide. */
export interface PacketSettle {
	compliant_regex: string | null;
	violated_regex: string | null;
}

export interface Packet {
	id: string;
	kind: PacketKind;
	source: PacketSource;
	strength: PacketStrength;
	applies: PacketApplies;
	/** Deterministic decider; `{null, null}` sends every triggered event to the model. */
	settle: PacketSettle;
	evidence: EvidenceKind;
	questions: PacketQuestions;
	/** Deterministic rule ids whose ALLOW this packet may tighten to ASK at `cosign`. */
	cosignals: string[];
	/** sha256 over the canonical JSON of {applies, settle, evidence, questions}. */
	packet_hash: string;
	calibration: PacketCalibration;
	release: PacketRelease | null;
}

export interface PacketSkipped {
	quote: string;
	reason: string;
}

export interface PacketFile {
	version: typeof PACKET_FILE_VERSION;
	compiled_at: string;
	compiler: { model: string; skill: string };
	/** source file → sha256 of its content at compile time. */
	sources: Record<string, string>;
	packets: Packet[];
	skipped: PacketSkipped[];
}

/** The `packets` section of guard-rules(.local).json — DEFAULT OFF, local-only (design §6). */
export interface PacketsConfig {
	/** Master switch; `jev.enabled` must also be true. */
	enabled?: boolean;
	/** Explicit consent for DERIVED evidence by kind and repo-relative path glob; absent ⇒ nothing is sent. */
	evidence_consent?: { kinds?: ConsentKind[]; paths?: string[] };
	/** Per-daemon spend ceiling (USD). Default 0.25. */
	max_spend_usd?: number;
	/** Per-call deadline. Default 1500 ms. */
	timeout_ms?: number;
	/** Share of windows (turn/session) that run pass 2 for every window packet whatever pass 1 said, so screening recall is measured. Default 0.1. */
	screen_sample?: number;
	/** Newest megabytes of each local log a Stop/SessionEnd window reads. Default 32. */
	window_tail_mb?: number;
}
