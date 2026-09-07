import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set([".git", ".interlinked", ".claude", ".codex", ".agents", "node_modules", "vendor", "dist", "build", "coverage", "target", ".venv", "venv"]);
export interface InventoryPaths { discovery: "git" | "filesystem"; paths: string[]; issues: string[]; }

function walk(root: string, directory: string, result: InventoryPaths): void {
    if (result.paths.length >= 50_000) return;
    try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(root, path, result);
            else result.paths.push(relative(root, path));
            if (result.paths.length >= 50_000) break;
        }
    } catch (error) {
        result.issues.push(`Cannot enumerate ${relative(root, directory)}: ${String(error)}`);
    }
}

export function inventoryPaths(root: string): InventoryPaths {
    try {
        const output = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
            cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        });
        return { discovery: "git", paths: [...new Set(output.split("\0").filter(Boolean))].sort(), issues: [] };
    } catch {
        const result: InventoryPaths = { discovery: "filesystem", paths: [], issues: [] };
        walk(root, root, result);
        if (result.paths.length >= 50_000) result.issues.push("Discovery reached the 50000-path limit");
        result.paths.sort();
        return result;
    }
}
