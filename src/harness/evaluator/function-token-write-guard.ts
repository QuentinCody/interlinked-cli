import type { JsonObject } from "../../lib/json-types.js";
import { selectFunctionTokenAnalyzer } from "../function-tokens/index.js";
import { CANONICAL_TOKENIZER_ID, type FunctionTokenEntry } from "../function-tokens/types.js";
import {
    DEFAULT_MAX_FUNCTION_TOKENS,
    maxFunctionTokensFor,
} from "../metric-caps.js";
import {
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

export type CommitTokenScope = "index" | "tracked" | "constructed" | "conservative-worktree";

/** Commit comparisons establish a delta from HEAD, never writer or session attribution. */
export function buildFunctionTokenBlock(violations: string[], cwd: string, scope: CommitTokenScope = "index"): string {
    const scopes: Record<CommitTokenScope, string> = {
        index: "staged index versus HEAD",
        tracked: "tracked working-tree changes versus HEAD (commit --all)",
        constructed: "selected working-tree paths versus HEAD (compound/pathspec command)",
        "conservative-worktree": "conservative working-tree scan versus HEAD; the command's exact commit scope is unresolved",
    };
    const shown = violations.slice(0, 8).map(violation => violation
        .replace(/raised from (\d+)/g, "HEAD value $1")
        .replace(/new (?:anonymous )?function over cap|new over-cap function/g, "no matching function in HEAD"));
    return [
        `[interlinked:function-tokens] COMMIT BLOCKED: ${violations.length} function-size regression(s); cap ${maxFunctionTokensFor(cwd)} syntax tokens (${CANONICAL_TOKENIZER_ID}).`,
        `Scope: ${scopes[scope]}.`,
        "These are differences from the committed version; writer and edit time are not determined.",
        ...shown.map(violation => `  • ${violation}`),
        ...(shown.length < violations.length ? [`  … ${violations.length - shown.length} more; all findings still participate in the gate. Use interlinked metrics --full for the current-worktree inventory.`] : []),
        ...(scope === "conservative-worktree" ? ["Run staging and git commit as separate tool calls to check the exact staged index."] : []),
        "Simplify the affected functions or extract cohesive responsibilities. Existing over-cap functions may hold or shrink; they may not grow.",
    ].join("\n");
}

export function resetFunctionTokenWarningsForTesting(): void {
    warnedLanguages.clear();
}
