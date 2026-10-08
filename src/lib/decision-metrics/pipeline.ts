import { randomUUID } from "node:crypto";
import { adapterIdentity } from "./adapter-identity.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { interpretAnswer, object, parseAnswer } from "./answers.js";
import { CATALOG, selectEvidence } from "./contracts.js";
import { withLocalModel } from "./runtime.js";
import { digest, privateDirectory, readJson, saveImmutable } from "./store.js";
import { annotate, type BackendAnswer } from "./thinkthen.js";
import type {
    Band,
    DecisionConfig,
    DecisionRun,
    EvidenceRecord,
    Measurement,
    MeasurementStatus,
    MetricContract,
} from "./types.js";

interface MeasureOptions {
    plan?: boolean;
    fresh?: boolean;
    deadline?: number;
}
type Backend = (
    record: EvidenceRecord,
    contracts: MetricContract[],
    folder: string,
    deadline: number,
) => Promise<BackendAnswer[]>;
interface Execution extends MeasureOptions {
    identity: string;
    backend: Backend;
    adapterIdentity?: string;
}

function pending(
    record: EvidenceRecord,
    contract: MetricContract,
    config: DecisionConfig,
    identity: string,
): Measurement {
    return {
        schemaVersion: 1,
        id: `${record.id}::${contract.id}`,
        unitId: record.id,
        contract,
        record,
        raw: null,
        status: "unassessed",
        value: null,
        band: config.band,
        provenance: {
            evidenceVersion: digest(record.evidence),
            questionHash: digest(contract),
            requestedModel: config.model,
            servedModel: null,
            modelIdentity: identity,
            calibrationVersion: "unvalidated",
            aggregationVersion: "semantic-metrics-v1",
            requestHash: null,
            batch: [],
            adapterVersion: "thinkthen-cli-v1",
            cached: false,
            durationMs: 0,
        },
    };
}

function prepare(
    record: EvidenceRecord,
    contracts: MetricContract[],
    config: DecisionConfig,
    identity: string,
    skipped: boolean,
): Measurement[] {
    return contracts.map((contract) => {
        const row = pending(record, contract, config, identity);
        if (skipped || record.eligible === false)
            return {
                ...row,
                reason: record.reason ?? "candidate or deadline/record budget excluded",
            };
        try {
            const evidence = selectEvidence(record.evidence, contract.on);
            if (Buffer.byteLength(JSON.stringify(evidence)) > config.maxEvidenceBytes)
                return { ...row, reason: "evidence byte budget exceeded; not truncated" };
            return row;
        } catch {
            return {
                ...row,
                status: "insufficient_evidence",
                reason: "required evidence selector is absent",
            };
        }
    });
}

function cacheAnswers(value: unknown, contracts: MetricContract[]): BackendAnswer[] {
    if (!Array.isArray(value) || value.length !== contracts.length)
        throw new Error("invalid decision cache");
    return value.map((item, index) => {
        const answer = object(item);
        const contract = contracts[index]!;
        if (
            answer.metric !== contract.id ||
            typeof answer.servedModel !== "string" ||
            typeof answer.adapterVersion !== "string"
        )
            throw new Error("cache identity mismatch");
        const decoded: BackendAnswer = {
            metric: contract.id,
            raw: parseAnswer(answer.raw, contract),
            servedModel: answer.servedModel,
            adapterVersion: answer.adapterVersion,
            requestHash: typeof answer.requestHash === "string" ? answer.requestHash : null,
        };
        if (
            Array.isArray(answer.requestHashes) &&
            answer.requestHashes.every((hash): hash is string => typeof hash === "string")
        )
            decoded.requestHashes = answer.requestHashes;
        if (typeof answer.questionKey === "string") decoded.questionKey = answer.questionKey;
        return decoded;
    });
}

function applyAnswers(
    rows: Measurement[],
    answers: BackendAnswer[],
    cached: boolean,
    durationMs: number,
): void {
    for (const row of rows) {
        const answer = answers.find((item) => item.metric === row.contract.id);
        row.provenance.batch = rows.map((item) => item.contract.id);
        row.provenance.durationMs = durationMs;
        row.provenance.cached = cached;
        if (!answer?.raw) {
            row.status = "failed";
            row.reason = answer?.failure ?? "backend omitted question";
            continue;
        }
        row.raw = answer.raw;
        row.provenance.servedModel = answer.servedModel;
        row.provenance.adapterVersion = answer.adapterVersion;
        row.provenance.requestHash = answer.requestHash;
        if (answer.requestHashes) row.provenance.requestHashes = answer.requestHashes;
        if (answer.questionKey) row.provenance.questionKey = answer.questionKey;
        Object.assign(row, interpretAnswer(row.contract, answer.raw, row.band));
    }
}

function markRows(rows: Measurement[], status: MeasurementStatus, reason: string): void {
    for (const row of rows) Object.assign(row, { status, reason });
}

async function measureRecord(
    record: EvidenceRecord,
    rows: Measurement[],
    config: DecisionConfig,
    execution: Execution,
    folder: string,
    cacheDir: string,
    deadline: number,
): Promise<void> {
    const active = rows.filter((row) => row.status === "unassessed" && !row.reason);
    if (!active.length) return;
    const contracts = active.map((row) => row.contract);
    const selected = contracts.map((contract) => selectEvidence(record.evidence, contract.on));
    const cacheKey = digest({
        identity: execution.identity,
        adapter: execution.adapterIdentity ?? config.command,
        endpoint: config.url,
        contracts,
        selected,
    });
    for (const row of rows)
        row.provenance.adapterIdentity = execution.adapterIdentity ?? config.command;
    const cachePath = join(cacheDir, `${cacheKey}.json`);
    const start = Date.now();
    privateDirectory(folder);
    try {
        const cached = !execution.plan && !execution.fresh && existsSync(cachePath);
        const answers = cached
            ? cacheAnswers(readJson(cachePath), contracts)
            : await execution.backend(record, contracts, folder, deadline);
        if (execution.plan) {
            markRows(active, "unassessed", "plan only; no inference");
            return;
        }
        applyAnswers(active, answers, cached, Date.now() - start);
        if (
            !cached &&
            answers.length === contracts.length &&
            answers.every((answer) => answer.raw && !answer.failure)
        ) {
            // Fresh runs remain immutable separate observations; never overwrite the reusable first answer.
            if (!existsSync(cachePath)) saveImmutable(cachePath, answers);
        }
    } catch (error) {
        markRows(active, "failed", error instanceof Error ? error.message : "measurement failed");
    }
}

export function summarize(
    measurements: Measurement[],
): Pick<DecisionRun, "summary" | "population" | "measured" | "completion"> {
    const summary: Record<MeasurementStatus, number> = {
        answered: 0,
        insufficient_evidence: 0,
        abstained: 0,
        failed: 0,
        unassessed: 0,
    };
    for (const row of measurements) summary[row.status]++;
    const measured = measurements.filter((row) => row.raw !== null).length;
    return {
        summary,
        population: measurements.length,
        measured,
        completion: measurements.length ? measured / measurements.length : 0,
    };
}

export async function measureWithBackend(
    root: string,
    records: EvidenceRecord[],
    config: DecisionConfig,
    execution: Execution,
): Promise<DecisionRun> {
    const startedAt = new Date().toISOString();
    const deadline = execution.deadline ?? Date.now() + config.deadlineMs;
    const runId = randomUUID();
    const directory = join(root, ".interlinked", "decision-metrics");
    const runDir = join(directory, "runs", runId);
    const cacheDir = join(directory, "cache");
    privateDirectory(runDir);
    privateDirectory(cacheDir);
    const contracts = config.metrics.map((id) => {
        const contract = CATALOG[id];
        if (!contract) throw new Error(`unknown metric: ${id}`);
        return contract;
    });
    if (new Set(records.map((record) => record.id)).size !== records.length)
        throw new Error("duplicate unit IDs in population");
    const measurements: Measurement[] = [];
    for (const [index, record] of records.entries()) {
        const rows = prepare(
            record,
            contracts,
            config,
            execution.identity,
            index >= config.maxRecords || Date.now() >= deadline,
        );
        await measureRecord(
            record,
            rows,
            config,
            execution,
            join(runDir, String(index)),
            cacheDir,
            deadline,
        );
        measurements.push(...rows);
    }
    const run: DecisionRun = {
        schemaVersion: 1,
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        mode: execution.plan ? "plan" : "measure",
        measurements,
        ...summarize(measurements),
    };
    saveImmutable(join(runDir, "run.json"), run);
    return run;
}

export async function measurePopulation(
    root: string,
    records: EvidenceRecord[],
    config: DecisionConfig,
    options: MeasureOptions = {},
): Promise<DecisionRun> {
    const deadline = options.deadline ?? Date.now() + config.deadlineMs;
    if (Date.now() >= deadline)
        return measureWithBackend(root, records, config, {
            ...options,
            deadline,
            identity: `unassessed:${config.model}`,
            backend: async () => [],
        });
    let completed: DecisionRun | undefined;
    try {
        const adapter = adapterIdentity(config.command);
        const run = async (identity: string) => {
            completed = await measureWithBackend(root, records, config, {
                ...options,
                adapterIdentity: adapter,
                deadline,
                identity,
                backend: (record, contracts, folder, end) =>
                    annotate(config, record, contracts, {
                        folder,
                        deadline: end,
                        plan: options.plan === true,
                    }),
            });
            return completed;
        };
        if (options.plan) return await run(`planned:${config.model}`);
        if (config.backend === "ollama")
            return await withLocalModel(config, config.model, deadline, run);
        return await run(`${config.backend}:${config.model}`);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "decision runtime unavailable";
        if (completed) {
            saveImmutable(
                join(
                    root,
                    ".interlinked",
                    "decision-metrics",
                    "runs",
                    completed.runId,
                    "runtime-failure.json",
                ),
                { reason },
            );
            return { ...completed, runtimeFailure: reason };
        }
        return measureWithBackend(root, records, config, {
            ...options,
            deadline,
            identity: `unavailable:${config.model}`,
            backend: async () => {
                throw new Error(reason, { cause: error });
            },
        });
    }
}

export function reinterpretRun(run: DecisionRun, band: Band): DecisionRun {
    const measurements = run.measurements.map((row) => {
        if (!row.raw) return row;
        const { reason: _oldReason, ...observation } = row;
        return { ...observation, band, ...interpretAnswer(row.contract, row.raw, band) };
    });
    return { ...run, measurements, ...summarize(measurements) };
}
