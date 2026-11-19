import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CalibrationResult } from "./calibrate.js";
import type { PacketJudgmentRow } from "./evaluator.js";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { applyPromotions } from "./promote.js";
import { applyPacketTransition, type DemoteReason, type Measurement, type PacketTxn, sanctionedTransition } from "./transition.js";
import type { PacketBinding, PacketCalibration, PacketHoldout } from "./types.js";

const NOW = "2026-11-05T21:00:00.000Z";
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const BINDING: PacketBinding = { packet_hash: HASH, renderer: "evidence-v1", redaction: "e20-v3", model: "jev-1.14.0", runner: "claude-code" };
const HOLDOUT: PacketHoldout = { n: 60, pos: 20, auroc: 0.95, precision_at_tau: 0.9, recall_at_tau: 0.75 };
const EMPTY: PacketHoldout = { n: 0, pos: 0, auroc: null, precision_at_tau: null, recall_at_tau: null };
const MEASUREMENT: Measurement = { binding: BINDING, tau: 0.7, holdout: HOLDOUT };
const SHADOW: PacketCalibration = { status: "shadow", bound_to: null, tau: null, holdout: EMPTY, adjudication: null, measured_at: null };
const WARN: PacketCalibration = { status: "warn", bound_to: BINDING, tau: 0.7, holdout: HOLDOUT, adjudication: null, measured_at: "2026-11-05T16:00:00.000Z" };
const COSIGN: PacketCalibration = { ...WARN, status: "cosign", adjudication: { n: 200, tp: 180 } };
const ADJ = { n: 200, tp: 180 };

const promote = (measurement: Measurement = MEASUREMENT): PacketTxn => ({ kind: "promote", measurement, now: NOW });
const cosign = (adjudication = ADJ, measurement: Measurement = MEASUREMENT): PacketTxn => ({ kind: "cosign", measurement, adjudication, now: NOW });
const demote: PacketTxn = { kind: "demote", reason: { kind: "recalibration-failed", reasons: ["holdout has 4 positives, needs 15"] }, now: NOW };
const reset: PacketTxn = { kind: "compile-reset", now: NOW };

function ok(before: PacketCalibration, txn: PacketTxn, hash = HASH): PacketCalibration {
	const r = applyPacketTransition(before, txn, hash);
	if (!r.ok) throw new Error(r.reason);
	return r.calibration;
}
function refused(before: PacketCalibration, txn: PacketTxn, hash = HASH): string {
	const r = applyPacketTransition(before, txn, hash);
	if (r.ok) throw new Error(`expected a refusal, got ${r.calibration.status}`);
	return r.reason;
}

describe("applyPacketTransition — the edge table", () => {
	it("P1: compile-reset from any status → the birth record: shadow, nothing bound, no holdout, no measured_at (a new wording was never measured)", () => {
		for (const before of [SHADOW, { ...SHADOW, status: "score" as const, bound_to: BINDING }, WARN, COSIGN]) {
			expect(ok(before, reset)).toEqual({ status: "shadow", bound_to: null, tau: null, holdout: { n: 0, pos: 0, auroc: null, precision_at_tau: null, recall_at_tau: null }, adjudication: null, measured_at: null });
		}
	});
	it("P2: promote from shadow or score → warn carrying exactly the measurement", () => {
		const expected = { status: "warn", bound_to: BINDING, tau: 0.7, holdout: HOLDOUT, adjudication: null, measured_at: NOW };
		expect(ok(SHADOW, promote())).toEqual(expected);
		expect(ok({ ...WARN, status: "score" }, promote())).toEqual(expected);
	});
	it("P3: promote from warn re-measures (a lowered tau becomes legal this way, R21)", () => {
		const lower = ok(WARN, promote({ ...MEASUREMENT, tau: 0.5 }));
		expect(lower).toEqual(expect.objectContaining({ status: "warn", tau: 0.5, measured_at: NOW }));
	});
	it("P4: promote from cosign without an adjudication steps back to warn and drops the adjudication record", () => {
		expect(ok(COSIGN, promote())).toEqual(expect.objectContaining({ status: "warn", adjudication: null }));
	});
	it("P5: demote from warn or cosign (and score) → shadow, tau and binding cleared, holdout kept", () => {
		for (const before of [WARN, COSIGN, { ...WARN, status: "score" as const }]) {
			expect(ok(before, demote)).toEqual({ status: "shadow", bound_to: null, tau: null, holdout: HOLDOUT, adjudication: null, measured_at: NOW });
		}
		expect(ok(WARN, { kind: "demote", reason: { kind: "shown-precision", tp: 17, n: 30 }, now: NOW }).status).toBe("shadow");
	});
	it("N1: demote from shadow is refused (already shadow)", () => {
		expect(refused(SHADOW, demote)).toContain("already shadow");
	});
	it("P6: cosign from warn (or a re-measured cosign) → cosign carrying the adjudication record", () => {
		const expected = { status: "cosign", bound_to: BINDING, tau: 0.7, holdout: HOLDOUT, adjudication: ADJ, measured_at: NOW };
		expect(ok(WARN, cosign())).toEqual(expected);
		expect(ok(COSIGN, cosign())).toEqual(expected);
	});
	it("N2: cosign from shadow or score is refused (warn comes first)", () => {
		expect(refused(SHADOW, cosign())).toContain("warn first");
		expect(refused({ ...WARN, status: "score" }, cosign())).toContain("warn first");
	});
	it("N3: cosign is refused below holdout recall 0.7 or with a short or imprecise adjudication body", () => {
		expect(refused(WARN, cosign(ADJ, { ...MEASUREMENT, holdout: { ...HOLDOUT, recall_at_tau: 0.5 } }))).toContain("recall");
		expect(refused(WARN, cosign(ADJ, { ...MEASUREMENT, holdout: { ...HOLDOUT, recall_at_tau: null } }))).toContain("recall");
		expect(refused(WARN, cosign({ n: 199, tp: 190 }))).toContain("needs 200");
		expect(refused(WARN, cosign({ n: 200, tp: 150 }))).toContain("precision");
	});
	it("N4: promote is refused when the binding names another hash (labels from before a recompile)", () => {
		expect(refused(SHADOW, promote({ ...MEASUREMENT, binding: { ...BINDING, packet_hash: OTHER } }))).toContain("re-run the shadow after a recompile");
		expect(refused(SHADOW, promote(), OTHER)).toContain("re-run the shadow after a recompile");
	});
	it("N5: promote is refused when the holdout misses any floor or tau is out of range", () => {
		expect(refused(SHADOW, promote({ ...MEASUREMENT, holdout: { ...HOLDOUT, n: 39 } }))).toContain("holdout n");
		expect(refused(SHADOW, promote({ ...MEASUREMENT, holdout: { ...HOLDOUT, pos: 14 } }))).toContain("positives");
		expect(refused(SHADOW, promote({ ...MEASUREMENT, holdout: { ...HOLDOUT, auroc: null } }))).toContain("AUROC");
		expect(refused(SHADOW, promote({ ...MEASUREMENT, holdout: { ...HOLDOUT, auroc: 0.84 } }))).toContain("AUROC");
		expect(refused(SHADOW, promote({ ...MEASUREMENT, holdout: { ...HOLDOUT, precision_at_tau: null } }))).toContain("precision");
		expect(refused(SHADOW, promote({ ...MEASUREMENT, holdout: { ...HOLDOUT, precision_at_tau: 0.79 } }))).toContain("precision");
		expect(refused(SHADOW, promote({ ...MEASUREMENT, tau: 1.5 }))).toContain("tau");
		expect(refused(SHADOW, promote({ ...MEASUREMENT, tau: Number.NaN }))).toContain("tau");
	});
	it("N6: a transition never touches its input", () => {
		const before = structuredClone(WARN);
		ok(before, demote);
		ok(before, reset);
		ok(before, promote());
		expect(before).toEqual(WARN);
	});
});

describe("sanctionedTransition — is `after` one legal step from `before`?", () => {
	it("P7: a measured promotion, a re-measure, a cosign grant, a demotion and a compile reset are each recognised", () => {
		expect(sanctionedTransition(SHADOW, ok(SHADOW, promote()), HASH)?.kind).toBe("promote");
		expect(sanctionedTransition(WARN, ok(WARN, promote({ ...MEASUREMENT, tau: 0.5 })), HASH)?.kind).toBe("promote");
		expect(sanctionedTransition(WARN, ok(WARN, cosign()), HASH)?.kind).toBe("cosign");
		expect(sanctionedTransition(WARN, ok(WARN, demote), HASH)?.kind).toBe("demote");
		// A demotion keeps the failed holdout and stamps when; a compile reset writes the birth record. The file
		// tells them apart, from a live packet and from shadow (where demote is refused) alike.
		expect(sanctionedTransition(WARN, ok(WARN, reset), HASH)?.kind).toBe("compile-reset");
		expect(sanctionedTransition(SHADOW, ok(SHADOW, reset), HASH)?.kind).toBe("compile-reset");
	});
	it("P8: measured_at is taken from `after`, whatever clock wrote it", () => {
		const after = { ...ok(SHADOW, promote()), measured_at: "1999-01-01T00:00:00.000Z" };
		expect(sanctionedTransition(SHADOW, after, HASH)?.kind).toBe("promote");
	});
	it("N7: a hand-written warn with an incomplete holdout, a lowered tau without a measurement, a cosign without recall or adjudication, a score status, or a null measured_at is not sanctioned", () => {
		expect(sanctionedTransition(SHADOW, { ...WARN, holdout: { n: 3, pos: 1, auroc: null, precision_at_tau: null, recall_at_tau: null } }, HASH)).toBeNull();
		expect(sanctionedTransition(WARN, { ...WARN, tau: 0.3, holdout: { ...HOLDOUT, n: 3 } }, HASH)).toBeNull();
		expect(sanctionedTransition(WARN, { ...COSIGN, adjudication: null }, HASH)).toBeNull();
		expect(sanctionedTransition(WARN, { ...COSIGN, holdout: { ...HOLDOUT, recall_at_tau: null } }, HASH)).toBeNull();
		expect(sanctionedTransition(SHADOW, { ...WARN, status: "score" }, HASH)).toBeNull();
		expect(sanctionedTransition(SHADOW, { ...WARN, measured_at: null }, HASH)).toBeNull();
	});
	it("N8: a warn whose binding names another hash is not sanctioned", () => {
		expect(sanctionedTransition(SHADOW, WARN, OTHER)).toBeNull();
	});
});

// --- property tests (fast-check) ---

const holdoutArb: fc.Arbitrary<PacketHoldout> = fc.record({
	n: fc.constantFrom(0, 39, 40, 60),
	pos: fc.constantFrom(0, 14, 15, 20),
	auroc: fc.constantFrom(null, 0.84, 0.85, 0.97),
	precision_at_tau: fc.constantFrom(null, 0.79, 0.8, 0.9),
	recall_at_tau: fc.constantFrom(null, 0.69, 0.7, 0.9),
});
const bindingArb: fc.Arbitrary<PacketBinding> = fc.record({ ...bindingFields(), packet_hash: fc.constantFrom(HASH, OTHER) });
function bindingFields() {
	return { renderer: fc.constant("evidence-v1"), redaction: fc.constant("e20-v3"), model: fc.constantFrom("jev-1.14.0", "jev-2.0.0"), runner: fc.constant("claude-code") };
}
const adjudicationArb = fc.option(fc.record({ n: fc.constantFrom(0, 199, 200, 300), tp: fc.constantFrom(0, 150, 180, 300) }), { nil: null });
const calibrationArb: fc.Arbitrary<PacketCalibration> = fc.record({
	status: fc.constantFrom("shadow", "score", "warn", "cosign"),
	bound_to: fc.option(bindingArb, { nil: null }),
	tau: fc.constantFrom(null, 0.3, 0.7),
	holdout: holdoutArb,
	adjudication: adjudicationArb,
	measured_at: fc.constantFrom(null, NOW, "2026-11-05T16:00:00.000Z"),
});
const measurementArb: fc.Arbitrary<Measurement> = fc.record({ binding: bindingArb, tau: fc.constantFrom(-0.1, 0, 0.5, 1, 1.1), holdout: holdoutArb });
const DEMOTE_REASONS: DemoteReason[] = [{ kind: "recalibration-failed", reasons: [] }, { kind: "shown-precision", tp: 17, n: 30 }];
const txnArb: fc.Arbitrary<PacketTxn> = fc
	.oneof(
		fc.constant(reset),
		fc.record({ kind: fc.constant("promote" as const), measurement: measurementArb, now: fc.constant(NOW) }),
		fc.record({ kind: fc.constant("cosign" as const), measurement: measurementArb, adjudication: fc.record({ n: fc.constantFrom(0, 199, 200), tp: fc.constantFrom(0, 150, 180, 200) }), now: fc.constant(NOW) }),
		fc.record({ kind: fc.constant("demote" as const), reason: fc.constantFrom(...DEMOTE_REASONS), now: fc.constant(NOW) }),
	)
	.map((t): PacketTxn => t);
/** `demote` and `compile-reset` write the same record, so the file cannot tell them apart. */
const resetKinds = new Set<PacketTxn["kind"]>(["demote", "compile-reset"]);

describe("properties", () => {
	it("P9: whenever an apply succeeds, sanctionedTransition recognises its result as the same kind of step", () => {
		fc.assert(
			fc.property(calibrationArb, txnArb, (before, txn) => {
				const r = applyPacketTransition(before, txn, HASH);
				if (!r.ok) return true;
				const found = sanctionedTransition(before, r.calibration, HASH);
				return found !== null && (found.kind === txn.kind || (resetKinds.has(found.kind) && resetKinds.has(txn.kind)));
			}),
			{ numRuns: 400 },
		);
	});
	it("P10: no sequence of sanctioned steps yields a live status with a null tau or binding, nor a cosign without its record", () => {
		fc.assert(
			fc.property(calibrationArb, fc.array(txnArb, { maxLength: 8 }), (start, txns) => {
				let c = start;
				for (const txn of txns) {
					const r = applyPacketTransition(c, txn, HASH);
					if (!r.ok) continue;
					c = r.calibration;
					if (c.status !== "shadow" && (c.tau === null || c.bound_to === null || c.measured_at === null)) return false;
					if (c.status === "cosign" && c.adjudication === null) return false;
				}
				return true;
			}),
			{ numRuns: 400 },
		);
	});
	it("P11: through applyPromotions, a shown-precision demotion and a promotion never both land on one packet in one pass (R16)", () => {
		const file = sampleFile([warnPacket()]);
		const hash = file.packets[0]?.packet_hash ?? "";
		fc.assert(
			fc.property(fc.integer({ min: 30, max: 60 }), fc.integer({ min: 0, max: 60 }), (n, tp) => {
				const shown = { "bounded-log-read": { n, tp: Math.min(tp, n) } };
				const out = applyPromotions(file, [promotable()], { "bounded-log-read": [judged(hash)] }, NOW, shown);
				const demoted = out.demoted.some((d) => d.id === "bounded-log-read");
				const applied = out.applied.includes("bounded-log-read");
				return !(demoted && applied) && (demoted ? out.file.packets[0]?.calibration.status === "shadow" : applied);
			}),
			{ numRuns: 200 },
		);
	});
	it("P12: applyPromotions never writes a calibration the edge table would refuse to reach from the packet it started with", () => {
		const start = sampleFile([samplePacket()]);
		const hash = start.packets[0]?.packet_hash ?? "";
		const out = applyPromotions(start, [promotable()], { "bounded-log-read": [judged(hash)] }, NOW);
		const before = start.packets[0]?.calibration;
		const after = out.file.packets[0]?.calibration;
		if (!before || !after) throw new Error("fixture lost its packet");
		expect(sanctionedTransition(before, after, hash)?.kind).toBe("promote");
	});
});

function promotable(): CalibrationResult {
	return {
		packet: "bounded-log-read",
		labeled: 120,
		gold: 118,
		disagreements: 2,
		kappa: 0.95,
		tau: 0.7,
		tune: { n: 58, pos: 20 },
		holdout: { n: 60, pos: 20, auroc: 0.97, precision_at_tau: { tp: 18, flagged: 20 }, recall_at_tau: { tp: 18, pos: 20 }, brier: 0.05, brier_const: 0.22 },
		decision: { promote: true, reasons: [] },
	};
}
function judged(packet_hash: string): PacketJudgmentRow {
	return {
		ts: NOW, session_id: "s", tool_use_id: "t", seq: 1, runner: "claude-code", tool: "Bash", packet: "bounded-log-read", packet_hash, evidence_hash: "e".repeat(64),
		status: "shadow", status_effective: "shadow", p: 0.5, settled: null, source: "live", eligible: false, shown: false, warning: null, latency_ms: 1, input_tokens: 1, usd: 0, model: "jev-1.14.0", renderer: "evidence-v1", redaction: "e20-v3", gate: null, error: null,
	};
}
