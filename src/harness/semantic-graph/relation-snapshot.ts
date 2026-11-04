import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { boundedHistory, gitText, resolveCommit } from "./relation-history.js";
import { hash, parsePolicy, textHash } from "./relation-core.js";
import { extractUnits } from "./units.js";
import type { HistoryBoundary, PolicyReference, RelationSnapshot } from "./relation-types.js";

export function safeRelative(path: string): string {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some(p => p === ".." || p === ".git") || /[\0\r\n]/.test(path)) throw new Error("unsafe repository path");
    return path;
}
export function gitFile(root: string, revision: string, path: string): string {
    return execFileSync("git", ["--no-replace-objects", "-C", root, "show", `${revision}:${safeRelative(path)}`], { encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "pipe"] });
}
export function loadRelationPolicy(root: string, revision: string | null, exploratory = false): PolicyReference {
    if (revision === null && !exploratory) throw new Error("committed policy revision required; use explicit exploratory mode for local policy");
    const resolved = revision === null ? null : resolveCommit(root, revision);
    const blobs: Record<string, string> = {};
    const read = (path: string) => {
        const bytes = resolved === null ? readFileSync(join(root, path), "utf8") : gitFile(root, resolved, path);
        blobs[path] = resolved === null ? textHash(bytes) : gitText(root, ["rev-parse", `${resolved}:${path}`]);
        return JSON.parse(bytes) as unknown;
    };
    const invariants = read("semantic-relations/invariants.json");
    const scenarios = read("semantic-relations/scenarios.json");
    const policy = parsePolicy({ version: 1, invariants, scenarios });
    return { revision: resolved, blobs, digest: hash(policy), exploratory: resolved === null, policy };
}
export function snapshotRelations(root: string, revision: string, history: HistoryBoundary, options: { files?: string[]; maxFiles?: number; contextFiles?: string[] } = {}): RelationSnapshot {
    const commit = resolveCommit(root, revision);
    const historyTip = resolveCommit(root, history.tip);
    try { gitText(root, ["merge-base", "--is-ancestor", historyTip, commit]); }
    catch { throw new Error("history tip must be an ancestor of the source revision"); }
    const tree = gitText(root, ["rev-parse", `${commit}^{tree}`]);
    const all = gitText(root, ["ls-tree", "-r", "--name-only", commit]).split("\n").filter(p => (/\.(?:[cm]?[jt]sx?|md)$/.test(p) || options.contextFiles?.includes(p)) && !/^(?:node_modules|dist|scratch|research|\.interlinked)\//.test(p));
    const wanted = options.files ? all.filter(p => options.contextFiles?.includes(p) || options.files!.some(f => p === f || p.startsWith(`${f}/`))) : all;
    const limit = options.maxFiles ?? 2000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("invalid source file budget");
    const omitted = wanted.slice(limit).map(p => `file_budget:${p}`);
    const { files, units } = readSnapshotSources(root, commit, wanted, limit, omitted);
    const repository = gitText(root, ["rev-list", "--max-parents=0", commit]).split("\n").sort().join(",");
    const result = { schema: "interlinked.relation-snapshot/1" as const, repository, revision: commit, tree, files, units, history: boundedHistory(root, history), omitted };
    return { ...result, digest: hash(result) };
}

function readSnapshotSources(root: string, commit: string, wanted: string[], limit: number, omitted: string[]) {
    const files: RelationSnapshot["files"] = {};
    const units: RelationSnapshot["units"] = [];
    let totalBytes = 0;
    for (const path of wanted.slice(0, limit)) {
        const mode = gitText(root, ["ls-tree", commit, "--", path]).split(" ")[0];
        if (mode !== "100644" && mode !== "100755") { omitted.push(`non_regular:${path}`); continue; }
        let content: string;
        try { content = gitFile(root, commit, path); } catch { omitted.push(`unavailable:${path}`); continue; }
        totalBytes += Buffer.byteLength(content);
        if (totalBytes > 24_000_000) { omitted.push(`byte_budget:${path}`); continue; }
        files[path] = { text: content, hash: textHash(content) };
        const lines = content.split(/\r?\n/);
        for (const unit of extractUnits(path, content)) {
            // Recover full markdown spans too: the legacy extractor caps doc text.
            const full = lines.slice(unit.line - 1, unit.endLine).join("\n");
            units.push({ ...unit, text: full, hash: textHash(full) });
        }
    }
    return { files, units };
}
