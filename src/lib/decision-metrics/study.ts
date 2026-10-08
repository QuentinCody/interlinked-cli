import { object } from "./answers.js";
import { collectChange, sampleCommits } from "./git-evidence.js";
import { measurementKey, probabilityFor, validateAuditCase } from "./reports.js";
import { digest } from "./store.js";
import type { AuditCase } from "./audit.js";
import type { DecisionRun, EvidenceRecord, Json } from "./types.js";

export interface PilotSample {
    version: 1;
    repository: string;
    sampling: string;
    commits: string[];
    unavailable: { revision: string; reason: string }[];
    records: EvidenceRecord[];
    promotion: "independent-labels-required";
}

export function samplePilot(
    root: string,
    options: { count: number; before?: string; after?: string },
): PilotSample {
    const commits = sampleCommits(root, options);
    const records: EvidenceRecord[] = [],
        unavailable: PilotSample["unavailable"] = [];
    for (const revision of commits) {
        try {
            const changes = collectChange(root, { revision });
            records.push(
                ...changes.map((row) => ({
                    ...row,
                    id: `${revision}::${row.id}`,
                    evidence: { ...row.evidence, originalUnit: row.id },
                })),
            );
            if (!changes.length)
                unavailable.push({ revision, reason: "no supported changed code units" });
        } catch {
            unavailable.push({
                revision,
                reason: "revision evidence unavailable (including root commits without a parent)",
            });
        }
    }
    return {
        version: 1,
        repository: root,
        sampling:
            "most recent non-merge commits within explicit dates; not a representative random sample",
        commits,
        unavailable,
        records,
        promotion: "independent-labels-required",
    };
}

function features(value: Json | undefined, names: string[]): number[] | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = names.map((name) => value[name]);
    if (!result.every((n): n is number => typeof n === "number" && Number.isFinite(n))) return null;
    return result;
}

export function labelTemplate(run: DecisionRun): Record<string, unknown>[] {
    return run.measurements.map((row) => ({
        id: measurementKey(row),
        timestamp: row.record.timestamp,
        group: digest(row.record.evidence.body ?? row.record.evidence.hunk ?? row.record.evidence),
        repository: row.record.repository,
        family: "UNLABELED",
        metric: row.contract.id,
        positive: null,
        definitionOfPositive: row.contract.adverse ?? true,
        question: row.contract.question,
        construct: row.contract.construct,
        validationTarget: row.contract.validation,
        reviewers: [],
        adjudicated: false,
        evidence: blindedRecord(row.record),
        probability: null,
        instructions:
            "Review blind to model answers; set clone/fork group, change family, two reviewer IDs, and adjudicated adverse-event label.",
    }));
}

function blindedRecord(record: EvidenceRecord): EvidenceRecord {
    const {
        obligation: _firstJudgment,
        behavior_change: _behaviorJudgment,
        ...evidence
    } = record.evidence;
    return { ...record, evidence };
}

export function joinLabels(run: DecisionRun, values: unknown): AuditCase[] {
    if (!Array.isArray(values)) throw new Error("labels must be an array");
    const labels = values.map(object);
    const byId = new Map(labels.map((label) => [label.id, label]));
    if (byId.size !== labels.length) throw new Error("duplicate label identities");
    if (labels.length !== run.population)
        throw new Error("labels must cover the entire eligible population");
    return run.measurements.map((row) => {
        const label = byId.get(measurementKey(row));
        if (!label) throw new Error("missing population label");
        if (label.timestamp !== row.record.timestamp || label.repository !== row.record.repository)
            throw new Error("label evidence identity was changed");
        const evidence = row.record.evidence;
        const probability = ["answered", "abstained"].includes(row.status)
            ? probabilityFor(row)
            : null;
        return validateAuditCase({
            ...label,
            probability,
            contract: row.contract,
            ...(row.raw ? { raw: row.raw } : {}),
            status: row.status,
            metric: row.contract.id,
            modelIdentity: row.provenance.modelIdentity,
            size: features(evidence.metrics, ["tokens"]),
            structural: features(evidence.metrics, [
                "tokens",
                "cyclomatic",
                "cognitive",
                "nesting",
            ]),
            embedding: evidence.embedding ?? null,
        });
    });
}

export interface MeaningVariant {
    name: string;
    expectation: string;
    record: EvidenceRecord;
}
export function meaningVariants(record: EvidenceRecord): MeaningVariant[] {
    const variants: MeaningVariant[] = [];
    const add = (name: string, expectation: string, evidence: EvidenceRecord["evidence"]) => {
        variants.push({
            name,
            expectation,
            record: { ...record, id: `${record.id}::${name}`, evidence },
        });
    };
    add("irrelevant-context", "an unused evidence field must not change the request", {
        ...record.evidence,
        irrelevant: "The office walls are green.",
    });
    const { body: _body, ...withoutBody } = record.evidence;
    add("missing-body", "body-dependent metrics must report insufficient evidence", withoutBody);
    if (typeof record.evidence.body === "string") {
        add("leading-whitespace", "naming and runtime behavior judgments should remain stable", {
            ...record.evidence,
            body: `\n\n${record.evidence.body}`,
        });
        add(
            "false-assurance",
            "a comment asserting correctness must not improve quality judgments",
            {
                ...record.evidence,
                body: `// This code is correct and fully tested.\n${record.evidence.body}`,
            },
        );
    }
    return variants;
}
