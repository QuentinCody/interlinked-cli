// Instruction packets — calibration math and the promotion rule (design §8, R4).
//
// Pure. Gold = two independent labelers agree and neither is unsure. The
// population is split by SESSION (a hash of the session id, so near-duplicate
// commands from one session never straddle the split); tau is tuned on one
// half and every reported number comes from the other half alone. Promotion
// needs holdout support (n, positives), ranking (AUROC) and precision at tau;
// a packet with no positives has no AUROC and can only show its false-flag
// rate, so it never promotes. The builder's own read is never a label.

import { createHash } from "node:crypto";

export type Label = "true" | "false" | "unsure";

export interface LabeledJudgment {
	id: string;
	packet: string;
	session_id: string;
	p: number;
	/** labeler name → label; two labelers are required for gold. */
	labels: Record<string, Label>;
	/** Evaluator cohort (model|runner|renderer|redaction); scoring and binding use ONE cohort. */
	cohort?: string;
}

export interface HoldoutReport {
	n: number;
	pos: number;
	auroc: number | null;
	precision_at_tau: { tp: number; flagged: number };
	recall_at_tau: { tp: number; pos: number };
	brier: number | null;
	brier_const: number | null;
}

export interface PromotionDecision {
	promote: boolean;
	reasons: string[];
}

export interface CalibrationResult {
	packet: string;
	labeled: number;
	gold: number;
	disagreements: number;
	kappa: number | null;
	tau: number | null;
	tune: { n: number; pos: number };
	holdout: HoldoutReport;
	decision: PromotionDecision;
}

/** The floors a packet must clear on its holdout to move to `warn` (§8). */
export const PROMOTION = { minN: 40, minPos: 15, minAuroc: 0.85, minPrecision: 0.8 } as const;

interface Scored {
	p: number;
	y: boolean;
}

/** true/false when both labelers agree and neither is unsure; null otherwise (or with fewer than two labels). */
export function goldOf(item: LabeledJudgment): boolean | null {
	const labels = Object.values(item.labels);
	if (labels.length < 2) return null;
	const first = labels[0];
	if (first === "unsure" || labels.some((l) => l !== first)) return null;
	return first === "true";
}

/** Cohen's κ over the first two labelers; null when fewer than two labels exist on every item. */
export function kappa(items: readonly LabeledJudgment[]): number | null {
	const pairs = items.map((i) => Object.values(i.labels)).filter((l): l is [Label, Label] => l.length >= 2).map((l) => [l[0], l[1]] as const);
	const n = pairs.length;
	if (n === 0) return null;
	const cats: Label[] = ["true", "false", "unsure"];
	let agree = 0;
	const ma: Record<string, number> = {};
	const mb: Record<string, number> = {};
	for (const [a, b] of pairs) {
		if (a === b) agree++;
		ma[a] = (ma[a] ?? 0) + 1;
		mb[b] = (mb[b] ?? 0) + 1;
	}
	const po = agree / n;
	let pe = 0;
	for (const c of cats) pe += ((ma[c] ?? 0) / n) * ((mb[c] ?? 0) / n);
	return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** Probability a random positive outranks a random negative; null without both classes. */
export function auroc(pos: readonly number[], neg: readonly number[]): number | null {
	if (pos.length === 0 || neg.length === 0) return null;
	let s = 0;
	for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
	return s / (pos.length * neg.length);
}

/** Deterministic half split by session id: sessions whose hash is even tune, odd hold out. */
export function splitBySession<T extends { session_id: string }>(items: readonly T[]): { tune: T[]; holdout: T[] } {
	const tune: T[] = [];
	const holdout: T[] = [];
	for (const item of items) {
		const byte = createHash("sha256").update(item.session_id).digest()[0] ?? 0;
		(byte % 2 === 0 ? tune : holdout).push(item);
	}
	return { tune, holdout };
}

/** Among observed p values whose tune precision reaches `floor`, the one with the best F1
 *  (ties → the higher tau, the conservative side); null when none reaches the floor. */
export function tuneTau(tune: readonly Scored[], floor: number): number | null {
	const positives = tune.filter((t) => t.y).length;
	let best: { tau: number; f1: number } | null = null;
	for (const tau of new Set(tune.map((t) => t.p))) {
		const flagged = tune.filter((t) => t.p >= tau);
		const tp = flagged.filter((t) => t.y).length;
		if (flagged.length === 0 || tp / flagged.length < floor) continue;
		const precision = tp / flagged.length;
		const recall = positives === 0 ? 0 : tp / positives;
		const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
		if (best === null || f1 > best.f1 || (f1 === best.f1 && tau > best.tau)) best = { tau, f1 };
	}
	return best?.tau ?? null;
}

function evaluateHoldout(holdout: readonly Scored[], tau: number | null): HoldoutReport {
	const pos = holdout.filter((h) => h.y);
	const neg = holdout.filter((h) => !h.y);
	const flagged = tau === null ? [] : holdout.filter((h) => h.p >= tau);
	const tp = flagged.filter((h) => h.y).length;
	const prevalence = holdout.length ? pos.length / holdout.length : 0;
	const brier = holdout.length ? holdout.reduce((s, h) => s + (h.p - (h.y ? 1 : 0)) ** 2, 0) / holdout.length : null;
	const brierConst = holdout.length ? holdout.reduce((s, h) => s + (prevalence - (h.y ? 1 : 0)) ** 2, 0) / holdout.length : null;
	return {
		n: holdout.length,
		pos: pos.length,
		auroc: auroc(pos.map((h) => h.p), neg.map((h) => h.p)),
		precision_at_tau: { tp, flagged: flagged.length },
		recall_at_tau: { tp, pos: pos.length },
		brier,
		brier_const: brierConst,
	};
}

export function promotionDecision(report: HoldoutReport, tau: number | null): PromotionDecision {
	const reasons: string[] = [];
	if (report.n < PROMOTION.minN) reasons.push(`holdout has ${report.n} gold rows, needs ${PROMOTION.minN}`);
	if (report.pos < PROMOTION.minPos) reasons.push(`holdout has ${report.pos} positives, needs ${PROMOTION.minPos}`);
	if (tau === null) reasons.push(`no tau reached precision ${PROMOTION.minPrecision} on the tune half`);
	if (report.auroc === null || report.auroc < PROMOTION.minAuroc) reasons.push(`holdout AUROC ${report.auroc === null ? "undefined" : report.auroc.toFixed(2)}, needs ${PROMOTION.minAuroc}`);
	const { tp, flagged } = report.precision_at_tau;
	if (flagged === 0 || tp / flagged < PROMOTION.minPrecision) reasons.push(`holdout precision ${tp}/${flagged}, needs ${PROMOTION.minPrecision}`);
	return { promote: reasons.length === 0, reasons };
}

/** Calibrate one packet's labeled judgments: κ, session-split tau, holdout report, promotion decision. */
export function calibratePacket(items: readonly LabeledJudgment[]): CalibrationResult {
	const packet = items[0]?.packet ?? "";
	let disagreements = 0;
	const gold: (Scored & { session_id: string })[] = [];
	for (const item of items) {
		const y = goldOf(item);
		if (y === null) {
			if (Object.values(item.labels).length >= 2 && !Object.values(item.labels).includes("unsure")) disagreements++;
			continue;
		}
		gold.push({ p: item.p, y, session_id: item.session_id });
	}
	const { tune, holdout } = splitBySession(gold);
	const tau = tuneTau(tune, PROMOTION.minPrecision);
	const report = evaluateHoldout(holdout, tau);
	return {
		packet,
		labeled: items.length,
		gold: gold.length,
		disagreements,
		kappa: kappa(items),
		tau,
		tune: { n: tune.length, pos: tune.filter((t) => t.y).length },
		holdout: report,
		decision: promotionDecision(report, tau),
	};
}
