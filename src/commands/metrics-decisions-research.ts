import { resolve } from "node:path";
import {
    candidateConsumers,
    snapshotRepository,
    augmentWithHistory,
} from "../lib/decision-metrics/corpus.js";
import { discoverCandidates } from "../lib/decision-metrics/candidate-retrieval.js";
import { measureGeometry } from "../lib/decision-metrics/geometry.js";
import { readDecisionRun, readEvidenceRecords } from "../lib/decision-metrics/io.js";
import { probeMeaning } from "../lib/decision-metrics/meaning-probe.js";
import { labelTemplate, joinLabels, samplePilot } from "../lib/decision-metrics/study.js";
import { readJson } from "../lib/decision-metrics/store.js";
import type { DecisionConfig } from "../lib/decision-metrics/types.js";
import type { DecisionsOptions } from "./metrics-decisions.js";

export const RESEARCH_ACTIONS = [
    "geometry",
    "snapshot",
    "candidates",
    "retrieve",
    "pilot",
    "labels",
    "join-labels",
    "probe",
];

function corpusPath(root: string, options: DecisionsOptions): string {
    if (!options.corpus) throw new Error("--corpus evidence file is required");
    return resolve(root, options.corpus);
}
function retrievalMethod(value = "lexical"): "lexical" | "embedding" | "hybrid" {
    if (value !== "lexical" && value !== "embedding" && value !== "hybrid")
        throw new Error("retrieval must be lexical, embedding, or hybrid");
    return value;
}
function pilotOptions(options: DecisionsOptions): Parameters<typeof samplePilot>[1] {
    const result: Parameters<typeof samplePilot>[1] = { count: Number(options.count ?? 10) };
    if (options.before) result.before = options.before;
    if (options.after) result.after = options.after;
    return result;
}
export async function decisionResearch(
    action: string,
    input: string | undefined,
    root: string,
    config: DecisionConfig,
    options: DecisionsOptions,
): Promise<unknown> {
    switch (action) {
        case "geometry":
            return measureGeometry(readEvidenceRecords(input));
        case "snapshot":
            return snapshotRepository(root, {
                revision: options.revision ?? "HEAD",
                maxFiles: Number(options.maxFiles ?? 2000),
            });
        case "candidates": {
            const changes = readEvidenceRecords(input),
                consumers = readEvidenceRecords(corpusPath(root, options));
            return options.retrieval
                ? discoverCandidates(
                      root,
                      changes,
                      consumers,
                      config,
                      retrievalMethod(options.retrieval),
                  )
                : candidateConsumers(changes, consumers);
        }
        case "retrieve": {
            const method = retrievalMethod(options.retrieval);
            return augmentWithHistory(
                readEvidenceRecords(input),
                readEvidenceRecords(corpusPath(root, options)),
                config,
                method,
                root,
            );
        }
        case "pilot":
            return samplePilot(root, pilotOptions(options));
        case "labels":
            return labelTemplate(readDecisionRun(input));
        case "join-labels": {
            if (!options.labels) throw new Error("--labels file is required");
            return joinLabels(readDecisionRun(input), readJson(resolve(root, options.labels)));
        }
        case "probe": {
            const records = readEvidenceRecords(input);
            if (records.length !== 1) throw new Error("probe takes one bounded evidence record");
            if (options.plan)
                throw new Error(
                    "probe performs fresh inference; use measure --plan to inspect requests",
                );
            return probeMeaning(root, records[0]!, config);
        }
        default:
            throw new Error("unknown research action");
    }
}
