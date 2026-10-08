import { object, parseAnswer } from "./answers.js";
import { parseBand } from "./config.js";
import { validateEvidence } from "./evidence.js";
import { summarize } from "./pipeline.js";
import type { DecisionRun, Measurement, MetricContract } from "./types.js";

function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requiredStrings(row: Record<string, unknown>, keys: string[]): void {
    for (const key of keys)
        if (typeof row[key] !== "string") throw new Error(`invalid stored ${key}`);
}

function assertContract(value: unknown): asserts value is MetricContract {
    const row = object(value);
    requiredStrings(row, [
        "id",
        "version",
        "construct",
        "population",
        "question",
        "aggregation",
        "validation",
    ]);
    if (!["function", "hunk", "commit", "pair", "claim"].includes(String(row.unit)))
        throw new Error("invalid contract unit");
    if (!["pilot", "research", "phase2"].includes(String(row.phase)))
        throw new Error("invalid contract phase");
    if (!strings(row.on)) throw new Error("invalid contract selectors");
    switch (row.kind) {
        case "decide":
            break;
        case "choose":
            if (!Object.values(object(row.options)).every((item) => typeof item === "string"))
                throw new Error("invalid options");
            break;
        case "score":
            if (!strings(row.levels) || row.levels.length < 2)
                throw new Error("invalid score levels");
            break;
        case "tag":
            if (!strings(row.labels)) throw new Error("invalid tag labels");
            break;
        default:
            throw new Error("invalid question kind");
    }
    if (row.adverse !== undefined && !["boolean", "string", "number"].includes(typeof row.adverse))
        throw new Error("invalid adverse outcome");
}

function assertMeasurement(value: unknown): asserts value is Measurement {
    const row = object(value);
    if (row.schemaVersion !== 1) throw new Error("invalid measurement schema");
    requiredStrings(row, ["id", "unitId"]);
    assertContract(row.contract);
    const record = validateEvidence(row.record);
    if (row.unitId !== record.id || row.id !== `${record.id}::${row.contract.id}`)
        throw new Error("measurement identity mismatch");
    parseBand(row.band);
    if (
        !["answered", "abstained", "insufficient_evidence", "unassessed", "failed"].includes(
            String(row.status),
        )
    )
        throw new Error("invalid measurement state");
    if (row.raw !== null) parseAnswer(row.raw, row.contract);
    if (["answered", "abstained"].includes(String(row.status)) && row.raw === null)
        throw new Error("answered measurement lacks probabilities");
    validateProvenance(row.provenance);
    if (row.reason !== undefined && typeof row.reason !== "string")
        throw new Error("invalid outcome reason");
    if (!validOutcome(row.value)) throw new Error("invalid outcome value");
}

export function validateMetricContract(value: unknown): MetricContract {
    assertContract(value);
    return value;
}

function validOutcome(value: unknown): boolean {
    return (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        strings(value)
    );
}

function validateProvenance(value: unknown): void {
    const row = object(value);
    requiredStrings(row, [
        "evidenceVersion",
        "questionHash",
        "requestedModel",
        "modelIdentity",
        "adapterVersion",
    ]);
    for (const key of ["servedModel", "requestHash"])
        if (row[key] !== null && typeof row[key] !== "string") throw new Error(`invalid ${key}`);
    if (
        row.calibrationVersion !== "unvalidated" ||
        row.aggregationVersion !== "semantic-metrics-v1"
    )
        throw new Error("unsupported interpretation version");
    if (
        !strings(row.batch) ||
        typeof row.cached !== "boolean" ||
        typeof row.durationMs !== "number"
    )
        throw new Error("invalid measurement provenance");
}

export function validateRun(value: unknown): DecisionRun {
    const run = object(value);
    if (run.schemaVersion !== 1 || !Array.isArray(run.measurements))
        throw new Error("invalid decision run");
    if (
        typeof run.runId !== "string" ||
        typeof run.startedAt !== "string" ||
        typeof run.completedAt !== "string"
    )
        throw new Error("invalid run identity");
    if (run.mode !== "plan" && run.mode !== "measure") throw new Error("invalid run mode");
    const measurements = run.measurements.map((value) => {
        assertMeasurement(value);
        return value;
    });
    if (new Set(measurements.map((row) => row.id)).size !== measurements.length)
        throw new Error("duplicate measurement IDs");
    const result: DecisionRun = {
        schemaVersion: 1,
        runId: run.runId,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        mode: run.mode,
        measurements,
        ...summarize(measurements),
    };
    if (typeof run.runtimeFailure === "string") result.runtimeFailure = run.runtimeFailure;
    return result;
}
