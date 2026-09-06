// interlinked-tdd: exempt
// ===========================================
// Graph-prediction reconciliation — scoring primitives
// ===========================================
// Pure per-section scorers extracted from graph-prediction-reconcile.ts to
// keep the orchestrator under the per-file line cap. These are leaf helpers:
// they depend only on their own logic, the shared sentinels, and the
// SectionMissDetail type. The orchestrator imports them; they import nothing
// back from it.

import type { SectionMissDetail } from "./graph-prediction-cache.js";

const UNKNOWN_SENTINEL = "unknown" as const;
const TOP_K_RECALL_CAP = 30;

export interface ListSectionScore {
	score: number;
	recall: number;
	precision: number;
	abstained: boolean;
	missDetail: SectionMissDetail | null;
}

function isAbstainedList(value: string[] | typeof UNKNOWN_SENTINEL | null): boolean {
	if (value === null) return true;
	if (value === UNKNOWN_SENTINEL) return true;
	if (Array.isArray(value) && value.includes(UNKNOWN_SENTINEL)) return true;
	return false;
}

function predictedListAsArray(value: string[] | typeof UNKNOWN_SENTINEL | null): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v) => v !== UNKNOWN_SENTINEL);
}

export function scoreListSection(
	predicted: string[] | typeof UNKNOWN_SENTINEL | null,
	oracleSet: string[],
): ListSectionScore {
	const abstained = isAbstainedList(predicted);
	const predFull = predictedListAsArray(predicted);

	if (oracleSet.length === 0 && predFull.length === 0) {
		return { score: 1, recall: 1, precision: 1, abstained, missDetail: null };
	}
	if (oracleSet.length === 0 && predFull.length > 0) {
		return {
			score: 0,
			recall: 1,
			precision: 0,
			abstained,
			missDetail: { over_predicted: predFull },
		};
	}
	if (oracleSet.length > 0 && predFull.length === 0 && !abstained) {
		return {
			score: 0,
			recall: 0,
			precision: 1,
			abstained,
			missDetail: { missed: oracleSet },
		};
	}
	if (oracleSet.length > 0 && predFull.length === 0 && abstained) {
		return {
			score: 0.5,
			recall: 0,
			precision: 0,
			abstained,
			missDetail: { missed: oracleSet },
		};
	}

	const oracleTopK = oracleSet.slice().sort().slice(0, TOP_K_RECALL_CAP);
	const matchRecallSet = new Set(oracleTopK.filter((o) => predFull.includes(o)));
	const matchPrecSet = new Set(predFull.filter((p) => oracleSet.includes(p)));
	// Both denominators are non-zero by construction: the four early-return
	// branches above are exhaustive over every empty-set permutation of
	// (oracleSet, predFull), so both are non-empty here, and
	// `oracleTopK.length > 0` follows from `oracleSet.length > 0` plus slice(0, K).
	const recall = matchRecallSet.size / oracleTopK.length;
	const precision = matchPrecSet.size / predFull.length;
	const baseScore = Math.min(recall, precision);
	const score = abstained ? baseScore * 0.7 : baseScore;
	const missed = oracleSet.filter((o) => !predFull.includes(o));
	const overPredicted = predFull.filter((p) => !oracleSet.includes(p));
	const missDetail =
		missed.length > 0 || overPredicted.length > 0
			? { missed, over_predicted: overPredicted }
			: null;
	return { score, recall, precision, abstained, missDetail };
}

const COUNT_BUCKETS = ["0", "1-3", "4-10", "10+"] as const;

function bucketIndex(n: number): number {
	if (n <= 0) return 0;
	if (n <= 3) return 1;
	if (n <= 10) return 2;
	return 3;
}

export function scoreCount(
	predicted: number | typeof UNKNOWN_SENTINEL,
	oracleValue: number,
): { score: number; missDetail: SectionMissDetail | null } {
	if (predicted === UNKNOWN_SENTINEL) {
		return { score: 0.5, missDetail: { predicted: UNKNOWN_SENTINEL, oracle: oracleValue } };
	}
	if (predicted === oracleValue) return { score: 1.0, missDetail: null };
	const pi = bucketIndex(predicted);
	const oi = bucketIndex(oracleValue);
	const predBucket = COUNT_BUCKETS[pi];
	const oracleBucket = COUNT_BUCKETS[oi];
	if (pi === oi) {
		return {
			score: 0.7,
			missDetail: { predicted: `${predicted} (bucket ${predBucket})`, oracle: `${oracleValue} (bucket ${oracleBucket})` },
		};
	}
	if (Math.abs(pi - oi) === 1) {
		return {
			score: 0.4,
			missDetail: { predicted: `${predicted} (bucket ${predBucket})`, oracle: `${oracleValue} (bucket ${oracleBucket})` },
		};
	}
	return {
		score: 0.0,
		missDetail: { predicted: `${predicted} (bucket ${predBucket})`, oracle: `${oracleValue} (bucket ${oracleBucket})` },
	};
}

export function scoreRisk(
	predicted: "low" | "medium" | "high" | typeof UNKNOWN_SENTINEL,
	oracleRisk: "LOW" | "MEDIUM" | "HIGH",
): { score: number; missDetail: SectionMissDetail | null } {
	if (predicted === UNKNOWN_SENTINEL) {
		return { score: 0.5, missDetail: { predicted: UNKNOWN_SENTINEL, oracle: oracleRisk } };
	}
	const oracleNorm = oracleRisk.toLowerCase();
	if (predicted === oracleNorm) return { score: 1.0, missDetail: null };
	return { score: 0.0, missDetail: { predicted, oracle: oracleRisk } };
}
