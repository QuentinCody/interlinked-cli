// Instruction packets — the deterministic half of the compiler (design §5).
//
// The large model writes a DRAFT (packets without hashes, calibration or
// release; `sources` as a list of file names). This module turns it into the
// strict file: hashes every packet, hashes every source file as it is on disk
// NOW, forces calibration to shadow and release to null — then carries over
// the EXISTING file's calibration and release for any packet whose identity
// (`packet_hash`) is unchanged. A changed packet drops to shadow with a note.
// A packet that is RELEASED (its text has left the source file) can neither
// change nor disappear here: that would leave the rule with no guidance and
// no enforcement (R2); `packets restore` must put the text back first.
// Pure: file reads are injected.

import { createHash } from "node:crypto";
import { packetHash, parsePacketFile } from "./schema.js";
import { applyPacketTransition } from "./transition.js";
import { PACKET_FILE_VERSION, type PacketCalibration, type PacketFile } from "./types.js";

export interface CompileDeps {
	now: string;
	/** Content of a source file relative to the project root, or null when unreadable. */
	readSource: (file: string) => string | null;
}

export type CompileResult = { ok: true; file: PacketFile; notes: string[] } | { ok: false; error: string };

const SHADOW: PacketCalibration = { status: "shadow", bound_to: null, tau: null, holdout: { n: 0, pos: 0, auroc: null, precision_at_tau: null, recall_at_tau: null }, adjudication: null, measured_at: null };

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Fill the fields a draft may omit; everything else is validated by the strict parser afterwards. */
function normalizeDraftPacket(raw: unknown): Record<string, unknown> {
	const row = asRecord(raw) ?? {};
	const source = asRecord(row.source) ?? {};
	const questions = asRecord(row.questions) ?? {};
	const normalized: Record<string, unknown> = {
		...row,
		source: { span: null, ...source },
		questions: { where: null, ...questions },
		settle: row.settle ?? { compliant_regex: null, violated_regex: null },
		cosignals: row.cosignals ?? [],
		calibration: SHADOW,
		release: null,
	};
	// Hash over whatever the draft holds; the strict parser then validates the shape and re-checks the hash.
	const forHash = { applies: normalized.applies, settle: normalized.settle, evidence: normalized.evidence, questions: normalized.questions, source: normalized.source } as Parameters<typeof packetHash>[0];
	normalized.packet_hash = packetHash(forHash);
	return normalized;
}

function sourceDigests(sources: unknown, readSource: CompileDeps["readSource"]): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
	const names = Array.isArray(sources) ? sources : Object.keys(asRecord(sources) ?? {});
	const out: Record<string, string> = {};
	for (const name of names) {
		if (typeof name !== "string" || !name) return { ok: false, error: "sources must name files" };
		const content = readSource(name);
		if (content === null) return { ok: false, error: `source file ${name} cannot be read` };
		out[name] = createHash("sha256").update(content).digest("hex");
	}
	return { ok: true, value: out };
}

/** Carry calibration/release over from the existing file; refuse a changed or dropped released packet. */
function carryOver(fresh: PacketFile, existing: PacketFile | null, notes: string[], now: string): string | null {
	if (!existing) return null;
	const freshById = new Map(fresh.packets.map((p) => [p.id, p]));
	for (const old of existing.packets) {
		const next = freshById.get(old.id);
		const unchanged = next !== undefined && next.packet_hash === old.packet_hash;
		// The hash leaves `source.file` out, so a released packet must also stay in its file: its release, pointer
		// and restore all name that file (audit C5).
		if (old.release && (!unchanged || next?.source.file !== old.source.file)) {
			return `packet ${old.id} is released (its text left ${old.source.file}) and the draft ${next ? "changes" : "drops"} it; run \`interlinked packets restore ${old.source.file}\` first`;
		}
		if (!next) continue;
		if (unchanged) {
			next.calibration = old.calibration;
			next.release = old.release;
			continue;
		}
		// A changed identity is the `compile-reset` edge of the ONE table (`transition.ts`): shadow, measurement cleared.
		const reset = applyPacketTransition(old.calibration, { kind: "compile-reset", now }, next.packet_hash);
		if (reset.ok) next.calibration = reset.calibration;
		if (old.calibration.status !== "shadow") notes.push(`${old.id}: identity changed; status ${old.calibration.status} → shadow until re-measured`);
	}
	return null;
}

export function compilePacketFile(draftText: string, existingText: string | null, deps: CompileDeps): CompileResult {
	let raw: unknown;
	try {
		raw = JSON.parse(draftText);
	} catch (e) {
		return { ok: false, error: `draft is not JSON: ${(e as Error).message}` };
	}
	const root = asRecord(raw);
	if (!root) return { ok: false, error: "draft must be an object" };
	const digests = sourceDigests(root.sources, deps.readSource);
	if (!digests.ok) return digests;
	const packets = Array.isArray(root.packets) ? root.packets.map(normalizeDraftPacket) : [];
	const candidate = {
		version: PACKET_FILE_VERSION,
		compiled_at: deps.now,
		compiler: root.compiler ?? { model: "unknown", skill: "unknown" },
		sources: digests.value,
		packets,
		skipped: root.skipped ?? [],
	};
	const parsed = parsePacketFile(JSON.stringify(candidate));
	if (!parsed.ok) return { ok: false, error: `draft: ${parsed.error}` };
	let existing: PacketFile | null = null;
	if (existingText !== null) {
		const e = parsePacketFile(existingText);
		if (!e.ok) return { ok: false, error: `existing packet file does not parse (${e.error}); fix or remove it before recompiling` };
		existing = e.value;
	}
	const notes: string[] = [];
	const refused = carryOver(parsed.value, existing, notes, deps.now);
	if (refused) return { ok: false, error: refused };
	// The carried-over calibration may bind to this hash; re-run the strict parser so the result is exactly what a reader sees.
	const final = parsePacketFile(JSON.stringify(parsed.value));
	if (!final.ok) return { ok: false, error: `carry-over produced an invalid file: ${final.error}` };
	return { ok: true, file: final.value, notes };
}
