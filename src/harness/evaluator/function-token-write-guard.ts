import type { JsonObject } from "../../lib/json-types.js";
import { selectFunctionTokenAnalyzer } from "../function-tokens/index.js";
import { CANONICAL_TOKENIZER_ID, type FunctionTokenEntry } from "../function-tokens/types.js";
import {
    DEFAULT_MAX_FUNCTION_TOKENS,
    maxFunctionTokensFor,
} from "../metric-caps.js";
import {
    buildMetricBlock,
    checkPerFunctionMetricWrite,
    metricViolations,
    type MetricGateSpec,
    type MetricObserver,
    type MetricWriteBlock,
} from "./per-function-metric-gate.js";

const warnedLanguages = new Set<string>();

function warnAnalyzerUnavailable(language: string): void {
    if (warnedLanguages.has(language)) return;
    warnedLanguages.add(language);
    process.stderr.write(
        `[interlinked:function-tokens:not-measured] ${language} source was allowed because ` +
            `an exact ${CANONICAL_TOKENIZER_ID} before/after measurement was unavailable. ` +
            `The ${DEFAULT_MAX_FUNCTION_TOKENS}-token cap was not evaluated for that language.\n`,
    );
}

const FUNCTION_TOKEN_SPEC: MetricGateSpec<FunctionTokenEntry> = {
    label: "function-tokens",
    anonName: "(callback)",
    slewTolerance: null,
    metricOf: (entry) => entry.canonicalTokens,
    selectAnalyzer: selectFunctionTokenAnalyzer,
    capFor: maxFunctionTokensFor,
    onAnalyzerUnavailable: warnAnalyzerUnavailable,
    requireMeasuredBefore: true,
    limitPhrase: `canonical function-token limit (${CANONICAL_TOKENIZER_ID})`,
    unitPlural: "token(s)",
    unitAdj: "token",
    advice: "Split the function into cohesive named helpers, then retry.",
};

export function checkFunctionTokenWrite(
    toolInput: JsonObject,
    cwd: string,
    observe?: MetricObserver<FunctionTokenEntry>,
): MetricWriteBlock | null {
    return checkPerFunctionMetricWrite(FUNCTION_TOKEN_SPEC, toolInput, cwd, observe);
}

/** Compare two already-materialized versions of one file (commit-gate seam). */
export function compareFunctionTokens(
    before: string,
    after: string,
    filePath: string,
    cwd: string,
): string[] | null {
    const analyzer = selectFunctionTokenAnalyzer(filePath);
    if (!analyzer) return [];
    return metricViolations(
        FUNCTION_TOKEN_SPEC,
        before,
        after,
        filePath,
        analyzer,
        maxFunctionTokensFor(cwd),
    );
}

/** Render the canonical function-token block message for a commit batch. */
export function buildFunctionTokenBlock(violations: string[], cwd: string): string {
    return buildMetricBlock(FUNCTION_TOKEN_SPEC, violations, maxFunctionTokensFor(cwd));
}

export function resetFunctionTokenWarningsForTesting(): void {
    warnedLanguages.clear();
}
