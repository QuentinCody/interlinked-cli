import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonObject } from "../../lib/json-types.js";
import { runEvidenceProcess } from "../../lib/metrics/evidence-process.js";
import { captureEvidenceEnvironment } from "../../lib/metrics/evidence-environment.js";
import type { SpawnFn } from "../coverage-runner.js";
import { remainingCoverageTime } from "../coverage-index/runtime-inputs.js";
import { skipsCoverageOverlayEntry } from "../coverage-overlay.js";

/** Match Vitest's prepareVitest environment before either public API loads config. */
export function captureVitestEnvironment(inherited: NodeJS.ProcessEnv = process.env): ReturnType<typeof captureEvidenceEnvironment> {
    return captureEvidenceEnvironment({ ...inherited, TEST: "true", VITEST: "true", NODE_ENV: inherited.NODE_ENV ?? "test" });
}

/** Exact child environment stays in memory; persisted index fields contain only its digest. */
export function coverageIndexSpawn(environment: NodeJS.ProcessEnv): SpawnFn {
    return async (command, args, options) => {
        const result = await runEvidenceProcess({ cwd: options.cwd, argv: [command, ...args], timeoutMs: Math.max(1, Math.floor(options.timeout)), environment });
        return { stdout: result.output, stderr: "", status: result.outcome === "passed" ? 0 : 1,
            ...(result.outcome === "timeout" || result.outcome === "error" || result.outcome === "cancelled" ? { error: new Error(`Coverage child ${result.outcome}`) } : {}) };
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
