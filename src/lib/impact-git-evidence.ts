// ===========================================
// Observed git/dependency deltas for `interlinked impact`
// ===========================================

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "./json-types.js";

export interface GitWorktreeEvidence {
    availability: "available" | "unavailable";
    evidence_class: "observed";
    base: string;
    resolved_base?: string | undefined;
    files_changed: number;
    lines_added: number;
    lines_removed: number;
    binary_files: number;
    untracked_files: number;
    scope: string;
    reason?: string | undefined;
}

interface DependencyChange {
    group: string;
    name: string;
    before?: string | undefined;
    after?: string | undefined;
}

export interface DependencyDeltaEvidence {
    availability: "available" | "unavailable";
    evidence_class: "observed";
    manifest: "package.json";
    added: DependencyChange[];
    removed: DependencyChange[];
    changed: DependencyChange[];
    scope: string;
    reason?: string | undefined;
}

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function unavailableGit(base: string, reason: string): GitWorktreeEvidence {
    return {
        availability: "unavailable",
        evidence_class: "observed",
        base,
        files_changed: 0,
        lines_added: 0,
        lines_removed: 0,
        binary_files: 0,
        untracked_files: 0,
        scope: "tracked worktree delta from a verified commit; untracked paths counted without LOC",
        reason,
    };
}

function parseNumstat(raw: string): Pick<
    GitWorktreeEvidence,
    "binary_files" | "files_changed" | "lines_added" | "lines_removed"
> {
    let filesChanged = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    let binaryFiles = 0;
    for (const line of raw.split("\n")) {
        if (!line) continue;
        const [added, removed] = line.split("\t");
        filesChanged++;
        if (added === "-" || removed === "-") {
            binaryFiles++;
            continue;
        }
        const parsedAdded = Number.parseInt(added ?? "", 10);
        const parsedRemoved = Number.parseInt(removed ?? "", 10);
        if (Number.isFinite(parsedAdded)) linesAdded += parsedAdded;
        if (Number.isFinite(parsedRemoved)) linesRemoved += parsedRemoved;
    }
    return {
        files_changed: filesChanged,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        binary_files: binaryFiles,
    };
}

const INTERLINKED_STATE_PATH = ".interlinked";

function isRepositoryUntrackedLine(line: string): boolean {
    if (!line.startsWith("?? ")) return false;
    const path = line.slice(3).replace(/^"|"$/g, "");
    // Interlinked's own local evidence files are measurement substrate, not
    // repository work product. Counting them makes the view grow by observing.
    return path !== INTERLINKED_STATE_PATH && !path.startsWith(`${INTERLINKED_STATE_PATH}/`);
}

function countUntracked(raw: string): number {
    return raw.split("\n").filter(isRepositoryUntrackedLine).length;
}

export function readGitWorktreeEvidence(cwd: string, base: string): GitWorktreeEvidence {
    try {
        const resolvedBase = git(cwd, ["rev-parse", "--verify", `${base}^{commit}`]);
        const delta = parseNumstat(git(cwd, ["diff", "--numstat", resolvedBase, "--"]));
        const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
        return {
            availability: "available",
            evidence_class: "observed",
            base,
            resolved_base: resolvedBase,
            ...delta,
            untracked_files: countUntracked(status),
            scope: "tracked worktree delta from a verified commit; untracked paths counted without LOC",
        };
    } catch (error) {
        return unavailableGit(base, error instanceof Error ? error.message : String(error));
    }
}

const DEPENDENCY_GROUPS = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
] as const;

function parseManifest(raw: string): JsonObject | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return isJsonObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function dependencyGroup(manifest: JsonObject, group: string): Map<string, string> {
    const value = manifest[group];
    if (!isJsonObject(value)) return new Map();
    const rows = Object.entries(value)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .sort(([left], [right]) => left.localeCompare(right));
    return new Map(rows);
}

function compareGroup(
    group: string,
    before: Map<string, string>,
    after: Map<string, string>,
): Pick<DependencyDeltaEvidence, "added" | "changed" | "removed"> {
    const added: DependencyChange[] = [];
    const removed: DependencyChange[] = [];
    const changed: DependencyChange[] = [];
    for (const [name, version] of after) {
        const prior = before.get(name);
        if (prior === undefined) added.push({ group, name, after: version });
        else if (prior !== version) changed.push({ group, name, before: prior, after: version });
    }
    for (const [name, version] of before) {
        if (!after.has(name)) removed.push({ group, name, before: version });
    }
    return { added, removed, changed };
}

function unavailableDependencies(reason: string): DependencyDeltaEvidence {
    return {
        availability: "unavailable",
        evidence_class: "observed",
        manifest: "package.json",
        added: [],
        removed: [],
        changed: [],
        scope: "root package.json dependency fields compared with the verified base commit",
        reason,
    };
}

export function readDependencyDeltaEvidence(
    cwd: string,
    resolvedBase: string | undefined,
): DependencyDeltaEvidence {
    if (!resolvedBase) return unavailableDependencies("git base is unavailable");
    try {
        const before = parseManifest(git(cwd, ["show", `${resolvedBase}:package.json`]));
        const after = parseManifest(readFileSync(`${cwd}/package.json`, "utf8"));
        if (!before || !after) return unavailableDependencies("package.json is missing or malformed");
        const result: DependencyDeltaEvidence = {
            availability: "available",
            evidence_class: "observed",
            manifest: "package.json",
            added: [],
            removed: [],
            changed: [],
            scope: "root package.json dependency fields compared with the verified base commit",
        };
        for (const group of DEPENDENCY_GROUPS) {
            const delta = compareGroup(group, dependencyGroup(before, group), dependencyGroup(after, group));
            result.added.push(...delta.added);
            result.removed.push(...delta.removed);
            result.changed.push(...delta.changed);
        }
        return result;
    } catch (error) {
        return unavailableDependencies(error instanceof Error ? error.message : String(error));
    }
}
