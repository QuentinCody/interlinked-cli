import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

const OMIT = new Set(["node_modules", ".git", ".interlinked", ".venv", "venv", "vendor", "scratch", "dist", "build", "target", "coverage", "__pycache__", ".next", ".cache", ".wrangler", ".stryker-tmp"]);
const MAX_SOURCE_ENTRIES = 100_000;

/** Shared bounded source census for file-only analyzers and report freshness snapshots. */
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
