export const CANONICAL_TOKENIZER_ID = "interlinked-code-v2" as const;
export const TYPESCRIPT_TOKENIZER_ID = "interlinked-ts-ast-v1" as const;
export const PYTHON_TOKENIZER_ID = "interlinked-python-tokenize-v1" as const;

export type FunctionDeclarationKind =
    | "function"
    | "method"
    | "constructor"
    | "getter"
    | "setter"
    | "closure"
    | "lambda";

export interface FunctionTokenEntry {
    name: string;
    qualifiedName: string;
    declarationKind: FunctionDeclarationKind;
    language: string;
    startOffset: number;
    endOffset: number;
    line: number;
    endLine: number;
    canonicalTokens: number;
    identityKind: "named" | "anonymous" | "colliding";
}

export interface FunctionTokenAnalyzerStatus {
    language: string;
    confidence: "exact" | "unavailable" | "unsupported";
    reason?: string;
}
