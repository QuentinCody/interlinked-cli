import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkE2eBaseline, editE2eIdentity, E2E_BASELINE_PATH, loadE2eBaseline, type E2eCheckOptions } from "../harness/e2e-store.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export interface E2eCommandOptions {
    lane?: string;
    cwd?: string;
    report?: string;
    base?: string;
    map?: string[];
    changedFiles?: string;
    updateBaseline?: boolean;
    initBaseline?: boolean;
    requireMeasured?: boolean;
    json?: boolean;
}

export function coverageLaneStatusCommand(options: E2eCommandOptions): void {
    const root = resolve(options.cwd ?? process.cwd());
    const rows = ["base", "e2e"].map((lane) => {
        const path = join(root, ".interlinked", lane === "e2e" ? "coverage-e2e-baseline.json" : "coverage-baseline.json");
        if (!existsSync(path)) return { lane, status: "not initialized", files: 0 };
        try {
            const baseline = lane === "e2e" ? loadE2eBaseline(path) : JSON.parse(readFileSync(path, "utf8"));
            return { lane, status: "baseline recorded (run coverage check for a verdict)", files: Object.keys(baseline.files).length };
        } catch { return { lane, status: "invalid baseline", files: 0 }; }
    });
    output(getOutputMode(options), rows, { json: () => rows, normal: () => rows.map((row) => `${row.lane}: ${row.status}; ${row.files} files`).join("\n") });
}

export function e2eCheckOptions(options: E2eCommandOptions): E2eCheckOptions {
    assert.equal(options.lane, "e2e", "The only named coverage lane is e2e");
    assert(!options.changedFiles, "--changed-files conflicts with --lane e2e: the entire inventory is required");
    return { root: resolve(options.cwd ?? process.cwd()), report: options.report, base: options.base,
        mappings: options.map, init: options.initBaseline, update: options.updateBaseline };
}

export async function coverageE2eCheckCommand(options: E2eCommandOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const baseline = await checkE2eBaseline(e2eCheckOptions(options));
        const payload = { lane: "e2e", measured: true, passed: true, files: Object.keys(baseline.files).length,
            written: Boolean(options.updateBaseline || options.initBaseline) };
        output(mode, payload, { json: () => payload, normal: () => `E2e coverage passed for ${payload.files} files${payload.written ? "; baseline saved" : ""}.` });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

export function coverageE2eBaselineCommand(options: E2eCommandOptions): void {
    const mode = getOutputMode(options);
    try {
        const { root } = e2eCheckOptions(options);
        const baseline = loadE2eBaseline(join(root, E2E_BASELINE_PATH));
        output(mode, baseline, { json: () => baseline, normal: () => JSON.stringify(baseline, null, 2) });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

export async function coverageE2eIdentityCommand(options: E2eCommandOptions, positional: { old?: string | undefined; next?: string | undefined; retire?: string | undefined }): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const { root, base } = e2eCheckOptions(options);
        assert(!positional.old || positional.next, "coverage move requires both old and new paths");
        const mappings = [...(options.map ?? [])];
        if (positional.old && positional.next) mappings.push(`${positional.old}=${positional.next}`);
        const baseline = await editE2eIdentity({ root, base, mappings, retire: positional.retire });
        output(mode, baseline, { json: () => baseline, normal: () => "E2e identity decision recorded. Run coverage check --lane e2e for a measured verdict." });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
