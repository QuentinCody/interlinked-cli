// Instruction packets — the water-line detector (design §3 rule 5, §4).
//
// The agent being judged can write `.interlinked/instruction-packets.json`.
// Promotion (`packets calibrate`) and release (`packets release`) reach the
// file through internal fs writes, never through a tool call, so ANY tool
// write that moves a packet in the loosening direction is gate-gaming:
//   status up, tau down, trigger/question change while live, binding change
//   while live, a release added or its text edited, a released packet or its
//   text removed, a new packet born live. A tool write may still lower a
//   status, raise tau, recompile with the status reset to shadow, add shadow
//   packets, retire unreleased packets, or restore a release.
// Pure functions over file TEXT, called from `detectBaselineGaming`
// (`baseline-integrity-gate.ts`) like every other water-line detector.

import { createHash } from "node:crypto";
import type { BaselineGamingFinding } from "../evaluator/baseline-integrity-gate.js";
import { PROMOTION } from "./calibrate.js";
import { lenientReleasedEntries } from "./fallback.js";
import { locateQuote, pointerLine } from "./release.js";
import { parsePacketFile, statusRank } from "./schema.js";
import { applyPacketTransition, claimedMeasuredTxn, sanctionedTransition } from "./transition.js";
import type { Packet } from "./types.js";

function fmt(file: string, rule: string, before: unknown, after: unknown, message: string): BaselineGamingFinding {
	return { file, rule, before, after, message };
}

function sameBinding(a: Packet["calibration"]["bound_to"], b: Packet["calibration"]["bound_to"]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** A promotion carrying the full measurement `packets calibrate score --apply` writes: binding to this
 *  hash, a tau, a timestamp and a holdout that clears every floor — i.e. the `promote` (or `cosign`, with
 *  recall and the adjudication record, R34) edge of `transition.ts` is legal for the measurement the
 *  calibration carries. This is provenance by content, not by signature: a hand edit that fabricates all
 *  of it passes, and that edit TIGHTENS enforcement on the agent (the gaming direction is loosening), so
 *  the gate accepts it and the ledger shows no judgments behind it. */
export function isMeasuredPromotion(p: Packet): boolean {
	const txn = claimedMeasuredTxn(p.calibration);
	return txn !== null && applyPacketTransition(p.calibration, txn, p.packet_hash).ok;
}

/** Calibration loosenings: status up without measurement, tau down, identity or binding changed while live. */
function compareCalibration(file: string, b: Packet, a: Packet): BaselineGamingFinding[] {
	// One sanctioned edge of the table (a measured promotion or re-measure, a cosign grant, a demotion, a
	// compile reset) reproduces `after` from `before`: nothing to report. Everything else is judged field by field.
	if (sanctionedTransition(b.calibration, a.calibration, a.packet_hash) !== null) return [];
	const out: BaselineGamingFinding[] = [];
	const bs = b.calibration.status;
	const as = a.calibration.status;
	// A complete measured promotion vouches for the whole calibration block: the status, a lowered tau,
	// a recompiled identity and a new binding all came from `packets calibrate score --apply`.
	const live = as !== "shadow" && !isMeasuredPromotion(a);
	if (statusRank(as) > statusRank(bs) && !isMeasuredPromotion(a)) {
		out.push(fmt(file, `status-raised:${a.id}`, bs, as, `packet ${a.id} status raised ${bs} → ${as} without a complete measured promotion (binding to this hash, tau, measured_at, holdout n ≥ ${PROMOTION.minN} / positives ≥ ${PROMOTION.minPos} / AUROC ≥ ${PROMOTION.minAuroc} / precision ≥ ${PROMOTION.minPrecision}); only \`interlinked packets calibrate score --apply\` promotes.`));
	}
	const bt = b.calibration.tau;
	const at = a.calibration.tau;
	if (bt !== null && live && (at === null || at < bt)) {
		out.push(fmt(file, `tau-lowered:${a.id}`, bt, at, `packet ${a.id} tau lowered ${bt} → ${at ?? "null"} while live; a lower threshold shows more findings than the holdout measured.`));
	}
	if (live && a.packet_hash !== b.packet_hash) {
		out.push(fmt(file, `hash-changed-live:${a.id}`, b.packet_hash, a.packet_hash, `packet ${a.id} trigger, evidence or question changed while status is ${as}; recompile resets the status to shadow until re-measured.`));
	}
	if (live && as === bs && !sameBinding(b.calibration.bound_to, a.calibration.bound_to)) {
		out.push(fmt(file, `binding-changed-live:${a.id}`, b.calibration.bound_to, a.calibration.bound_to, `packet ${a.id} calibration binding changed while status is ${as}; a new evaluator starts at shadow.`));
	}
	return out;
}

/** A reader for a packet's instruction file (repo- or home-relative name → text, null when unreadable). */
export type SourceReader = (file: string) => string | null;

/** A release vouched for by content (R43), the way `isMeasuredPromotion` vouches for a calibration: the packet is
 *  measured-live, `release.text` hashes to `span_hash`, and the instruction file on disk is the pointer-bearing
 *  one the set records — it holds the pointer, no longer holds the quote, and hashes to `sources[file]`. A hand
 *  edit that fabricates all of that has done exactly what `packets release` does, and the fallback still
 *  carries the words; the loosening it guards against (text gone, nothing enforcing) cannot pass. */
export function isConsistentRelease(p: Packet, sources: Record<string, string>, readSource: SourceReader | undefined): boolean {
	const r = p.release;
	if (!r || !readSource || !isMeasuredPromotion(p)) return false;
	if (createHash("sha256").update(r.text).digest("hex") !== r.span_hash) return false;
	// The released text must BE the packet's instruction (audit C6): the whole text is one location of the quote.
	const own = locateQuote(r.text, p.source.quote);
	if (!own.ok || own.start !== 0 || own.end !== r.text.length) return false;
	const source = readSource(p.source.file);
	if (source === null || createHash("sha256").update(source).digest("hex") !== sources[p.source.file]) return false;
	// The pointer stands where the words were. A second, wrapped copy of the quote elsewhere is harmless (the
	// words are then in context twice), so it no longer makes a real release look forged (audit D7).
	return source.includes(pointerLine(p.id, p.source.file));
}

/** Who wrote the after-image. `tool`: an agent's Write/Edit — the CLI never writes this file through a tool, so
 *  anything but a demotion of a released packet is a hand edit. `recorded`: a commit or a shell write, which
 *  also carry legitimate `packets calibrate score --apply` recalibrations the content cannot tell apart. */
export type WriteOrigin = "tool" | "recorded";

/** Release loosenings: a release added by a tool write (unless consistent on disk), released text edited, a
 *  released packet's identity changed, or (tool writes) its calibration changed other than by a demotion. */
function compareRelease(file: string, b: Packet, a: Packet, ctx: CompareContext): BaselineGamingFinding[] {
	if (!b.release && a.release && !isConsistentRelease(a, ctx.sources, ctx.readSource)) {
		return [fmt(file, `release-added:${a.id}`, null, a.release.released_at, `packet ${a.id} release added by a tool write; only \`interlinked packets release\` moves instruction text, in one transaction with the source file.`)];
	}
	if (b.release && !a.release && !wordsBack(b, b.release.text, ctx.readSource)) {
		return [fmt(file, `release-removed:${a.id}`, b.release.released_at, null, `packet ${a.id} release cleared while ${b.source.file} does not hold its words again; the words would exist nowhere. Run \`interlinked packets restore ${b.source.file}\`: it puts the words back and clears the release in one transaction.`)];
	}
	if (!b.release || !a.release) return [];
	// span_hash too: restore and the lenient fallback reader both refuse a text that does not match it (break R4 #2).
	if (b.release.text !== a.release.text || b.release.span_hash !== a.release.span_hash) {
		return [fmt(file, `release-text-changed:${a.id}`, b.release.text, a.release.text, `packet ${a.id} released text edited; the fallback must stay the verbatim instruction.`)];
	}
	// No CLI path changes a released packet's identity (compile refuses; restore first), so whatever the
	// calibration claims, a changed trigger/decider/question or source file under a release is a hand edit that
	// can leave the words gone and nothing enforcing them (audit C1, P1).
	if (a.packet_hash !== b.packet_hash || a.source.file !== b.source.file) {
		return [fmt(file, `released-packet-changed:${a.id}`, { hash: b.packet_hash, file: b.source.file }, { hash: a.packet_hash, file: a.source.file }, `packet ${a.id} is released and its trigger, decider, question or source file changed; run \`interlinked packets restore ${b.source.file}\` before changing a released packet.`)];
	}
	if (ctx.origin === "tool" && !isShadowEdge(b, a)) {
		return [fmt(file, `released-calibration-changed:${a.id}`, b.calibration, a.calibration, `packet ${a.id} is released; a tool write may only demote it (the fallback then hands the words back). Recalibration runs through \`interlinked packets calibrate score --apply\`.`)];
	}
	return [];
}

/** A tool write may leave a released packet's calibration unchanged or take a shadow-landing edge of
 *  `transition.ts` (demote, or the compile reset). Any other change is a hand edit, and that includes a
 *  one-step "demotion" that also raises tau (R6 P2). */
function isShadowEdge(b: Packet, a: Packet): boolean {
	if (JSON.stringify(a.calibration) === JSON.stringify(b.calibration)) return true;
	// A shadow packet that stays shadow with the same tau/binding/adjudication/holdout changed only its timestamp (R6 P3).
	if (b.calibration.status === "shadow" && JSON.stringify({ ...a.calibration, measured_at: null }) === JSON.stringify({ ...b.calibration, measured_at: null })) return true;
	const edge = sanctionedTransition(b.calibration, a.calibration, a.packet_hash);
	return edge !== null && (edge.kind === "demote" || edge.kind === "compile-reset");
}

/** True when the instruction file (as the write or commit leaves it) holds the released words again and no longer
 *  the packet's pointer: what `packets restore` leaves. Without a reader nothing vouches, so a cleared release fires
 *  (break R4 #1, P1: a demotion plus `release: null` left the pointer and the words nowhere). */
function wordsBack(p: Packet, text: string, readSource: SourceReader | undefined): boolean {
	const source = readSource?.(p.source.file) ?? null;
	return source !== null && source.includes(text) && !source.includes(pointerLine(p.id, p.source.file));
}

/** Released words an INVALID pre-image still delivered (the lenient fallback reader) that the after-image no longer
 *  carries verbatim (break R4 #3). */
function droppedFromInvalid(file: string, beforeText: string, afterText: string): BaselineGamingFinding[] {
	// Both images go through the SAME lenient reader so the rendered lines share one gap string (R6 P3).
	const kept = new Set(lenientReleasedEntries(afterText, "").map((e) => e.line));
	return lenientReleasedEntries(beforeText, "")
		.filter((e) => !kept.has(e.line))
		.map((e) => fmt(file, `released-packet-dropped:${e.id}`, e.id, undefined, `the packet file did not parse, but it still delivered the released text of ${e.id}; this write drops it. Repair the file with the \`interlinked packets\` commands, never by hand.`));
}

/** R36: a window packet has no tightening path at PreToolUse, so `cosign` on it is never earned. */
function compareWindowCosign(file: string, b: Packet, a: Packet): BaselineGamingFinding[] {
	if (a.kind !== "window" || a.calibration.status !== "cosign" || b.calibration.status === "cosign") return [];
	return [fmt(file, `window-cosign:${a.id}`, b.calibration.status, "cosign", `packet ${a.id} is a window packet; cosign is granted to call packets only (R36).`)];
}

/** C9: a cosign packet asks only while a cosignal names an active rule (§5), so dropping one from a packet that
 *  stays at cosign can silence its asks. Demoting the packet is the sanctioned way out; adding cosignals tightens. */
function compareCosignals(file: string, b: Packet, a: Packet): BaselineGamingFinding[] {
	if (b.calibration.status !== "cosign" || a.calibration.status !== "cosign") return [];
	const dropped = b.cosignals.filter((id) => !a.cosignals.includes(id));
	return dropped.length === 0 ? [] : [fmt(file, `cosignal-dropped:${a.id}`, b.cosignals, a.cosignals, `packet ${a.id} is at cosign; this write drops cosignal(s) ${dropped.join(", ")}, which can leave it unpaired so its asks stop. Demote it with \`interlinked packets calibrate\` instead.`)];
}

interface CompareContext {
	sources: Record<string, string>;
	readSource: SourceReader | undefined;
	origin: WriteOrigin;
}

/** Loosenings between one existing packet and its successor. */
function comparePacket(file: string, b: Packet, a: Packet, ctx: CompareContext): BaselineGamingFinding[] {
	return [...compareCalibration(file, b, a), ...compareRelease(file, b, a, ctx), ...compareWindowCosign(file, b, a), ...compareCosignals(file, b, a)];
}

/** Findings for a write that changes an existing packet file. `readSource` reads an instruction file as the
 *  write (or the commit) leaves it, so a release can be vouched for by content (R43); without it every added
 *  release fires. `origin` decides how much a released packet may change (see `WriteOrigin`). */
export function detectPacketLoosening(file: string, beforeText: string, afterText: string, readSource?: SourceReader, origin: WriteOrigin = "recorded"): BaselineGamingFinding[] {
	const before = parsePacketFile(beforeText);
	const after = parsePacketFile(afterText);
	if (!after.ok) return [fmt(file, "packets-invalid", undefined, after.error, `the written packet file does not parse: ${after.error}; the daemon would disable every packet.`)];
	// A pre-image the strict parser refuses holds no water-line the runtime reads: the write is a creation, so
	// every packet in it must be born at shadow with nothing released (break R1).
	if (!before.ok) return [...droppedFromInvalid(file, beforeText, afterText), ...after.value.packets.flatMap((p) => newPacketDefects(file, p))];
	const out: BaselineGamingFinding[] = [];
	const afterById = new Map(after.value.packets.map((p) => [p.id, p]));
	for (const b of before.value.packets) {
		const a = afterById.get(b.id);
		if (!a) {
			if (b.release) out.push(fmt(file, `released-packet-removed:${b.id}`, b.id, undefined, `packet ${b.id} removed while its instruction text is released; restore the text first (\`interlinked packets restore\`).`));
			continue;
		}
		out.push(...comparePacket(file, b, a, { sources: after.value.sources, readSource, origin }));
	}
	const beforeIds = new Set(before.value.packets.map((p) => p.id));
	for (const a of after.value.packets) {
		if (!beforeIds.has(a.id)) out.push(...newPacketDefects(file, a));
	}
	return out;
}

function newPacketDefects(file: string, a: Packet): BaselineGamingFinding[] {
	if (a.calibration.status === "shadow" && !a.release) return [];
	return [fmt(file, `new-packet-not-shadow:${a.id}`, undefined, a.calibration.status, `packet ${a.id} is new and not at shadow (or carries a release); every packet earns its status on a measured holdout.`)];
}

/** Reasons a tool write may NOT create the packet file with this content (empty = allowed). */
export function packetCreationDefects(afterText: string): string[] {
	const after = parsePacketFile(afterText);
	if (!after.ok) return [`the packet file does not parse: ${after.error}`];
	return after.value.packets.flatMap((p) => newPacketDefects("", p)).map((f) => f.message);
}
