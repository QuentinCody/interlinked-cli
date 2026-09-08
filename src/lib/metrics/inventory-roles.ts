import { extname } from "node:path";
import type { SourceRole } from "./measurement-types.js";

const LANGUAGES: Readonly<Record<string, string>> = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".swift": "swift",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cs": "csharp",
    ".rb": "ruby", ".php": "php", ".sh": "shell", ".sql": "sql", ".vue": "vue", ".svelte": "svelte", ".astro": "astro",
};

export function sourceLanguage(path: string): string | null {
    return LANGUAGES[extname(path).toLowerCase()] ?? null;
}

/** Roles are independent of local gate caps and do not execute repository configuration. */
export function sourceRole(path: string): SourceRole {
    const p = path.replaceAll("\\", "/");
    if (/(^|\/)(node_modules|vendor|\.venv|venv|target)(\/|$)/.test(p)) return "vendor";
    if (/(^|\/)(dist|build|generated|__generated__)(\/|$)|\.gen\.|\.generated\.|\.d\.[cm]?ts$/.test(p)) return "generated";
    if (/(^|\/)(\.?scratch|bench|benchmarks?|fixtures?|__fixtures__|evals)(\/|$)|(^|\/)_[^/]*fixtures[^/]*\/|\.overlay-/.test(p)) return "fixture";
    if (/(^|\/)(__tests__|__mocks__|tests?|test-setup)(\/|$)|\.(test|spec|bench)\.[cm]?[jt]sx?$/.test(p)) return "test";
    if (/\.(md|mdx|rst)$/.test(p)) return "documentation";
    if (/(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|[^/]*lock[^/]*|wrangler\.(toml|jsonc))$|\.config\.[cm]?[jt]s$|\.(json|jsonc|yaml|yml|toml)$/.test(p)) return "configuration";
    return sourceLanguage(p) === null ? "asset" : "product";
}

export function isScoreInput(role: SourceRole): boolean {
    return role === "product" || role === "test" || role === "configuration" || role === "documentation";
}

export function isJavaScriptLanguage(language: string | null): boolean {
    return language === "javascript" || language === "typescript";
}
