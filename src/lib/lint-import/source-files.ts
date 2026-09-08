import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { lintPath } from "./input-path.js";

const OMIT = new Set(["node_modules", ".git", ".interlinked", ".venv", "venv", "vendor", "scratch", "dist", "build", "target", "coverage", "__pycache__", ".next", ".cache", ".wrangler", ".stryker-tmp"]);
const MAX_SOURCE_ENTRIES = 100_000;

/** Explicit file-only inputs must survive unchanged. Shell quote/glob expansion
 * provenance is not retained by command import, so patterns need review. */
export function literalLintTargets(root: string, targets: readonly string[]): string[] {
    if (targets.length === 0) throw new Error("No explicit lint files requested; no verdict");
    for (const target of targets) {
        if (/[*?\[\]{}]/.test(target)) throw new Error(`Explicit lint pattern needs literal file targets: ${target}; no verdict`);
        if (!statSync(lintPath(root, target)).isFile()) throw new Error(`Explicit lint target is not a regular file: ${target}; no verdict`);
    }
    return [...targets];
}

/** Bounded default file expansion for the file-only ShellCheck/Hadolint adapters. */
export function lintSourceFiles(root: string): string[] {
    const files: string[] = [];
    const pending = [""];
    let visited = 0;
    while (pending.length > 0) {
        const directory = pending.pop() ?? "";
        for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
            if (++visited > MAX_SOURCE_ENTRIES) throw new Error("Lint source census budget exceeded");
            const file = join(directory, entry.name).split(sep).join("/");
            if (entry.isDirectory() && !OMIT.has(entry.name)) pending.push(file);
            if (entry.isFile()) files.push(file);
        }
    }
    return files.sort();
}
