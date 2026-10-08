import {
    binaryStatistics,
    fitLogistic,
    predictLogistic,
    type BinaryStatistics,
} from "./statistics.js";
import type { Band, MeasurementStatus, MetricContract, RawAnswer } from "./types.js";
import { adverseAnswer, interpretAnswer } from "./answers.js";

export interface AuditCase {
    id: string;
    timestamp: string;
    group: string;
    repository: string;
    family: string;
    positive: boolean;
    probability: number | null;
    status: MeasurementStatus;
    size: number[] | null;
    structural: number[] | null;
    embedding?: number[] | null;
    ruleProbability?: number | null;
    reviewers: string[];
    adjudicated: boolean;
    metric?: string;
    modelIdentity?: string;
    contract?: MetricContract;
    raw?: RawAnswer;
}

export interface AuditOptions {
    cutoff: string;
    band: Band;
    aucMargin?: number;
    falseBlockBudget?: number;
    minTrain?: number;
    minTest?: number;
}
export interface OperationalReport {
    eligible: number;
    completion: number;
    answeredFraction: number;
    fullCohortRecall: number | null;
    falseBlockRate: number | null;
    notSureRate: number;
    states: Record<MeasurementStatus, number>;
}
export interface CohortAudit {
    version: 1;
    cutoff: string;
    train: number;
    test: number;
    probability: BinaryStatistics;
    baseRateBrier: number | null;
    baselines: Record<string, BinaryStatistics | null>;
    operational: OperationalReport;
    bands: { band: Band; training: OperationalReport; heldOut: OperationalReport }[];
    suggestedBand: { selectedOn: "training"; band: Band; heldOut: OperationalReport } | null;
    acceptance: { qualified: boolean; reasons: string[]; policy: AuditOptions };
    slices: Record<string, OperationalReport>;
}

function observations(rows: AuditCase[]) {
    return rows
        .filter((row) => row.probability !== null)
        .map((row) => ({ probability: row.probability!, positive: row.positive }));
}

function operatingStatus(row: AuditCase, band: Band): MeasurementStatus {
    if (row.contract && row.raw && !["failed", "unassessed"].includes(row.status))
        return interpretAnswer(row.contract, row.raw, band).status;
    if (row.probability === null || !["answered", "abstained"].includes(row.status))
        return row.status;
    return row.probability >= band[1] || row.probability < band[0] ? "answered" : "abstained";
}

export function operationalReport(rows: AuditCase[], band: Band): OperationalReport {
    const states: Record<MeasurementStatus, number> = {
        answered: 0,
        insufficient_evidence: 0,
        abstained: 0,
        failed: 0,
        unassessed: 0,
    };
    let tp = 0,
        fp = 0;
    for (const row of rows) {
        const status = operatingStatus(row, band);
        states[status]++;
        const alert = status === "answered" && detectsAdverse(row, band);
        if (alert && row.positive) tp++;
        if (alert && !row.positive) fp++;
    }
    const positives = rows.filter((row) => row.positive).length;
    const negatives = rows.length - positives;
    return {
        eligible: rows.length,
        completion: rows.length ? observations(rows).length / rows.length : 0,
        answeredFraction: rows.length ? states.answered / rows.length : 0,
        fullCohortRecall: positives ? tp / positives : null,
        falseBlockRate: negatives ? fp / negatives : null,
        notSureRate: rows.length ? states.abstained / rows.length : 0,
        states,
    };
}

function detectsAdverse(row: AuditCase, band: Band): boolean {
    if (row.probability === null) return false;
    if (row.contract && row.raw) return adverseAnswer(row.contract, row.raw, band);
    return row.probability >= band[1];
}

function baseline(
    train: AuditCase[],
    test: AuditCase[],
    field: "size" | "structural" | "embedding",
): BinaryStatistics | null {
    const available = train.filter((row) => row[field]?.length);
    if (
        available.length < 2 ||
        available.every((row) => row.positive) ||
        available.every((row) => !row.positive)
    )
        return null;
    // Compare AUC on the same held-out cases where the decision model supplied a probability.
    const evaluation = test.filter((row) => row.probability !== null);
    if (evaluation.some((row) => !row[field]?.length)) return null;
    const head = fitLogistic(
        available.map((row) => row[field]!),
        available.map((row) => row.positive),
    );
    return binaryStatistics(
        evaluation.map((row) => ({
            probability: predictLogistic(head, row[field]!),
            positive: row.positive,
        })),
    );
}

function validateSplit(
    rows: AuditCase[],
    cutoff: string,
): { train: AuditCase[]; test: AuditCase[] } {
    if (new Set(rows.map((row) => row.metric ?? "unspecified")).size > 1)
        throw new Error("audit one metric at a time; different constructs must not be pooled");
    if (new Set(rows.map((row) => row.modelIdentity ?? "unspecified")).size > 1)
        throw new Error("audit one pinned model arm at a time");
    const contracts = rows.flatMap((row) => (row.contract ? [JSON.stringify(row.contract)] : []));
    if (new Set(contracts).size > 1)
        throw new Error("audit one question contract version at a time");
    const date = Date.parse(cutoff);
    if (!Number.isFinite(date) || rows.some((row) => !Number.isFinite(Date.parse(row.timestamp))))
        throw new Error("time split requires valid dates");
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new Error("duplicate audit IDs");
    const train = rows.filter((row) => Date.parse(row.timestamp) < date);
    const test = rows.filter((row) => Date.parse(row.timestamp) >= date);
    const groups = new Set(train.map((row) => row.group));
    if (test.some((row) => groups.has(row.group)))
        throw new Error("clone/fork group leakage across time split");
    if (!train.length || !test.length) throw new Error("both sides of the time split need labels");
    return { train, test };
}

type QualificationReport = Pick<
    CohortAudit,
    "probability" | "baseRateBrier" | "baselines" | "operational"
>;

function probabilityQualification(report: QualificationReport, policy: AuditOptions): string[] {
    const reasons: string[] = [];
    if (
        report.probability.brier === null ||
        report.baseRateBrier === null ||
        report.probability.brier >= report.baseRateBrier
    )
        reasons.push("Brier does not beat the training-base-rate predictor");
    if (report.probability.ece === null || report.probability.ece >= 0.05)
        reasons.push("ECE must be below 0.05");
    for (const name of ["size", "structural"]) {
        const auc = report.baselines[name]?.auc;
        if (
            auc === null ||
            auc === undefined ||
            report.probability.auc === null ||
            report.probability.auc < auc + (policy.aucMargin ?? 0.02)
        )
            reasons.push(`AUC does not beat ${name} by required margin`);
    }
    return reasons;
}

function qualification(
    train: AuditCase[],
    test: AuditCase[],
    report: QualificationReport,
    policy: AuditOptions,
): string[] {
    const reasons = probabilityQualification(report, policy);
    if (train.length < (policy.minTrain ?? 50) || test.length < (policy.minTest ?? 50))
        reasons.push("insufficient independent train/test population");
    if ([...train, ...test].some((row) => !row.adjudicated || new Set(row.reviewers).size < 2))
        reasons.push("two independent adjudicators required");
    if (report.operational.notSureRate >= 0.2) reasons.push("not-sure rate must be below 20%");
    if (
        report.operational.falseBlockRate === null ||
        report.operational.falseBlockRate > (policy.falseBlockBudget ?? 0.01)
    )
        reasons.push("false-block budget not met");
    if (report.operational.completion < 0.8) reasons.push("assessment completion below 80%");
    return reasons;
}

export function auditCohort(rows: AuditCase[], options: AuditOptions): CohortAudit {
    const policy: AuditOptions = {
        aucMargin: 0.02,
        falseBlockBudget: 0.01,
        minTrain: 50,
        minTest: 50,
        ...options,
    };
    const { train, test } = validateSplit(rows, policy.cutoff);
    const rate = train.filter((row) => row.positive).length / train.length;
    const observed = observations(test);
    const baseRateBrier = observed.length
        ? observed.reduce((sum, row) => sum + (rate - Number(row.positive)) ** 2, 0) /
          observed.length
        : null;
    const report = {
        version: 1 as const,
        cutoff: policy.cutoff,
        train: train.length,
        test: test.length,
        probability: binaryStatistics(observed),
        baseRateBrier,
        baselines: {
            size: baseline(train, test, "size"),
            structural: baseline(train, test, "structural"),
            embedding_head: baseline(train, test, "embedding"),
            rules: binaryStatistics(
                test
                    .filter(
                        (row) => row.ruleProbability !== null && row.ruleProbability !== undefined,
                    )
                    .map((row) => ({ probability: row.ruleProbability!, positive: row.positive })),
            ),
        },
        operational: operationalReport(test, policy.band),
    };
    const reasons = qualification(train, test, report, policy);
    const bands: Band[] = [
        [0.2, 0.8],
        [0.3, 0.7],
        [0.4, 0.6],
    ];
    const slices: Record<string, OperationalReport> = {};
    for (const field of ["repository", "family"] as const)
        for (const value of new Set(test.map((row) => row[field])))
            slices[`${field}:${value}`] = operationalReport(
                test.filter((row) => row[field] === value),
                policy.band,
            );
    const bandReports = bands.map((band) => ({
        band,
        training: operationalReport(train, band),
        heldOut: operationalReport(test, band),
    }));
    return {
        ...report,
        bands: bandReports,
        suggestedBand: suggestBand(bandReports, policy.falseBlockBudget!),
        acceptance: { qualified: reasons.length === 0, reasons, policy },
        slices,
    };
}

function suggestBand(
    bands: CohortAudit["bands"],
    falseBlockBudget: number,
): CohortAudit["suggestedBand"] {
    const eligible = bands.filter(
        ({ training }) =>
            training.falseBlockRate !== null &&
            training.falseBlockRate <= falseBlockBudget &&
            training.notSureRate < 0.2 &&
            training.completion >= 0.8,
    );
    eligible.sort(
        (a, b) =>
            (b.training.fullCohortRecall ?? 0) - (a.training.fullCohortRecall ?? 0) ||
            b.training.answeredFraction - a.training.answeredFraction,
    );
    const selected = eligible[0];
    return selected
        ? { selectedOn: "training", band: selected.band, heldOut: selected.heldOut }
        : null;
}
