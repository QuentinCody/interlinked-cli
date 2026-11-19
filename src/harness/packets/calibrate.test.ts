import { describe, expect, it } from "vitest";
import { auroc, calibratePacket, goldOf, kappa, type LabeledJudgment, PROMOTION, promotionDecision, splitBySession, tuneTau } from "./calibrate.js";

function item(i: number, p: number, a: "true" | "false" | "unsure", b: "true" | "false" | "unsure" = a, session = `s${i % 8}`): LabeledJudgment {
	return { id: `j${i}`, packet: "pk", session_id: session, p, labels: { A: a, B: b } };
}
/** A well-separated population: positives near 0.9, negatives near 0.1. */
function population(n: number, posEvery = 3): LabeledJudgment[] {
	return Array.from({ length: n }, (_, i) => (i % posEvery === 0 ? item(i, 0.85 + (i % 5) * 0.02, "true") : item(i, 0.05 + (i % 7) * 0.03, "false")));
}

describe("goldOf / kappa / auroc", () => {
	it("P1: gold needs both labelers to agree and neither unsure", () => {
		expect(goldOf(item(1, 0.5, "true", "true"))).toBe(true);
		expect(goldOf(item(1, 0.5, "false", "false"))).toBe(false);
		expect(goldOf(item(1, 0.5, "true", "false"))).toBeNull();
		expect(goldOf(item(1, 0.5, "unsure", "unsure"))).toBeNull();
		expect(goldOf({ ...item(1, 0.5, "true"), labels: { A: "true" } })).toBeNull();
	});
	it("P2: κ is 1 on perfect agreement and null with one labeler", () => {
		expect(kappa([item(1, 0.5, "true"), item(2, 0.5, "false")])).toBe(1);
		expect(kappa([{ ...item(1, 0.5, "true"), labels: { A: "true" } }])).toBeNull();
	});
	it("P3: AUROC is 1 for separated scores, 0.5 for ties, null without both classes", () => {
		expect(auroc([0.9, 0.8], [0.1, 0.2])).toBe(1);
		expect(auroc([0.5], [0.5])).toBe(0.5);
		expect(auroc([], [0.1])).toBeNull();
	});
});

describe("splitBySession", () => {
	it("P4: every session lands wholly on one side, deterministically", () => {
		const items = population(80);
		const { tune, holdout } = splitBySession(items);
		const tuneSessions = new Set(tune.map((i) => i.session_id));
		const holdSessions = new Set(holdout.map((i) => i.session_id));
		expect([...tuneSessions].filter((s) => holdSessions.has(s))).toEqual([]);
		expect(tune.length + holdout.length).toBe(80);
		expect(splitBySession(items).holdout.map((i) => i.id)).toEqual(holdout.map((i) => i.id));
	});
});

describe("tuneTau", () => {
	it("P5: picks the smallest tau whose tune precision reaches the floor", () => {
		const tau = tuneTau(
			[
				{ p: 0.9, y: true },
				{ p: 0.8, y: true },
				{ p: 0.7, y: false },
				{ p: 0.2, y: false },
			],
			0.8,
		);
		expect(tau).toBe(0.8);
	});
	it("N1: returns null when no tau reaches the floor", () => {
		expect(tuneTau([{ p: 0.9, y: false }, { p: 0.5, y: true }], 0.8)).toBeNull();
	});
});

describe("promotionDecision — negative (must not promote)", () => {
	it("N2: too few holdout rows", () => {
		const d = promotionDecision({ n: 10, pos: 5, auroc: 1, precision_at_tau: { tp: 5, flagged: 5 }, recall_at_tau: { tp: 5, pos: 5 }, brier: 0, brier_const: 0.2 }, 0.7);
		expect(d.promote).toBe(false);
		expect(d.reasons.join(" ")).toContain(`${PROMOTION.minN}`);
	});
	it("N3: too few positives, however good the AUROC", () => {
		const d = promotionDecision({ n: 60, pos: 3, auroc: 1, precision_at_tau: { tp: 3, flagged: 3 }, recall_at_tau: { tp: 3, pos: 3 }, brier: 0, brier_const: 0.05 }, 0.7);
		expect(d.promote).toBe(false);
		expect(d.reasons.join(" ")).toContain(`${PROMOTION.minPos}`);
	});
	it("N4: no tau (tune precision never reached the floor)", () => {
		const d = promotionDecision({ n: 60, pos: 20, auroc: 0.9, precision_at_tau: { tp: 0, flagged: 0 }, recall_at_tau: { tp: 0, pos: 20 }, brier: 0.1, brier_const: 0.2 }, null);
		expect(d.promote).toBe(false);
	});
	it("N5: holdout precision under the floor", () => {
		const d = promotionDecision({ n: 60, pos: 20, auroc: 0.9, precision_at_tau: { tp: 10, flagged: 20 }, recall_at_tau: { tp: 10, pos: 20 }, brier: 0.1, brier_const: 0.2 }, 0.7);
		expect(d.promote).toBe(false);
	});
});

describe("calibratePacket — end to end", () => {
	it("P6: a large, well-separated, agreed population promotes with a tau and a holdout report", () => {
		const r = calibratePacket(population(240));
		expect(r.kappa).toBe(1);
		expect(r.tau).not.toBeNull();
		expect(r.holdout.n).toBeGreaterThanOrEqual(PROMOTION.minN);
		expect(r.holdout.pos).toBeGreaterThanOrEqual(PROMOTION.minPos);
		expect(r.holdout.auroc).toBe(1);
		expect(r.decision.promote).toBe(true);
	});
	it("N6: the trial-sized population (10 positives in 39 gold rows) does not promote", () => {
		const r = calibratePacket(population(39, 4));
		expect(r.decision.promote).toBe(false);
	});
	it("N7: disagreements are excluded from gold but counted", () => {
		const items = [...population(120), item(999, 0.5, "true", "false")];
		const r = calibratePacket(items);
		expect(r.disagreements).toBe(1);
		expect(r.gold).toBe(120);
	});
});
