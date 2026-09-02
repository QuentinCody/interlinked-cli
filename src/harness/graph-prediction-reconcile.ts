// ===========================================
// Graph-prediction reconciliation
// ===========================================
// Compares an agent-emitted graph_prediction against the authoritative
// Supermodel shard. Per the v1.2 reviewer's call:
//
//   - Aggregate `weighted_avg` is TELEMETRY ONLY. It is logged for
//     "files where the agent's overall awareness is consistently low"
//     analysis. It does NOT drive any decision.
//
//   - Load-bearing decisions come from explicit severity predicates:
//       1. risk underestimated (low→high or medium→high)
//       2. predicted direct ≤ 3 AND oracle direct ≥ 10 (off by >1 bucket)
//       3. imported_by recall < 0.3 AND oracle has ≥ 5 importers
//       4. callers recall < 0.3 AND oracle has ≥ 5 callers
//       5. domains recall < 0.5 AND oracle has ≥ 3 domains
//
//   - Full abstention (every section is `unknown`) gets its own severity
//     class. When the oracle reports high impact (HIGH risk OR direct ≥ 10
//     OR transitive ≥ 50), full abstention requires acknowledgment.
//
// Bucket-tolerance scoring on counts (§7.2): exact 1.0, same-bucket 0.7,
// adjacent 0.4, off-by-more 0.0, abstention 0.5.

import type {
	DiffMissSet,
	PerSectionScore,
	SectionMissDetail,
} from "./graph-prediction-cache.js";
import type { ParsedGraphPrediction } from "./graph-prediction-parser.js";
import {
	type ListSectionScore,
	scoreCount,
	scoreListSection,
	scoreRisk,
} from "./graph-prediction-reconcile-scoring.js";
import type { SupermodelGraph } from "./supermodel-graph.js";

const UNKNOWN_SENTINEL = "unknown" as const;
const FULL_ABSTENTION = "full_abstention" as const;

const ORACLE_RISK_HIGH = "HIGH" as const;
const PREDICTED_RISK_LOW = "low" as const;
const PREDICTED_RISK_MEDIUM = "medium" as const;
const SEVERITY_HIGH = "high" as const;
const TRIGGER_FULL_ABSTENTION = "full_abstention_against_high_impact" as const;
const MEDIUM_SEVERITY_AVG_FLOOR = 0.6;

const HIGH_IMPACT_DIRECT_THRESHOLD = 10;
const HIGH_IMPACT_TRANSITIVE_THRESHOLD = 50;

const IMPORTED_BY_RECALL_FLOOR = 0.3;
const CALLERS_RECALL_FLOOR = 0.3;
const DOMAINS_RECALL_FLOOR = 0.5;
const IMPORTED_BY_ORACLE_MIN = 5;
const CALLERS_ORACLE_MIN = 5;
const DOMAINS_ORACLE_MIN = 3;
const DIRECT_PRED_MAX_FOR_TRIGGER = 3;
const DIRECT_ORACLE_MIN_FOR_TRIGGER = 10;

/** Section weights for the telemetry-only weighted average. Per design
 *  §7.3, harder-to-predict sections (imported_by, callers) carry more
 *  weight; impact.risk is the highest because it's a primary decision
 *  input the agent is forced to commit to. */
const SECTION_WEIGHTS: PerSectionScore = {
	"deps.imports": 0.5,
	"deps.imported_by": 1.5,
	"calls.callers": 1.5,
	"calls.callees": 1.0,
	"impact.risk": 2.0,
	"impact.domains": 1.0,
	"impact.direct": 1.0,
	"impact.transitive": 1.0,
	"impact.affects": 1.0,
};

export type SeverityTrigger =
	| "risk_underestimated_low_to_high"
	| "risk_underestimated_medium_to_high"
	| "direct_count_underestimated"
	| "imported_by_recall_low"
	| "callers_recall_low"
	| "domains_recall_low"
	| "full_abstention_against_high_impact";

export type Severity = "low" | "medium" | "high" | typeof FULL_ABSTENTION;
export type Decision = "reveal_and_allow" | "ack_required";

/** Reused empty set for callers that supply no `unavailable` set — the
 *  Supermodel-shard path, where every section is answerable. */
const EMPTY_UNAVAILABLE: ReadonlySet<keyof PerSectionScore> = new Set<keyof PerSectionScore>();

export interface ReconcileInputs {
	prediction: ParsedGraphPrediction;
	oracle: SupermodelGraph;
	/** Sections the oracle backend cannot answer (the internal regex graph
	 *  has no call edges, no domain clustering, no transitive BFS). EXCLUDED
	 *  from scoring — not scored as empty-set. Scoring an unanswerable section
	 *  as "[]" both rewards an agent for sharing the oracle's blindness
	 *  (predict nothing → recall 1.0) and penalizes one for seeing past it
	 *  (predict real callers the oracle lacks → precision 0.0). Mirrors the
	 *  existing `if (!oracle.impact) return` skip in scoreScalarSections. */
	unavailable?: ReadonlySet<keyof PerSectionScore>;
}

export interface SeverityResult {
	severity: Severity;
	decision: Decision;
	triggers: SeverityTrigger[];
	high_impact_oracle: boolean;
	per_section_score: PerSectionScore;
	weighted_avg: number;
	miss_set: DiffMissSet;
}

function isHighImpactOracle(oracle: SupermodelGraph): boolean {
	if (!oracle.impact) return false;
	if (oracle.impact.risk === ORACLE_RISK_HIGH) return true;
	if (oracle.impact.direct >= HIGH_IMPACT_DIRECT_THRESHOLD) return true;
	if (oracle.impact.transitive >= HIGH_IMPACT_TRANSITIVE_THRESHOLD) return true;
	return false;
}

function callerSetFromOracle(oracle: SupermodelGraph): string[] {
	if (!oracle.calls) return [];
	return oracle.calls.callers.map((c) => `${c.fn} ← ${c.caller}`);
}

function calleeSetFromOracle(oracle: SupermodelGraph): string[] {
	if (!oracle.calls) return [];
	return oracle.calls.callees.map((c) => `${c.fn} → ${c.callee}`);
}

interface ListSectionConfig {
	key: keyof PerSectionScore;
	predicted: string[] | typeof UNKNOWN_SENTINEL | null;
	oracleSet: string[];
}

interface ScoreAccumulator {
	perSectionScore: PerSectionScore;
	missSet: DiffMissSet;
	weightedTotal: number;
	weightSum: number;
	listScores: Map<keyof PerSectionScore, ListSectionScore>;
	/** Sections the oracle backend cannot answer — excluded from scoring.
	 *  Carried on the accumulator (the shared scoring context) so the scorers
	 *  keep a 3-arg signature. See ReconcileInputs.unavailable. */
	unavailable: ReadonlySet<keyof PerSectionScore>;
}

function newScoreAccumulator(
	unavailable: ReadonlySet<keyof PerSectionScore> = EMPTY_UNAVAILABLE,
): ScoreAccumulator {
	return {
		perSectionScore: {},
		missSet: {},
		weightedTotal: 0,
		weightSum: 0,
		listScores: new Map(),
		unavailable,
	};
}

interface SectionRecord {
	acc: ScoreAccumulator;
	key: keyof PerSectionScore;
	score: number;
	miss: SectionMissDetail | null;
}

function recordSection(record: SectionRecord): void {
	const { acc, key, score, miss } = record;
	acc.perSectionScore[key] = score;
	const w = SECTION_WEIGHTS[key];
	if (typeof w === "number") {
		acc.weightedTotal += score * w;
		acc.weightSum += w;
	}
	if (miss) acc.missSet[key] = miss;
}

function scoreListSections(
	prediction: ParsedGraphPrediction,
	oracle: SupermodelGraph,
	acc: ScoreAccumulator,
): void {
	const listSections: ListSectionConfig[] = [
		{
			key: "deps.imports",
			predicted: prediction.deps?.imports ?? null,
			oracleSet: oracle.deps?.imports ?? [],
		},
		{
			key: "deps.imported_by",
			predicted: prediction.deps?.imported_by ?? null,
			oracleSet: oracle.deps?.importedBy ?? [],
		},
		{
			key: "calls.callers",
			predicted: prediction.calls?.callers ?? null,
			oracleSet: callerSetFromOracle(oracle),
		},
		{
			key: "calls.callees",
			predicted: prediction.calls?.callees ?? null,
			oracleSet: calleeSetFromOracle(oracle),
		},
		{
			key: "impact.domains",
			predicted: prediction.impact?.domains ?? null,
			oracleSet: oracle.impact?.domains ?? [],
		},
		{
			key: "impact.affects",
			predicted: prediction.impact?.affects ?? null,
			oracleSet: oracle.impact?.affects ?? [],
		},
	];
	for (const cfg of listSections) {
		// Sections the backend cannot answer are EXCLUDED, not scored as empty.
		// An unanswerable section scored as "[]" rewards shared blindness and
		// penalizes seeing past it — see ReconcileInputs.unavailable. Leaving
		// the key out of acc.listScores also disables its severity trigger,
		// which guards on `listScores.get(key)` being present.
		if (acc.unavailable.has(cfg.key)) continue;
		const s = scoreListSection(cfg.predicted, cfg.oracleSet);
		acc.listScores.set(cfg.key, s);
		recordSection({ acc, key: cfg.key, score: s.score, miss: s.missDetail });
	}
}

function scoreScalarSections(
	prediction: ParsedGraphPrediction,
	oracle: SupermodelGraph,
	acc: ScoreAccumulator,
): void {
	if (!oracle.impact) return;
	if (!acc.unavailable.has("impact.direct")) {
		const direct = scoreCount(prediction.impact?.direct ?? UNKNOWN_SENTINEL, oracle.impact.direct);
		recordSection({ acc, key: "impact.direct", score: direct.score, miss: direct.missDetail });
	}
	if (!acc.unavailable.has("impact.transitive")) {
		const trans = scoreCount(
			prediction.impact?.transitive ?? UNKNOWN_SENTINEL,
			oracle.impact.transitive,
		);
		recordSection({ acc, key: "impact.transitive", score: trans.score, miss: trans.missDetail });
	}
	if (!acc.unavailable.has("impact.risk")) {
		const risk = scoreRisk(prediction.impact?.risk ?? UNKNOWN_SENTINEL, oracle.impact.risk);
		recordSection({ acc, key: "impact.risk", score: risk.score, miss: risk.missDetail });
	}
}

function collectSeverityTriggers(
	prediction: ParsedGraphPrediction,
	oracle: SupermodelGraph,
	listScores: Map<keyof PerSectionScore, ListSectionScore>,
): SeverityTrigger[] {
	const triggers: SeverityTrigger[] = [];
	pushRiskTriggers(prediction, oracle, triggers);

	if (isDirectCountUnderestimated(prediction, oracle)) {
		triggers.push("direct_count_underestimated");
	}

	if (
		hasLowRecall({
			score: listScores.get("deps.imported_by"),
			oracleCount: (oracle.deps?.importedBy ?? []).length,
			recallFloor: IMPORTED_BY_RECALL_FLOOR,
			oracleMin: IMPORTED_BY_ORACLE_MIN,
		})
	) {
		triggers.push("imported_by_recall_low");
	}

	if (
		hasLowRecall({
			score: listScores.get("calls.callers"),
			oracleCount: (oracle.calls?.callers ?? []).length,
			recallFloor: CALLERS_RECALL_FLOOR,
			oracleMin: CALLERS_ORACLE_MIN,
		})
	) {
		triggers.push("callers_recall_low");
	}

	if (
		hasLowRecall({
			score: listScores.get("impact.domains"),
			oracleCount: (oracle.impact?.domains ?? []).length,
			recallFloor: DOMAINS_RECALL_FLOOR,
			oracleMin: DOMAINS_ORACLE_MIN,
		})
	) {
		triggers.push("domains_recall_low");
	}
	return triggers;
}

function pushRiskTriggers(
	prediction: ParsedGraphPrediction,
	oracle: SupermodelGraph,
	triggers: SeverityTrigger[],
): void {
	const predictedRisk = prediction.impact?.risk;
	const oracleRisk = oracle.impact?.risk;
	if (predictedRisk === PREDICTED_RISK_LOW && oracleRisk === ORACLE_RISK_HIGH) {
		triggers.push("risk_underestimated_low_to_high");
	}
	if (predictedRisk === PREDICTED_RISK_MEDIUM && oracleRisk === ORACLE_RISK_HIGH) {
		triggers.push("risk_underestimated_medium_to_high");
	}
}

function isDirectCountUnderestimated(
	prediction: ParsedGraphPrediction,
	oracle: SupermodelGraph,
): boolean {
	const predictedDirect = prediction.impact?.direct;
	const oracleDirect = oracle.impact?.direct;
	return (
		typeof predictedDirect === "number" &&
		predictedDirect <= DIRECT_PRED_MAX_FOR_TRIGGER &&
		typeof oracleDirect === "number" &&
		oracleDirect >= DIRECT_ORACLE_MIN_FOR_TRIGGER
	);
}

interface RecallTriggerInput {
	score: ListSectionScore | undefined;
	oracleCount: number;
	recallFloor: number;
	oracleMin: number;
}

function hasLowRecall(input: RecallTriggerInput): boolean {
	const { score, oracleCount, recallFloor, oracleMin } = input;
	return score !== undefined && score.recall < recallFloor && oracleCount >= oracleMin;
}

export function reconcile(inputs: ReconcileInputs): SeverityResult {
	const { prediction, oracle } = inputs;
	const acc = newScoreAccumulator(inputs.unavailable ?? EMPTY_UNAVAILABLE);
	scoreListSections(prediction, oracle, acc);
	scoreScalarSections(prediction, oracle, acc);

	const triggers = collectSeverityTriggers(prediction, oracle, acc.listScores);
	const fullAbstention = computeFullAbstention(prediction);
	const high_impact_oracle = isHighImpactOracle(oracle);
	if (fullAbstention && high_impact_oracle) {
		triggers.push(TRIGGER_FULL_ABSTENTION);
	}

	const weightedAvg = acc.weightSum > 0 ? acc.weightedTotal / acc.weightSum : 0;
	const severity: Severity = classifySeverity(fullAbstention, triggers, weightedAvg);
	const decision: Decision =
		triggers.length > 0 && (severity === SEVERITY_HIGH || fullAbstention)
			? "ack_required"
			: "reveal_and_allow";

	return {
		severity,
		decision,
		triggers,
		high_impact_oracle,
		per_section_score: acc.perSectionScore,
		weighted_avg: weightedAvg,
		miss_set: acc.missSet,
	};
}

/** A field is "abstained" iff its value is the bare `unknown` sentinel
 *  (whole-section, scalar, or every list element). An empty list `[]` is
 *  an explicit assertion of absence — not abstention. A value that
 *  contains some real entries plus an `unknown` sentinel counts as
 *  partially-asserted, not full-abstention. */
function isFieldAbstained(value: unknown): boolean {
	if (value === UNKNOWN_SENTINEL) return true;
	return false;
}

function computeFullAbstention(prediction: ParsedGraphPrediction): boolean {
	const fields: unknown[] = [
		prediction.deps?.imports ?? UNKNOWN_SENTINEL,
		prediction.deps?.imported_by ?? UNKNOWN_SENTINEL,
		prediction.calls?.callers ?? UNKNOWN_SENTINEL,
		prediction.calls?.callees ?? UNKNOWN_SENTINEL,
		prediction.impact?.risk ?? UNKNOWN_SENTINEL,
		prediction.impact?.domains ?? UNKNOWN_SENTINEL,
		prediction.impact?.direct ?? UNKNOWN_SENTINEL,
		prediction.impact?.transitive ?? UNKNOWN_SENTINEL,
		prediction.impact?.affects ?? UNKNOWN_SENTINEL,
	];
	return fields.every(isFieldAbstained);
}

function classifySeverity(
	fullAbstention: boolean,
	triggers: SeverityTrigger[],
	weightedAvg: number,
): Severity {
	if (fullAbstention) return FULL_ABSTENTION;
	const hasHighTrigger = triggers.some((t) => t !== TRIGGER_FULL_ABSTENTION);
	if (hasHighTrigger) return SEVERITY_HIGH;
	if (weightedAvg < MEDIUM_SEVERITY_AVG_FLOOR) return "medium";
	return "low";
}
