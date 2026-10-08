import type { Band, Interpretation, MetricContract, RawAnswer } from "./types.js";

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected an object");
    return value as Record<string, unknown>;
}

function probability(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        throw new Error("invalid probability");
    return value;
}

export function parseAnswer(value: unknown, contract: MetricContract): RawAnswer {
    const raw = object(value);
    if (contract.kind === "decide") {
        if (raw.kind !== "yes_no") throw new Error("expected yes_no answer");
        return { kind: "yes_no", probability: probability(raw.probability) };
    }
    const expectedKind = contract.kind === "choose" ? "choice" : contract.kind;
    if (raw.kind !== expectedKind) throw new Error("answer kind mismatch");
    const probabilities = Object.fromEntries(
        Object.entries(object(raw.probabilities)).map(([key, p]) => [key, probability(p)]),
    );
    const ordinalKeys = contract.levels?.map((_, i) => String(i)) ?? [];
    const namedLevels = contract.levels?.every((level) => Object.hasOwn(probabilities, level));
    const expected = contract.options
        ? Object.keys(contract.options)
        : (contract.labels ?? (namedLevels ? contract.levels! : ordinalKeys));
    if (
        Object.keys(probabilities).length !== expected.length ||
        expected.some((key) => !Object.hasOwn(probabilities, key))
    )
        throw new Error("incomplete or unexpected distribution");
    const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
    if (raw.kind !== "tag" && Math.abs(sum - 1) > 0.01)
        throw new Error("distribution does not sum to one");
    const confidence =
        raw.confidence === undefined ? {} : { confidence: probability(raw.confidence) };
    return { kind: raw.kind as "choice" | "score" | "tag", probabilities, ...confidence };
}

export function interpretAnswer(
    contract: MetricContract,
    raw: RawAnswer,
    band: Band,
): Interpretation {
    if (raw.kind === "yes_no") {
        if (raw.probability >= band[1]) return { status: "answered", value: true };
        if (raw.probability < band[0]) return { status: "answered", value: false };
        return { status: "abstained", value: null, reason: "probability inside uncertainty band" };
    }
    const entries = Object.entries(raw.probabilities);
    if (raw.kind === "tag")
        return {
            status: "answered",
            value: entries.filter(([, p]) => p >= band[1]).map(([label]) => label),
        };
    if (raw.kind === "score") {
        const sum = entries.reduce((total, [, p]) => total + p, 0);
        return {
            status: "answered",
            value:
                entries.reduce(
                    (total, [level, p]) => total + scorePosition(contract, level) * p,
                    0,
                ) / sum,
        };
    }
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries[0]!;
    if (top[1] < band[1] || top[1] === entries[1]?.[1])
        return { status: "abstained", value: null, reason: "choice tied or below threshold" };
    if (top[0] === "insufficient_evidence")
        return {
            status: "insufficient_evidence",
            value: top[0],
            reason: "rubric selected insufficient evidence",
        };
    if (!contract.options?.[top[0]]) throw new Error("unknown option");
    return { status: "answered", value: top[0] };
}

export function scorePosition(contract: MetricContract, level: string): number {
    const named = contract.levels?.indexOf(level) ?? -1;
    return named >= 0 ? named : Number(level);
}

export function adverseProbability(contract: MetricContract, raw: RawAnswer): number | null {
    const adverse = contract.adverse ?? true;
    if (raw.kind === "yes_no") return adverse === false ? 1 - raw.probability : raw.probability;
    if (typeof adverse === "string") return raw.probabilities[adverse] ?? null;
    if (raw.kind === "score" && typeof adverse === "number")
        return Object.entries(raw.probabilities)
            .filter(([level]) => scorePosition(contract, level) < adverse)
            .reduce((sum, [, p]) => sum + p, 0);
    return null;
}

export function adverseAnswer(contract: MetricContract, raw: RawAnswer, band: Band): boolean {
    const result = interpretAnswer(contract, raw, band);
    if (result.status !== "answered") return false;
    const adverse = contract.adverse ?? true;
    if (raw.kind === "yes_no" || raw.kind === "choice") return result.value === adverse;
    const probability = adverseProbability(contract, raw);
    return probability !== null && probability >= band[1];
}
