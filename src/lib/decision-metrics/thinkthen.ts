// Adapter for the ThinkThen 0.2 command line (`thinkthen annotate <toolbox> --json`).
//
// ThinkThen turns a toolbox of questions and one record into a single System One
// request and one JSON row. The child never reaches the real backend: it is pointed at
// the loopback recorder (`transport.ts`), which speaks `/v1/systemone`, holds the
// upstream credential, enforces the request byte budget and keeps every exchange. So
// the child always uses ThinkThen's `systemone` backend, whichever upstream backend
// the decision config names.
//
// ThinkThen 0.2 has no flag for retries, caching, a timeout or a dry run. It retries a
// 429/5xx reply up to three times (each attempt is recorded); the caller's deadline
// kills the child; a plan uses the built-in offline `stub` backend, which validates
// the toolbox and the record without a request.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { object, parseAnswer } from "./answers.js";
import { decisionChildEnvironment } from "./config.js";
import { evidenceInput, questionSet } from "./contracts.js";
import { readJson, saveImmutable } from "./store.js";
import { runCommand, startRecorder } from "./transport.js";
import type { DecisionConfig, DecisionQuestion, EvidenceRecord, RawAnswer } from "./types.js";

/** Names the row contract this decoder reads. The executable itself is pinned by `adapterIdentity`. */
const ADAPTER_VERSION = "thinkthen-cli-0.2/annotate-json";

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

/**
 * Decode the one row `annotate --json` prints for one record. `servedModel` is the model
 * the backend reported; the row itself only repeats the model ThinkThen asked for.
 */
export function decodeAnnotated(
    stdout: string,
    id: string,
    contracts: DecisionQuestion[],
    servedModel: string | null,
): BackendAnswer[] {
    const lines = stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("expected exactly one annotated record");
    const row = object(JSON.parse(lines[0]!));
    if (row.function !== "annotate") throw new Error("ThinkThen schema mismatch");
    const questionKey = object(row.source).question_identity;
    const base: BackendAnswer = {
        metric: "",
        raw: null,
        servedModel,
        adapterVersion: ADAPTER_VERSION,
        requestHash: null,
        ...(typeof questionKey === "string" ? { questionKey } : {}),
    };
    // A record that fails as a whole carries no id and no per-question answers.
    if (row.status === "failed")
        return contracts.map((contract) => ({
            ...base,
            metric: contract.id,
            failure: failureText("backend record failed", row.error),
        }));
    if (row.id !== id) throw new Error("ThinkThen record identity mismatch");
    const answers = object(row.answer);
    return contracts.map((contract) =>
        decodeQuestion(answers[contract.id], contract, { ...base, metric: contract.id }),
    );
}

function failureText(prefix: string, error: unknown): string {
    // Only the error code is kept: the message can quote a backend reply.
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    return typeof code === "string" ? `${prefix}: ${code}` : prefix;
}

function decodeQuestion(
    value: unknown,
    contract: DecisionQuestion,
    result: BackendAnswer,
): BackendAnswer {
    if (value === undefined) return { ...result, failure: "missing question in backend response" };
    try {
        const answer = object(value);
        if (answer.status === "failed")
            return { ...result, failure: failureText("backend question failed", answer.error) };
        return { ...result, raw: parseAnswer(distribution(answer, contract), contract) };
    } catch {
        return { ...result, failure: "malformed backend probability distribution" };
    }
}

/** Rewrite one 0.2 question answer as the distribution shape `parseAnswer` validates. */
function distribution(answer: Record<string, unknown>, contract: DecisionQuestion): unknown {
    if (answer.function !== contract.kind) throw new Error("answer function mismatch");
    if (contract.kind === "decide") return { kind: "yes_no", probability: answer.probability };
    const detail = object(answer.detail);
    if (contract.kind !== "score")
        return { kind: contract.kind === "choose" ? "choice" : "tag", probabilities: detail.labels };
    // A score lists one probability per level, lowest level first.
    const levels = contract.levels ?? [];
    const listed: unknown = detail.levels;
    if (!Array.isArray(listed) || listed.length !== levels.length)
        throw new Error("score levels mismatch");
    return {
        kind: "score",
        probabilities: Object.fromEntries(levels.map((level, i) => [level, listed[i] as unknown])),
    };
}

/** The model a recorded backend reply names, or null when the reply names none. */
function reportedModel(exchange: Record<string, unknown>): string | null {
    if (exchange.status !== 200 || typeof exchange.responseBody !== "string") return null;
    try {
        const model = object(JSON.parse(exchange.responseBody)).model;
        return typeof model === "string" ? model : null;
    } catch {
        return null; // A reply that is not a JSON object names no model.
    }
}

/** What the recorder kept for this call: every request hash, and the model the backend reported. */
function recordedExchanges(folder: string): { requestHashes: string[]; servedModel: string | null } {
    const exchanges = join(folder, "exchanges");
    const records = readdirSync(exchanges).map((file) => object(readJson(join(exchanges, file))));
    const models = new Set(records.map(reportedModel).filter((model) => model !== null));
    return {
        requestHashes: records
            .map((record) => record.requestHash)
            .filter((hash): hash is string => typeof hash === "string"),
        // Replies that name different models, or none, establish no served model.
        servedModel: models.size === 1 ? [...models][0]! : null,
    };
}

/** The ThinkThen 0.2 arguments for one record on stdin. `url` is the recorder; null plans offline. */
export function annotateArguments(
    config: DecisionConfig,
    questionPath: string,
    url: string | null,
): string[] {
    const shared = ["annotate", questionPath, "--json", "--from", "jsonl", "--batch", "1", "--model", config.model];
    return url === null
        ? [...shared, "--backend", "stub"]
        : [...shared, "--backend", "systemone", "--url", url];
}

export async function annotate(
    config: DecisionConfig,
    record: Pick<EvidenceRecord, "id" | "evidence">,
    contracts: DecisionQuestion[],
    options: { folder: string; deadline: number; plan: boolean },
): Promise<BackendAnswer[]> {
    const questionPath = join(options.folder, "questions.json");
    saveImmutable(questionPath, questionSet(contracts));
    const input = { ...evidenceInput(record.evidence, contracts), id: record.id };
    saveImmutable(join(options.folder, "input.json"), input);
    const recorder = options.plan
        ? null
        : await startRecorder(config, join(options.folder, "exchanges"), options.deadline);
    try {
        const result = await runCommand(
            config.command,
            annotateArguments(config, questionPath, recorder?.url ?? null),
            {
                timeoutMs: options.deadline - Date.now(),
                input: `${JSON.stringify(input)}\n`,
                env: decisionChildEnvironment(),
            },
        );
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
        // Exit 6 means some question or the record failed; the row still says which.
        if (result.exitCode !== 0 && result.exitCode !== 6)
            throw new Error(`ThinkThen failed (${result.exitCode})`);
        const { requestHashes, servedModel } = recordedExchanges(options.folder);
        return decodeAnnotated(result.stdout, record.id, contracts, servedModel).map((answer) => ({
            ...answer,
            requestHashes,
            requestHash: requestHashes.length === 1 ? requestHashes[0]! : null,
        }));
    } finally {
        await recorder?.close();
    }
}
