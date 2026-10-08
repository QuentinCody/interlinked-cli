import { measurePopulation } from "./pipeline.js";
import { probabilityFor } from "./reports.js";
import { meaningVariants } from "./study.js";
import type { DecisionConfig, DecisionRun, EvidenceRecord } from "./types.js";

export interface ProbeReport {
    version: 1;
    interpretation: string;
    observations: { name: string; expectation: string; run: DecisionRun }[];
    changes: { variant: string; metric: string; probabilityDelta: number | null; status: string }[];
}

export async function probeMeaning(
    root: string,
    record: EvidenceRecord,
    config: DecisionConfig,
): Promise<ProbeReport> {
    const deadline = Date.now() + config.deadlineMs;
    const options = { fresh: true, deadline };
    const original = await measurePopulation(root, [record], config, options);
    const observations = [
        { name: "original", expectation: "reference fresh inference", run: original },
    ];
    observations.push({
        name: "repeat",
        expectation: "fresh-run stability; cache replay is not evidence of stability",
        run: await measurePopulation(root, [record], config, options),
    });
    observations.push({
        name: "question-order",
        expectation: "question order should not materially change probabilities",
        run: await measurePopulation(
            root,
            [record],
            { ...config, metrics: [...config.metrics].reverse() },
            options,
        ),
    });
    for (const variant of meaningVariants(record))
        observations.push({
            name: variant.name,
            expectation: variant.expectation,
            run: await measurePopulation(root, [variant.record], config, options),
        });
    for (const metric of config.metrics)
        observations.push({
            name: `singleton:${metric}`,
            expectation: "compare single-question and batched probabilities",
            run: await measurePopulation(root, [record], { ...config, metrics: [metric] }, options),
        });
    const changes = observations.slice(1).flatMap((observation) =>
        observation.run.measurements.map((row) => {
            const before = original.measurements.find(
                (other) => other.contract.id === row.contract.id,
            );
            const a = before ? probabilityFor(before) : null,
                b = probabilityFor(row);
            return {
                variant: observation.name,
                metric: row.contract.id,
                probabilityDelta: a === null || b === null ? null : b - a,
                status: row.status,
            };
        }),
    );
    return {
        version: 1,
        interpretation:
            "diagnostic perturbations, not calibration labels or proof of invariance; inspect failures and budget exclusions",
        observations,
        changes,
    };
}
