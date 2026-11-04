import { execFileSync } from "node:child_process";
import { hash, integer } from "./relation-core.js";
import { coChangeFromPairs } from "./candidates.js";
import { computeCoupling } from "../../commands/metrics-coupling.js";
import type { HistoryBoundary, HistoryEvidence } from "./relation-types.js";

export function gitText(root: string, args: string[]): string {
    return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], { encoding: "utf8", maxBuffer: 32_000_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function resolveCommit(root: string, revision: string): string {
    if (!revision || revision.startsWith("-") || revision.includes("\0")) throw new Error("invalid revision");
    return gitText(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
}
export function boundedHistory(root: string, boundary: HistoryBoundary): HistoryEvidence {
    const unavailable = (reason: string): HistoryEvidence => ({ status: "unavailable", boundary, commits: [], map: {}, digest: hash({ boundary, reason }), reason, complete: false });
    try {
        integer(boundary.maxCommits, 1, 10000);
        const since = Date.parse(boundary.since), until = Date.parse(boundary.until);
        if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("invalid absolute history window");
        const tip = resolveCommit(root, boundary.tip);
        if (gitText(root, ["rev-parse", "--is-shallow-repository"]) === "true") return unavailable("shallow history");
        // Walk ancestry before time filtering: skewed timestamps must not prune parents.
        const walked = gitText(root, ["rev-list", "--no-merges", `--max-count=${boundary.maxCommits + 1}`, tip]).split("\n").filter(Boolean);
        if (walked.length > boundary.maxCommits) return unavailable("history commit budget exceeded");
        const commits: string[] = [];
        const changes: Array<{ sha: string; timestamp: number; files: string[] }> = [];
        for (const id of walked) {
            const stamp = Number(gitText(root, ["show", "-s", "--format=%ct", id]));
            if (stamp * 1000 < since || stamp * 1000 > until) continue;
            const files = gitText(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", id]).split("\n").filter(Boolean);
            commits.push(id); changes.push({ sha: id, timestamp: stamp, files });
        }
        const map = Object.fromEntries(coChangeFromPairs(computeCoupling(changes, { minSupport: 1, maxCommitFiles: 30, minStrength: 0 })));
        const resolved = { ...boundary, tip };
        return { status: "available", boundary: resolved, commits, map, digest: hash({ boundary: resolved, commits, map }), reason: null, complete: true };
    } catch (error) {
        return unavailable(error instanceof Error && !error.message.startsWith("Command failed") ? error.message : "history objects unavailable");
    }
}
