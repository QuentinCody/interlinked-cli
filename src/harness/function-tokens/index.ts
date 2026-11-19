import { extname } from "node:path";
import type { MetricAnalyzer } from "../evaluator/per-function-metric-gate.js";
import { computePythonFunctionTokens } from "./python.js";
import type {
    FunctionTokenAnalyzerStatus,
    FunctionTokenEntry,
    FunctionTokenAnalysisOptions,
} from "./types.js";
import { computeTypeScriptFunctionTokens } from "./typescript.js";

export * from "./types.js";

const TYPESCRIPT_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
]);

const KNOWN_CODE_LANGUAGES = new Map<string, string>([
    [".go", "go"],
    [".rs", "rust"],
    [".java", "java"],
    [".kt", "kotlin"],
    [".kts", "kotlin"],
    [".c", "c"],
    [".h", "c"],
    [".cc", "cpp"],
    [".cpp", "cpp"],
    [".cxx", "cpp"],
    [".hpp", "cpp"],
    [".cs", "csharp"],
    [".rb", "ruby"],
    [".php", "php"],
    [".swift", "swift"],
]);

const unavailable = (): FunctionTokenEntry[] | null => null;

export function functionTokenAnalyzerStatus(filePath: string): FunctionTokenAnalyzerStatus {
    const extension = extname(filePath).toLowerCase();
    if (TYPESCRIPT_EXTENSIONS.has(extension)) {
        return { language: "typescript", confidence: "exact" };
    }
    if (extension === ".py") return { language: "python", confidence: "exact" };
    const language = KNOWN_CODE_LANGUAGES.get(extension);
    if (language) {
        return {
            language,
            confidence: "unsupported",
            reason: `the ${language} exact function-token adapter is not installed`,
        };
    }
    return { language: extension.slice(1) || "unknown", confidence: "unsupported" };
}

export function selectFunctionTokenAnalyzer(
    filePath: string,
    options: FunctionTokenAnalysisOptions = {},
): MetricAnalyzer<FunctionTokenEntry> | null {
    const extension = extname(filePath).toLowerCase();
    if (TYPESCRIPT_EXTENSIONS.has(extension)) {
        return { compute: computeTypeScriptFunctionTokens, language: "typescript" };
    }
    if (extension === ".py") {
        return { compute: options.resourcePolicy === "foreground-survey"
            ? (content, path) => computePythonFunctionTokens(content, path, options)
            : computePythonFunctionTokens, language: "python" };
    }
    const language = KNOWN_CODE_LANGUAGES.get(extension) ?? extension.slice(1);
    return language ? { compute: unavailable, language } : null;
}

export function computeFunctionTokens(
    content: string,
    filePath: string,
    options: FunctionTokenAnalysisOptions = {},
): FunctionTokenEntry[] | null {
    return selectFunctionTokenAnalyzer(filePath, options)?.compute(content, filePath) ?? null;
}
