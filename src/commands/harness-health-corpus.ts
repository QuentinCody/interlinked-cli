import { CHECK_REGISTRY } from "../harness/check-registry/index.js";
import { loadCorpusStore } from "../harness/check-evidence/corpus-scan.js";

/** Recorded adjudications only. This is a sampling report, not a freshness qualification. */
export function corpusPrecision(cwd: string) {
    return Object.entries(loadCorpusStore(cwd).checks).map(([check, record]) => {
        const verdicts = record.hits.map(id => record.adjudications[id]?.verdict);
        const truePositive = verdicts.filter(value => value === "true_positive").length;
        const falsePositive = verdicts.filter(value => value === "false_positive").length;
        const classified = truePositive + falsePositive;
        return { check, hits: record.hits.length, adjudicated: classified,
            true_positive: truePositive, false_positive: falsePositive, unadjudicated: record.hits.length - classified,
            precision: classified > 0 ? truePositive / classified : null,
            severity: CHECK_REGISTRY.find(row => row.id === check)?.severity ?? "unknown",
            run: record.provenance?.run ?? null, detector: record.provenance?.detector ?? null,
            observed_at: record.provenance?.timestamp ?? null, scope: record.provenance?.scope ?? "legacy unknown",
            freshness: "not recomputed; use harness corpus status", triage_cost_ms: null };
    });
}
