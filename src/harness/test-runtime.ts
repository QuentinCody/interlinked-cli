import { captureCoverageRuntime, prepareCoverageRuntime } from "./coverage-index/runtime-inputs.js";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { hashBytes } from "../lib/metrics/inventory.js";
import { hasErrorCode } from "./check-engine/tool-errors.js";

export type TestRuntime = { hash: string; issue?: never } | { hash?: never; issue: string };

/** A bounded snapshot failure disables reuse; it never fabricates an empty identity. */
export async function captureTestRuntime(root: string, deadline: number): Promise<TestRuntime> {
    try {
        prepareCoverageRuntime(root, deadline);
        return { hash: (await captureCoverageRuntime(root, { originalRoot: root, deadline })).hash };
    } catch (error) {
        return { issue: error instanceof Error ? error.message : "Runtime snapshot unavailable" };
    }
}

function knownInputHash(path: string): string {
    try {
        const before = statSync(path);
        if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error(`Test input must be a regular file no larger than 64 MiB: ${path}`);
        const hash = hashBytes(readFileSync(path)), after = statSync(path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error(`Test input changed while reading: ${path}`);
        return hash;
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return "<absent>";
        throw error;
    }
}

/** Track requested and declared fixtures even when the source-role inventory excludes them. */
export function captureKnownTestInputs(root: string, paths: Iterable<string>): Map<string, string> {
    return new Map([...new Set(paths)].map(path => [path, knownInputHash(resolve(root, path))]));
}

export function changedKnownTestInputs(root: string, before: Map<string, string>): string[] {
    const after = captureKnownTestInputs(root, before.keys());
    return [...before.keys()].filter(path => before.get(path) !== after.get(path));
}
