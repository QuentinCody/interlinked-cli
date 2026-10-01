import { realpathSync } from "node:fs";
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

/** `storeRoot` names the checkout whose `.interlinked/coverage-index/` this context reads and stages into; the inventory root stays the measured source. */
export interface CoverageIndexContext extends TestDependencyGraph { inventory: RepositoryInventory; storeRoot: string; validity: IndexValidityInputs; fingerprint: string; sourceFingerprint: string; testFiles: string[]; runtime: IndexRuntimeContext; }
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
/** The manifest-validity inputs: runner, engine, configuration + support hashes, discovered tests, graph shape, environment. */
function indexValidity(root: string, identity: ReturnType<typeof evidenceIdentity>, supportHash: string, testFiles: readonly string[], graph: ReturnType<typeof buildTestDependencyGraph>, environmentHash: string): IndexValidityInputs {
    return { runnerId: "vitest-exact-v1", runnerVersion: runnerVersion(root), coverageEngine: "v8-location-runtime-v2",
        coverageConfigHash: hashBytes(JSON.stringify([identity.configurationHash, identity.dependencyHash, identity.supportHash, identity.scopeHash, supportHash])),
        testDiscoveryHash: hashBytes(JSON.stringify(testFiles)),
        dependencyGraphVersion: hashBytes(JSON.stringify(["per-test-uncertainty-v1", [...graph.dependencies], [...graph.opaqueFiles].sort(), graph.incomplete])),
        environmentHash, shardBoundary: "file" };
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
    const validity = indexValidity(inventory.root, identity, coverageRuntimeSupportHash(runtime.workspace, sourcePaths), testFiles, graph, runtime.environmentHash);
    const sourceFingerprint = hashBytes(JSON.stringify(identity));
    const storeRoot = realpathSync(options.storeRoot ?? inventory.root);
    return { inventory, storeRoot, validity, sourceFingerprint, fingerprint: hashBytes(JSON.stringify([sourceFingerprint, validity])), testFiles, runtime, ...graph };
}
/** The manifest key under which an OPAQUE shard binds the whole inventory: one digest, not one entry per file. */
export const WHOLE_INVENTORY_KEY = "@inventory";

/** One digest over every inventoried file's content hash — what an opaque shard depends on. */
export function inventoryDigest(inventory: RepositoryInventory): string {
    const entries = inventory.files.map(file => [file.path, file.sha256] as const).sort((left, right) => left[0].localeCompare(right[0]));
    return hashBytes(JSON.stringify(entries));
}

/**
 * An opaque shard depends on everything, and it says so with ONE entry: enumerating every inventoried file per
 * shard put 4790 hashes into each of 2501 manifest entries on this repository (~1 GB of JSON) and the manifest
 * could not even be serialized ("Invalid string length", 2026-09-29).
 */
export function dependencyHashes(context: CoverageIndexContext, tests: string[], covered: string[]): Record<string, string> {
    const closure = testDependencyClosure(context, [...tests, ...covered]);
    if (closure.opaque) return { [WHOLE_INVENTORY_KEY]: inventoryDigest(context.inventory) };
    const reached = closure.paths;
    return Object.fromEntries(context.inventory.files.filter(file => reached.has(file.path)).map(file => [file.path, file.sha256]));
}
