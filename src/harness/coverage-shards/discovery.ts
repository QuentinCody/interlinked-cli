import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonObject } from "../../lib/json-types.js";
import { runEvidenceProcess } from "../../lib/metrics/evidence-process.js";
import { captureEvidenceEnvironment } from "../../lib/metrics/evidence-environment.js";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import type { SpawnFn } from "../coverage-runner.js";
import { LEASE_ANCESTORS_ENV, leaseAncestorsForChildren } from "../project-compiler-lock.js";
import type { ResourceBudget } from "../resource-budget.js";
import { remainingCoverageTime } from "../coverage-index/runtime-inputs.js";
import { skipsCoverageOverlayEntry } from "../coverage-overlay.js";

/** Match Vitest's prepareVitest environment before either public API loads config. */
/**
 * Variables the SUPERVISING route sets for itself — a bounded runner's per-export outcome record, lease ancestry,
 * the scope file of one run, a test-capacity scope — and never for the tests. They are removed from the child
 * environment, not merely ignored: a test cannot read a variable it does not receive, so the environment identity
 * stays exact AND stable across pushes (each pre-push export carried a fresh outcome path and invalidated the whole
 * index on every push — found by review 2026-09-29).
 */
const SUPERVISOR_ONLY_VARIABLES = ["INTERLINKED_BOUNDED_OUTCOME", "INTERLINKED_LEASE_ANCESTORS", "INTERLINKED_COVERAGE_SCOPE_FILE", "INTERLINKED_TEST_CAPACITY_SCOPE"] as const;
/**
 * The shell's and npm's working-directory bookkeeping. Each pre-push export is a fresh directory, so `PWD`
 * differed between two byte-identical exports of the same revision and the index could never be reused across
 * pushes (review 2026-09-30). They are removed, not ignored: the child's `process.cwd()` is the workspace either way.
 */
const SHELL_CWD_VARIABLES = ["PWD", "OLDPWD", "INIT_CWD"] as const;

export function captureVitestEnvironment(inherited: NodeJS.ProcessEnv = process.env): ReturnType<typeof captureEvidenceEnvironment> {
    const environment: NodeJS.ProcessEnv = { ...inherited, TEST: "true", VITEST: "true", NODE_ENV: inherited.NODE_ENV ?? "test" };
    for (const name of [...SUPERVISOR_ONLY_VARIABLES, ...SHELL_CWD_VARIABLES]) delete environment[name];
    return captureEvidenceEnvironment(environment);
}

/**
 * The instrumented capture child, SUPERVISED the way the test scheduler's child is: the exact identity environment
 * (persisted index fields carry only its digest) plus this process's lease ancestry, added at spawn time so a test
 * that takes the host lease itself is not deadlocked by the run hosting it; the admitted memory budget is enforced
 * over the whole child tree; a kill or an exceeded budget is an error, never a failed test verdict. A worker cap
 * alone was no supervision (review 2026-09-30).
 */
export function coverageIndexSpawn(environment: NodeJS.ProcessEnv, resourceBudget: ResourceBudget): SpawnFn {
    return async (command, args, options) => {
        const result = await runProcessAsync(command, args, { cwd: options.cwd, timeout: Math.max(1, Math.floor(options.timeout)), resourceBudget,
            exactEnv: { ...environment, [LEASE_ANCESTORS_ENV]: leaseAncestorsForChildren() } });
        const interrupted = result.killed || result.timedOut || result.code === null;
        if (!interrupted) return { stdout: result.stdout, stderr: result.stderr, status: result.code ?? 1 };
        const cause = result.resourceReason ?? (result.timedOut ? "timeout" : "killed");
        return { stdout: result.stdout, stderr: result.stderr, status: result.code ?? 1, error: new Error(`Coverage child interrupted: ${cause}`) };
    };
}
function discoverySource(module: string, root: string, output: string): string {
    return `import { createVitest } from ${JSON.stringify(module)};
import { writeFileSync } from "node:fs";
const ctx = await createVitest("test", { root: ${JSON.stringify(root)}, watch: false, run: true, cache: false }, { cacheDir: ${JSON.stringify(join(output, "vite"))} });
try {
    const specs = await ctx.globTestSpecifications();
    const unsupported = ctx.projects.length !== 1 || ctx.projects.some(project => project.name || project.config.typecheck?.enabled) || specs.some(spec => spec.pool === "typescript");
    const supportFiles = ctx.projects.flatMap(project => [project.vite.config.configFile, ...project.vite.config.configFileDependencies, ...project.config.setupFiles, ...project.config.globalSetup]).filter(value => typeof value === "string");
    writeFileSync(${JSON.stringify(join(output, "discovery.json"))}, JSON.stringify({ unsupported, files: specs.map(spec => spec.moduleId), supportFiles }));
} finally { await ctx.close(); }
`;
}
export interface VitestUniverse { tests: string[]; supportFiles: string[]; }
interface DependencyMount { logical: string; canonical: string; }
function relativeTestInput(root: string, file: unknown): string {
    if (typeof file !== "string" || !isAbsolute(file)) throw new Error("Malformed Vitest input path");
    const path = relative(root, resolve(file));
    if (isAbsolute(path) || /^\.\.(?:[\\/]|$)/.test(path)) throw new Error("Vitest input lies outside the coverage workspace");
    return path;
}
function supportInput(root: string, file: unknown, mounts: DependencyMount[]): string {
    if (typeof file !== "string" || !isAbsolute(file)) throw new Error("Malformed Vitest support path");
    for (const mount of mounts) {
        const path = relative(mount.canonical, file);
        if (!isAbsolute(path) && !/^\.\.(?:[\\/]|$)/.test(path)) return join(mount.logical, path);
    }
    return relativeTestInput(root, file);
}
function parseDiscovery(root: string, directory: string, mounts: DependencyMount[]): VitestUniverse {
    const path = join(directory, "discovery.json");
    if (statSync(path).size > 4 * 1024 * 1024) throw new Error("Vitest discovery exceeds output bound");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || typeof value.unsupported !== "boolean" || !Array.isArray(value.files) || !Array.isArray(value.supportFiles)) throw new Error("Malformed Vitest discovery");
    if (value.unsupported) throw new Error("Coverage index does not support named/multiple projects or typecheck-only test specifications");
    const files: string[] = [];
    for (const file of value.files) {
        const path = relativeTestInput(root, file);
        if (path.split(/[\\/]/).some((part, depth) => skipsCoverageOverlayEntry(part, depth === 0 ? 0 : 1))) continue;
        if (files.includes(path)) throw new Error("Duplicate Vitest executable test specification");
        files.push(path);
    }
    return { tests: files.sort(), supportFiles: [...new Set(value.supportFiles.map(file => supportInput(root, file, mounts)))].sort() };
}
/** Vitest owns include/exclude/includeSource semantics. Load its config only in a bounded child. */
export async function discoverVitestUniverse(root: string, deadline: number, environment: NodeJS.ProcessEnv, dependencyPaths: readonly string[] = ["node_modules"]): Promise<VitestUniverse> {
    const module = createRequire(join(root, "package.json")).resolve("vitest/node");
    const mounts = dependencyPaths.map(logical => ({ logical, canonical: realpathSync(join(root, logical)) })).sort((a, b) => b.canonical.length - a.canonical.length);
    const directory = mkdtempSync(join(tmpdir(), "interlinked-test-discovery-"));
    try {
        const result = await runEvidenceProcess({ cwd: root, argv: [process.execPath, "--input-type=module", "--eval", discoverySource(pathToFileURL(module).href, root, directory)],
            timeoutMs: remainingCoverageTime(deadline), environment: captureVitestEnvironment(environment).environment });
        if (result.outcome !== "passed") throw new Error(`Vitest discovery ${result.outcome}; test universe unavailable`);
        remainingCoverageTime(deadline);
        return parseDiscovery(root, directory, mounts);
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
export async function discoverVitestTests(root: string, deadline: number, environment: NodeJS.ProcessEnv): Promise<string[]> {
    return (await discoverVitestUniverse(root, deadline, environment)).tests;
}
