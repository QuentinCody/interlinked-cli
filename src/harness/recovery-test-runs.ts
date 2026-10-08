import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { collectRepositoryInventory, hashBytes, inventoryHash } from "../lib/metrics/inventory.js";
import { inventoryPaths } from "../lib/metrics/inventory-paths.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { getProfileForFile } from "./language-profiles.js";
import { pathMatchesCheck } from "./quality-checks/change-set-external-candidates.js";
import { runLanguageTestSuite, type LanguageSuiteOptions, type LanguageSuiteResult } from "./quality-checks/language-test-suite.js";
import { findProjectRoot } from "./quality-checks/project-root.js";
import { readTestDependencies } from "./test-plan-inputs.js";
import type { TestExecution } from "./test-run-receipt.js";
import { captureKnownTestInputs, captureTestRuntime } from "./test-runtime.js";
import { scheduleTests, type ScheduleTestsOptions } from "./test-scheduler.js";
import { requestTests } from "./test-requests.js";
import type { LanguageId, QualityCheckConfig } from "./types.js";

interface TestWitness { inventory: string; environment: string; hashes: Map<string, string>; }
interface SharedTestRun<T> { before: TestWitness; promise: Promise<T>; }
interface TestScope { root: string; language: LanguageId; paths: readonly string[]; check: QualityCheckConfig; }

/** One fresh scheduling request for this job's complete planned project cohort.
 * The scheduler may retry input drift within the request's original deadline.
 * This is not a persistent result cache: another job/restart executes again.
 * Later receipt batches must still match the source, known inputs and environment
 * observed before the shared run. Unavailable outcomes are shared too, never retried
 * for every 32-file batch and never promoted into completed-check evidence. */
export class RecoveryTestRuns {
    private readonly projects = new Map<string, string[]>();
    private readonly vitestRuns = new Map<string, SharedTestRun<TestExecution>>();
    private readonly languageRuns = new Map<string, SharedTestRun<LanguageSuiteResult>>();
    private readonly queuedVitestScopes = new Set<string>();

    constructor(root: string, paths: readonly string[], private readonly deadlineAt: number) {
        for (const path of new Set(paths)) {
            const absolute = resolve(root, path), project = resolve(findProjectRoot(absolute, root) ?? root);
            const group = this.projects.get(project) ?? [];
            group.push(absolute);
            this.projects.set(project, group);
        }
    }

    async vitest(options: ScheduleTestsOptions, check: QualityCheckConfig): Promise<TestExecution> {
        const result = await this.shared(this.vitestRuns, { ...options, language: "typescript", check },
            paths => scheduleTests({ ...options, paths }), false);
        if (result.runtimeVerified) {
            const current = await captureTestRuntime(options.root, this.deadlineAt);
            if (!result.plan.runtimeHash || current.hash !== result.plan.runtimeHash) {
                throw new Error("Recovery test runtime changed; the shared execution cannot certify this batch");
            }
        }
        return result;
    }

    /** Queue the full cohort once, even if another tool prevents reaching tests.
     * Later receipt batches must not recreate work the shared run already served. */
    retainVitest(root: string, paths: readonly string[], check: QualityCheckConfig): void {
        const scope: TestScope = { root, paths, check, language: "typescript" };
        const key = scopeKey(scope);
        if (this.queuedVitestScopes.has(key)) return;
        requestTests(root, this.cohort(scope), false);
        this.queuedVitestScopes.add(key);
    }

    language(options: LanguageSuiteOptions, paths: readonly string[], check: QualityCheckConfig): Promise<LanguageSuiteResult> {
        return this.shared(this.languageRuns, { ...options, paths, check }, () => runLanguageTestSuite(options), true);
    }

    private cohort(scope: TestScope): string[] {
        const paths = (this.projects.get(resolve(scope.root)) ?? []).filter(path => {
            const language = getProfileForFile(path)?.id;
            return (!language || language === scope.language) && pathMatchesCheck(path, scope.check);
        });
        const planned = new Set(paths);
        if (!scope.paths.length || scope.paths.some(path => !planned.has(resolve(scope.root, path)))) {
            throw new Error("Recovery test input was not part of the planned project cohort");
        }
        return paths;
    }

    private async shared<T>(runs: Map<string, SharedTestRun<T>>, scope: TestScope, execute: (paths: string[]) => Promise<T>, native: boolean): Promise<T> {
        const paths = this.cohort(scope);
        const key = scopeKey(scope);
        let run = runs.get(key);
        if (!run) {
            const before = witness(scope.root, paths, native);
            run = { before, promise: Promise.resolve().then(() => execute(paths)) };
            runs.set(key, run);
        }
        const result = await run.promise;
        const changes = changedInputs(run.before, witness(scope.root, paths, native));
        if (changes.length) throw new Error(`Recovery test inputs changed since the shared execution began: ${changes.slice(0, 10).join(", ")}. Current versions remain pending for a fresh job`);
        return result;
    }
}

function scopeKey(scope: TestScope): string { return JSON.stringify([resolve(scope.root), scope.language, scope.check]); }

/** Files a test runner writes for itself (pytest's cache, Python bytecode); their creation is not input drift. */
const RUNNER_OUTPUT = /(^|\/)(\.pytest_cache|__pycache__)(\/|$)|\.py[co]$/;

/** Every discovered file, whatever its source role: a native suite has no runtime validation, so a fixture or asset it
 * reads is only covered here. Files over the inventory's 2 MiB read limit are identified by size and mtime. */
function nativeInputs(root: string): [string, string][] {
    return inventoryPaths(root).paths.filter(path => !RUNNER_OUTPUT.test(path)).map(path => {
        const absolute = resolve(root, path);
        try {
            const stat = lstatSync(absolute);
            if (stat.isSymbolicLink()) return [absolute, `link:${readlinkSync(absolute)}`];
            return [absolute, stat.size > 2 * 1024 * 1024 ? `stat:${stat.size}:${stat.mtimeMs}` : hashBytes(readFileSync(absolute))];
        } catch (error) {
            return [absolute, `unreadable:${error instanceof Error ? error.message : String(error)}`];
        }
    });
}

function witness(root: string, paths: readonly string[], native: boolean): TestWitness {
    const declared = Object.values(readTestDependencies(root)).flat();
    const known = captureKnownTestInputs(root, [...paths, ...declared, ".interlinked/test-dependencies.json"]);
    const files = collectRepositoryInventory(root).files.filter(file => !RUNNER_OUTPUT.test(file.path));
    return { inventory: inventoryHash(files), environment: captureVitestEnvironment().environmentHash,
        hashes: new Map([...files.map(file => [resolve(root, file.path), file.sha256] as const),
            ...(native ? nativeInputs(root) : []),
            ...[...known].map(([path, hash]) => [resolve(root, path), hash] as const)]) };
}

function changedInputs(before: TestWitness, after: TestWitness): string[] {
    const paths = new Set([...before.hashes.keys(), ...after.hashes.keys()]);
    const changes = [...paths].filter(path => before.hashes.get(path) !== after.hashes.get(path));
    if (before.inventory !== after.inventory && changes.length === 0) changes.push("source inventory");
    if (before.environment !== after.environment) changes.push("test environment");
    return changes;
}
