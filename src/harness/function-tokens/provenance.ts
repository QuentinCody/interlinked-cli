import { spawnSync } from "node:child_process";
import { isJsonObject } from "../../lib/json-types.js";
import { parseTsSource } from "../checks/cyclomatic-ast.js";
import { CANONICAL_TOKENIZER_ID, PYTHON_TOKENIZER_ID, TYPESCRIPT_TOKENIZER_ID } from "./types.js";
import type { FunctionTokenAnalysisOptions } from "./types.js";

export interface TokenAdapterProvenance {
    language: string;
    tokenizer: string;
    parserVersion: string | null;
}

export interface FunctionTokenProvenance {
    contract: string;
    adapters: TokenAdapterProvenance[];
}

function pythonVersion(options: FunctionTokenAnalysisOptions): string | null {
    const foreground = options.resourcePolicy === "foreground-survey";
    const result = spawnSync("python3", [...(foreground ? ["-I", "-S", "-B"] : []), "--version"], {
        encoding: "utf8", timeout: foreground ? 0 : 2_000,
        ...(foreground ? { maxBuffer: Infinity } : {}),
    });
    if (result.error || result.status !== 0) return null;
    return (result.stdout || result.stderr).trim() || null;
}

/** Report/index provenance only; gate comparisons never spawn a version probe. */
export function functionTokenProvenance(languages: readonly string[], options: FunctionTokenAnalysisOptions = {}): FunctionTokenProvenance {
    const adapters: TokenAdapterProvenance[] = [];
    for (const language of [...new Set(languages)].sort()) {
        if (language === "typescript") {
            adapters.push({ language, tokenizer: TYPESCRIPT_TOKENIZER_ID,
                parserVersion: parseTsSource("", "provenance.ts")?.ts.version ?? null });
        } else if (language === "python") {
            adapters.push({ language, tokenizer: PYTHON_TOKENIZER_ID, parserVersion: pythonVersion(options) });
        }
    }
    return { contract: CANONICAL_TOKENIZER_ID, adapters };
}

export function isFunctionTokenProvenance(value: unknown): value is FunctionTokenProvenance {
    if (!isJsonObject(value) || typeof value.contract !== "string" || !Array.isArray(value.adapters)) return false;
    return value.adapters.every(adapter => isJsonObject(adapter)
        && typeof adapter.language === "string" && typeof adapter.tokenizer === "string"
        && (adapter.parserVersion === null || typeof adapter.parserVersion === "string"));
}
