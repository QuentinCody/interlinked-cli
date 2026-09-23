import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertE2eBuild, validateE2eEvidence } from "../../scripts/e2e-evidence.mjs";
import { withAsyncFileMutationLock } from "../lib/file-mutation-lock.js";
import { boundaryInventory } from "./e2e-inventory.js";
import { assertE2eTransition, compareE2e, moveE2e, parseE2eBaseline, parseE2eReport, retireE2e, type E2eBaseline, type E2eFiles } from "./e2e-ratchet.js";

export const E2E_BASELINE_PATH = ".interlinked/coverage-e2e-baseline.json";

export function resolveE2eBase(base?: string): string { return base ?? "HEAD"; }

export function loadE2eBaseline(path: string): E2eBaseline {
    assert(existsSync(path), `Missing e2e baseline: ${path}. Initialize a measured run with --init-baseline.`);
    return parseE2eBaseline(JSON.parse(readFileSync(path, "utf8")));
}

/** A missing baseline at an existing commit means first initialization. A
 * missing commit or malformed baseline is always an error. */
export function baseE2eFiles(root: string, base?: string): E2eFiles {
    const commit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${resolveE2eBase(base)}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", commit], { cwd: root, encoding: "utf8" });
    const files = new Set(tree.trim().split("\n"));
    if (!files.has(E2E_BASELINE_PATH)) return {};
    const baseline = parseE2eBaseline(JSON.parse(execFileSync("git", ["show", `${commit}:${E2E_BASELINE_PATH}`], { cwd: root, encoding: "utf8" })));
    return Object.fromEntries(Object.entries(baseline.files).filter(([path]) => files.has(path)));
}

export interface E2eStoreDeps {
    inventory: (root: string) => string[] | Promise<string[]>;
    base: (root: string, base?: string) => E2eFiles;
    evidence: (root: string, report: string, inventory: string[]) => Promise<void>;
}

const defaultDeps: E2eStoreDeps = {
    inventory: (root) => {
        assertE2eBuild(root);
        return boundaryInventory(root, JSON.parse(readFileSync(join(root, "dist/metafile-esm.json"), "utf8")));
    },
    base: baseE2eFiles,
    evidence: async (root, report, inventory) => { await validateE2eEvidence(root, report, inventory); },
};

function publishBaseline(path: string, files: E2eFiles): E2eBaseline {
    const baseline: E2eBaseline = { version: 1, updated_at: new Date().toISOString(), files };
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
        renameSync(temp, path);
    } finally { if (existsSync(temp)) rmSync(temp); }
    return baseline;
}

export interface E2eCheckOptions {
    root: string;
    report?: string | undefined;
    base?: string | undefined;
    mappings?: string[] | undefined;
    init?: boolean | undefined;
    update?: boolean | undefined;
}

export async function checkE2eBaseline(options: E2eCheckOptions, deps: E2eStoreDeps = defaultDeps): Promise<E2eBaseline> {
    const path = join(options.root, E2E_BASELINE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    return withAsyncFileMutationLock(path, async () => {
        assert(!options.init || !existsSync(path), "E2e baseline already exists");
        const before = options.init ? {} : loadE2eBaseline(path).files;
        const inventory = await deps.inventory(options.root);
        const base = deps.base(options.root, options.base);
        const reportPath = resolve(options.root, options.report ?? "coverage-e2e/coverage-summary.json");
        const bytes = readFileSync(reportPath, "utf8");
        await deps.evidence(options.root, reportPath, inventory);
        assert.equal(readFileSync(reportPath, "utf8"), bytes, "Report changed during validation");
        const report = parseE2eReport(JSON.parse(bytes));
        const files = compareE2e({ before, base, report, inventory, mappings: options.mappings ?? [] });
        if (options.update || options.init) return publishBaseline(path, files);
        return { version: 1, updated_at: "not written", files };
    }, { waitMs: 10_000 });
}

export async function editE2eIdentity(options: { root: string; base?: string | undefined; mappings?: string[] | undefined; retire?: string | undefined }, deps: E2eStoreDeps = defaultDeps): Promise<E2eBaseline> {
    const path = join(options.root, E2E_BASELINE_PATH);
    return withAsyncFileMutationLock(path, async () => {
        const before = loadE2eBaseline(path).files;
        const inventory = await deps.inventory(options.root);
        const base = deps.base(options.root, options.base);
        const files = options.retire
            ? retireE2e(before, options.retire, inventory)
            : moveE2e({ before, base, inventory, mappings: options.mappings ?? [] });
        assert(options.retire || options.mappings?.length, "Supply a path to retire or at least one --map old=new");
        assertE2eTransition(before, files, inventory, base);
        return publishBaseline(path, files);
    }, { waitMs: 10_000 });
}
