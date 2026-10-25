import type { JevAnswer, JevQuestion, JevResponse } from "../../src/harness/jev/types.js";
import { redactE20 } from "../../src/harness/jev/decision-shadow-redact.js";

export function validateAnswers(questions: Record<string, JevQuestion>, answers: Record<string, JevAnswer>): void {
    const probability = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
    for (const [id, question] of Object.entries(questions)) {
        const answer = answers?.[id];
        if (!answer || answer.type !== question.type) throw new Error("Missing or wrong answer type");
        if (answer.type === "noul" && !probability(answer.noul)) throw new Error("Invalid probability");
        if (answer.type === "choice" && question.type === "choice") {
            if (JSON.stringify(Object.keys(question.criteria).sort()) !== JSON.stringify(Object.keys(answer.probabilities).sort())
                || !(answer.choice in question.criteria)) throw new Error("Invalid choice options");
            const values = Object.values(answer.probabilities);
            if (!values.every(probability) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.02) throw new Error("Invalid choice probability");
        }
    }
}

interface Options {
    model: "jev-1.13.0" | "clef-flash"; token: string; account?: string; remainingUsd: number;
    save: (name: string, value: unknown) => void; fetchImpl?: typeof fetch;
}

function prepareRequest(options: Options, state: unknown, questions: Record<string, JevQuestion>) {
    if (!options.token || (options.model === "clef-flash" && !options.account)) throw new Error("Missing credentials");
    if (!Object.keys(questions).length || Object.keys(questions).length > 60) throw new Error("Question batch outside 1..60");
    const request = { model: options.model, state, questions }, body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 70_000) throw new Error("Request exceeds conservative context budget");
    if (redactE20(body) !== body) throw new Error("Request requires credential redaction");
    return { request, body };
}

function decisionEndpoint(options: Options): string {
    return options.model === "clef-flash"
        ? `https://api.cloudflare.com/client/v4/accounts/${options.account}/ai/run/@cf/cloudflare/clef-flash`
        : "https://api.typesafe.ai/v1/systemone";
}

export function createDecisionClient(options: Options) {
    let count = 0, estimatedUsd = 0, unknownCostCalls = 0;
    const latencies: number[] = [];
    const rate = options.model === "clef-flash" ? 0.038 : 0.042;
    return {
        usage: () => ({ model: options.model, calls: count, estimatedUsd, unknownCostCalls, latenciesMs: latencies }),
        async ask(label: string, state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse> {
            if (estimatedUsd + unknownCostCalls * 0.15 + 0.15 > options.remainingUsd) throw new Error("Experiment budget reserve exhausted");
            const { request, body } = prepareRequest(options, state, questions);
            const id = count++, start = performance.now(), startedAt = new Date().toISOString();
            const url = decisionEndpoint(options);
            let recorded = false;
            try {
                const response = await (options.fetchImpl ?? fetch)(url, { method: "POST", body,
                    headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
                    signal: AbortSignal.timeout(30_000) });
                const raw = await response.text();
                const envelope = JSON.parse(raw);
                const result: JevResponse = options.model === "clef-flash" ? envelope.result : envelope;
                const tokens = result?.usage?.input_tokens;
                const measured = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0;
                const cost = measured ? tokens * rate / 1_000_000 : null;
                if (cost === null) unknownCostCalls++; else estimatedUsd += cost;
                const latencyMs = performance.now() - start; latencies.push(latencyMs);
                options.save(`call-${id}.json`, { label, startedAt, request, httpStatus: response.status, rawResponse: raw,
                    latencyMs, estimatedUsd: cost, returnedModel: result?.model ?? null });
                recorded = true;
                if (!response.ok || (options.model === "clef-flash" && !envelope.success)) throw new Error(`Model HTTP failure ${response.status}`);
                validateAnswers(questions, result.answers);
                return result;
            } catch (error) {
                if (!recorded) {
                    unknownCostCalls++;
                    options.save(`call-${id}.json`, { label, startedAt, request, error: error instanceof Error ? error.name : "unknown",
                        latencyMs: performance.now() - start, estimatedUsd: null });
                }
                throw error;
            }
        },
    };
}
export type DecisionClient = ReturnType<typeof createDecisionClient>;
