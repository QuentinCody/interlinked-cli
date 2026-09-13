import { createRequire } from "node:module";
import { join } from "node:path";
import { evidenceIdentity } from "../../lib/metrics/evidence-identity.js";
import { hashBytes } from "../../lib/metrics/inventory.js";
import type { RepositoryInventory } from "../../lib/metrics/measurement-types.js";
import { buildTestDependencyGraph, testDependencyClosure, type TestDependencyGraph } from "../test-dependency-graph.js";
import type { IndexValidityInputs } from "./invalidation.js";
import { discoverVitestUniverse } from "../coverage-shards/discovery.js";
import { captureIndexRuntime, verifyIndexRuntime, type IndexContextOptions, type IndexRuntimeContext } from "./runtime-context.js";
import { coverageRuntimeSupportHash } from "./runtime-inputs.js";

export interface CoverageIndexContext extends TestDependencyGraph { inventory: RepositoryInventory; validity: IndexValidityInputs; fingerprint: string; sourceFingerprint: string; testFiles: string[]; runtime: IndexRuntimeContext; }
function runnerVersion(root: string): string {
    const require = createRequire(join(root, "package.json"));
    const runner: unknown = require("vitest/package.json"), provider: unknown = require("@vitest/coverage-v8/package.json");
    const version = (value: unknown) => typeof value === "object" && value !== null && "version" in value && typeof value.version === "string" ? value.version : "";
    if (!version(runner) || version(runner) !== version(provider)) throw new Error("Matching local Vitest and coverage-v8 packages required");
    return version(runner);
}
function globalSupport(inventory: RepositoryInventory, dependencies: ReadonlyMap<string, string[]>, native: string[]): Set<string> {
    const support = new Set([...native, ...inventory.files.filter(file => file.role === "configuration").map(file => file.path)]), queue = [...support];
    for (let index = 0; index < queue.length; index++) for (const target of dependencies.get(queue[index] ?? "") ?? []) {
        if (!support.has(target)) { support.add(target); queue.push(target); }
    }
    return support;
}
export async function coverageIndexContext(inventory: RepositoryInventory, changes: ReadonlyMap<string, string | null> = new Map(), options: IndexContextOptions = {}): Promise<CoverageIndexContext> {
    const identity = evidenceIdentity(inventory, changes), graph = buildTestDependencyGraph(inventory);
    const runtime = await captureIndexRuntime(inventory, changes, options);
    const mounts = runtime.workspace.inputs.filter(input => input.kind === "dependency").map(input => input.path);
    const universe = await discoverVitestUniverse(runtime.workspaceRoot, runtime.deadline, runtime.environment, mounts), testFiles = universe.tests;
    const known = new Set(inventory.files.map(file => file.path));
    if (testFiles.some(path => !known.has(path))) throw new Error("Discovered test outside measured source inventory; index unavailable");
    const runtimeFiles = new Set(runtime.workspace.inputs.filter(input => input.kind === "file").map(input => input.path));
    if (universe.supportFiles.some(path => !runtimeFiles.has(path))) throw new Error("Vitest support input outside captured runtime; index unavailable");
    await verifyIndexRuntime(inventory.root, runtime);
    const support = globalSupport(inventory, graph.dependencies, universe.supportFiles);
    graph.incomplete ||= testDependencyClosure(graph, support).opaque;
    const sourcePaths = new Set([...inventory.files.filter(file => file.role === "product").map(file => file.path), ...testFiles].filter(path => !support.has(path)));
    const supportHash = coverageRuntimeSupportHash(runtime.workspace, sourcePaths);
    const validity: IndexValidityInputs = { runnerId: "vitest-exact-v1", runnerVersion: runnerVersion(inventory.root), coverageEngine: "v8-location-runtime-v2",
        coverageConfigHash: hashBytes(JSON.stringify([identity.configurationHash, identity.dependencyHash, identity.supportHash, identity.scopeHash, supportHash])),
        testDiscoveryHash: hashBytes(JSON.stringify(testFiles)),
        dependencyGraphVersion: hashBytes(JSON.stringify(["per-test-uncertainty-v1", [...graph.dependencies], [...graph.opaqueFiles].sort(), graph.incomplete])),
        environmentHash: runtime.environmentHash, shardBoundary: "file" };
    const sourceFingerprint = hashBytes(JSON.stringify(identity));
    return { inventory, validity, sourceFingerprint, fingerprint: hashBytes(JSON.stringify([sourceFingerprint, validity])), testFiles, runtime, ...graph };
}
export function dependencyHashes(context: CoverageIndexContext, tests: string[], covered: string[]): Record<string, string> {
    const closure = testDependencyClosure(context, [...tests, ...covered]);
    const reached = closure.paths;
    if (closure.opaque) for (const file of context.inventory.files) reached.add(file.path);
    return Object.fromEntries(context.inventory.files.filter(file => reached.has(file.path)).map(file => [file.path, file.sha256]));
}
