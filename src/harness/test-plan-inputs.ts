import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { discoverVitestUniverse, captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { readAcceptedManifest } from "./coverage-index/store.js";
import { indexStore } from "./coverage-index/staged-state.js";
import { isTestPath } from "./coverage-test-selector.js";
import { buildTestPlan, type TestPlan, type TestPlanInput } from "./test-plan.js";
import { captureTestRuntime, type TestRuntime } from "./test-runtime.js";
import { hasErrorCode } from "./check-engine/tool-errors.js";

/** Resolve existing ancestors so deleted inputs and macOS /tmp aliases share identity. */
function canonicalInput(path: string): string {
    try { return realpathSync(path); }
    catch (error) {
        const parent = dirname(path);
        if (!hasErrorCode(error, "ENOENT") || parent === path) throw error;
        return join(canonicalInput(parent), basename(path));
    }
}

export function normalizeTestInput(root: string, path: string): string {
    const value = relative(realpathSync(root), canonicalInput(resolve(root, path))).replaceAll("\\", "/");
    if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) throw new Error(`Test input outside project: ${path}`);
    return value;
}

/** Declarations are additive literal dependencies; they never excuse opaque execution. */
export function readTestDependencies(root: string): Record<string, string[]> {
    const path = join(root, ".interlinked", "test-dependencies.json");
    if (!existsSync(path)) return {};
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || value.version !== 1 || !isJsonObject(value.tests)) throw new Error("Expected test-dependencies.json {version:1, tests:{testPath:[inputPath]}}");
    const entries: [string, string[]][] = [];
    for (const [test, inputs] of Object.entries(value.tests)) {
        if (!Array.isArray(inputs) || !inputs.every((input): input is string => typeof input === "string" && input.length > 0)) throw new Error(`Invalid dependencies for ${test}`);
        entries.push([normalizeTestInput(root, test), inputs.map(input => normalizeTestInput(root, input))]);
    }
    return Object.fromEntries(entries);
}

/** Includes staged, unstaged, deleted and untracked inputs; Git failure is not an empty diff. */
export function changedTestInputs(root: string, base = "HEAD"): string[] {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).split("\0").filter(Boolean);
    const revision = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).join("").trim();
    return [...new Set([...git(["diff", "--name-only", "-z", revision, "--"]), ...git(["ls-files", "--others", "--exclude-standard", "-z"])])].sort();
}

function historicalTests(root: string): NonNullable<TestPlanInput["historical"]> {
    const manifest = readAcceptedManifest(indexStore(root)), result: NonNullable<TestPlanInput["historical"]> = {};
    for (const shard of Object.values(manifest?.shards ?? {})) {
        for (const test of shard.testPaths) result[test] = { dependencies: Object.keys(shard.dependencyHashes), durationMs: shard.lastDurationMs };
    }
    return result;
}

export async function loadTestPlan(root: string, paths: readonly string[], timeoutMs: number, full = false): Promise<TestPlan> {
    const deadline = Date.now() + timeoutMs;
    const inventory = collectRepositoryInventory(root), changedPaths = paths.map(path => normalizeTestInput(inventory.root, path));
    const dependencies = readTestDependencies(inventory.root);
    const input: TestPlanInput = { inventory, changedPaths, dependencies, full, tests: [], supportFiles: [], historical: historicalTests(inventory.root) };
    try {
        const universe = await discoverVitestUniverse(inventory.root, deadline, captureVitestEnvironment().environment);
        input.tests = universe.tests; input.supportFiles = universe.supportFiles;
        if (universe.tests.some(test => !inventory.files.some(file => file.path === test))) input.uncertainty = ["Discovered tests outside analyzed inventory"];
    } catch (error) {
        input.tests = inventory.files.filter(file => isTestPath(file.path)).map(file => file.path);
        input.uncertainty = [`Native test discovery unavailable: ${error instanceof Error ? error.message : "unknown error"}`];
    }
    return bindRuntime(input, deadline);
}

async function bindRuntime(input: TestPlanInput, deadline: number): Promise<TestPlan> {
    const plan = buildTestPlan(input);
    if (!plan.reusable) return { ...plan, runtimeIssue: "Opaque or incomplete dependencies: only fresh execution and analyzed source stability are checked" };
    const runtime: TestRuntime = await captureTestRuntime(input.inventory.root, deadline);
    if (runtime.hash !== undefined) return { ...plan, runtimeHash: runtime.hash };
    input.uncertainty = [...input.uncertainty ?? [], `Runtime validation unavailable: ${runtime.issue}`];
    return { ...buildTestPlan(input), runtimeIssue: runtime.issue };
}
