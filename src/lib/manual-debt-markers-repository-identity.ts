// ===========================================
// Manual design-debt markers — repository identity fingerprinting
// ===========================================
// Pairs the scan result with the git commit/tree the scan ran against, plus
// a content hash of the exact files scanned so a stale cache is detectable
// even outside a git checkout.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface DebtMarkerRepositoryIdentity {
    root: string;
    head_sha: string | null;
    tree_sha: string | null;
    working_tree_sha256: string;
}

export function repoRelative(projectRoot: string, absolute: string): string | null {
    const rel = relative(projectRoot, absolute);
    if (rel === "") return ".";
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(projectRoot, rel) !== absolute) {
        return null;
    }
    return rel.split(sep).join("/");
}

function gitValue(projectRoot: string, args: string[]): string | null {
    try {
        const value = execFileSync("git", args, {
            cwd: projectRoot,
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        return value.length > 0 ? value : null;
    } catch (gitError) {
        void gitError;
        return null;
    }
}

function workingTreeFingerprint(projectRoot: string, files: readonly string[]): string {
    const hash = createHash("sha256");
    for (const absolute of [...files].sort()) {
        const rel = repoRelative(projectRoot, absolute) ?? absolute;
        hash.update(rel);
        hash.update("\0");
        try {
            hash.update(readFileSync(absolute));
        } catch (readError) {
            void readError;
            hash.update("<unreadable>");
        }
        hash.update("\0");
    }
    return hash.digest("hex");
}

export function repositoryIdentity(
    projectRoot: string,
    files: readonly string[],
): DebtMarkerRepositoryIdentity {
    return {
        root: projectRoot,
        head_sha: gitValue(projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
        tree_sha: gitValue(projectRoot, ["rev-parse", "--verify", "HEAD^{tree}"]),
        working_tree_sha256: workingTreeFingerprint(projectRoot, files),
    };
}
