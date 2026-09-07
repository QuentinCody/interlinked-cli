import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { getDataDir } from "../config.js";
import { dataSourceForPath } from "./catalog.js";
import type { DataSource } from "./catalog-types.js";

export interface DiscoveredDataFile {
    path: string;
    relativePath: string;
    source: DataSource;
    bytes: number;
    modifiedMs: number;
    identity: string;
    compressed: boolean;
    archived: boolean;
}

export interface DataDiscovery {
    root: string;
    files: DiscoveredDataFile[];
    issues: Array<{ path: string; reason: string }>;
    entriesScanned: number;
    complete: boolean;
}

interface DiscoveryLimits { maxEntries?: number; maxDepth?: number; }
interface DiscoveryDirectory { path: string; depth: number; }
interface DiscoveryWalk {
    result: DataDiscovery;
    pending: DiscoveryDirectory[];
    maxEntries: number;
    maxDepth: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_DEPTH = 16;
const JSONL_FILE = /\.jsonl(?:\.\d+)?(?:\.gz)?$/;

function discoverEntry(result: DataDiscovery, path: string): void {
    const stat = lstatSync(path);
    if (!stat.isFile()) return;
    const rel = relative(result.root, path).split("\\").join("/");
    result.files.push({
        path, relativePath: rel, source: dataSourceForPath(rel),
        bytes: stat.size, modifiedMs: stat.mtimeMs,
        identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
        compressed: rel.endsWith(".gz"),
        archived: rel.startsWith("archive/") || /\.jsonl(?:\.\d+)?\.gz$/.test(rel) || /\.jsonl\.\d+$/.test(rel),
    });
}

function visitEntry(walk: DiscoveryWalk, directory: DiscoveryDirectory, entry: Dirent): void {
    const path = join(directory.path, entry.name);
    if (entry.isSymbolicLink()) {
        walk.result.issues.push({ path, reason: "symlink not followed" });
        return;
    }
    if (entry.isDirectory()) {
        if (directory.depth < walk.maxDepth) walk.pending.push({ path, depth: directory.depth + 1 });
        else {
            walk.result.complete = false;
            walk.result.issues.push({ path, reason: "discovery depth budget exhausted" });
        }
        return;
    }
    if (entry.isFile() && JSONL_FILE.test(entry.name)) discoverEntry(walk.result, path);
}

function visitDirectory(walk: DiscoveryWalk, directory: DiscoveryDirectory): void {
    try {
        for (const entry of readdirSync(directory.path, { withFileTypes: true })) {
            if (++walk.result.entriesScanned > walk.maxEntries) {
                walk.result.complete = false;
                walk.result.issues.push({ path: directory.path, reason: "discovery entry budget exhausted" });
                return;
            }
            visitEntry(walk, directory, entry);
        }
    } catch (error) {
        walk.result.complete = false;
        walk.result.issues.push({ path: directory.path, reason: error instanceof Error ? error.message : String(error) });
    }
}

/** Metadata only. Never follows symlinks or claims an exhausted walk is complete. */
export function discoverDataFiles(cwd: string, limits: DiscoveryLimits = {}): DataDiscovery {
    const configuredRoot = getDataDir(cwd);
    const root = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
    const result: DataDiscovery = { root, files: [], issues: [], entriesScanned: 0, complete: true };
    if (!existsSync(root)) return result;
    const walk: DiscoveryWalk = {
        result, pending: [{ path: root, depth: 0 }],
        maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES,
        maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    };
    while (walk.pending.length > 0 && result.entriesScanned <= walk.maxEntries) {
        const directory = walk.pending.pop();
        if (directory) visitDirectory(walk, directory);
    }
    result.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return result;
}
