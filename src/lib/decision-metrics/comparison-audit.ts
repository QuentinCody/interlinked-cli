import { auditCohort, type AuditCase, type AuditOptions, type CohortAudit } from "./audit.js";
import { binaryStatistics, type BinaryStatistics } from "./statistics.js";

export interface ComparisonAudit {
    version: 1;
    direct: CohortAudit;
    retrieval: CohortAudit;
    paired: {
        eligible: number;
        bothAssessed: number;
        direct: BinaryStatistics;
        retrieval: BinaryStatistics;
    };
    arms: {
        static: Record<string, BinaryStatistics | null>;
        handRules: BinaryStatistics | null;
        embeddingHead: BinaryStatistics | null;
        directDecision: BinaryStatistics;
        retrievalDecision: BinaryStatistics;
    };
}

function validatePairs(direct: AuditCase[], retrieval: AuditCase[]): Map<string, AuditCase> {
    const right = new Map(retrieval.map((row) => [row.id, row]));
    if (right.size !== retrieval.length || direct.length !== retrieval.length)
        throw new Error("comparison arms require the same full cohort");
    for (const left of direct) {
        const row = right.get(left.id);
        if (!row) throw new Error("comparison cohort identity mismatch");
        const key = (item: AuditCase) =>
            JSON.stringify([
                item.positive,
                item.timestamp,
                item.group,
                item.repository,
                item.family,
                item.metric,
                item.contract,
                item.modelIdentity,
                item.size,
                item.structural,
                item.embedding,
                item.ruleProbability,
            ]);
        if (key(left) !== key(row))
            throw new Error(
                "comparison labels, time split, and baseline evidence must be identical",
            );
    }
    return right;
}

export function auditComparison(
    direct: AuditCase[],
    retrieval: AuditCase[],
    policy: AuditOptions,
): ComparisonAudit {
    const right = validatePairs(direct, retrieval);
    const a = auditCohort(direct, policy),
        b = auditCohort(retrieval, policy);
    const heldOut = direct.filter((row) => Date.parse(row.timestamp) >= Date.parse(policy.cutoff));
    const common = heldOut.filter(
        (row) => row.probability !== null && right.get(row.id)!.probability !== null,
    );
    const paired = {
        eligible: heldOut.length,
        bothAssessed: common.length,
        direct: binaryStatistics(
            common.map((row) => ({ positive: row.positive, probability: row.probability! })),
        ),
        retrieval: binaryStatistics(
            common.map((row) => ({
                positive: row.positive,
                probability: right.get(row.id)!.probability!,
            })),
        ),
    };
    return {
        version: 1,
        direct: a,
        retrieval: b,
        paired,
        arms: {
            static: { size: a.baselines.size ?? null, structural: a.baselines.structural ?? null },
            handRules: a.baselines.rules ?? null,
            embeddingHead: a.baselines.embedding_head ?? null,
            directDecision: paired.direct,
            retrievalDecision: paired.retrieval,
        },
    };
}
