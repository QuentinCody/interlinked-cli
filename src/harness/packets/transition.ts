// Instruction packets — the ONE edge table for `calibration` (design §8).
//
// Every change of a packet's calibration status goes through
// `applyPacketTransition`, the way every reservation change goes through
// `reservations-state-machine.ts applyTransition`: the compiler's identity
// reset, `packets calibrate score --apply`'s promotions, cosign grants and
// demotions, and the water-line's "is this before → after pair one legal
// step?" question all read the same rows. Pure; an illegal edge is refused
// with a reason, never guessed. `release` is not calibration and is never
// touched here.
//
//   from              | txn            | to      | conditions
//   any               | compile-reset  | shadow  | always; the birth record (no holdout, no measured_at): a new wording was never measured
//   any               | promote        | warn    | measurement complete: binding to THIS hash, tau in [0, 1], holdout clears PROMOTION
//   warn / cosign     | cosign         | cosign  | promote's conditions, recall ≥ COSIGN_MIN_RECALL, adjudication ≥ COSIGN_MIN_ADJUDICATIONS at ≥ COSIGN_MIN_PRECISION
//   score/warn/cosign | demote         | shadow  | always (tau, binding, adjudication cleared; holdout kept; measured_at now)
//   shadow            | demote         | —       | refused: already shadow
//   shadow / score    | cosign         | —       | refused: warn comes first

import { PROMOTION } from "./calibrate.js";
import type { PacketBinding, PacketCalibration, PacketHoldout } from "./types.js";

/** `cosign` (allow → ask) needs holdout recall at tau and a body of adjudicated shown findings at `warn` first (§8). */
export const COSIGN_MIN_RECALL = 0.7;
export const COSIGN_MIN_ADJUDICATIONS = 200;
export const COSIGN_MIN_PRECISION = 0.8;

/** Exactly what `packets calibrate score --apply` has measured for one packet. */
export interface Measurement {
	binding: PacketBinding;
	tau: number;
	holdout: PacketHoldout;
}

export type DemoteReason =
	| { kind: "recalibration-failed"; reasons: string[] }
	| { kind: "shown-precision"; tp: number; n: number }
	/** The water-line sees the file, not the reason behind a demotion it reconstructs. */
	| { kind: "reconstructed" };

export type PacketTxn =
	| { kind: "compile-reset"; now: string }
	| { kind: "promote"; measurement: Measurement; now: string }
	| { kind: "cosign"; measurement: Measurement; adjudication: { n: number; tp: number }; now: string }
	| { kind: "demote"; reason: DemoteReason; now: string };

export type TransitionResult = { ok: true; calibration: PacketCalibration } | { ok: false; reason: string };

function refuse(reason: string): TransitionResult {
	return { ok: false, reason };
}

/** The first promotion floor the measurement misses, or null when it clears every one. */
function measurementDefect(m: Measurement, packetHash: string): string | null {
	if (m.binding.packet_hash !== packetHash) {
		return `labels were judged under packet_hash ${m.binding.packet_hash.slice(0, 12)}…, the packet is now ${packetHash.slice(0, 12)}…; re-run the shadow after a recompile`;
	}
	if (!(m.tau >= 0 && m.tau <= 1)) return `tau ${m.tau} is not a probability`;
	const h = m.holdout;
	if (h.n < PROMOTION.minN) return `holdout n ${h.n} below ${PROMOTION.minN}`;
	if (h.pos < PROMOTION.minPos) return `holdout positives ${h.pos} below ${PROMOTION.minPos}`;
	if (h.auroc === null || h.auroc < PROMOTION.minAuroc) return `holdout AUROC ${h.auroc ?? "undefined"} below ${PROMOTION.minAuroc}`;
	if (h.precision_at_tau === null || h.precision_at_tau < PROMOTION.minPrecision) return `holdout precision ${h.precision_at_tau ?? "undefined"} below ${PROMOTION.minPrecision}`;
	return null;
}

/** The first cosign prerequisite missing beyond the measurement, or null. */
function cosignDefect(before: PacketCalibration, m: Measurement, a: { n: number; tp: number }): string | null {
	if (before.status !== "warn" && before.status !== "cosign") return `a ${before.status} packet reaches cosign through warn first`;
	const recall = m.holdout.recall_at_tau;
	if (recall === null || recall < COSIGN_MIN_RECALL) return `holdout recall ${recall ?? "undefined"} below ${COSIGN_MIN_RECALL}`;
	if (a.n < COSIGN_MIN_ADJUDICATIONS) return `${a.n} adjudicated shown findings, needs ${COSIGN_MIN_ADJUDICATIONS} at warn first`;
	if (a.tp / a.n < COSIGN_MIN_PRECISION) return `adjudicated precision ${a.tp}/${a.n} below ${COSIGN_MIN_PRECISION}`;
	return null;
}

function measured(status: "warn" | "cosign", m: Measurement, adjudication: { n: number; tp: number } | null, now: string): PacketCalibration {
	return { status, bound_to: { ...m.binding }, tau: m.tau, holdout: { ...m.holdout }, adjudication: adjudication ? { ...adjudication } : null, measured_at: now };
}

function toShadow(before: PacketCalibration, now: string): PacketCalibration {
	return { status: "shadow", bound_to: null, tau: null, holdout: { ...before.holdout }, adjudication: null, measured_at: now };
}

/** A new identity has no measurement: the old holdout measured a different wording, and a reset is not a
 *  measurement, so nothing is kept and nothing is stamped (unlike `demote`, which records when THIS hash failed). */
const BIRTH: PacketCalibration = { status: "shadow", bound_to: null, tau: null, holdout: { n: 0, pos: 0, auroc: null, precision_at_tau: null, recall_at_tau: null }, adjudication: null, measured_at: null };

/** The ONE place the edges are defined. Pure; never mutates `before`. */
export function applyPacketTransition(before: PacketCalibration, txn: PacketTxn, packetHash: string): TransitionResult {
	switch (txn.kind) {
		case "compile-reset":
			return { ok: true, calibration: { ...BIRTH, holdout: { ...BIRTH.holdout } } };
		case "demote":
			if (before.status === "shadow") return refuse("already shadow");
			return { ok: true, calibration: toShadow(before, txn.now) };
		case "promote": {
			const defect = measurementDefect(txn.measurement, packetHash);
			return defect ? refuse(defect) : { ok: true, calibration: measured("warn", txn.measurement, null, txn.now) };
		}
		case "cosign": {
			const defect = measurementDefect(txn.measurement, packetHash) ?? cosignDefect(before, txn.measurement, txn.adjudication);
			return defect ? refuse(defect) : { ok: true, calibration: measured("cosign", txn.measurement, txn.adjudication, txn.now) };
		}
		default: {
			const exhaustive: never = txn;
			return refuse(`unknown transition ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** Canonical field order, so two calibrations compare by content whatever order a file wrote them in. */
function canonical(c: PacketCalibration): string {
	const b = c.bound_to;
	const h = c.holdout;
	return JSON.stringify({
		status: c.status,
		bound_to: b ? { packet_hash: b.packet_hash, renderer: b.renderer, redaction: b.redaction, model: b.model, runner: b.runner } : null,
		tau: c.tau,
		holdout: { n: h.n, pos: h.pos, auroc: h.auroc, precision_at_tau: h.precision_at_tau, recall_at_tau: h.recall_at_tau },
		adjudication: c.adjudication ? { n: c.adjudication.n, tp: c.adjudication.tp } : null,
		measured_at: c.measured_at,
	});
}

/** The measured txn `after` claims to be the result of (its own binding, tau and holdout), or null when it carries none. */
export function claimedMeasuredTxn(after: PacketCalibration): PacketTxn | null {
	if (after.status === "shadow" || after.bound_to === null || after.tau === null || after.measured_at === null) return null;
	const measurement: Measurement = { binding: after.bound_to, tau: after.tau, holdout: after.holdout };
	if (after.status === "cosign") return after.adjudication ? { kind: "cosign", measurement, adjudication: after.adjudication, now: after.measured_at } : null;
	return { kind: "promote", measurement, now: after.measured_at };
}

/** Is `after` reachable from `before` by exactly one sanctioned txn? The txn that reproduces `after`
 *  field for field (measured_at taken from `after`), else null. Used by the water-line. */
export function sanctionedTransition(before: PacketCalibration, after: PacketCalibration, packetHash: string): PacketTxn | null {
	const now = after.measured_at ?? "";
	const claimed = claimedMeasuredTxn(after);
	const candidates: PacketTxn[] = [...(claimed ? [claimed] : []), { kind: "demote", reason: { kind: "reconstructed" }, now }, { kind: "compile-reset", now }];
	const want = canonical(after);
	for (const txn of candidates) {
		const r = applyPacketTransition(before, txn, packetHash);
		if (r.ok && canonical(r.calibration) === want) return txn;
	}
	return null;
}
