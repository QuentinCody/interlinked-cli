import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeAssetInputs } from "./copy-runtime-assets.mjs";

export const COWORK_ENTRY_POINT = "src/cowork-hook.ts";
export function buildEntryPoints(mode = "standard") {
    return [
        "src/index.ts", "src/hook-entry.ts", "src/harness/server.ts", "src/harness/background-job-main.ts",
        "src/harness/replay/inference-proxy.ts", "src/harness/check-engine/tool-runners/tsc-overlay-sidecar-main.ts",
        "src/lib/demo-runtime/index.ts", "src/lib/viz/reporter-vitest.ts", "src/lib/hook-bridge/index.ts",
        ...(mode === "e2e" ? ["src/harness/agent-io/store.ts", "src/harness/break-glass.ts"] : []),
    ];
}

const INPUT_DIRECTORIES = ["src", "skills"];
const TSUP_CONFIG_FILES = ["ts", "cts", "mts", "js", "cjs", "mjs", "json"].map((extension) => `tsup.config.${extension}`);
const INPUT_FILES = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts/build-atomic.mjs",
    "scripts/build-atomic-cli.mjs",
    "scripts/build-input-fingerprint.mjs",
    "scripts/build-lease.mjs",
    "scripts/build-publish.mjs",
    "scripts/fix-dist-dts.mjs",
    "scripts/copy-runtime-assets.mjs",
    "scripts/e2e-declaration-inputs.mjs",
    ...TSUP_CONFIG_FILES,
];

function isProductBuildInput(relativePath) {
    const normalized = relativePath.split(sep).join("/");
    if (/(?:^|\/)(?:__tests__|__fixtures__)(?:\/|$)/.test(normalized)) return false;
    return !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(normalized);
}

function collectFiles(root, current, out) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name);
        const rel = relative(root, absolute);
        if (!isProductBuildInput(rel)) continue;
        if (entry.isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) {
            throw new Error(`Build inputs must not be symbolic links: ${rel}`);
        }
        if (entry.isDirectory()) collectFiles(root, absolute, out);
        else if (entry.isFile()) out.push(rel);
    }
}

function runtimeCandidates(files) {
    // Source and declaration files can affect --dts even when esbuild erases their type-only imports.
    return files.filter((file) => /^src\/(?:.*\/)?\.interlinked\/.*\.jsonl?$/.test(file.split(sep).join("/")));
}

function hasCustomBuildConfig(root) {
    for (let directory = root; ; directory = dirname(directory)) {
        if (TSUP_CONFIG_FILES.some((file) => existsSync(join(directory, file)))) return true;
        const packagePath = join(directory, "package.json");
        if (existsSync(packagePath) && Object.hasOwn(JSON.parse(readFileSync(packagePath, "utf8")), "tsup")) return true;
        if (dirname(directory) === directory) return false;
    }
}

/** The JS graph erases type-only JSON imports, but their shapes can change published declarations. */
function declarationInputs(root, files) {
    // Source scripts and root bundles use a sibling; the unsplit daemon lives
    // one level below the same published asset. Never load a helper from cwd.
    const helper = ["./e2e-declaration-inputs.mjs", "../e2e-declaration-inputs.mjs"]
        .map(path => fileURLToPath(new URL(path, import.meta.url))).find(path => existsSync(path));
    if (!helper) throw new Error("Build declaration helper unavailable");
    const result = spawnSync(process.execPath, ["--max-old-space-size=512", helper], {
        cwd: root, input: JSON.stringify({ root, files }), encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 ** 2,
        // This compiler metadata probe is not a product boundary execution;
        // copied analysis assets have no product source map for the E2E merger.
        env: { ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: undefined },
    });
    if (result.error || result.status !== 0) throw new Error("Build declaration graph unavailable");
    const inputs = JSON.parse(result.stdout);
    if (!Array.isArray(inputs) || !inputs.every(file => typeof file === "string")) throw new Error("Invalid build declaration graph");
    return new Set(inputs);
}

/** Git errors and incomplete dependency graphs retain every candidate: unknown input relevance is never an exclusion. */
function generatedRuntimeFiles(root, candidates, mode, files) {
    if (candidates.length === 0) return new Set();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const tracked = spawnSync("git", ["ls-files", "--cached", "-z", "--", ...candidates],
        { cwd: root, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
    if (tracked.error || tracked.status !== 0) return new Set();
    const protectedInputs = new Set([...tracked.stdout.split("\0").filter(Boolean), ...runtimeAssetInputs()]
        .map((file) => resolve(root, file)));
    const untracked = candidates.filter((file) => !protectedInputs.has(resolve(root, file)));
    if (untracked.length === 0) return new Set();
    try {
        if (hasCustomBuildConfig(root)) return new Set();
        const entryPoints = [...buildEntryPoints(mode), COWORK_ENTRY_POINT];
        if (entryPoints.some((file) => !existsSync(join(root, file)))) return new Set();
        const { buildSync } = createRequire(import.meta.url)("esbuild");
        const { metafile } = buildSync({ absWorkingDir: root, entryPoints, outdir: ".build-input-scan",
            bundle: true, write: false, platform: "node", format: "esm", packages: "external", metafile: true, logLevel: "silent" });
        for (const file of Object.keys(metafile.inputs)) protectedInputs.add(resolve(root, file));
        const declarations = declarationInputs(root, files);
        return new Set(untracked.filter((file) => !protectedInputs.has(resolve(root, file)) && !declarations.has(realpathSync(join(root, file)))));
    } catch {
        return new Set();
    }
}

function buildInputFiles(root, mode) {
    const files = [];
    for (const directory of INPUT_DIRECTORIES) {
        const absolute = join(root, directory);
        if (existsSync(absolute)) collectFiles(root, absolute, files);
    }
    for (const rel of INPUT_FILES) {
        if (existsSync(join(root, rel))) files.push(rel);
    }
    const generated = generatedRuntimeFiles(root, runtimeCandidates(files), mode, files);
    return [...new Set(files)].filter((file) => !generated.has(file)).sort();
}

/** Public build seam: fingerprint every product source, bundled skill, and build recipe input. */
export function fingerprintBuildInputs(projectRoot, { mode = "standard" } = {}) {
    const root = resolve(projectRoot);
    const hash = createHash("sha256");
    hash.update(`mode:${mode}\0`);
    for (const rel of buildInputFiles(root, mode)) {
        const content = readFileSync(join(root, rel));
        hash.update(rel.split(sep).join("/"));
        hash.update("\0");
        hash.update(String(content.byteLength));
        hash.update("\0");
        hash.update(content);
        hash.update("\0");
    }
    return hash.digest("hex");
}
