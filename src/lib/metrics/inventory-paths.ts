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

function filesystemPaths(root: string): InventoryPaths {
    const result: InventoryPaths = { discovery: "filesystem", paths: [], issues: [] };
    walk(root, root, result);
    if (result.paths.length >= 50_000) result.issues.push("Discovery reached the 50000-path limit");
    result.paths.sort();
    return result;
}

function explicitlyIgnoredSubdirectory(root: string, env: NodeJS.ProcessEnv): boolean {
    try {
        const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
            cwd: root, env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"],
        });
        // `check-ignore .` can match "*" even at the checkout root. Only an
        // explicitly selected subdirectory may override an empty Git census.
        if (!prefix.trim()) return false;
        execFileSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "--quiet", "--", "."], {
            cwd: root, env, timeout: 15_000, stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

export function inventoryPaths(root: string): InventoryPaths {
    // Hooks can inherit Git's repository selectors. They must not override the
    // directory being measured or bind its inventory to another checkout/index.
    const env = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
    try {
        const output = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
            cwd: root, env, encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        });
        const paths = [...new Set(output.split("\0").filter(Boolean))].sort();
        if (paths.length === 0 && explicitlyIgnoredSubdirectory(root, env)) return filesystemPaths(root);
        return { discovery: "git", paths, issues: [] };
    } catch {
        return filesystemPaths(root);
    }
}
