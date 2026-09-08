import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { inspectLintInput } from "./discovery.js";
import { lintPath } from "./policy.js";
import { lintJson, lintObject } from "./json.js";
import type { LintImportEntry, LintInventory } from "./types.js";

const RESOLUTIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".json", "/index.js", "/index.mjs", "/index.ts"];
const CONTEXT = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "pyproject.toml", "uv.lock", "poetry.lock", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock", "tsconfig.json"];
const QUOTED_LOCAL = /["'](\.{1,2}\/[^"'\r\n]+)["']/g;
const IMPORT_LOCAL = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](\.{1,2}\/[^"'\r\n]+)["']/g;

function referenceText(file: string, content: string): string {
    if (!file.endsWith("package.json")) return content;
    const manifest = lintObject(lintJson(content));
    return JSON.stringify([manifest.eslintConfig, manifest.stylelint, manifest.prettier]);
}

function existingInput(root: string, file: string): boolean {
    const path = lintPath(root, file);
    return existsSync(path) && lstatSync(path).isFile();
}

function localReferences(root: string, file: string, content: string): string[] {
    const files: string[] = [];
    const expression = /\.[cm]?[jt]s$/.test(file) ? IMPORT_LOCAL : QUOTED_LOCAL;
    for (const match of referenceText(file, content).matchAll(expression)) {
        const value = match[1] ?? "";
        if (/[*?{}]/.test(value)) continue;
        const relative = posix.normalize(posix.join(dirname(file), value));
        const resolved = RESOLUTIONS.map((suffix) => relative + suffix).find((candidate) => existingInput(root, candidate));
        if (resolved) files.push(resolved);
    }
    return files;
}

function contextInputs(root: string, entry: LintImportEntry): string[] {
    const files: string[] = [];
    let scope = entry.scope;
    for (;;) {
        for (const name of CONTEXT) {
            const file = posix.join(scope, name);
            if (existingInput(root, file)) files.push(file);
        }
        if (scope === ".") return files;
        scope = posix.dirname(scope);
    }
}

function includeInput(inventory: LintInventory, entry: LintImportEntry, file: string): string {
    lintPath(inventory.root, file);
    const previous = inventory.sources.find((source) => source.file === file && source.tool === entry.tool);
    if (!previous) inventory.sources.push(inspectLintInput({ root: inventory.root, file, tool: entry.tool, kind: "dependency" }));
    return readFileSync(lintPath(inventory.root, file), "utf8");
}

/** Conservative static closure: literal local imports plus package/lock context; analyzers resolve dynamic presets. */
export function includeLintInputGraph(inventory: LintInventory, entry: LintImportEntry): void {
    const pending = [...entry.sources, ...contextInputs(inventory.root, entry)];
    const seen = new Set<string>();
    let bytes = 0;
    while (pending.length > 0) {
        const file = pending.pop();
        if (!file || seen.has(file)) continue;
        seen.add(file);
        if (seen.size > 1000) throw new Error("Lint configuration dependency graph exceeds 1000 files");
        const content = includeInput(inventory, entry, file);
        bytes += content.length;
        if (bytes > 20_000_000) throw new Error("Lint configuration dependency graph exceeds its read budget");
        if (!/(?:lock|\.sum)$/.test(file) && !file.endsWith("-lock.json")) pending.push(...localReferences(inventory.root, file, content));
    }
    entry.sources = [...seen].sort();
}
