// Judgment of the whole-tree score metrics that no per-file check can judge.
//
// A share of modules (redundancy.disconnected), a share of module pairs
// (architecture.reach) and the failed share of declared contracts
// (contracts.findings) are properties of the whole dependency graph or of the
// score configuration, so a per-edit check cannot see them. `interlinked metrics
// score` applies these limits to its own readings and prints the verdicts.
//
// Rules: a verdict needs a `measured` reading. An `inconclusive` reading (the graph
// has unresolved or computed imports) yields a `not-judged` row with the reason, because
// graph shares require a complete population. The limits follow the score profile's own
// knots: disconnected 5 percent (burden starts), reach 25
// percent (half burden), a failed declared contract at any share (a failed assertion
// has no legitimate use). Every verdict is an advisory except a failed contract, which
// is a warning. No limit blocks; a blocking cap is a policy choice for the operator.

import type { MetricReading } from "./measurement-types.js";

export const DISCONNECTED_ADVISORY_PERCENT = 5;
export const REACH_ADVISORY_PERCENT = 25;

/** The check or judgment that judges each of the six metrics that had none. */
export const METRIC_JUDGES: Readonly<Record<string, string>> = {
	difficulty: "halstead_difficulty",
	"file.top_level": "top_level_burden",
	"redundancy.dead_stores": "dead_literal_store",
	"redundancy.disconnected": "score_judgment",
	"architecture.reach": "score_judgment",
	"contracts.findings": "score_judgment",
};

export interface ScoreJudgment {
	metric: string;
	judge: "score_judgment";
	level: "advisory" | "warning" | "not-judged";
	value: number | null;
	limit: number | null;
	message: string;
}

function judgeOne(reading: MetricReading): ScoreJudgment | null {
	const { id, state, value } = reading;
	if (state === "not-applicable") return null;
	if (state === "inconclusive") {
		return { metric: id, judge: "score_judgment", level: "not-judged", value, limit: null,
			message: `${id} is inconclusive and not judged: ${reading.limitations.join(" ") || "the measurement is incomplete"}` };
	}
	if (state !== "measured" || value === null) return null;
	if (id === "redundancy.disconnected" && value >= DISCONNECTED_ADVISORY_PERCENT) {
		return { metric: id, judge: "score_judgment", level: "advisory", value, limit: DISCONNECTED_ADVISORY_PERCENT,
			message: `${reading.numerator ?? "?"} of ${reading.denominator ?? "?"} product modules are not reached from an entry point (${value.toFixed(1)} percent, advisory from ${DISCONNECTED_ADVISORY_PERCENT})` };
	}
	if (id === "architecture.reach" && value >= REACH_ADVISORY_PERCENT) {
		return { metric: id, judge: "score_judgment", level: "advisory", value, limit: REACH_ADVISORY_PERCENT,
			message: `${value.toFixed(1)} percent of ordered module pairs reach each other through imports (advisory from ${REACH_ADVISORY_PERCENT})` };
	}
	if (id === "contracts.findings" && value > 0) {
		return { metric: id, judge: "score_judgment", level: "warning", value, limit: 0,
			message: `${reading.numerator ?? "?"} of ${reading.denominator ?? "?"} declared contracts failed` };
	}
	return null;
}

const JUDGED_IDS: ReadonlySet<string> = new Set(["redundancy.disconnected", "architecture.reach", "contracts.findings"]);

/** Verdicts for the whole-tree metrics among the readings; a reading that passes yields nothing. */
export function judgeWholeTreeMetrics(readings: readonly MetricReading[]): ScoreJudgment[] {
	return readings.filter(reading => JUDGED_IDS.has(reading.id)).flatMap(reading => judgeOne(reading) ?? []);
}
