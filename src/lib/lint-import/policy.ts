import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { supportsLintImport } from "./catalog.js";
import { discoverLint, lintDigest } from "./discovery.js";
import { lintEntryKey } from "./identity.js";
import { lintJson, lintObject } from "./json.js";
import { applyLintEntryOptions } from "./entry-options.js";
import { LINT_ADAPTERS } from "./adapters.js";
import { lintSourceNeedsReview } from "./review.js";
import { LINT_ADAPTER_PATH } from "./custom-adapters.js";
import { includeLintInputGraph } from "./input-graph.js";
import { lintPath } from "./input-path.js";
export { lintPath } from "./input-path.js";
export { lintJson, lintObject } from "./json.js";
import type { LintImportEntry, LintImportPolicy, LintInventory, LintSource } from "./types.js";

export const LINT_POLICY_PATH = ".interlinked/lint-import.json";
export const LINT_BASELINE_PATH = ".interlinked/lint-baseline.json";

export function normalizedLintPath(root: string, file: string): string {
    if (!file.trim()) throw new Error("Empty lint path");
    return relative(root, lintPath(root, file)).split(sep).join("/") || ".";
}

function exampleSource(source: LintSource): boolean {
    return source.file.split("/").some((part) => /^(?:__fixtures__|fixtures?|examples?|docs|scratch)$/.test(part));
}

function canonicalSource(source: LintSource): boolean {
    if (source.kind === "ignore" || source.kind === "script" || source.kind === "dependency" || exampleSource(source)) return false;
    const name = basename(source.file);
    if (source.tool === "eslint") return /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?|package\.json)$/.test(name);
    if (source.tool === "swiftlint") return /^\.swiftlint\.ya?ml$/.test(name);
    if (source.tool === "rubocop") return name === ".rubocop.yml";
    return true;
}

function withinScope(scope: string, parent: string): boolean {
    return parent === "." || scope === parent || scope.startsWith(`${parent}/`);
}

function scopesOverlap(source: LintSource, entry: LintImportEntry): boolean {
    return withinScope(source.scope, entry.scope) || withinScope(entry.scope, source.scope);
}

function sourceApplies(source: LintSource, entry: LintImportEntry): boolean {
    if (entry.sources.includes(source.file)) return true;
    if (source.kind === "script" || exampleSource(source)) return false;
    if (source.tool === "shared-ignore") return scopesOverlap(source, entry);
    if (source.tool !== entry.tool) return false;
    return source.kind === "ignore" ? scopesOverlap(source, entry) : withinScope(source.scope, entry.scope);
}

export function planLintImport(inventory: LintInventory, configured: LintImportEntry[] = []): { policy: LintImportPolicy; review: LintSource[] } {
    const groups = new Map(configured.map((entry) => [lintEntryKey(entry), entry]));
    const review: LintSource[] = [];
    for (const source of inventory.sources) {
        if (configured.some((entry) => entry.tool === source.tool && entry.sources.includes(source.file))) continue;
        if (!supportsLintImport(source.tool) || !canonicalSource(source)) {
            review.push(source);
            continue;
        }
        const key = `${source.tool}:${source.scope}`;
        const entry = groups.get(key) ?? { tool: source.tool, scope: source.scope, sources: [] };
        if (LINT_ADAPTERS[source.tool]?.cadence === "audit") entry.cadence = "audit";
        entry.sources.push(source.file);
        groups.set(key, entry);
    }
    const entries = [...groups.values()];
    const digests = Object.fromEntries(inventory.sources.filter((source) => source.tool === "invocation" || entries.some((entry) => sourceApplies(source, entry))).map((source) => [source.file, source.digest]));
    return { policy: { version: 1, entries, digests }, review: review.filter((source) => lintSourceNeedsReview(source, inventory, entries)).filter((source) => source.tool !== "shared-ignore" || !Object.hasOwn(digests, source.file)) };
}

/** Refresh reviewed scopes and deleted auxiliary inputs, retaining missing adopted scopes for repair. */
export function mergeLintPolicy(root: string, previous: LintImportPolicy | null, next: LintImportPolicy): LintImportPolicy {
    const entries = new Map(previous?.entries.map((entry) => [lintEntryKey(entry), entry]));
    for (const entry of next.entries) entries.set(lintEntryKey(entry), entry);
    const sources = new Set([...entries.values()].flatMap((entry) => entry.sources));
    const retained = Object.fromEntries(Object.entries(previous?.digests ?? {}).filter(([file]) => sources.has(normalizedLintPath(root, file))));
    return { version: 1, entries: [...entries.values()], digests: { ...retained, ...next.digests } };
}

function parseEntry(raw: unknown, root: string): LintImportEntry {
    const value = lintObject(raw);
    if (typeof value.tool !== "string" || !supportsLintImport(value.tool)) throw new Error("Unknown imported lint adapter");
    if (typeof value.scope !== "string" || !Array.isArray(value.sources) || value.sources.length === 0) throw new Error("Invalid imported lint scope/sources");
    const scope = normalizedLintPath(root, value.scope);
    const sources = value.sources.map((file: unknown) => {
        if (typeof file !== "string") throw new Error("Invalid lint source path");
        return normalizedLintPath(root, file);
    });
    const config = parseConfig(root, value, sources);
    return applyLintEntryOptions({ tool: value.tool, scope, sources, ...config }, value);
}

function parseConfig(root: string, value: Record<string, unknown>, sources: string[]): { config?: string } {
    if (value.config === undefined) return {};
    if (typeof value.tool !== "string" || !LINT_ADAPTERS[value.tool]?.configFlag || typeof value.config !== "string") throw new Error("Explicit config requires a supported analyzer configuration path");
    const config = normalizedLintPath(root, value.config);
    if (!sources.includes(config)) throw new Error("Explicit configuration must be an imported source");
    return { config };
}

export function loadLintPolicy(root: string): LintImportPolicy | null {
    const path = lintPath(root, LINT_POLICY_PATH);
    if (!existsSync(path)) return null;
    const value = lintObject(lintJson(readFileSync(path, "utf8")));
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length === 0) throw new Error("Unsupported or empty lint import policy");
    const digests = lintObject(value.digests);
    for (const [file, hash] of Object.entries(digests)) {
        lintPath(root, file);
        if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid lint source digest: ${file}`);
    }
    const entries = value.entries.map((entry: unknown) => parseEntry(entry, root));
    if (entries.some((entry) => entry.sources.some((file) => !Object.hasOwn(digests, file)))) throw new Error("Imported lint source has no configuration digest");
    if (new Set(entries.map(lintEntryKey)).size !== entries.length) throw new Error("Duplicate lint import scope/configuration");
    // SAFETY: each digest was validated above and no unvalidated fields are retained.
    return { version: 1, entries, digests: digests as Record<string, string> };
}

export function checkLintSources(root: string, policy: LintImportPolicy): void {
    const inventory = checkNewLintSources(root, policy);
    for (const [file, digest] of Object.entries(policy.digests)) {
        const path = lintPath(root, file);
        if (!existsSync(path) || lintDigest(readFileSync(path, "utf8")) !== digest) {
            throw new Error(`Lint configuration changed: ${file}; review with interlinked lint import, then apply with --write`);
        }
    }
    checkInputDependencies(inventory, policy);
}

function checkNewRegistry(root: string, policy: LintImportPolicy): void {
    if (existsSync(lintPath(root, LINT_ADAPTER_PATH)) && !Object.hasOwn(policy.digests, LINT_ADAPTER_PATH)) throw new Error("New lint adapter registry; review interlinked lint import --write");
}

function checkInputDependencies(inventory: LintInventory, policy: LintImportPolicy): void {
    for (const entry of policy.entries) {
        const current = { ...entry, sources: [...entry.sources] };
        includeLintInputGraph(inventory, current);
        for (const file of current.sources) {
            if (!Object.hasOwn(policy.digests, file)) throw new Error(`New lint configuration dependency: ${file}; review interlinked lint import --write`);
        }
    }
}

function checkNewLintSources(root: string, policy: LintImportPolicy): LintInventory {
    const inventory = discoverLint(root);
    if (!inventory.complete) throw new Error("Lint configuration discovery is incomplete; no verdict");
    checkNewRegistry(root, policy);
    for (const source of inventory.sources) {
        const applies = source.tool === "invocation" || policy.entries.some((entry) => sourceApplies(source, entry));
        if (applies && !Object.hasOwn(policy.digests, source.file)) throw new Error(`New lint configuration: ${source.file}; review interlinked lint import --write`);
    }
    return inventory;
}

// interlinked: defer same_typed_primitive_params -- Preserve the root/path filesystem convention shared with lintPath; writes validate that boundary.
export function writeLintJson(root: string, file: string, value: unknown): void {
    const path = lintPath(root, file);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked lint output: ${file}`);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (existsSync(path) && readFileSync(path, "utf8") === text) return;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
}

/** Validate the team update before any import artifacts are written. */
export function importedLintGuardUpdate(root: string): Record<string, unknown> {
    const file = ".interlinked/guard-rules.json";
    const path = lintPath(root, file);
    const config = existsSync(path) ? lintObject(JSON.parse(readFileSync(path, "utf8"))) : {};
    const checks = config.quality_checks === undefined ? {} : lintObject(config.quality_checks);
    const current = checks.lint_import === undefined ? {} : lintObject(checks.lint_import);
    const localPath = lintPath(root, ".interlinked/guard-rules.local.json");
    if (existsSync(localPath)) {
        const local = lintObject(JSON.parse(readFileSync(localPath, "utf8")));
        const localChecks = local.quality_checks === undefined ? {} : lintObject(local.quality_checks);
        const override = localChecks.lint_import === undefined ? {} : lintObject(localChecks.lint_import);
        if (override.enabled === false) throw new Error("Local guard rules disable lint_import; resolve that override before importing");
    }
    return { ...config, quality_checks: { ...checks, lint_import: { ...current, enabled: true } } };
}

/** Enable the registered wrapper while retaining every unrelated team setting. */
export function enableImportedLintCheck(root: string): void {
    writeLintJson(root, ".interlinked/guard-rules.json", importedLintGuardUpdate(root));
}
