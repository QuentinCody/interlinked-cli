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
import { discoverVitestUniverse } from "../coverage-shards/discovery.js";
import { captureIndexRuntime, verifyIndexRuntime, type IndexContextOptions, type IndexRuntimeContext } from "./runtime-context.js";
import { coverageRuntimeSupportHash } from "./runtime-inputs.js";

export interface CoverageIndexContext { inventory: RepositoryInventory; validity: IndexValidityInputs; fingerprint: string; sourceFingerprint: string; dependencies: Map<string, string[]>; opaque: boolean; testFiles: string[]; runtime: IndexRuntimeContext; }
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
        if (!specifier?.startsWith(".")) { if (specifier !== "vitest" && specifier !== "vitest/config" && specifier !== "node:assert/strict") opaque = true; continue; }
        const target = resolveSourceTarget(join(dirname(file.path), specifier), known);
        if (target) targets.push(target); else opaque = true;
    }
    return { targets: targets.sort(), opaque };
}
function sourceGraph(inventory: RepositoryInventory): { dependencies: Map<string, string[]>; opaque: boolean } {
    const known = new Set(inventory.files.map(file => file.path)), dependencies = new Map<string, string[]>();
    let opaque = inventory.gaps.length > 0 || inventory.issues.length > 0;
    for (const file of inventory.files.filter(file => file.role === "product" || file.role === "test" || (file.role === "configuration" && /\.[cm]?[jt]s$/.test(file.path)))) {
        const result = fileDependencies(file, known);
        opaque ||= result.opaque;
        dependencies.set(file.path, result.targets);
    }
    return { dependencies, opaque };
}
function globalSupport(inventory: RepositoryInventory, dependencies: ReadonlyMap<string, string[]>, native: string[]): Set<string> {
    const support = new Set([...native, ...inventory.files.filter(file => file.role === "configuration").map(file => file.path)]), queue = [...support];
    for (let index = 0; index < queue.length; index++) for (const target of dependencies.get(queue[index] ?? "") ?? []) {
        if (!support.has(target)) { support.add(target); queue.push(target); }
    }
    return support;
}
export async function coverageIndexContext(inventory: RepositoryInventory, changes: ReadonlyMap<string, string | null> = new Map(), options: IndexContextOptions = {}): Promise<CoverageIndexContext> {
    const identity = evidenceIdentity(inventory, changes), graph = sourceGraph(inventory);
    const runtime = await captureIndexRuntime(inventory, changes, options);
    const mounts = runtime.workspace.inputs.filter(input => input.kind === "dependency").map(input => input.path);
    const universe = await discoverVitestUniverse(runtime.workspaceRoot, runtime.deadline, runtime.environment, mounts), testFiles = universe.tests;
    const known = new Set(inventory.files.map(file => file.path));
    if (testFiles.some(path => !known.has(path))) throw new Error("Discovered test outside measured source inventory; index unavailable");
    const runtimeFiles = new Set(runtime.workspace.inputs.filter(input => input.kind === "file").map(input => input.path));
    if (universe.supportFiles.some(path => !runtimeFiles.has(path))) throw new Error("Vitest support input outside captured runtime; index unavailable");
    await verifyIndexRuntime(inventory.root, runtime);
    const support = globalSupport(inventory, graph.dependencies, universe.supportFiles);
    const sourcePaths = new Set([...inventory.files.filter(file => file.role === "product").map(file => file.path), ...testFiles].filter(path => !support.has(path)));
    const supportHash = coverageRuntimeSupportHash(runtime.workspace, sourcePaths);
    const validity: IndexValidityInputs = { runnerId: "vitest-exact-v1", runnerVersion: runnerVersion(inventory.root), coverageEngine: "v8-location-runtime-v2",
        coverageConfigHash: hashBytes(JSON.stringify([identity.configurationHash, identity.dependencyHash, identity.supportHash, identity.scopeHash, supportHash])),
        testDiscoveryHash: hashBytes(JSON.stringify(testFiles)),
        dependencyGraphVersion: hashBytes(JSON.stringify([...graph.dependencies])),
        environmentHash: runtime.environmentHash, shardBoundary: "file" };
    const sourceFingerprint = hashBytes(JSON.stringify(identity));
    return { inventory, validity, sourceFingerprint, fingerprint: hashBytes(JSON.stringify([sourceFingerprint, validity])), testFiles, runtime, ...graph };
}
export function dependencyHashes(context: CoverageIndexContext, tests: string[], covered: string[]): Record<string, string> {
    const reached = new Set([...tests, ...covered]), queue = [...reached];
    if (context.opaque) for (const file of context.inventory.files) reached.add(file.path);
    for (let index = 0; index < queue.length; index++) for (const path of context.dependencies.get(queue[index] ?? "") ?? []) {
        if (!reached.has(path)) { reached.add(path); queue.push(path); }
    }
    return Object.fromEntries(context.inventory.files.filter(file => reached.has(file.path)).map(file => [file.path, file.sha256]));
}
