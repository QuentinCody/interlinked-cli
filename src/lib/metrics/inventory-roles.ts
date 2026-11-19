import { extname } from "node:path";
import type { SourceRole } from "./measurement-types.js";

const LANGUAGES: Readonly<Record<string, string>> = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".swift": "swift",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cs": "csharp",
    ".rb": "ruby", ".php": "php", ".sh": "shell", ".sql": "sql", ".vue": "vue", ".svelte": "svelte", ".astro": "astro",
};

const NAMED_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lockb", "packages.lock.json", ".terraform.lock.hcl"]);

export function isDependencyLockfile(path: string): boolean {
    const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
    return name.endsWith(".lock") || NAMED_LOCKFILES.has(name);
}

export function sourceLanguage(path: string): string | null {
    return LANGUAGES[extname(path).toLowerCase()] ?? null;
}

/** Location roles also contain documentation and data. Keep unknown source formats eligible. */
export function sourceAnalysisExclusion(path: string, content: string): string | null {
    if (sourceLanguage(path) !== null || content.startsWith("#!")) return null;
    const normalized = path.replaceAll("\\", "/");
    if (normalized.split("/").at(-1) === ".gitkeep") return "Repository placeholder metadata is outside executable-source analysis";
    if (/\.(md|rst|txt)$/i.test(normalized)) return "Known documentation input is outside executable-source analysis";
    if (isDependencyLockfile(normalized) || /\.(json|jsonc|yaml|yml|toml)$/i.test(normalized)) {
        return "Known configuration/data input is outside executable-source analysis";
    }
    return null;
}

/** The path-only vendor and generated rules; `role-evidence.ts` reports which part of the path matched. */
export const VENDOR_PATH = /(^|\/)(node_modules|vendor|\.venv|venv|target)(\/|$)/;
export const GENERATED_PATH = /(^|\/)(dist|build|generated|__generated__)(\/|$)|\.gen\.|\.generated\.|\.d\.[cm]?ts$/;

/** Roles are independent of local gate caps and do not execute repository configuration. */
export function sourceRole(path: string): SourceRole {
    const p = path.replaceAll("\\", "/");
    if (VENDOR_PATH.test(p)) return "vendor";
    if (GENERATED_PATH.test(p)) return "generated";
    if (/(^|\/)(?:bench(?:mark)?\.[cm]?[jt]sx?)$/.test(p)) return "fixture";
    if (!/(^|\/)(\.?scratch|evals)(\/|$)/.test(p) && /(?:^|\/)(?:tests?\.[cm]?[jt]sx?|tests?\.py|conftest\.py|test_[^/]+\.py|[^/]+_test\.(?:py|go))$|\.test-d\.[cm]?ts$/.test(p)) return "test";
    // A test FILE is a test wherever it lives: the runner discovers `*.test.ts` under `__fixtures__/` and fixture
    // project trees too (this repo: 4 of 2501), and the coverage index needs every executed test in the inventory
    // (roles v3, 2026-09-29). Fixture DIRECTORIES still classify everything else they hold.
    if (/\.(test|spec|bench)\.[cm]?[jt]sx?$/.test(p) && !/(^|\/)(\.?scratch|evals)(\/|$)|\.overlay-/.test(p)) return "test";
    if (/(^|\/)(\.?scratch|bench|benchmarks?|fixtures?|__fixtures__|evals)(\/|$)|(^|\/)_[^/]*fixtures[^/]*\/|\.overlay-/.test(p)) return "fixture";
    if (/(^|\/)(__tests__|__mocks__|tests?|test-setup)(\/|$)/.test(p)) return "test";
    if (/\.(md|mdx|rst)$/.test(p)) return "documentation";
    if (isDependencyLockfile(p) || /(^|\/)(package\.json|tsconfig[^/]*\.json|wrangler\.(toml|jsonc))$|\.config\.[cm]?[jt]s$|\.(json|jsonc|yaml|yml|toml)$/.test(p)) return "configuration";
    return sourceLanguage(p) === null ? "asset" : "product";
}

export function isScoreInput(role: SourceRole): boolean {
    return role === "product" || role === "test" || role === "configuration" || role === "documentation";
}

export function isJavaScriptLanguage(language: string | null): boolean {
    return language === "javascript" || language === "typescript";
}
