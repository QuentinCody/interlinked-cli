import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fingerprintBuildInputs } from "./build-input-fingerprint.mjs";
export { fingerprintBuildInputs } from "./build-input-fingerprint.mjs";

export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

function treeFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        assert(!entry.isSymbolicLink(), `Test inputs cannot be symbolic links: ${path}`);
        return entry.isDirectory() ? treeFiles(path) : [path];
    });
}

export async function discoveredTests(root, configFile) {
    const require = createRequire(join(root, "package.json"));
    const { createVitest } = await import(require.resolve("vitest/node"));
    const context = await createVitest("test", { root, config: configFile, watch: false, reporters: [] });
    try {
        const tests = await context.globTestSpecifications();
        return { tests: tests.map((test) => test.moduleId).sort(), setup: context.config.setupFiles };
    } finally { await context.close(); }
}

export async function fingerprintTestInputs(root) {
    const { tests, setup } = await discoveredTests(root, join(root, "vitest.e2e.config.ts"));
    assert(tests.length > 0, "The e2e lane collected no tests");
    const compiler = createRequire(join(root, "package.json"))("esbuild");
    const entryPoints = [...tests, ...setup, join(root, "vitest.e2e.config.ts"), join(root, "scripts/e2e-coverage-merge.mjs"), join(root, "scripts/e2e-run.mjs")];
    const { metafile } = await compiler.build({ absWorkingDir: root, entryPoints, outdir: ".e2e-input-scan", write: false,
        bundle: true, platform: "node", format: "esm", packages: "external", metafile: true, logLevel: "silent" });
    const files = [...new Set([...Object.keys(metafile.inputs).map((path) => resolve(root, path)), ...treeFiles(join(root, "src/e2e"))])].sort();
    const hash = createHash("sha256");
    hash.update(JSON.stringify(tests.map((file) => relative(root, file))));
    for (const file of files) {
        hash.update(relative(root, file));
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
    }
    return hash.digest("hex");
}

export function assertE2eBuild(root) {
    const expected = fingerprintBuildInputs(root, { mode: "e2e" });
    assert.equal(readFileSync(join(root, "dist/.build-input-fingerprint"), "utf8").trim(), expected, "Stale or non-e2e build; run npm run build:e2e");
    return expected;
}

export async function validateE2eEvidence(root, reportPath, inventory) {
    const evidence = JSON.parse(readFileSync(join(dirname(reportPath), "run.json"), "utf8"));
    assert(evidence?.schema === 1 && evidence.lane === "e2e" && evidence.passed === true, "No passing measured e2e run");
    assert.equal(evidence.build, assertE2eBuild(root), "Build changed since the measured run");
    assert.equal(evidence.tests, await fingerprintTestInputs(root), "Test inputs changed since the measured run");
    assert.equal(evidence.inventory, hashBytes(JSON.stringify(inventory)), "Boundary inventory changed");
    assert.equal(evidence.report, hashBytes(readFileSync(reportPath)), "Coverage report changed");
    return evidence;
}
