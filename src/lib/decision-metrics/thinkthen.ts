import { readdirSync } from "node:fs";
import { join } from "node:path";
import { object, parseAnswer } from "./answers.js";
import { decisionChildEnvironment } from "./config.js";
import { questionSet } from "./contracts.js";
import { readJson, saveImmutable } from "./store.js";
import { runCommand, startRecorder } from "./transport.js";
import type { DecisionConfig, EvidenceRecord, MetricContract, RawAnswer } from "./types.js";

export interface BackendAnswer {
    metric: string;
    raw: RawAnswer | null;
    servedModel: string | null;
    adapterVersion: string;
    requestHash: string | null;
    requestHashes?: string[];
    questionKey?: string;
    failure?: string;
}

export function decodeAnnotated(
    stdout: string,
    id: string,
    contracts: MetricContract[],
): BackendAnswer[] {
    const lines = stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("expected exactly one annotated record");
    const row = object(JSON.parse(lines[0]!));
    if (row.schema !== "thinkthen.result/1" || object(row.input).id !== id)
        throw new Error("ThinkThen schema or record identity mismatch");
    const meta = object(row.meta);
    if (typeof meta.model !== "string" || typeof meta.tool !== "string")
        throw new Error("missing served model or adapter identity");
    const answers = object(row.answers);
    return contracts.map((contract) => decodeQuestion(answers[contract.id], contract, meta));
}

function decodeQuestion(
    value: unknown,
    contract: MetricContract,
    meta: Record<string, unknown>,
): BackendAnswer {
    const result: BackendAnswer = {
        metric: contract.id,
        raw: null,
        servedModel: String(meta.model),
        adapterVersion: String(meta.tool),
        requestHash: null,
    };
    if (value === undefined) return { ...result, failure: "missing question in backend response" };
    try {
        const answer = object(value);
        if (answer.failure) return { ...result, failure: "backend question failed" };
        result.raw = parseAnswer(answer.answer, contract);
        if (typeof answer.request === "string") result.questionKey = answer.request;
        return result;
    } catch {
        return { ...result, failure: "malformed backend probability distribution" };
    }
}

function recordedRequestHashes(folder: string): string[] {
    const exchanges = join(folder, "exchanges");
    return readdirSync(exchanges)
        .map((file) => object(readJson(join(exchanges, file))).requestHash)
        .filter((hash): hash is string => typeof hash === "string");
}

export async function annotate(
    config: DecisionConfig,
    record: EvidenceRecord,
    contracts: MetricContract[],
    options: { folder: string; deadline: number; plan: boolean },
): Promise<BackendAnswer[]> {
    const questionPath = join(options.folder, "questions.json");
    saveImmutable(questionPath, questionSet(contracts, config.band));
    const input = { ...record.evidence, id: record.id };
    saveImmutable(join(options.folder, "input.json"), input);
    const recorder = options.plan
        ? null
        : await startRecorder(config, join(options.folder, "exchanges"), options.deadline);
    const url = recorder?.url ?? config.url;
    const args = [
        "annotate",
        questionPath,
        "--jsonl",
        "--details",
        "--facts",
        "--batch",
        "1",
        "--jobs",
        "1",
        "--backend",
        config.backend,
        "--url",
        url,
        "--model",
        config.model,
        "--max-retries",
        "0",
        "--no-cache",
        "--max-request-bytes",
        String(config.maxRequestBytes),
        "--timeout",
        String(Math.max(1, Math.ceil((options.deadline - Date.now()) / 1000))),
    ];
    if (options.plan) args.push("--plan");
    try {
        const result = await runCommand(config.command, args, {
            timeoutMs: options.deadline - Date.now(),
            input: `${JSON.stringify(input)}\n`,
            env: decisionChildEnvironment(config.backend),
        });
        // stderr can contain provider diagnostics. Retain structured outcomes, not arbitrary diagnostics or credentials.
        saveImmutable(join(options.folder, "command.json"), {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
        });
        if (result.timedOut) throw new Error("ThinkThen deadline exceeded");
        if (options.plan) {
            if (result.exitCode !== 0)
                throw new Error(`ThinkThen plan failed (${result.exitCode})`);
            return [];
        }
        if (result.exitCode !== 0 && result.exitCode !== 6)
            throw new Error(`ThinkThen failed (${result.exitCode})`);
        const requestHashes = recordedRequestHashes(options.folder);
        return decodeAnnotated(result.stdout, record.id, contracts).map((answer) => ({
            ...answer,
            requestHashes,
            requestHash: requestHashes.length === 1 ? requestHashes[0]! : null,
        }));
    } finally {
        await recorder?.close();
    }
}
