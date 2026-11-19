// Instruction packets — strict parser and identity (design §4).
//
// Constructing parser: every field is checked by type and enum, unknown keys
// are refused, every regex must compile, and the structural invariants that
// the water-line relies on hold in ANY file that loads:
//   - a `call` packet runs at pre/post with ≥1 tool; a window-kind packet runs
//     at stop/session_start with no tools and window evidence;
//   - a `where` localizer enumerates the packet's own evidence;
//   - a non-shadow packet carries a binding whose packet_hash is its own;
//   - a release is created only at warn/cosign (release.ts); a demoted packet keeps its release.
// `packet_hash` is sha256 over the canonical JSON of {applies, settle, evidence,
// questions, source.quote}: the parts a promotion is bound to. Calibration and release are
// outside the hash on purpose (they change without re-measuring the question).

import { createHash } from "node:crypto";
import type { JevNoulQuestion } from "../jev/types.js";
import {
	EVIDENCE_KINDS,
	PACKET_FILE_VERSION,
	PACKET_KINDS,
	PACKET_PHASES,
	PACKET_STATUSES,
	PACKET_STRENGTHS,
	type Packet,
	type PacketApplies,
	type PacketBinding,
	type PacketCalibration,
	type PacketFile,
	type PacketQuestions,
	type PacketRelease,
	type PacketSettle,
	type PacketStatus,
	type PacketWhereQuestion,
} from "./types.js";

export type ParseResult = { ok: true; value: PacketFile } | { ok: false; error: string };

/** A packet id. Exported so every reader that renders an id into a line (the lenient fallback) checks it too. */
export const PACKET_ID = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const ID = PACKET_ID;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_REGEX_CHARS = 500;
const WINDOW_KINDS = new Set(["window", "session", "cross-session"]);
const WINDOW_PHASES = new Set(["stop", "session_start"]);
const WINDOW_EVIDENCE = new Set(["window_digest", "window_calls", "final_message"]);

class PacketParseError extends Error {}
function fail(message: string): never {
	throw new PacketParseError(message);
}
function record(value: unknown, where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
	// SAFETY: the guard above proves a non-null, non-array object.
	return value as Record<string, unknown>;
}
function onlyKeys(row: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(row)) if (!allowed.includes(key)) fail(`${where} has unknown key "${key}"`);
}
function str(value: unknown, where: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${where} must be a non-empty string`);
	return value;
}
function strOrNull(value: unknown, where: string): string | null {
	return value === null ? null : str(value, where);
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
	if (!allowed.includes(value as T)) fail(`${where} must be one of ${allowed.join(", ")}`);
	// SAFETY: membership was just checked.
	return value as T;
}
function regexOrNull(value: unknown, where: string): string | null {
	if (value === null) return null;
	const s = str(value, where);
	if (s.length > MAX_REGEX_CHARS) fail(`${where} is longer than ${MAX_REGEX_CHARS} characters`);
	try {
		new RegExp(s);
	} catch (e) {
		fail(`${where} does not compile: ${(e as Error).message}`);
	}
	return s;
}
function stringList(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) fail(`${where} must be a list of non-empty strings`);
	return value;
}
function numOrNull(value: unknown, where: string, min: number, max: number): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${where} must be a number in [${min}, ${max}] or null`);
	return value;
}
function count(value: unknown, where: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(`${where} must be a non-negative integer`);
	return value;
}

function parseNoul(value: unknown, where: string): JevNoulQuestion {
	const row = record(value, where);
	onlyKeys(row, ["type", "instructions", "criteria"], where);
	if (row.type !== "noul") fail(`${where}.type must be "noul"`);
	const criteria = record(row.criteria, `${where}.criteria`);
	onlyKeys(criteria, ["true", "false"], `${where}.criteria`);
	return {
		type: "noul",
		instructions: str(row.instructions, `${where}.instructions`),
		criteria: { true: str(criteria.true, `${where}.criteria.true`), false: str(criteria.false, `${where}.criteria.false`) },
	};
}

function parseWhere(value: unknown, where: string): PacketWhereQuestion | null {
	if (value === null) return null;
	const row = record(value, where);
	onlyKeys(row, ["type", "over", "instructions"], where);
	if (row.type !== "choice") fail(`${where}.type must be "choice"`);
	return { type: "choice", over: oneOf(row.over, ["hunks", "window_calls"] as const, `${where}.over`), instructions: str(row.instructions, `${where}.instructions`) };
}

function parseApplies(value: unknown, where: string): PacketApplies {
	const row = record(value, where);
	onlyKeys(row, ["phase", "tools", "command_regex", "path_regex", "exclude_path_regex", "new_text_regex", "role"], where);
	return {
		phase: oneOf(row.phase, PACKET_PHASES, `${where}.phase`),
		tools: stringList(row.tools, `${where}.tools`),
		command_regex: regexOrNull(row.command_regex, `${where}.command_regex`),
		path_regex: regexOrNull(row.path_regex, `${where}.path_regex`),
		exclude_path_regex: regexOrNull(row.exclude_path_regex, `${where}.exclude_path_regex`),
		new_text_regex: regexOrNull(row.new_text_regex, `${where}.new_text_regex`),
		role: strOrNull(row.role, `${where}.role`),
	};
}

function parseSettle(value: unknown, where: string): PacketSettle {
	const row = record(value, where);
	onlyKeys(row, ["compliant_regex", "violated_regex"], where);
	return { compliant_regex: regexOrNull(row.compliant_regex, `${where}.compliant_regex`), violated_regex: regexOrNull(row.violated_regex, `${where}.violated_regex`) };
}

function parseBinding(value: unknown, where: string): PacketBinding | null {
	if (value === null) return null;
	const row = record(value, where);
	onlyKeys(row, ["packet_hash", "renderer", "redaction", "model", "runner"], where);
	const packet_hash = str(row.packet_hash, `${where}.packet_hash`, true);
	return {
		packet_hash,
		renderer: str(row.renderer, `${where}.renderer`),
		redaction: str(row.redaction, `${where}.redaction`),
		model: str(row.model, `${where}.model`),
		runner: str(row.runner, `${where}.runner`),
	};
}

function parseCalibration(value: unknown, where: string): PacketCalibration {
	const row = record(value, where);
	onlyKeys(row, ["status", "bound_to", "tau", "holdout", "adjudication", "measured_at"], where);
	const holdout = record(row.holdout, `${where}.holdout`);
	onlyKeys(holdout, ["n", "pos", "auroc", "precision_at_tau", "recall_at_tau"], `${where}.holdout`);
	return {
		status: oneOf(row.status, PACKET_STATUSES, `${where}.status`),
		bound_to: parseBinding(row.bound_to, `${where}.bound_to`),
		tau: numOrNull(row.tau, `${where}.tau`, 0, 1),
		holdout: {
			n: count(holdout.n, `${where}.holdout.n`),
			pos: count(holdout.pos, `${where}.holdout.pos`),
			auroc: numOrNull(holdout.auroc, `${where}.holdout.auroc`, 0, 1),
			precision_at_tau: numOrNull(holdout.precision_at_tau, `${where}.holdout.precision_at_tau`, 0, 1),
			recall_at_tau: holdout.recall_at_tau === undefined ? null : numOrNull(holdout.recall_at_tau, `${where}.holdout.recall_at_tau`, 0, 1),
		},
		adjudication: parseAdjudication(row.adjudication, `${where}.adjudication`),
		measured_at: strOrNull(row.measured_at, `${where}.measured_at`),
	};
}

function parseAdjudication(value: unknown, where: string): { n: number; tp: number } | null {
	if (value === undefined || value === null) return null;
	const row = record(value, where);
	onlyKeys(row, ["n", "tp"], where);
	const n = count(row.n, `${where}.n`);
	const tp = count(row.tp, `${where}.tp`);
	if (tp > n) fail(`${where}.tp cannot exceed n`);
	return { n, tp };
}

function parseRelease(value: unknown, where: string): PacketRelease | null {
	if (value === null) return null;
	const row = record(value, where);
	onlyKeys(row, ["text", "released_at", "span_hash"], where);
	const span_hash = str(row.span_hash, `${where}.span_hash`);
	if (!SHA256.test(span_hash)) fail(`${where}.span_hash must be 64 hex characters`);
	return { text: str(row.text, `${where}.text`), released_at: str(row.released_at, `${where}.released_at`), span_hash };
}

function parseSource(value: unknown, where: string): Packet["source"] {
	const row = record(value, where);
	onlyKeys(row, ["file", "span", "quote"], where);
	let span: [number, number] | null = null;
	if (row.span !== null) {
		if (!Array.isArray(row.span) || row.span.length !== 2) fail(`${where}.span must be [start, end] or null`);
		const [a, b] = row.span as unknown[];
		span = [count(a, `${where}.span[0]`), count(b, `${where}.span[1]`)];
		if (span[0] < 1 || span[1] < span[0]) fail(`${where}.span must be a 1-based non-empty range`);
	}
	return { file: str(row.file, `${where}.file`), span, quote: str(row.quote, `${where}.quote`) };
}

function checkInvariants(p: Packet, where: string): void {
	const windowKind = WINDOW_KINDS.has(p.kind);
	if (windowKind) {
		if (!WINDOW_PHASES.has(p.applies.phase)) fail(`${where}.applies.phase must be stop or session_start for a ${p.kind} packet`);
		if (p.applies.tools.length > 0) fail(`${where}.applies.tools must be empty for a ${p.kind} packet`);
		if (!WINDOW_EVIDENCE.has(p.evidence)) fail(`${where}.evidence must be window evidence for a ${p.kind} packet`);
	} else {
		if (WINDOW_PHASES.has(p.applies.phase)) fail(`${where}.applies.phase must be pre or post for a call packet`);
		if (p.applies.tools.length === 0) fail(`${where}.applies.tools must name at least one tool for a call packet`);
	}
	const w = p.questions.where;
	if (w && w.over !== p.evidence) fail(`${where}.questions.where.over (${w.over}) must equal the packet's evidence (${p.evidence})`);
	if (p.calibration.status !== "shadow") {
		if (!p.calibration.bound_to) fail(`${where}.calibration.bound_to is required at status ${p.calibration.status}`);
		if (p.calibration.bound_to.packet_hash !== p.packet_hash) fail(`${where}.calibration.bound_to.packet_hash must equal packet_hash`);
	}
	// A release may be CREATED only at warn/cosign (`release.ts releaseEdit`, and the water-line refuses a
	// tool-written one); a demoted packet keeps its release so the fallback can restore the words (§9).
}

function parsePacket(value: unknown, where: string): Packet {
	const row = record(value, where);
	onlyKeys(row, ["id", "kind", "source", "strength", "applies", "settle", "evidence", "questions", "cosignals", "packet_hash", "calibration", "release"], where);
	const id = str(row.id, `${where}.id`);
	if (!ID.test(id)) fail(`${where}.id must match ${ID}`);
	const questions = record(row.questions, `${where}.questions`);
	onlyKeys(questions, ["violated", "where"], `${where}.questions`);
	const parsedQuestions: PacketQuestions = { violated: parseNoul(questions.violated, `${where}.questions.violated`), where: parseWhere(questions.where, `${where}.questions.where`) };
	const packet: Packet = {
		id,
		kind: oneOf(row.kind, PACKET_KINDS, `${where}.kind`),
		source: parseSource(row.source, `${where}.source`),
		strength: oneOf(row.strength, PACKET_STRENGTHS, `${where}.strength`),
		applies: parseApplies(row.applies, `${where}.applies`),
		settle: parseSettle(row.settle, `${where}.settle`),
		evidence: oneOf(row.evidence, EVIDENCE_KINDS, `${where}.evidence`),
		questions: parsedQuestions,
		cosignals: stringList(row.cosignals, `${where}.cosignals`),
		packet_hash: str(row.packet_hash, `${where}.packet_hash`),
		calibration: parseCalibration(row.calibration, `${where}.calibration`),
		release: parseRelease(row.release, `${where}.release`),
	};
	const expected = packetHash(packet);
	if (packet.packet_hash !== expected) fail(`${where}.packet_hash does not match the packet's content (expected ${expected})`);
	checkInvariants(packet, where);
	return packet;
}

/** Parse the text of `.interlinked/instruction-packets.json`. Never throws. */
export function parsePacketFile(text: string): ParseResult {
	try {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (e) {
			fail(`not JSON: ${(e as Error).message}`);
		}
		const root = record(raw, "file");
		onlyKeys(root, ["version", "compiled_at", "compiler", "sources", "packets", "skipped"], "file");
		if (root.version !== PACKET_FILE_VERSION) fail(`file.version must be ${PACKET_FILE_VERSION}`);
		const compiler = record(root.compiler, "file.compiler");
		onlyKeys(compiler, ["model", "skill"], "file.compiler");
		const sourcesRow = record(root.sources, "file.sources");
		const sources: Record<string, string> = {};
		for (const [k, v] of Object.entries(sourcesRow)) {
			if (typeof v !== "string" || !SHA256.test(v)) fail(`file.sources["${k}"] must be a sha256 hex digest`);
			sources[k] = v;
		}
		if (!Array.isArray(root.packets)) fail("file.packets must be a list");
		const packets = root.packets.map((p, i) => parsePacket(p, `file.packets[${i}]`));
		if (new Set(packets.map((p) => p.id)).size !== packets.length) fail("file.packets ids must be unique");
		if (!Array.isArray(root.skipped)) fail("file.skipped must be a list");
		const skipped = root.skipped.map((s, i) => {
			const row = record(s, `file.skipped[${i}]`);
			onlyKeys(row, ["quote", "reason"], `file.skipped[${i}]`);
			return { quote: str(row.quote, `file.skipped[${i}].quote`), reason: str(row.reason, `file.skipped[${i}].reason`) };
		});
		return {
			ok: true,
			value: {
				version: PACKET_FILE_VERSION,
				compiled_at: str(root.compiled_at, "file.compiled_at"),
				compiler: { model: str(compiler.model, "file.compiler.model"), skill: str(compiler.skill, "file.compiler.skill") },
				sources,
				packets,
				skipped,
			},
		};
	} catch (e) {
		if (e instanceof PacketParseError) return { ok: false, error: e.message };
		throw e;
	}
}

/** Canonical JSON: object keys sorted recursively, arrays in order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const row = value as Record<string, unknown>;
		return `{${Object.keys(row)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(row[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** The identity a promotion binds to: trigger + decider + evidence selector + questions + the
 *  instruction quote (it enters the model's state, so a reworded rule is a new question). */
export function packetHash(packet: Pick<Packet, "applies" | "settle" | "evidence" | "questions"> & { source: Pick<Packet["source"], "quote"> }): string {
	return createHash("sha256")
		.update(canonical({ applies: packet.applies, settle: packet.settle, evidence: packet.evidence, questions: packet.questions, quote: packet.source.quote }))
		.digest("hex");
}

/** The packet with its `packet_hash` recomputed (compiler and tests). */
export function withHash(packet: Packet): Packet {
	return { ...packet, packet_hash: packetHash(packet) };
}

export function statusRank(status: PacketStatus): number {
	return PACKET_STATUSES.indexOf(status);
}
