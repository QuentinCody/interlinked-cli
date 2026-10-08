import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceFileEffect } from "../../harness/workspace-effects.js";
import { readDecisionConfig } from "./config.js";
import { extractChangedEvidence } from "./evidence.js";
import { workingFile } from "./git-evidence.js";
import { measurePopulation } from "./pipeline.js";
import { probabilityFor } from "./reports.js";
import { digest, privateDirectory, readJson, saveImmutable } from "./store.js";
import { object, adverseAnswer } from "./answers.js";
import { runCommand } from "./transport.js";
import type { DecisionConfig, DecisionRun, EvidenceRecord, Measurement } from "./types.js";

type HookMeasure = (
    root: string,
    records: EvidenceRecord[],
    config: DecisionConfig,
    options: { deadline: number },
) => Promise<DecisionRun>;
const MAX_SOURCE_BYTES = 1000000;

export function captureDecisionPreimages(
    root: string,
    effects: WorkspaceFileEffect[],
    readCached: (file: string) => string | null,
): Map<string, string> {
    const result = new Map<string, string>();
    if (!existsSync(join(root, ".interlinked", "decision-metrics.json"))) return result;
    for (const effect of effects) {
        const content = readCached(effect.path);
        if (content !== null && digest(content) === effect.before_sha256)
            result.set(effect.path, content);
    }
    return result;
}

function snapshotPath(root: string, file: string, hash: string): string {
    const folder = join(root, ".interlinked", "decision-metrics", "sources", digest(file));
    privateDirectory(folder);
    return join(folder, `${hash}.json`);
}

function beforeSource(
    root: string,
    effect: WorkspaceFileEffect,
    preimages: Map<string, string>,
): string | null {
    if (effect.kind === "created") return "";
    if (!effect.before_sha256 || !/^[a-f0-9]{64}$/.test(effect.before_sha256)) return null;
    const cached = preimages.get(effect.path);
    if (cached !== undefined && digest(cached) === effect.before_sha256) return cached;
    const path = snapshotPath(root, effect.path, effect.before_sha256);
    if (!existsSync(path)) return null;
    const saved = object(readJson(path));
    return typeof saved.source === "string" && digest(saved.source) === effect.before_sha256
        ? saved.source
        : null;
}

async function sourceDiff(before: string, after: string, deadline: number): Promise<string> {
    const folder = mkdtempSync(join(tmpdir(), "decision-diff-"));
    try {
        const a = join(folder, "before"),
            b = join(folder, "after");
        writeFileSync(a, before, { mode: 0o600 });
        writeFileSync(b, after, { mode: 0o600 });
        const result = await runCommand(
            "git",
            [
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--diff-algorithm=myers",
                "--unified=3",
                "--",
                a,
                b,
            ],
            { timeoutMs: deadline - Date.now() },
        );
        if (result.timedOut || ![0, 1].includes(result.exitCode ?? -1))
            throw new Error("bounded source diff failed");
        return result.stdout;
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}

async function hookRecords(
    root: string,
    effect: WorkspaceFileEffect,
    preimages: Map<string, string>,
    deadline: number,
): Promise<{ records: EvidenceRecord[]; warning?: string }> {
    const after = effect.kind === "deleted" ? "" : workingFile(root, effect.path);
    if (Buffer.byteLength(after) > MAX_SOURCE_BYTES)
        return { records: [], warning: `${effect.path}: source exceeds hook budget; unassessed` };
    if (effect.kind !== "deleted" && digest(after) !== effect.after_sha256)
        return {
            records: [],
            warning: `${effect.path}: file changed after the observed edit; unassessed`,
        };
    const before = beforeSource(root, effect, preimages);
    saveImmutable(snapshotPath(root, effect.path, digest(after)), { source: after });
    if (before === null)
        return {
            records: [],
            warning: `${effect.path}: exact pre-edit source unavailable; baseline captured, edit unassessed`,
        };
    const diff = await sourceDiff(before, after, deadline);
    const source = {
        repository: root,
        revision: `edit:${digest(after)}`,
        timestamp: new Date().toISOString(),
        message: "",
        file: effect.path,
        before,
        after,
        diff,
    };
    const current = extractChangedEvidence(source).filter((row) => row.unit === "function");
    const previous = extractChangedEvidence({
        ...source,
        revision: `edit:${digest(before)}`,
        after: before,
        diff: "",
        allFunctions: true,
    });
    const records: EvidenceRecord[] = [];
    for (const row of current) {
        const prior = previous.find((candidate) => candidate.id === row.id);
        if (prior) records.push({ ...prior, id: `before:${prior.id}` });
        records.push({ ...row, id: `after:${row.id}` });
    }
    return {
        records,
        ...(current.length
            ? {}
            : {
                  warning: `${effect.path}: no supported touched function; hunk-only review remains unassessed`,
              }),
    };
}

function advice(run: DecisionRun): string[] {
    const warnings: string[] = run.runtimeFailure
        ? [
              "local runtime cleanup failed; inference observations are retained, but exclusive model residency was not confirmed",
          ]
        : [];
    for (const row of run.measurements.filter((item) => item.unitId.startsWith("after:"))) {
        const path = `${row.record.file}:${row.record.line} ${row.contract.id}`;
        if (row.status !== "answered") {
            warnings.push(`${path}: ${row.status}${row.reason ? ` (${row.reason})` : ""}`);
            continue;
        }
        const risk = probabilityFor(row);
        if (risk === null || !row.raw || !adverseAnswer(row.contract, row.raw, row.band)) continue;
        const beforeId = row.unitId.replace(/^after:/, "before:");
        const prior = run.measurements.find(
            (item) => item.unitId === beforeId && item.contract.id === row.contract.id,
        );
        const baseline = comparableBaseline(prior, row);
        if (baseline !== null && prior?.raw && adverseAnswer(prior.contract, prior.raw, prior.band))
            continue;
        warnings.push(
            `${path}: ${baseline === null ? "adverse judgment; baseline unavailable" : "adverse judgment increased"}, p=${risk.toFixed(3)}. Review supplied evidence; model is uncalibrated on code.`,
        );
    }
    return warnings;
}

function comparableBaseline(prior: Measurement | undefined, current: Measurement): number | null {
    if (!prior || prior.status !== "answered") return null;
    if (
        prior.provenance.modelIdentity !== current.provenance.modelIdentity ||
        prior.provenance.questionHash !== current.provenance.questionHash
    )
        return null;
    return probabilityFor(prior);
}

export async function decisionHookAdvice(
    root: string,
    effects: WorkspaceFileEffect[],
    options: { dryRun?: boolean; preimages?: Map<string, string>; measure?: HookMeasure } = {},
): Promise<string[]> {
    if (options.dryRun || !existsSync(join(root, ".interlinked", "decision-metrics.json")))
        return [];
    try {
        const config = readDecisionConfig(root);
        if (!config.enabled || !config.hook.enabled) return [];
        const deadline = Date.now() + config.hook.deadlineMs;
        const warnings: string[] = [],
            records: EvidenceRecord[] = [];
        for (const effect of effects) {
            if (Date.now() >= deadline) {
                warnings.push("remaining edited files exceeded hook deadline; unassessed");
                break;
            }
            const result = await hookRecords(
                root,
                effect,
                options.preimages ?? new Map(),
                deadline,
            );
            records.push(...result.records);
            if (result.warning) warnings.push(result.warning);
        }
        if (!effects.length) warnings.push("observed file hashes unavailable; edit unassessed");
        if (records.length) {
            const run = await (options.measure ?? measurePopulation)(
                root,
                records,
                {
                    ...config,
                    metrics: config.hook.metrics,
                    maxRecords: config.hook.maxRecords * 2,
                    deadlineMs: config.hook.deadlineMs,
                },
                { deadline },
            );
            warnings.push(...advice(run));
        }
        return warnings.map((warning) => `[interlinked:decision-metrics] Advisory: ${warning}`);
    } catch {
        return [
            "[interlinked:decision-metrics] Advisory: measurement failed; no semantic quality verdict is available. Inspect decision run records.",
        ];
    }
}
