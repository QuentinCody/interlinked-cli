import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isWorkspaceControlPath } from "./workspace-effects-control-paths.js";

/** Named output only. Policy, ledgers that enforce obligations, and unknown files stay observed. */
export const SOURCE_SCAN_OUTPUTS = [
    ".interlinked/payload-keys.json",
    ".interlinked/coverage-runtime-estimate.json",
    ".interlinked/enforcement-ledger.json",
    ".interlinked/hook-translations.jsonl",
    ".interlinked/hook-reentry.jsonl",
    ".interlinked/hook-runtime.json",
];

function trackedPaths(root: string): Set<string> | null {
    try {
        return new Set(execFileSync("git", ["ls-files", "--cached", "-z"], {
            cwd: root, encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        }).split("\0").filter(Boolean));
    } catch { return null; }
}

function artifactReason(root: string, path: string): string | null {
    if (!regularAncestry(root, path)) return null;
    if (SOURCE_SCAN_OUTPUTS.includes(path)) return "harness-output";
    let parent = dirname(resolve(root, path));
    while (parent !== root && relative(root, parent) !== ".." && !relative(root, parent).startsWith("../")) {
        // Do not follow a symlink out of the observed project or exempt its target.
        try { if (lstatSync(parent).isSymbolicLink()) return null; } catch { return null; }
        if (existsSync(join(parent, "pyvenv.cfg"))) return "python-environment";
        if (parent.endsWith("/node_modules") && existsSync(join(parent, ".package-lock.json"))) return "installed-node-dependencies";
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
    }
    return null;
}

function regularAncestry(root: string, path: string): boolean {
    let current = resolve(root, path);
    try {
        while (current !== root) {
            if (lstatSync(current).isSymbolicLink()) return false;
            current = dirname(current);
        }
        return true;
    } catch { return false; }
}

/** One inventory per request. Source-quality scope only: never a runtime-input
 * cache exemption, security verdict, or proof of installer/writer identity. */
export function sourceScanScope(root: string, explicitPaths: readonly string[] = []): { reason(path: string): string | null; priority(path: string): number } {
    root = resolve(root);
    const tracked = trackedPaths(root);
    const explicit = new Set(explicitPaths.map(path => resolve(root, path)));
    const reasons = new Map<string, string | null>();
    return { priority(path) {
        const absolute = resolve(root, path), rel = relative(root, absolute).replaceAll("\\", "/");
        return explicit.has(absolute) || tracked?.has(rel) || isWorkspaceControlPath(rel) ? 0 : 1;
    }, reason(path) {
        const absolute = resolve(root, path), rel = relative(root, absolute).replaceAll("\\", "/");
        if (!tracked || explicit.has(absolute) || tracked.has(rel) || isWorkspaceControlPath(rel)) return null;
        if (rel === ".." || rel.startsWith("../")) return null;
        if (!reasons.has(rel)) reasons.set(rel, artifactReason(root, rel));
        return reasons.get(rel) ?? null;
    } };
}
