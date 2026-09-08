import { statSync } from "node:fs";
import { discoverLint, inspectLintInput } from "./discovery.js";
import { lintEntryKey } from "./identity.js";
import { inferredLintEntries } from "./inferred-entries.js";
import { declaredLintAdapters } from "./custom-adapters.js";
import { includeLintInputGraph } from "./input-graph.js";
import { type ConfigSelection, explicitLintConfigs } from "./config-selection.js";
import { lintPath, loadLintPolicy, mergeLintPolicy, normalizedLintPath, planLintImport } from "./policy.js";
import type { LintImportEntry, LintImportPolicy, LintInventory, LintSource } from "./types.js";

function applyCadence(entries: LintImportEntry[], cadence: string | undefined): void {
    if (cadence === undefined) return;
    if (cadence !== "hook" && cadence !== "audit") throw new Error("Invalid lint cadence");
    for (const entry of entries) entry.cadence = cadence;
}

function retainProfile(entry: LintImportEntry): boolean {
    return entry.config !== undefined || entry.report !== undefined || entry.flags !== undefined || entry.targets !== undefined;
}

function preserveCadence(entries: LintImportEntry[], previous: LintImportPolicy | null): void {
    const saved = new Map(previous?.entries.map((entry) => [lintEntryKey(entry), entry]));
    for (const entry of entries) {
        const prior = saved.get(lintEntryKey(entry));
        if (!prior) continue;
        if (prior.cadence === undefined) delete entry.cadence;
        else entry.cadence = prior.cadence;
    }
}

function mergeInferred(configured: Map<string, LintImportEntry>, entry: LintImportEntry): void {
    const key = lintEntryKey(entry);
    const previous = configured.get(key);
    if (previous) {
        entry.cadence = previous.cadence ?? "hook";
        const evidence = [...(previous.evidence ?? []), ...(entry.evidence ?? [])];
        entry.evidence = [...new Map(evidence.map((origin) => [JSON.stringify(origin), origin])).values()];
        entry.sources = [...new Set([...previous.sources, ...entry.sources])];
    }
    configured.set(key, entry);
}

export interface LintSelection extends ConfigSelection {
    eslintConfig?: string[];
    eslintScope?: string;
}

function selectedEntries(root: string, options: LintSelection): LintImportEntry[] {
    const configs = options.eslintConfig ?? [];
    if (options.eslintScope !== undefined && configs.length === 0) throw new Error("--eslint-scope requires --eslint-config");
    const scope = normalizedLintPath(root, options.eslintScope ?? ".");
    if (!statSync(lintPath(root, scope)).isDirectory()) throw new Error("ESLint scope must be a directory");
    return configs.map((file) => {
        const config = normalizedLintPath(root, file);
        return { tool: "eslint", scope, config, sources: [config] };
    });
}

function includeSelectedSources(inventory: LintInventory, entries: LintImportEntry[]): void {
    const inspected = new Set<string>();
    for (const entry of entries) {
        for (const file of entry.sources) {
            const key = `${entry.tool}:${file}`;
            if (inspected.has(key)) continue;
            inspected.add(key);
            lintPath(inventory.root, file);
            const previous = inventory.sources.find((source) => source.file === file && source.tool === entry.tool);
            const kind = file === entry.config ? "config" : (previous?.kind ?? "dependency");
            const source = inspectLintInput({ root: inventory.root, file, tool: entry.tool, kind });
            inventory.sources = inventory.sources.filter((existing) => existing.tool !== entry.tool || existing.file !== file);
            inventory.sources.push(source);
        }
    }
    inventory.sources.sort((a, b) => a.file.localeCompare(b.file) || a.tool.localeCompare(b.tool));
}

/** A preview and its write use the same plan, retaining previously selected profiles. */
export function prepareLintImport(target: string, options: LintSelection, retainedPolicy?: LintImportPolicy | null): { inventory: LintInventory; policy: LintImportPolicy; review: LintSource[] } {
    const inventory = discoverLint(target);
    const previous = retainedPolicy === undefined ? loadLintPolicy(inventory.root) : retainedPolicy;
    const configured = new Map(previous?.entries.filter(retainProfile).map((entry) => [lintEntryKey(entry), entry]));
    for (const entry of inferredLintEntries(inventory)) mergeInferred(configured, entry);
    for (const entry of selectedEntries(inventory.root, options)) configured.set(lintEntryKey(entry), entry);
    for (const entry of declaredLintAdapters((file) => lintPath(inventory.root, file))) configured.set(lintEntryKey(entry), entry);
    for (const entry of explicitLintConfigs(inventory.root, options)) configured.set(lintEntryKey(entry), entry);
    const entries = [...configured.values()];
    includeSelectedSources(inventory, entries);
    const plan = planLintImport(inventory, entries);
    preserveCadence(plan.policy.entries, previous);
    applyCadence(plan.policy.entries, options.cadence);
    for (const entry of plan.policy.entries) includeLintInputGraph(inventory, entry);
    const refreshed = planLintImport(inventory, plan.policy.entries);
    return { inventory, review: refreshed.review, policy: mergeLintPolicy(inventory.root, previous, refreshed.policy) };
}
