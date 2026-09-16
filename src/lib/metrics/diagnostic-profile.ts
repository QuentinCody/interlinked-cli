export const DIAGNOSTIC_PROFILE = {
    id: "interlinked-iterative-js-ts-v1",
    languages: ["javascript", "typescript"],
    role: "product",
    sloc: "parser-token-lines-v1: comments/JSDoc excluded; all lines intersecting multiline tokens included; type syntax included",
    functionSloc: "innermost-token-owner-v1: includes signature; a line with tokens owned by two functions counts in both",
    cyclomatic: "interlinked-cyclomatic-ast-v1: nested implementations counted independently",
    erosionThreshold: 10,
    clone: "exact-function-body-v1: identifiers/literals preserved; inclusive implementation >=30 tokens; all clone members covered",
    patterns: ["single_use_trivial_helper-v1: uncapped whole-declaration spans from existing advisory detector"],
    enforcement: "diagnostic-only",
} as const;

export const PYTHON_DIAGNOSTIC_PROFILE = {
    id: "interlinked-iterative-python-v1", languages: ["python"], role: "product",
    sloc: "python-token-lines-v1: comments/docstrings/layout excluded; multiline token lines included",
    functionSloc: "innermost-token-owner-v1: def/async def/lambda signatures included; decorators outside function; shared lines count in each owner",
    cyclomatic: "python-ast-v1: body base 1; if/ifexp/for/asyncfor/while/except/assert; bool arity-1; comprehension loop+filters; non-wildcard match cases+guards; nested functions/classes excluded",
    erosionThreshold: 10,
    clone: "python-exact-body-v1: identifiers/literals preserved; layout kinds retained without indentation text; >=30 non-layout implementation tokens",
    patterns: ["opposite_boolean_returns-v1: if/else each containing exactly one opposite literal-bool return; advisory"],
    enforcement: "diagnostic-only",
} as const;

export interface DiagnosticRatio {
    state: "measured" | "not-applicable";
    numerator: number; denominator: number; fraction: number | null;
}

export function diagnosticRatio(numerator: number, denominator: number): DiagnosticRatio {
    return { state: denominator === 0 ? "not-applicable" : "measured", numerator, denominator,
        fraction: denominator === 0 ? null : numerator / denominator };
}

export const DIAGNOSTIC_LIMITATIONS = [
    "These are Interlinked JS/TS diagnostics, not benchmark-compatible scores or proof of maintainability/correctness.",
    "Verbosity covers only exact function clones and the existing trivial-helper heuristic; other patterns and block/near clones are unmeasured.",
    "Pattern matches and exact token equality are review candidates, not proof of unnecessary code or safe consolidation.",
    "Function masses are not additive code size: two functions can own different tokens on the same source line.",
    "CC > 10 creates a discontinuity. Extraction or unrelated simple code can lower the ratio without reducing absolute burden.",
    "Ratios describe the measured subset only; missing files and discovery issues prevent a complete-repository claim.",
    "Python and other languages are unsupported in this profile. No target code, tests, models or external checkers are executed.",
];
