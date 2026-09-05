import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isCappableFile, isInsideRoot } from "../../harness/large-file-policy.js";
import { selectFunctionTokenAnalyzer } from "../../harness/function-tokens/index.js";

export interface SourceInput { file: string; content: string; sha256: string; }
export interface SourceGap { file: string; reason: string; }
export interface SourceCensus {
    sources: SourceInput[];
    notMeasured: SourceGap[];
    discoveryIssues: string[];
    excluded: string[];
    discovery: "git" | "filesystem";
}
const MAX_ENTRIES = 50_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const WALK_SKIP = new Set([".git", ".interlinked", ".claude", ".codex", "node_modules", "dist", "build", "coverage", "target", ".venv", "venv", "__pycache__"]);

function gitPaths(root: string): string[] | null {
    try {
        return execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
            cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        }).split("\0").filter(Boolean);
    } catch {
        return null; // Non-git directories have the same path/content classification below.
    }
}

interface WalkState { paths: string[]; issues: string[]; entries: number; }
function walkDirectory(root: string, directory: string, state: WalkState): void {
    if (state.entries >= MAX_ENTRIES) return;
    try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            state.entries++;
            if (state.entries >= MAX_ENTRIES) break;
            if (WALK_SKIP.has(entry.name)) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walkDirectory(root, path, state);
            else state.paths.push(relative(root, path));
        }
    } catch (error) {
        state.issues.push(`Cannot enumerate ${relative(root, directory) || "."}: ${String(error)}`);
    }
}

function collectSource(root: string, file: string, census: SourceCensus): void {
    const path = resolve(root, file);
    const scope = { root, filePath: path };
    if (selectFunctionTokenAnalyzer(file) === null || !isCappableFile({ ...scope, content: "" })) {
        census.excluded.push(file);
        return;
    }
    try {
        if (!isInsideRoot(root, path)) throw new Error("Path is outside the selected root");
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("Symbolic links are not followed by the scoring census");
        if (!stat.isFile()) throw new Error("Source is not a regular file");
        if (!isInsideRoot(root, realpathSync(path))) throw new Error("Source resolves outside the selected root");
        if (stat.size > MAX_SOURCE_BYTES) throw new Error("Source exceeds the 2 MiB analysis limit");
        const content = readFileSync(path, "utf8");
        if (!isCappableFile({ ...scope, content })) { census.excluded.push(file); return; }
        census.sources.push({ file, content, sha256: createHash("sha256").update(content).digest("hex") });
    } catch (error) {
        census.notMeasured.push({ file, reason: error instanceof Error ? error.message : "Cannot read source" });
    }
}

/** Read-only, no repository configuration scripts, plugins, models or network requests. */
export function collectScoringSources(directory: string): SourceCensus {
    const root = realpathSync(directory);
    if (!statSync(root).isDirectory()) throw new Error("Scoring requires a directory");
    const git = gitPaths(root);
    const walk: WalkState = { paths: [], issues: [], entries: 0 };
    if (git === null) walkDirectory(root, root, walk);
    if (walk.entries >= MAX_ENTRIES) walk.issues.push("Filesystem discovery reached its 50000-entry limit");
    const paths = [...new Set(git ?? walk.paths)].map(path => path.replace(/\\/g, "/")).sort();
    const census: SourceCensus = { sources: [], notMeasured: [], excluded: [], discoveryIssues: walk.issues, discovery: git === null ? "filesystem" : "git" };
    for (const file of paths) collectSource(root, file, census);
    return census;
}
