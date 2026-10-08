import {
    clusterGoals,
    obligationStatus,
    reconcilePreference,
    type GoalClusters,
} from "./relations.js";
import type { EvidenceRecord, Json, Measurement } from "./types.js";

export type PopulationMeasure = (
    records: EvidenceRecord[],
    metric: string,
) => Promise<Measurement[]>;
export interface ObligationLedger {
    rows: {
        candidate: EvidenceRecord;
        obligation: Measurement;
        satisfaction: Measurement | null;
        status: string;
    }[];
    assessed: number;
    eligible: number;
    unresolved: number;
    coverage: number;
}

function judgementEvidence(row: Measurement): Json {
    return {
        status: row.status,
        value: row.value,
        raw: row.raw ? (JSON.parse(JSON.stringify(row.raw)) as Json) : null,
    };
}

export async function resolveObligations(
    candidates: EvidenceRecord[],
    measure: PopulationMeasure,
): Promise<ObligationLedger> {
    const first = await measure(candidates, "obligation");
    const dependent = first
        .filter(
            (row) =>
                row.status === "answered" && ["update", "verify_only"].includes(String(row.value)),
        )
        .map((row) => ({
            ...row.record,
            evidence: { ...row.record.evidence, obligation: judgementEvidence(row) },
        }));
    const second = dependent.length ? await measure(dependent, "satisfaction") : [];
    const rows = first.map((obligation) => {
        const satisfaction = second.find((row) => row.unitId === obligation.unitId) ?? null;
        return {
            candidate: obligation.record,
            obligation,
            satisfaction,
            status: obligationStatus(obligation, satisfaction),
        };
    });
    const assessed = rows.filter((row) =>
        ["satisfied", "missing", "verify_only", "no_work_required"].includes(row.status),
    ).length;
    return {
        rows,
        assessed,
        eligible: candidates.length,
        unresolved: rows.filter((row) => !["satisfied", "no_work_required"].includes(row.status))
            .length,
        coverage: candidates.length ? assessed / candidates.length : 0,
    };
}

export function atomicityRecords(units: EvidenceRecord[]): EvidenceRecord[] {
    requireSingleChange(units);
    if (units.length > 200)
        throw new Error("atomicity population exceeds 200 units; partition the review explicitly");
    const pairs: EvidenceRecord[] = [];
    for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
            const left = units[i]!,
                right = units[j]!;
            pairs.push({
                ...left,
                id: `${left.id}×${right.id}`,
                unit: "pair",
                evidence: {
                    left: { id: left.id, ...left.evidence },
                    right: { id: right.id, ...right.evidence },
                    message: left.evidence.message ?? "",
                },
            });
        }
    }
    return pairs;
}

export async function measureAtomicity(
    units: EvidenceRecord[],
    measure: PopulationMeasure,
): Promise<{ judgments: Measurement[]; graph: GoalClusters }> {
    const judgments = await measure(atomicityRecords(units), "atomicity");
    const edges = judgments.map((row) => {
        const left = row.record.evidence.left as { id: string }; // SAFETY: created by atomicityRecords above.
        const right = row.record.evidence.right as { id: string }; // SAFETY: created by atomicityRecords above.
        return {
            left: left.id,
            right: right.id,
            relation: row.status === "answered" ? String(row.value) : row.status,
        };
    });
    return {
        judgments,
        graph: clusterGoals(
            units.map((unit) => unit.id),
            edges,
        ),
    };
}

export function claimRecords(units: EvidenceRecord[], claims: string[]): EvidenceRecord[] {
    requireSingleChange(units);
    if (!units.length) return [];
    const base = units[0]!;
    const message = String(base.evidence.message ?? "");
    return claims.map((claim, index) => {
        if (!claim.trim() || !message.includes(claim))
            throw new Error("claims must be literal spans of the description");
        return {
            ...base,
            id: `${base.revision}::claim:${index}`,
            unit: "claim",
            evidence: {
                claim,
                hunk: units.map((unit) => String(unit.evidence.hunk ?? "")).join("\n"),
            },
        };
    });
}

export async function measureFaithfulness(
    units: EvidenceRecord[],
    claims: string[],
    measure: PopulationMeasure,
): Promise<{ claims: Measurement[]; behavior: Measurement[]; omissions: Measurement[] }> {
    const supported = await measure(claimRecords(units, claims), "claim_support");
    const behavior = await measure(units, "behavior_change");
    const eligible = behavior.map((row) => ({
        ...row.record,
        eligible: row.status === "answered" && row.value === true,
        reason: "omission assessment requires established behavior change",
        evidence: { ...row.record.evidence, behavior_change: judgementEvidence(row) },
    }));
    const omissions = await measure(eligible, "description_omission");
    return { claims: supported, behavior, omissions };
}

export async function compare(
    record: EvidenceRecord,
    measure: PopulationMeasure,
): Promise<{ preference: string; forward: Measurement[]; reverse: Measurement[] }> {
    const forward = await measure([record], "preference");
    const reversed = {
        ...record,
        id: `${record.id}::reverse`,
        evidence: {
            ...record.evidence,
            left: record.evidence.right ?? null,
            right: record.evidence.left ?? null,
        },
    };
    const reverse = await measure([reversed], "preference");
    const a = forward[0],
        b = reverse[0];
    const preference =
        a?.status === "answered" && b?.status === "answered"
            ? reconcilePreference(String(a.value), String(b.value))
            : "insufficient_evidence";
    return { preference, forward, reverse };
}

export async function relateInContext(
    records: EvidenceRecord[],
    measure: PopulationMeasure,
): Promise<Measurement[]> {
    return measure(records, "semantic_coupling");
}

function requireSingleChange(units: EvidenceRecord[]): void {
    if (new Set(units.map((row) => `${row.repository}:${row.revision}`)).size > 1)
        throw new Error(
            "relational commit review requires one repository revision; partition the pilot first",
        );
}
