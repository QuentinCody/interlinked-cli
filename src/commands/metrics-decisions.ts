import { dirname, join, resolve } from "node:path";
import {
    readEvidenceRecords as records,
    readDecisionRun as readRun,
} from "../lib/decision-metrics/io.js";
import { decisionResearch, RESEARCH_ACTIONS } from "./metrics-decisions-research.js";
import { auditCohort } from "../lib/decision-metrics/audit.js";
import { auditComparison } from "../lib/decision-metrics/comparison-audit.js";
import { enrichBca } from "../lib/decision-metrics/bca-evidence.js";
import {
    DEFAULT_CONFIG,
    parseBand,
    parseConfig,
    readDecisionConfig,
} from "../lib/decision-metrics/config.js";
import { CATALOG, questionSet } from "../lib/decision-metrics/contracts.js";
import { collectChange } from "../lib/decision-metrics/git-evidence.js";
import { measurePopulation, reinterpretRun } from "../lib/decision-metrics/pipeline.js";
import { decisionExitCode } from "../lib/decision-metrics/outcome.js";
import {
    compare,
    measureAtomicity,
    measureFaithfulness,
    relateInContext,
    resolveObligations,
    type PopulationMeasure,
} from "../lib/decision-metrics/relational-analysis.js";
import { diffRuns, validateAuditCase } from "../lib/decision-metrics/reports.js";
import { embedInputs } from "../lib/decision-metrics/runtime.js";
import { privateDirectory, readJson, saveImmutable } from "../lib/decision-metrics/store.js";
import type { DecisionConfig, EvidenceRecord } from "../lib/decision-metrics/types.js";

export interface DecisionsOptions {
    cwd?: string;
    output?: string;
    config?: string;
    metrics?: string;
    band?: string;
    base?: string;
    revision?: string;
    file?: string[];
    message?: string;
    plan?: boolean;
    fresh?: boolean;
    analysis?: string;
    claims?: string;
    cutoff?: string;
    after?: string;
    json?: boolean;
    command?: string;
    maxRecords?: string;
    corpus?: string;
    retrieval?: string;
    count?: string;
    before?: string;
    labels?: string;
    maxFiles?: string;
    bcaCommand?: string;
    bcaVersion?: string;
    unit?: string;
    comparison?: string;
}

function configuration(root: string, options: DecisionsOptions): DecisionConfig {
    const config = options.config
        ? parseConfig(readJson(resolve(root, options.config)))
        : readDecisionConfig(root);
    const overrides: Record<string, unknown> = {};
    if (options.metrics) overrides.metrics = options.metrics.split(",");
    if (options.band) overrides.band = parseBand(options.band);
    if (options.command) overrides.command = options.command;
    if (options.maxRecords) overrides.maxRecords = Number(options.maxRecords);
    return parseConfig({ ...config, ...overrides });
}

function emit(value: unknown, root: string, options: DecisionsOptions): void {
    if (options.output) {
        const path = resolve(root, options.output);
        privateDirectory(dirname(path));
        saveImmutable(path, value);
    } else console.log(JSON.stringify(value, null, 2));
}

async function review(
    root: string,
    input: EvidenceRecord[],
    config: DecisionConfig,
    options: DecisionsOptions,
): Promise<unknown> {
    const deadline = Date.now() + config.deadlineMs;
    const measure: PopulationMeasure = async (population, metric) =>
        (
            await measurePopulation(
                root,
                population,
                { ...config, metrics: [metric] },
                { plan: options.plan === true, fresh: options.fresh === true, deadline },
            )
        ).measurements;
    switch (options.analysis ?? "atomicity") {
        case "atomicity":
            return measureAtomicity(input, measure);
        case "obligations":
            return resolveObligations(input, measure);
        case "coupling":
            return relateInContext(input, measure);
        case "rework":
            return measure(input, "corrective_rework");
        case "compare": {
            if (input.length !== 1) throw new Error("compare requires one evidence pair");
            return compare(input[0]!, measure);
        }
        case "faithfulness": {
            const claims: unknown = options.claims
                ? readJson(resolve(root, options.claims))
                : String(input[0]?.evidence.message ?? "")
                      .split(/\n+/)
                      .filter(Boolean);
            if (!Array.isArray(claims) || claims.some((claim) => typeof claim !== "string"))
                throw new Error("claims must be a JSON string array");
            return measureFaithfulness(input, claims as string[], measure); // SAFETY: claims validated above.
        }
        default:
            throw new Error("unknown relational analysis");
    }
}

async function prepareChange(root: string, options: DecisionsOptions): Promise<EvidenceRecord[]> {
    const records = collectChange(root, {
        ...(options.base ? { base: options.base } : {}),
        ...(options.revision ? { revision: options.revision } : {}),
        ...(options.file ? { files: options.file } : {}),
        ...(options.message ? { message: options.message } : {}),
    });
    const units = options.unit ?? "all";
    if (!["all", "function", "hunk"].includes(units))
        throw new Error("unit must be all, function, or hunk");
    const selected = records.filter((row) => units === "all" || row.unit === units);
    if (!options.bcaCommand) return selected;
    if (!options.bcaVersion)
        throw new Error("--bca-command requires the exact --bca-version output");
    return enrichBca(root, selected, {
        command: options.bcaCommand,
        version: options.bcaVersion,
        deadline: Date.now() + 120000,
        ...(options.revision ? { revision: options.revision } : {}),
    });
}

async function execute(
    action: string,
    argument: string | undefined,
    options: DecisionsOptions,
    root: string,
): Promise<unknown> {
    const config = configuration(root, options);
    if (RESEARCH_ACTIONS.includes(action))
        return decisionResearch(action, argument, root, config, options);
    switch (action) {
        case "init": {
            privateDirectory(join(root, ".interlinked"));
            saveImmutable(join(root, ".interlinked", "decision-metrics.json"), DEFAULT_CONFIG);
            return { initialized: true, enabled: false, hookEnabled: false };
        }
        case "catalog":
            return {
                version: 1,
                calibration: "unvalidated",
                contracts: Object.values(CATALOG),
                questionSet: questionSet(
                    config.metrics.map((id) => CATALOG[id]!),
                    config.band,
                ),
            };
        case "prepare":
            return prepareChange(root, options);
        case "measure":
            return measurePopulation(root, records(argument), config, {
                plan: options.plan === true,
                fresh: options.fresh === true,
            });
        case "review":
            return review(root, records(argument), config, options);
        case "replay":
            return reinterpretRun(readRun(argument), config.band);
        case "diff":
            return diffRuns(
                readRun(argument),
                readRun(options.after ? resolve(root, options.after) : undefined),
            );
        case "audit": {
            return auditInput(argument, options, root, config);
        }
        case "embed": {
            const input = records(argument);
            const texts = input.map((row) => String(row.evidence.body ?? row.evidence.hunk ?? ""));
            const embedded = await embedInputs(
                config,
                texts.map((text) => ({ text, role: "similarity" })),
                Date.now() + config.deadlineMs,
                join(root, ".interlinked", "decision-metrics", "embeddings"),
            );
            return {
                modelIdentity: embedded.identity,
                embeddingProfile: embedded.profile,
                records: input.map((row, i) => ({
                    ...row,
                    evidence: {
                        ...row.evidence,
                        embedding: embedded.vectors[i]!,
                        embeddingModelIdentity: embedded.identity,
                        embeddingProfile: embedded.profile,
                    },
                })),
            };
        }
        default:
            throw new Error(`unknown decision action: ${action}`);
    }
}

function auditInput(
    argument: string | undefined,
    options: DecisionsOptions,
    root: string,
    config: DecisionConfig,
): unknown {
    if (!argument || !options.cutoff) throw new Error("audit requires cases and --cutoff");
    const value = readJson(argument);
    if (!Array.isArray(value)) throw new Error("audit requires a full labeled cohort array");
    const cases = value.map(validateAuditCase);
    const policy = { cutoff: options.cutoff, band: config.band };
    if (!options.comparison) return auditCohort(cases, policy);
    const other = readJson(resolve(root, options.comparison));
    if (!Array.isArray(other)) throw new Error("comparison requires a full labeled cohort array");
    return auditComparison(cases, other.map(validateAuditCase), policy);
}

export async function decisionsAction(
    action: string,
    argument: string | undefined,
    options: DecisionsOptions,
): Promise<number> {
    const root = resolve(options.cwd ?? process.cwd());
    try {
        const result = await execute(
            action,
            argument ? resolve(root, argument) : undefined,
            options,
            root,
        );
        emit(result, root, options);
        return decisionExitCode(result);
    } catch (error) {
        console.error(
            JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : "decision metrics failed",
            }),
        );
        return 2;
    }
}
