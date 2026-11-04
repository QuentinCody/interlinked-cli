import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertE2eBuild, assertE2eReportDestination, fingerprintTestInputs } from "../../scripts/e2e-evidence.mjs";
import { assertE2eSourceMaps } from "./e2e-build-preflight.js";
import { boundaryInventory } from "./e2e-inventory.js";
import { preflightE2eComparison, type E2eFiles } from "./e2e-ratchet.js";
import { baseE2eFiles, E2E_BASELINE_PATH, loadE2eBaseline } from "./e2e-store.js";

export interface E2ePreflightOptions {
    requireBaseline?: boolean;
    base?: string;
    mappings?: string[];
}

export interface E2ePreflightDeps {
    build: (root: string) => string;
    tests: (root: string) => Promise<string>;
    inventory: (root: string, metafile: unknown) => string[];
    base: (root: string, base?: string) => E2eFiles;
}

const defaultDeps: E2ePreflightDeps = {
    build: assertE2eBuild, tests: fingerprintTestInputs, inventory: boundaryInventory, base: baseE2eFiles,
};

/** Read-only prerequisites, never measured coverage or a reusable execution receipt. */
export async function preflightE2eRun(root: string, options: E2ePreflightOptions = {}, deps: E2ePreflightDeps = defaultDeps) {
    const path = join(root, E2E_BASELINE_PATH);
    const before = options.requireBaseline === false && !existsSync(path) ? {} : loadE2eBaseline(path).files;
    const base = deps.base(root, options.base);
    const buildFingerprint = deps.build(root);
    const metafile: unknown = JSON.parse(readFileSync(join(root, "dist/metafile-esm.json"), "utf8"));
    const inventory = deps.inventory(root, metafile);
    assert(inventory.length > 0, "E2e boundary inventory is empty; coverage is unavailable");
    preflightE2eComparison({ before, base, inventory, mappings: options.mappings ?? [] });
    assertE2eSourceMaps(root, metafile, inventory);
    assertE2eReportDestination(root);
    const testFingerprint = await deps.tests(root);
    return { buildFingerprint, testFingerprint, inventory, measured: false as const };
}
