// Instruction packets — fallback delivery of released text (design §9, R2).
//
// A released packet's instruction left the context window because the hook
// enforces it. Whenever the packet is NOT live for a session, the agent must
// hold the original words again: this module decides "live or not" from the
// same facts the evaluator gates on (packets and Jev enabled, a key, source
// hashes, status ≥ warn, a binding for this runner, delivery support, consent)
// and renders one line per released packet that fails. Leaf module: no
// evaluator import, so the evaluator can use `fallbackLine` for the mid-session
// case (spend cap, outage) without a cycle. The daemon's SessionStart and the
// hook's cold path both call `releasedFallbackLines`.

import { createHash } from "node:crypto";
import type { GuardRulesConfig } from "../types.js";
import { EVIDENCE_REDACTION, EVIDENCE_RENDERER } from "./evidence.js";
import { packetSupport, runnerIdOf } from "./support.js";
import { PACKET_ID, parsePacketFile, statusRank } from "./schema.js";
import type { ConsentKind, Packet, PacketFile } from "./types.js";

export interface LiveContext {
	rules: GuardRulesConfig;
	/** Adapter id (`claude-code`) or the event's legacy `agent_source` (`claude`). */
	runner: string;
	hasKey: boolean;
	/** False when `loadPacketFile` reported a source-hash mismatch. */
	sourcesOk: boolean;
}

/** The consent kind a packet's evidence needs: per-call kinds as themselves, window kinds as `window`. */
function consentKindFor(packet: Packet): ConsentKind {
	return packet.evidence === "window_digest" || packet.evidence === "window_calls" ? "window" : packet.evidence;
}

/** Null when the packet would run live here; otherwise the first reason it would not (one short phrase). */
export function liveGap(packet: Packet, ctx: LiveContext): string | null {
	if (ctx.rules.packets?.enabled !== true) return "packets disabled";
	if (ctx.rules.jev?.enabled !== true) return "jev disabled";
	if (!ctx.hasKey) return "no TypeSafe key";
	if (!ctx.sourcesOk) return "instruction files changed since compile";
	if (statusRank(packet.calibration.status) < statusRank("warn")) return `status ${packet.calibration.status}`;
	const runner = runnerIdOf(ctx.runner);
	const bound = packet.calibration.bound_to;
	if (!bound || bound.packet_hash !== packet.packet_hash) return "calibration binding missing";
	if (bound.runner !== runner) return `calibrated for ${bound.runner}, not ${runner}`;
	// The evaluator judges at `shadow` under any binding mismatch (R39); the model is known only once a call
	// answers, so a model mismatch reaches the fallback through the mid-session path (`collectPacketWarnings`).
	if (bound.renderer !== EVIDENCE_RENDERER || bound.redaction !== EVIDENCE_REDACTION) return `calibrated under ${bound.renderer}/${bound.redaction}, this evaluator renders ${EVIDENCE_RENDERER}/${EVIDENCE_REDACTION}`;
	const support = packetSupport(packet, runner);
	if (!support.supported) return support.reason;
	const kinds = ctx.rules.packets?.evidence_consent?.kinds ?? [];
	if (!kinds.includes(consentKindFor(packet))) return `no consent for ${packet.evidence} evidence`;
	return null;
}

/** A fallback line with the packet it hands back (the delivery ledger keys on the id). */
export interface FallbackEntry {
	id: string;
	line: string;
}

/** The delivered line: tag, gap, then the released text verbatim (it may span lines). */
export function fallbackLineFor(id: string, file: string, text: string, gap: string): string {
	return `[interlinked:packet ${id}] not live here (${gap}); instruction released from ${file}, verbatim:\n${text}`;
}

export function fallbackLine(packet: Packet, gap: string): string {
	return fallbackLineFor(packet.id, packet.source.file, packet.release?.text ?? "", gap);
}

/** One entry per released packet that is not live under `ctx`, or — when `runtimeGap` is set (spend cap reached,
 *  Jev unreachable at the last call) — not live right now; an unreleased packet never prints. */
export function releasedFallbackEntries(file: PacketFile, ctx: LiveContext, runtimeGap: string | null = null): FallbackEntry[] {
	const out: FallbackEntry[] = [];
	for (const packet of file.packets) {
		if (!packet.release) continue;
		const gap = liveGap(packet, ctx) ?? runtimeGap;
		if (gap !== null) out.push({ id: packet.id, line: fallbackLine(packet, gap) });
	}
	return out;
}

export function releasedFallbackLines(file: PacketFile, ctx: LiveContext): string[] {
	return releasedFallbackEntries(file, ctx).map((e) => e.line);
}

const asObject = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A source file name fit to render in a header: no control characters (no newline), no `]`, bounded. */
const SAFE_FILE = /^[^\u0000-\u001f\u007f\]]{1,256}$/;

/** Releases out of a packet file the STRICT parser refuses (a newer CLI's field an older daemon does not know, a
 *  hand edit): a strict refusal disables every packet, so nothing is live and each release must still hand its
 *  words back. Only a release whose text hashes to its own `span_hash` counts, so a damaged entry never injects
 *  arbitrary text. A file that is not JSON at all yields nothing (audit B, schema-invalid file). */
export function lenientReleasedEntries(text: string, gap: string): FallbackEntry[] {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		return [];
	}
	const packets = asObject(root)?.packets;
	if (!Array.isArray(packets)) return [];
	const out: FallbackEntry[] = [];
	for (const raw of packets) {
		const p = asObject(raw);
		const release = asObject(p?.release);
		const file = asObject(p?.source)?.file;
		if (!p || !release || typeof p.id !== "string" || typeof file !== "string" || typeof release.text !== "string") continue;
		// The id and file are rendered INTO the header line: hold them to the schema so a forged entry cannot add a
		// line or a fake header of its own (break R1, P2).
		if (!PACKET_ID.test(p.id) || !SAFE_FILE.test(file)) continue;
		if (createHash("sha256").update(release.text).digest("hex") !== release.span_hash) continue;
		out.push({ id: p.id, line: fallbackLineFor(p.id, file, release.text, `${gap}; the packet file does not parse`) });
	}
	return out;
}

/** Every release in the packet file, all with one gap — the daemon is down, so nothing is live. */
export function allReleasedEntries(text: string, gap: string): FallbackEntry[] {
	const parsed = parsePacketFile(text);
	if (!parsed.ok) return lenientReleasedEntries(text, gap);
	return parsed.value.packets.filter((p) => p.release !== null).map((p) => ({ id: p.id, line: fallbackLine(p, gap) }));
}
