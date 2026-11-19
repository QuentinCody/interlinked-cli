import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SKIP = new Set([".git", ".interlinked", ".claude", ".codex", ".agents", "node_modules", "vendor", "dist", "build", "coverage", "target", ".venv", "venv"]);
export interface InventoryPaths { discovery: "git" | "filesystem"; paths: string[]; issues: string[]; }
export interface InventoryOptions {
    resourcePolicy?: "foreground-survey" | "runtime";
    signal?: AbortSignal;
}

function filesystemPaths(root: string, options: InventoryOptions): InventoryPaths {
    const result: InventoryPaths = { discovery: "filesystem", paths: [], issues: [] };
    const limit = options.resourcePolicy === "foreground-survey" ? Infinity : 50_000;
    const pending = [root];
    while (pending.length && result.paths.length < limit) {
        options.signal?.throwIfAborted();
        const directory = pending.pop();
        if (directory === undefined) break;
        try {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                options.signal?.throwIfAborted();
                if (SKIP.has(entry.name)) continue;
                const path = join(directory, entry.name);
                if (entry.isDirectory()) pending.push(path);
                else result.paths.push(relative(root, path));
                if (result.paths.length >= limit) break;
            }
        } catch (error) {
            options.signal?.throwIfAborted();
            result.issues.push(`Cannot enumerate ${relative(root, directory) || "."}: ${String(error)}`);
        }
    }
    options.signal?.throwIfAborted();
    if (result.paths.length >= limit) result.issues.push("Discovery reached the 50000-path runtime limit");
    result.paths.sort();
    return result;
}

function explicitlyIgnoredSubdirectory(root: string, env: NodeJS.ProcessEnv, options: InventoryOptions, issues: string[]): boolean {
    const timeout = options.resourcePolicy === "foreground-survey" ? 0 : 15_000;
    try {
        options.signal?.throwIfAborted();
        const prefix = execFileSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "--show-prefix"], {
            cwd: root, env, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"],
        });
        options.signal?.throwIfAborted();
        // `check-ignore .` can match "*" even at the checkout root. Only an
        // explicitly selected subdirectory may override an empty Git census.
        if (!prefix.trim()) return false;
        execFileSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "--quiet", "--", "."], {
            cwd: root, env, timeout, stdio: "ignore",
        });
        options.signal?.throwIfAborted();
        return true;
    } catch (error) {
        options.signal?.throwIfAborted();
        if (options.resourcePolicy === "foreground-survey" && !(error !== null && typeof error === "object" && "status" in error && error.status === 1)) {
            issues.push(`Cannot determine selected Git ignore scope: ${String(error)}`);
        }
        return false;
    }
}

function knownGitWorktree(root: string, env: NodeJS.ProcessEnv, options: InventoryOptions): boolean {
    try {
        const output = execFileSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "--is-inside-work-tree"], {
            cwd: root, env, timeout: 0, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
        options.signal?.throwIfAborted();
        if (output.trim() === "true") return true;
    } catch (error) {
        options.signal?.throwIfAborted();
        // A missing Git executable or a non-worktree root uses the filesystem.
        // A discoverable Git marker still establishes that ignore scope is unknown.
        void error;
    }
    let directory = root;
    for (;;) {
        options.signal?.throwIfAborted();
        if (existsSync(join(directory, ".git"))) return true;
        const parent = dirname(directory);
        if (parent === directory) return false;
        directory = parent;
    }
}

export function inventoryPaths(root: string, options: InventoryOptions = {}): InventoryPaths {
    options.signal?.throwIfAborted();
    // Hooks can inherit Git's repository selectors. They must not override the
    // directory being measured or bind its inventory to another checkout/index.
    const env = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
    try {
        const output = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
            cwd: root, env, encoding: "utf8", timeout: options.resourcePolicy === "foreground-survey" ? 0 : 15_000,
            maxBuffer: options.resourcePolicy === "foreground-survey" ? Infinity : 32 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        });
        options.signal?.throwIfAborted();
        const paths = [...new Set(output.split("\0").filter(Boolean))].sort();
        const issues: string[] = [];
        if (paths.length === 0 && explicitlyIgnoredSubdirectory(root, env, options, issues)) return filesystemPaths(root, options);
        return { discovery: "git", paths, issues };
    } catch (error) {
        options.signal?.throwIfAborted();
        if (options.resourcePolicy === "foreground-survey" && knownGitWorktree(root, env, options)) {
            return { discovery: "git", paths: [], issues: [`Git inventory unavailable; Git ignore scope could not be preserved: ${String(error)}`] };
        }
        return filesystemPaths(root, options);
    }
}
