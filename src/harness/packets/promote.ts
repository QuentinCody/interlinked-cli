// Instruction packets — applying a measured promotion to the packet file (design §8, R5).
//
// `packets calibrate score --apply` is the ONLY writer of `calibration` (the
// water-line refuses a tool write that raises a status). A promotion is bound
// to the evaluator that earned it: every judged row the labels came from must
// share one (packet_hash, renderer, redaction, model, runner), and that hash
// must be the packet's CURRENT hash — labels gathered before a recompile do
// not promote the recompiled question. Every calibration change is one
// `applyPacketTransition` edge (`transition.ts`); this module only decides
// WHICH edge each packet is offered. Pure: the caller writes the file.

import { pairedRule } from "./cosign-pairing.js";
import type { CalibrationResult, Label } from "./calibrate.js";
import { judgmentId, type PacketJudgmentRow } from "./evaluator.js";
import { observationAliases } from "./label-sheet.js";
import { applyPacketTransition, type Measurement, type PacketTxn } from "./transition.js";
import type { Packet, PacketBinding, PacketFile } from "./types.js";

export { COSIGN_MIN_ADJUDICATIONS, COSIGN_MIN_PRECISION, COSIGN_MIN_RECALL } from "./transition.js";

export type BindingResult = { ok: true; binding: PacketBinding } | { ok: false; reason: string };

/** What binding needs from a judgment row of either ledger. */
export type BindableRow = Pick<PacketJudgmentRow, "p" | "model" | "packet_hash" | "renderer" | "redaction" | "runner"> & { gate: string | null };

/** The single binding the judged rows share, or the first field that differs. */
export function bindingFromRows(rows: readonly BindableRow[]): BindingResult {
	const judged = rows.filter((r) => r.gate === null && r.p !== null && r.model !== null && r.packet_hash !== null);
	const first = judged[0];
	if (!first || first.model === null || first.packet_hash === null) return { ok: false, reason: "no judged rows to bind to" };
	const binding: PacketBinding = { packet_hash: first.packet_hash, renderer: first.renderer, redaction: first.redaction, model: first.model, runner: first.runner };
	for (const r of judged) {
		for (const key of ["packet_hash", "renderer", "redaction", "model", "runner"] as const) {
			if (r[key] !== binding[key]) return { ok: false, reason: `rows span more than one ${key} (${String(binding[key])} vs ${String(r[key])}); calibrate per evaluator` };
		}
	}
	return { ok: true, binding };
}

export interface ApplyResult {
	file: PacketFile;
	applied: string[];
	/** Live packets moved back to shadow, with why. */
	demoted: { id: string; reason: string }[];
	skipped: { id: string; reason: string }[];
}

/** Adjudicated SHOWN findings per packet over the rolling window: `n` adjudicated, `tp` adjudicated true. */
export type ShownAdjudications = Record<string, { n: number; tp: number }>;

/** The last `window` DISTINCT shown judgments per packet that carry a user verdict (newest by judgment
 *  time; a judgment seen twice counts once), so one verdict cannot be repeated into a demotion and an
 *  old run of true verdicts cannot hide a fresh run of false positives. */
/** The shape both ledgers share for the rolling window: id, judgment time, delivery, packet. */
export interface ShownItem {
	id: string;
	ts: string;
	shown: boolean;
	packet: string;
}

/** One item per row under its OBSERVATION's id (label-sheet.ts `observationAliases`): a cosign call's PreToolUse
 *  and PostToolUse rows are one shown finding, never two (audit C4). */
export function shownItemsOf(rows: readonly PacketJudgmentRow[]): ShownItem[] {
	const aliases = observationAliases(rows);
	return rows.map((r) => {
		const id = judgmentId(r);
		return { id: aliases.get(id) ?? id, ts: r.ts, shown: r.shown, packet: r.packet };
	});
}

export function shownAdjudications(items: readonly ShownItem[], adjudicated: Record<string, Label>, window = DEMOTE_MIN_N): ShownAdjudications {
	const newest = new Map<string, ShownItem>();
	for (const r of items) {
		if (!r.shown) continue;
		const prev = newest.get(r.id);
		if (!prev || prev.ts <= r.ts) newest.set(r.id, r);
	}
	const byPacket = new Map<string, ShownItem[]>();
	for (const r of newest.values()) {
		const label = adjudicated[r.id];
		if (label !== "true" && label !== "false") continue;
		byPacket.set(r.packet, [...(byPacket.get(r.packet) ?? []), r]);
	}
	const out: ShownAdjudications = {};
	for (const [packet, list] of byPacket) {
		const recent = list.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, window);
		out[packet] = { n: recent.length, tp: recent.filter((r) => adjudicated[r.id] === "true").length };
	}
	return out;
}

function belowPrecisionFloor(s: { n: number; tp: number } | undefined): boolean {
	return s !== undefined && s.n >= DEMOTE_MIN_N && s.tp / s.n < DEMOTE_PRECISION;
}

/** Rolling-precision floor for shown findings (§8): below this over ≥ DEMOTE_MIN_N adjudications, the packet is demoted. */
const DEMOTE_PRECISION = 0.6;
const DEMOTE_MIN_N = 30;

export interface ApplyOptions {
	/** Allow warn → cosign when the prerequisites hold; never implied by a plain --apply. */
	cosign?: boolean;
	/** ALL-TIME adjudicated shown findings per packet (the promotion history); the rolling 30 is for demotion only. */
	shownHistory?: ShownAdjudications;
	/** Ids of the rules the guard runs here (`activeRuleIds(loadRules(cwd))`): a cosign grant needs a cosignal among them (§5). */
	activeRules?: ReadonlySet<string>;
}

/** The holdout block the packet file records, from the calibration report's counts. */
function holdoutOf(result: CalibrationResult): Measurement["holdout"] {
	const { tp, flagged } = result.holdout.precision_at_tau;
	const recall = result.holdout.recall_at_tau;
	return { n: result.holdout.n, pos: result.holdout.pos, auroc: result.holdout.auroc, precision_at_tau: flagged === 0 ? null : tp / flagged, recall_at_tau: recall.pos === 0 ? null : recall.tp / recall.pos };
}

/** Pass 1 (R16): every packet below the rolling shown-precision floor is demoted FIRST and remembered, so pass 2
 *  never offers it a promote edge. A packet already at shadow is remembered without a demotion row. */
function demoteByShownPrecision(packets: Packet[], shown: ShownAdjudications, now: string, demoted: ApplyResult["demoted"]): Set<string> {
	const refused = new Set<string>();
	for (const packet of packets) {
		const s = shown[packet.id];
		if (!s || !belowPrecisionFloor(s)) continue;
		refused.add(packet.id);
		const r = applyPacketTransition(packet.calibration, { kind: "demote", reason: { kind: "shown-precision", tp: s.tp, n: s.n }, now }, packet.packet_hash);
		if (!r.ok) continue;
		packet.calibration = r.calibration;
		demoted.push({ id: packet.id, reason: `adjudicated shown-finding precision ${s.tp}/${s.n} below ${DEMOTE_PRECISION}` });
	}
	return refused;
}

/** A failed recalibration demotes a live packet (the edge refuses an already-shadow one, which is then only skipped). */
function demoteByRecalibration(packet: Packet, result: CalibrationResult, now: string, out: ApplyResult): void {
	const reasons = result.decision.reasons.length > 0 ? result.decision.reasons : ["no tau"];
	const r = applyPacketTransition(packet.calibration, { kind: "demote", reason: { kind: "recalibration-failed", reasons }, now }, packet.packet_hash);
	if (r.ok) {
		packet.calibration = r.calibration;
		out.demoted.push({ id: result.packet, reason: `recalibration failed: ${reasons.join("; ")}` });
	} else out.skipped.push({ id: result.packet, reason: reasons.join("; ") });
}

/** The cosign edge for a measured packet, or why none is offered (a window packet never gets one: no tool to tighten). */
function cosignTxn(packet: Packet, measurement: Measurement, history: { n: number; tp: number } | undefined, now: string, active: ReadonlySet<string>): { txn: PacketTxn } | { refused: string } {
	if (packet.kind !== "call") return { refused: `a ${packet.kind} packet has no PreToolUse tightening path (it names no tools); cosign is for call packets` };
	if (pairedRule(packet, active) === null) return { refused: `unpaired: no cosignal names an active rule (cosignals [${packet.cosignals.join(", ")}]); cosign tightens only the allow of a rule the packet names (§5)` };
	return { txn: { kind: "cosign", measurement, adjudication: history ?? { n: 0, tp: 0 }, now } };
}

/** Pass 2 for one promotable result: bind, then offer the cosign edge (on request, or to keep a cosign packet at
 *  cosign) and fall back to the promote edge; the edge table decides, this function reports. */
function promoteOne(packet: Packet, result: CalibrationResult, rows: readonly BindableRow[], tau: number, now: string, options: ApplyOptions, out: ApplyResult): void {
	const bound = bindingFromRows(rows);
	if (!bound.ok) {
		out.skipped.push({ id: result.packet, reason: bound.reason });
		return;
	}
	const measurement: Measurement = { binding: bound.binding, tau, holdout: holdoutOf(result) };
	if (options.cosign || packet.calibration.status === "cosign") {
		const offer = cosignTxn(packet, measurement, options.shownHistory?.[result.packet], now, options.activeRules ?? new Set());
		const r = "txn" in offer ? applyPacketTransition(packet.calibration, offer.txn, packet.packet_hash) : { ok: false as const, reason: offer.refused };
		if (r.ok) {
			packet.calibration = r.calibration;
			out.applied.push(result.packet);
			return;
		}
		out.skipped.push({ id: result.packet, reason: `cosign refused: ${r.reason}` });
	}
	const r = applyPacketTransition(packet.calibration, { kind: "promote", measurement, now }, packet.packet_hash);
	if (!r.ok) {
		out.skipped.push({ id: result.packet, reason: r.reason });
		return;
	}
	packet.calibration = r.calibration;
	out.applied.push(result.packet);
}

/** The packet file with every promoted result applied, failed recalibrations and low shown-precision
 *  packets demoted to shadow, and the rest reported in `skipped`. */
export function applyPromotions(
	file: PacketFile,
	results: readonly CalibrationResult[],
	rowsByPacket: Record<string, readonly BindableRow[]>,
	now: string,
	shown: ShownAdjudications = {},
	options: ApplyOptions = {},
): ApplyResult {
	const packets = file.packets.map((p) => ({ ...p, calibration: { ...p.calibration } }));
	const byId = new Map(packets.map((p) => [p.id, p]));
	const out: ApplyResult = { file: { ...file, packets }, applied: [], demoted: [], skipped: [] };
	const refused = demoteByShownPrecision(packets, shown, now, out.demoted);
	for (const result of results) {
		const packet = byId.get(result.packet);
		if (!packet) {
			out.skipped.push({ id: result.packet, reason: "not in the packet file" });
		} else if (refused.has(result.packet)) {
			// A packet the user has been correcting does not come back on the same pass, whatever the holdout says.
			const s = shown[result.packet];
			out.skipped.push({ id: result.packet, reason: `adjudicated shown-finding precision ${s?.tp}/${s?.n} below ${DEMOTE_PRECISION}; promotion refused` });
		} else if (!result.decision.promote || result.tau === null) {
			demoteByRecalibration(packet, result, now, out);
		} else {
			promoteOne(packet, result, rowsByPacket[result.packet] ?? [], result.tau, now, options, out);
		}
	}
	return out;
}
