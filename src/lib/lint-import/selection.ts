import { existsSync, statSync } from "node:fs";
import { discoverLint, inspectLintInput } from "./discovery.js";
import { lintEntryKey } from "./identity.js";
import { inferredLintEntries } from "./inferred-entries.js";
import { declaredLintAdapters, LINT_ADAPTER_PATH } from "./custom-adapters.js";
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
    /** Add only explicit selections while retaining every previously adopted profile. */
    onlySelected?: boolean;
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

function configuredEntries(inventory: LintInventory, options: LintSelection, previous: LintImportPolicy | null, selected: LintImportEntry[]): LintImportEntry[] {
    const retained = previous?.entries.filter((entry) => options.onlySelected || retainProfile(entry));
    const configured = new Map(retained?.map((entry) => [lintEntryKey(entry), entry]));
    if (!options.onlySelected) {
        for (const entry of inferredLintEntries(inventory)) mergeInferred(configured, entry);
        for (const entry of declaredLintAdapters((file) => lintPath(inventory.root, file))) configured.set(lintEntryKey(entry), entry);
    } else if (existsSync(lintPath(inventory.root, LINT_ADAPTER_PATH))) {
        // Record that this registry was present and left for review, without
        // enrolling its analyzers. Later changes must still invalidate the plan.
        inventory.sources.push(inspectLintInput({ root: inventory.root, file: LINT_ADAPTER_PATH, tool: "invocation", kind: "dependency" }));
    }
    for (const entry of selected) configured.set(lintEntryKey(entry), entry);
    return [...configured.values()];
}

/** A preview and its write use the same plan, retaining previously selected profiles. */
export function prepareLintImport(target: string, options: LintSelection, retainedPolicy?: LintImportPolicy | null): { inventory: LintInventory; policy: LintImportPolicy; review: LintSource[] } {
    const inventory = discoverLint(target);
    const previous = retainedPolicy === undefined ? loadLintPolicy(inventory.root) : retainedPolicy;
    const selected = [...selectedEntries(inventory.root, options), ...explicitLintConfigs(inventory.root, options)];
    if (options.onlySelected && selected.length === 0) throw new Error("--only-selected requires --config or --eslint-config");
    const entries = configuredEntries(inventory, options, previous, selected);
    includeSelectedSources(inventory, entries);
    const mode = { onlyConfigured: options.onlySelected === true };
    const plan = planLintImport(inventory, entries, mode);
    preserveCadence(plan.policy.entries, previous);
    const selectedKeys = new Set(selected.map(lintEntryKey));
    const cadenceEntries = options.onlySelected ? plan.policy.entries.filter((entry) => selectedKeys.has(lintEntryKey(entry))) : plan.policy.entries;
    applyCadence(cadenceEntries, options.cadence);
    for (const entry of plan.policy.entries) includeLintInputGraph(inventory, entry);
    const refreshed = planLintImport(inventory, plan.policy.entries, mode);
    return { inventory, review: refreshed.review, policy: mergeLintPolicy(inventory.root, previous, refreshed.policy) };
}
