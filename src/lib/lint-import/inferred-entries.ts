import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { LINT_ADAPTERS } from "./adapters.js";
import { TYPED_ESLINT_PROFILE } from "./builtin-profiles.js";
import { lintPath } from "./policy.js";
import type { LintImportEntry, LintInventory, LintSource, LintInvocationCandidate } from "./types.js";

function projectScope(root: string, file: string): string {
    let directory = dirname(join(root, file));
    while (directory !== root) {
        if (existsSync(join(directory, "package.json"))) return relative(root, directory).split("\\").join("/");
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return ".";
}

function namedEslint(source: LintSource): boolean {
    if (source.tool !== "eslint" || source.kind !== "config") return false;
    if (source.file.split("/").some((part) => /^(?:__fixtures__|fixtures?|examples?|docs|scratch)$/.test(part))) return false;
    return /(?:^|\/)eslint\.[\w-]+\.config\.[cm]?[jt]s$/.test(source.file);
}

function namedProfile(inventory: LintInventory, source: LintSource): LintImportEntry {
    const registered = source.file === TYPED_ESLINT_PROFILE.config;
    const scope = registered ? TYPED_ESLINT_PROFILE.scope : projectScope(inventory.root, source.file);
    return {
        tool: "eslint", scope, config: source.file, sources: [source.file], cadence: "audit",
        evidence: [{ file: source.file, line: 1, kind: registered ? "registry" : "config", label: registered ? TYPED_ESLINT_PROFILE.id : "named ESLint profile; inspect working scope before applying" }],
    };
}

function invocationEntry(inventory: LintInventory, source: LintImportEntry): LintImportEntry {
    const entry = { ...source, sources: [...source.sources] };
    const defaults = LINT_ADAPTERS[entry.tool]?.targets;
    if (JSON.stringify(entry.targets) === JSON.stringify(defaults)) delete entry.targets;
    if (entry.config === undefined) {
        entry.sources.push(...inventory.sources.filter((config) => config.tool === entry.tool && config.kind !== "script" && config.scope === entry.scope).map((config) => config.file));
    }
    entry.sources = [...new Set(entry.sources)];
    return entry;
}

export function inferredLintEntries(inventory: LintInventory): LintImportEntry[] {
    const invoked = (inventory.invocations ?? []).flatMap((candidate) => checkedInvocation(inventory, candidate));
    const selected = new Set(invoked.flatMap((entry) => entry.config === undefined ? [] : [entry.config]));
    const named = inventory.sources.filter(namedEslint).filter((source) => !selected.has(source.file)).map((source) => namedProfile(inventory, source));
    const semgrep = inventory.sources.filter((source) => source.tool === "semgrep" && source.kind === "config").map((source): LintImportEntry => ({ tool: "semgrep", scope: source.scope, config: source.file, sources: [source.file], cadence: "audit" }));
    return [...named, ...semgrep, ...invoked];
}

function checkedInvocation(inventory: LintInventory, candidate: LintInvocationCandidate): LintImportEntry[] {
    if (!candidate.entry) return [];
    try {
        const entry = candidate.entry;
        if (!statSync(lintPath(inventory.root, entry.scope)).isDirectory()) throw new Error("Invocation working directory is unavailable");
        for (const file of entry.sources) {
            if (!statSync(lintPath(inventory.root, file)).isFile()) throw new Error(`Invocation config input is not a file: ${file}`);
        }
        return [invocationEntry(inventory, entry)];
    } catch (error) {
        candidate.reason = error instanceof Error ? error.message : String(error);
        delete candidate.entry;
        return [];
    }
}
