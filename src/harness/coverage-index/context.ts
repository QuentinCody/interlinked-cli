import { createRequire } from "node:module";
import { join } from "node:path";
import { analyzeSyntax } from "../../lib/metrics/analysis-syntax.js";
import { evidenceIdentity } from "../../lib/metrics/evidence-identity.js";
import { hashBytes } from "../../lib/metrics/inventory.js";
import type { RepositoryInventory } from "../../lib/metrics/measurement-types.js";
import { resolveSourceTarget } from "../../lib/metrics/graph-entries.js";
import { parseTsSource } from "../checks/cyclomatic-ast.js";
import { hasExactSyntax } from "../function-tokens/ast-tokens.js";
import { dirname } from "node:path";
import type { IndexValidityInputs } from "./invalidation.js";

export interface CoverageIndexContext { inventory: RepositoryInventory; validity: IndexValidityInputs; fingerprint: string; dependencies: Map<string, string[]>; opaque: boolean; }
function runnerVersion(root: string): string {
    const require = createRequire(join(root, "package.json"));
    const runner: unknown = require("vitest/package.json"), provider: unknown = require("@vitest/coverage-v8/package.json");
    const version = (value: unknown) => typeof value === "object" && value !== null && "version" in value && typeof value.version === "string" ? value.version : "";
    if (!version(runner) || version(runner) !== version(provider)) throw new Error("Matching local Vitest and coverage-v8 packages required");
    return version(runner);
}
function fileDependencies(file: RepositoryInventory["files"][number], known: Set<string>): { targets: string[]; opaque: boolean } {
    const parsed = parseTsSource(file.content, file.path), targets: string[] = [];
    if (!parsed || !hasExactSyntax(parsed)) return { targets, opaque: true };
    let opaque = /\b(eval|fetch|process|globalThis)\b|import\.meta|Math\.random|Date\s*\./.test(file.content);
    for (const reference of analyzeSyntax(parsed).imports) {
        const specifier = reference.specifier;
        if (!specifier?.startsWith(".")) { if (specifier !== "vitest" && specifier !== "node:assert/strict") opaque = true; continue; }
        const target = resolveSourceTarget(join(dirname(file.path), specifier), known);
        if (target) targets.push(target); else opaque = true;
    }
    return { targets: targets.sort(), opaque };
}
function sourceGraph(inventory: RepositoryInventory): { dependencies: Map<string, string[]>; opaque: boolean } {
    const known = new Set(inventory.files.map(file => file.path)), dependencies = new Map<string, string[]>();
    let opaque = inventory.gaps.length > 0 || inventory.issues.length > 0;
    for (const file of inventory.files.filter(file => file.role === "product" || file.role === "test")) {
        const result = fileDependencies(file, known);
        opaque ||= result.opaque;
        dependencies.set(file.path, result.targets);
    }
    return { dependencies, opaque };
}
export function coverageIndexContext(inventory: RepositoryInventory, changes: ReadonlyMap<string, string | null> = new Map()): CoverageIndexContext {
    const identity = evidenceIdentity(inventory, changes), graph = sourceGraph(inventory);
    const validity: IndexValidityInputs = { runnerId: "vitest-exact-v1", runnerVersion: runnerVersion(inventory.root), coverageEngine: "v8-location-v1",
        coverageConfigHash: hashBytes(JSON.stringify([identity.configurationHash, identity.dependencyHash, identity.supportHash, identity.scopeHash])),
        testDiscoveryHash: hashBytes(JSON.stringify(inventory.files.filter(file => file.role === "test").map(file => file.path).sort())),
        dependencyGraphVersion: hashBytes(JSON.stringify([...graph.dependencies])),
        environmentHash: hashBytes(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))), shardBoundary: "file" };
    return { inventory, validity, fingerprint: hashBytes(JSON.stringify(identity)), ...graph };
}
export function dependencyHashes(context: CoverageIndexContext, tests: string[], covered: string[]): Record<string, string> {
    const reached = new Set([...tests, ...covered]), queue = [...reached];
    if (context.opaque) for (const file of context.inventory.files) reached.add(file.path);
    for (let index = 0; index < queue.length; index++) for (const path of context.dependencies.get(queue[index] ?? "") ?? []) {
        if (!reached.has(path)) { reached.add(path); queue.push(path); }
    }
    return Object.fromEntries(context.inventory.files.filter(file => reached.has(file.path)).map(file => [file.path, file.sha256]));
}
