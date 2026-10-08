import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { extractChangedEvidence } from "./evidence.js";
import { digest } from "./store.js";
import type { EvidenceRecord } from "./types.js";

export function gitText(root: string, args: string[]): string {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16000000,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

export function resolveRevision(root: string, revision: string): string {
    return gitText(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${revision}^{commit}`,
    ]).trim();
}

export function revisionFile(root: string, revision: string, file: string): string {
    const found = gitText(root, ["ls-tree", "-z", revision, "--", file]);
    if (!found) return "";
    if (!found.startsWith("100")) throw new Error("only regular source files are eligible");
    return gitText(root, ["show", `${revision}:${file}`]);
}

export function workingFile(root: string, file: string): string {
    try {
        const actual = realpathSync(resolve(root, file));
        const rel = relative(realpathSync(root), actual);
        if (rel === ".." || rel.startsWith(`..${sep}`))
            throw new Error("source escapes repository");
        return readFileSync(actual, "utf8");
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return "";
        throw error;
    }
}

function eligiblePath(file: string): boolean {
    return (
        /\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|h)$/.test(file) &&
        !/(?:^|\/)(?:node_modules|vendor|dist|\.interlinked|\.git)\//.test(file)
    );
}

function changedPaths(root: string, refs: string[], working: boolean): string[] {
    const paths = gitText(root, ["diff", "--name-only", "--no-renames", "-z", ...refs, "--"])
        .split("\0")
        .filter(Boolean);
    if (working)
        paths.push(
            ...gitText(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
                .split("\0")
                .filter(Boolean),
        );
    return [...new Set(paths)];
}

function addedFileDiff(after: string): string {
    const lines = after.replace(/\n$/, "").split("\n");
    return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

export function collectChange(
    root: string,
    options: { base?: string; revision?: string; files?: string[]; message?: string },
): EvidenceRecord[] {
    const revision = options.revision ? resolveRevision(root, options.revision) : null;
    const base = resolveRevision(root, options.base ?? (revision ? `${revision}^` : "HEAD"));
    const refs = revision ? [base, revision] : [base];
    const paths = options.files ?? changedPaths(root, refs, revision === null);
    const message =
        options.message ??
        (revision ? gitText(root, ["show", "-s", "--format=%B", revision]).trim() : "");
    const timestamp = revision
        ? gitText(root, ["show", "-s", "--format=%cI", revision]).trim()
        : new Date().toISOString();
    const records: EvidenceRecord[] = [];
    for (const file of paths.filter(eligiblePath)) {
        const before = revisionFile(root, base, file);
        const after = revision ? revisionFile(root, revision, file) : workingFile(root, file);
        const trackedDiff = gitText(root, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--diff-algorithm=myers",
            "--unified=3",
            ...refs,
            "--",
            file,
        ]);
        const diff = trackedDiff || (!before && after ? addedFileDiff(after) : "");
        const identity = revision ?? `worktree:${digest({ file, before, after })}`;
        records.push(
            ...extractChangedEvidence({
                file,
                before,
                after,
                diff,
                repository: realpathSync(root),
                revision: identity,
                timestamp,
                message,
            }),
        );
    }
    return records;
}

export function sampleCommits(
    root: string,
    options: { before?: string; after?: string; count: number },
): string[] {
    if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > 1000)
        throw new Error("sample count must be 1..1000");
    const args = ["log", "--no-merges", "--format=%H", `--max-count=${options.count}`];
    if (options.before) args.push(`--before=${options.before}`);
    if (options.after) args.push(`--after=${options.after}`);
    return gitText(root, [...args, "--"])
        .trim()
        .split("\n")
        .filter(Boolean);
}
