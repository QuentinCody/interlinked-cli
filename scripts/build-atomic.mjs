import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { copyRuntimeAssets } from "./copy-runtime-assets.mjs";
import { fixDistDts } from "./fix-dist-dts.mjs";
import { fingerprintBuildInputs } from "./build-input-fingerprint.mjs";
import { acquireBuildLease } from "./build-lease.mjs";
import {
    BUILD_INPUT_MARKER,
    publishedInputFingerprint,
    publishRuntimeSafe,
    writePackageFileAllowlist,
} from "./build-publish.mjs";

const ENTRY_POINTS = [
    "src/index.ts",
    "src/hook-entry.ts",
    "src/harness/server.ts",
    "src/harness/replay/inference-proxy.ts",
    "src/harness/check-engine/tool-runners/tsc-overlay-sidecar-main.ts",
    "src/lib/demo-runtime/index.ts",
    "src/lib/viz/reporter-vitest.ts",
    "src/lib/hook-bridge/index.ts",
];

// Exported so the regression suite pins the public declaration surface.
export const REQUIRED_OUTPUTS = [
    "index.js",
    "hook-entry.js",
    "harness/server.js",
    "harness/replay/inference-proxy.js",
    "harness/check-engine/tool-runners/tsc-overlay-sidecar-main.js",
    "lib/demo-runtime/index.js",
    "lib/viz/reporter-vitest.js",
    "lib/hook-bridge/index.js",
    "lib/hook-bridge/index.d.ts",
    "index.d.ts",
    "hook-entry.d.ts",
    "harness/server.d.ts",
    "lib/demo-runtime/index.d.ts",
    "lib/viz/reporter-vitest.d.ts",
    "sidecars/opf-sidecar.py",
    "sidecars/calibrations/default.json",
    "sidecars/calibrations/high_precision.json",
    "checks/data/npm-popular-packages.json",
    "viz/index.html",
    "viz/mutation-runs.html",
    "skills/interlinked/SKILL.md",
    ".npmignore",
];

const EXECUTABLE_OUTPUTS = ["index.js", "hook-entry.js"];
const NODE_SHEBANG = "#!/usr/bin/env node";
const HOOK_PROBE_RUNNER = "__interlinked_bootstrap_probe__";
const HOOK_PROBE_STDERR = `[interlinked] unknown runner id: ${HOOK_PROBE_RUNNER}\n`;

function runCommand(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status === 0) return;
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`;
    throw new Error(`${basename(command)} failed (${detail})`);
}

function buildStage(root, stage) {
    const tsup = join(root, "node_modules", ".bin", "tsup");
    runCommand(
        tsup,
        [...ENTRY_POINTS, "--format", "esm", "--dts", "--clean", "--out-dir", stage],
        root,
    );
    fixDistDts(stage);
    copyRuntimeAssets(stage, root);
    for (const rel of EXECUTABLE_OUTPUTS) chmodSync(join(stage, rel), 0o755);
}

function validateHookRuntime(artifact) {
    const result = spawnSync(
        process.execPath,
        [artifact, `--runner=${HOOK_PROBE_RUNNER}`, "--event=PreToolUse"],
        { input: "{}\n", encoding: "utf8", timeout: 5_000 },
    );
    if (
        result.error !== undefined ||
        result.status !== 0 ||
        result.stdout !== "" ||
        result.stderr !== HOOK_PROBE_STDERR
    ) {
        const detail = result.error?.message ?? `exit ${result.status ?? "unknown"}`;
        throw new Error(`Staged hook runtime self-check failed (${detail})`);
    }
}

// Exported for exact entrypoint/shebang validation tests.
export function validateDistribution(stage) {
    for (const rel of REQUIRED_OUTPUTS) {
        const artifact = join(stage, rel);
        if (!existsSync(artifact) || !statSync(artifact).isFile() || statSync(artifact).size === 0) {
            throw new Error(`Staged build is missing required non-empty artifact: ${rel}`);
        }
    }

    for (const rel of EXECUTABLE_OUTPUTS) {
        const artifact = join(stage, rel);
        if ((statSync(artifact).mode & 0o111) === 0) {
            throw new Error(`Staged CLI entry is not executable: ${rel}`);
        }
        const [firstLine] = readFileSync(artifact, "utf8").split(/\r?\n/, 1);
        if (firstLine !== NODE_SHEBANG) {
            throw new Error(`Staged CLI entry has an invalid Node shebang: ${rel}`);
        }
    }

    // A non-empty executable containing only a shebang exits zero under Node
    // while enforcing nothing. Exercise a side-effect-free unknown-runner path
    // so coalescing can only trust a hook bundle that actually initialized.
    validateHookRuntime(join(stage, "hook-entry.js"));
}

function publishedBuildMatches(projectRoot, fingerprint) {
    if (publishedInputFingerprint(projectRoot) !== fingerprint) return false;
    try {
        validateDistribution(join(projectRoot, "dist"));
        return true;
    } catch {
        return false;
    }
}

async function runBuildWhileLeased({
    projectRoot,
    lease,
    populateStage,
    validateStage,
    fingerprintInputs,
    publishStage,
    beforePublishFile,
}) {
    const inputFingerprint = fingerprintInputs(projectRoot);
    if (lease.waited && publishedBuildMatches(projectRoot, inputFingerprint)) {
        return { coalesced: true };
    }

    const stage = mkdtempSync(join(projectRoot, ".dist-build-"));
    try {
        await populateStage(projectRoot, stage);
        chmodSync(stage, 0o755);
        mkdirSync(stage, { recursive: true });
        writeFileSync(join(stage, BUILD_INPUT_MARKER), `${inputFingerprint}\n`);
        writePackageFileAllowlist(stage);
        await validateStage(stage);
        if (fingerprintInputs(projectRoot) !== inputFingerprint) {
            throw new Error("Build inputs changed while bundling; live dist entrypoints were not published");
        }
        publishStage(projectRoot, stage, { beforePublishFile });
        return { coalesced: false };
    } finally {
        if (existsSync(stage)) rmSync(stage, { recursive: true });
    }
}

/**
 * Build under a repository lease, reject moving build inputs, then publish
 * shared files before entrypoints. The live dist directory is never removed.
 */
// Deliberately exported for the focused failure-injection regression suite.
export async function buildAtomically({
    root = process.cwd(),
    populateStage = buildStage,
    validateStage = validateDistribution,
    fingerprintInputs = fingerprintBuildInputs,
    publishStage = publishRuntimeSafe,
    beforePublishFile = () => {},
    leaseOptions = {},
} = {}) {
    const projectRoot = resolve(root);
    const lease = await acquireBuildLease(projectRoot, leaseOptions);
    try {
        return await runBuildWhileLeased({
            projectRoot,
            lease,
            populateStage,
            validateStage,
            fingerprintInputs,
            publishStage,
            beforePublishFile,
        });
    } finally {
        lease.release();
    }
}
