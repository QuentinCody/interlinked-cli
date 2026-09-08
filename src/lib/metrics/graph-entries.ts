import { dirname, join, normalize } from "node:path";
import { isJsonObject } from "../json-types.js";
import type { InventoryFile, RepositoryInventory } from "./measurement-types.js";
import { frameworkScoringEntries } from "./framework-entries.js";

export function resolveSourceTarget(target: string, known: ReadonlySet<string>): string | null {
    const clean = normalize(target).replaceAll("\\", "/").replace(/^\.\//, "");
    const stem = clean.replace(/\.[cm]?js$/, "");
    const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
    const alternatives = [clean, ...extensions.map(ext => `${stem}.${ext}`), ...extensions.map(ext => `${clean}/index.${ext}`)];
    for (const candidate of alternatives) if (known.has(candidate)) return candidate;
    return null;
}

function strings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (isJsonObject(value)) return Object.values(value).flatMap(strings);
    return [];
}

function sourceEntry(target: string, directory: string, known: ReadonlySet<string>): string | null {
    const direct = resolveSourceTarget(join(directory, target), known);
    if (direct) return direct;
    return resolveSourceTarget(join(directory, target.replace(/^(\.\/)?(dist|build)\//, "src/")), known);
}

interface EntryContext { known: ReadonlySet<string>; entries: Set<string>; publicEntries: Set<string>; }
function addScriptEntries(script: string, directory: string, context: EntryContext): void {
    for (const match of script.matchAll(/[\w./-]+\.[cm]?[jt]sx?\b/g)) {
        const resolved = sourceEntry(match[0], directory, context.known);
        if (resolved) context.entries.add(resolved);
    }
}

function packageEntries(file: InventoryFile, context: EntryContext): void {
    try {
        const json: unknown = JSON.parse(file.content);
        if (!isJsonObject(json)) return;
        const directory = dirname(file.path);
        for (const target of strings([json.main, json.module, json.exports, json.bin])) {
            const resolved = sourceEntry(target, directory, context.known);
            if (resolved) { context.entries.add(resolved); context.publicEntries.add(resolved); }
        }
        for (const script of strings(json.scripts)) addScriptEntries(script, directory, context);
    } catch { /* Intentional: invalid metadata contributes no entries; the contract adapter reports failed declared contracts. */ }
}

function documentedEntries(file: InventoryFile, context: EntryContext): void {
    for (const match of file.content.matchAll(/\b(?:node(?:\s+--[\w-]+(?:[= ]\S+)?)?\s+|tsx\s+)([\w./-]+\.[cm]?[jt]sx?)\b/g)) {
        const resolved = sourceEntry(match[1] ?? "", "", context.known);
        if (resolved) context.entries.add(resolved);
    }
}

export function discoverScoringEntries(inventory: RepositoryInventory, known: ReadonlySet<string>): { entries: string[]; publicEntries: string[] } {
    const context: EntryContext = { known, entries: new Set(), publicEntries: new Set() };
    for (const path of ["src/index.ts", "src/index.js", "index.ts", "index.js", "src/main.ts", "src/main.tsx", "src/main.js", "src/main.jsx"]) if (known.has(path)) context.entries.add(path);
    for (const path of frameworkScoringEntries(inventory, known)) { context.entries.add(path); context.publicEntries.add(path); }
    for (const file of inventory.files) {
        if (file.path.endsWith("package.json")) packageEntries(file, context);
        if (file.role === "documentation") documentedEntries(file, context);
    }
    return { entries: [...context.entries].sort(), publicEntries: [...context.publicEntries].sort() };
}
