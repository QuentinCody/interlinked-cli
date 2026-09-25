// Unit F1 (plan §7.3, PE-35): the working tree, the index and a revision are
// DIFFERENT targets. A check against the index or a revision exports exactly
// those bytes into a disposable directory — never a stash, reset or checkout
// of the user's tree — and a worktree receipt certifies the target only when
// the generation computed from the export is byte-identical. Untracked files
// and unstaged fixes are absent from the export by construction.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH } from "./policy.js";
import { runProjectE2e } from "./run.js";
import { exportTarget } from "./target.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 90_000;
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim(); }
function tracked(paths: string[] = ["."]): FixtureProject {
    const project = fixtureProject("py", { accept: true });
    projects.push(project);
    git(project.root, "init", "--quiet");
    git(project.root, "add", ...paths);
    git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "good");
    return project;
}
const sourceOf = (project: FixtureProject) => readFileSync(join(project.root, project.sourceFile), "utf8");

describe("targets — positive (the export is the target's exact bytes)", () => {
    it("P1: after a passing worktree run, a clean index and HEAD certify the same generation; the evaluation records the target identity; the worktree, index and status are untouched", async () => {
        const project = tracked();
        const run = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(run.exitCode, run.messages.join("\n")).toBe(0);
        // The run writes receipts and the ledger (untracked); the CHECKS below must change nothing further.
        const before = { status: git(project.root, "status", "--porcelain"), source: sourceOf(project), head: git(project.root, "rev-parse", "HEAD") };
        const staged = evaluateE2e({ root: project.root, atMs: 5, target: { mode: "index" } });
        expect(staged.status).toBe("configured");
        expect(staged.verdicts[0]!.satisfied).toBe(true);
        expect(staged.target).toMatchObject({ mode: "index", tree: expect.stringMatching(/^[0-9a-f]{40}$/) });
        const revision = evaluateE2e({ root: project.root, atMs: 5, target: { mode: "revision", revision: "HEAD" } });
        expect(revision.verdicts[0]!.satisfied).toBe(true);
        expect(revision.target).toMatchObject({ mode: "revision", commit: before.head });
        expect(revision.verdicts[0]!.generation).toBe(staged.verdicts[0]!.generation);
        expect({ status: git(project.root, "status", "--porcelain"), source: sourceOf(project), head: git(project.root, "rev-parse", "HEAD") }).toEqual(before);
    }, TIMEOUT);
    it("P2: exportTarget copies only tracked bytes into a disposable directory and cleans it up; an untracked file never reaches the export", () => {
        const project = tracked();
        writeFileSync(join(project.root, "untracked.txt"), "not staged");
        const exported = exportTarget(project.root, { mode: "index" });
        expect(exported.ok).toBe(true);
        if (!exported.ok) return;
        expect(existsSync(join(exported.directory, project.sourceFile))).toBe(true);
        expect(existsSync(join(exported.directory, E2E_POLICY_PATH))).toBe(true);
        expect(existsSync(join(exported.directory, "untracked.txt"))).toBe(false);
        exported.cleanup();
        expect(existsSync(exported.directory)).toBe(false);
    });
});
describe("targets — negative (a passing worktree never certifies different staged bytes)", () => {
    it("N1 (PE-35): broken source staged, the fix left unstaged — the worktree run passes, the index check does not", async () => {
        const project = tracked();
        const good = sourceOf(project);
        injectPersistenceDefect(project);
        git(project.root, "add", project.sourceFile); // the defect is what would be committed
        writeFileSync(join(project.root, project.sourceFile), good); // the fix stays in the worktree only
        const run = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(run.exitCode, run.messages.join("\n")).toBe(0);
        expect(evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!.satisfied).toBe(true);
        const staged = evaluateE2e({ root: project.root, atMs: 5, target: { mode: "index" } });
        expect(staged.exitCode).toBe(1);
        expect(staged.verdicts[0]!.satisfied).toBe(false);
        expect(staged.verdicts[0]!.generation).not.toBe(evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!.generation);
        expect(staged.verdicts[0]!.reasons.map(reason => reason.code)).toContain("STALE_GENERATION");
    }, TIMEOUT);
    it("N2: a policy that is not part of the target is UNCONFIGURED for that target (exit 2), even though the worktree has one", () => {
        const project = tracked(["orders_cli.py", "REQUIREMENTS.md"]);
        expect(evaluateE2e({ root: project.root, atMs: 5 }).status).toBe("configured");
        const staged = evaluateE2e({ root: project.root, atMs: 5, target: { mode: "index" } });
        expect(staged.status).toBe("unconfigured");
        expect(staged.exitCode).toBe(2);
    });
    it("N3: an unknown revision, or a directory that is not a repository, is UNAVAILABLE (exit 2) with the reason, never a pass", () => {
        const project = tracked();
        const missing = evaluateE2e({ root: project.root, atMs: 5, target: { mode: "revision", revision: "no-such-ref" } });
        expect(missing.status).toBe("unavailable");
        expect(missing.exitCode).toBe(2);
        expect(missing.reason).toMatch(/no-such-ref/);
        const plain = fixtureProject("py", { accept: true });
        projects.push(plain);
        const notRepo = evaluateE2e({ root: plain.root, atMs: 5, target: { mode: "index" } });
        expect(notRepo.status).toBe("unavailable");
        expect(notRepo.exitCode).toBe(2);
    });
});
