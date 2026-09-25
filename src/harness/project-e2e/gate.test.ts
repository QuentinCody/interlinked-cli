// Unit F4 (plan §12 gate table, PE-35/36/37/38): explicitly installed git hooks
// that CHECK qualifying evidence for the exact target (index at pre-commit,
// each pushed revision at pre-push) and give the recovery command. Hooks never
// execute a suite; they chain with an existing hook through an explicit
// wrapper and never replace it. Real `git commit` / `git push` drive them.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { gateDecision, gateHookStatus, installGateHooks, pushTargets, uninstallGateHooks } from "./gate.js";
import { recordPolicyReplacement } from "./policy-base.js";
import { E2E_POLICY_PATH, parseE2ePolicy } from "./policy.js";
import { runProjectE2e } from "./run.js";

const roots: string[] = [];
const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const TIMEOUT = 180_000;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", env: ENV }).trim(); }
function gitTry(root: string, ...args: string[]): { status: number; out: string } { const run = spawnSync("git", args, { cwd: root, encoding: "utf8", env: ENV }); return { status: run.status ?? -1, out: `${run.stdout}\n${run.stderr}` }; }
function tracked(): FixtureProject {
    const project = fixtureProject("py", { accept: true });
    projects.push(project);
    git(project.root, "init", "--quiet", "-b", "main");
    writeFileSync(join(project.root, ".gitignore"), ".interlinked/test-runs/\n.interlinked/*.jsonl\n");
    git(project.root, "add", ".");
    git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
    return project;
}
function bareRemote(project: FixtureProject): string {
    const remote = mkdtempSync(join(tmpdir(), "e2e-remote-")); roots.push(remote);
    git(remote, "init", "--quiet", "--bare");
    git(project.root, "remote", "add", "origin", remote);
    return remote;
}
async function satisfiedAndCommitted(project: FixtureProject, message: string): Promise<void> {
    const run = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
    expect(run.exitCode, run.messages.join("\n")).toBe(0);
    git(project.root, "add", "-A");
    if (git(project.root, "status", "--porcelain")) git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", message);
}

describe("gate hooks — positive", () => {
    it("P1: install writes marked pre-commit and pre-push hooks, chains an existing hook (backed up, still runs first), status reports both, uninstall restores the original", () => {
        const project = tracked();
        const hooks = join(project.root, ".git", "hooks");
        writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\ntouch original-ran\n");
        chmodSync(join(hooks, "pre-commit"), 0o755);
        const installed = installGateHooks(project.root, { commit: true, push: true });
        expect(installed.preCommit).toMatchObject({ installed: true, backedUp: expect.stringMatching(/pre-commit\.interlinked-e2e-orig$/) });
        expect(installed.prePush).toMatchObject({ installed: true });
        expect(gateHookStatus(project.root)).toEqual({ preCommit: true, prePush: true });
        expect(readFileSync(join(hooks, "pre-commit"), "utf8")).toMatch(/interlinked-e2e-gate/);
        expect(installGateHooks(project.root, { commit: true, push: false }).preCommit.installed).toBe(false); // idempotent
        const removed = uninstallGateHooks(project.root);
        expect(removed).toEqual({ preCommit: { removed: true, restored: join(hooks, "pre-commit") }, prePush: { removed: true } });
        expect(readFileSync(join(hooks, "pre-commit"), "utf8")).toBe("#!/bin/sh\ntouch original-ran\n");
        expect(gateHookStatus(project.root)).toEqual({ preCommit: false, prePush: false });
    });
    it("P2: a commit whose staged bytes carry a qualifying receipt passes the pre-commit gate; the chained original hook still ran", async () => {
        const project = tracked();
        const hooks = join(project.root, ".git", "hooks");
        writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\ntouch original-ran\n");
        chmodSync(join(hooks, "pre-commit"), 0o755);
        installGateHooks(project.root, { commit: true, push: false });
        await satisfiedAndCommitted(project, "satisfied");
        writeFileSync(join(project.root, "NOTES.md"), "release notes\n"); // outside every generation (REQUIREMENTS.md is cited, so editing it would be stale)
        git(project.root, "add", "-A");
        const commit = gitTry(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "note");
        expect(commit.status, commit.out).toBe(0);
        expect(existsSync(join(project.root, "original-ran"))).toBe(true);
    }, TIMEOUT);
    it("P3: pre-push judges EACH pushed revision against its remote base — a satisfied branch pushes, a deleted ref is skipped, a new branch is a bootstrap", async () => {
        const project = tracked();
        bareRemote(project);
        installGateHooks(project.root, { commit: false, push: true });
        await satisfiedAndCommitted(project, "satisfied");
        const first = gitTry(project.root, "push", "--quiet", "origin", "main");
        expect(first.status, first.out).toBe(0);
        expect(first.out).toMatch(/new ref .*bootstrap/);
        git(project.root, "checkout", "--quiet", "-b", "feature");
        const feature = gitTry(project.root, "push", "--quiet", "origin", "feature");
        expect(feature.status, feature.out).toBe(0);
        const deletion = gitTry(project.root, "push", "--quiet", "origin", ":feature");
        expect(deletion.status, deletion.out).toBe(0);
        expect(deletion.out).toMatch(/deletion, nothing to check/);
    }, TIMEOUT);
    it("P4: gateDecision honours gates.commit / gates.ci — absent on a required project enforces, warn/off and advisory projects do not", () => {
        const policy = (gates?: Record<string, string>, mode = "required") => parseE2ePolicy(JSON.stringify({ version: 1, expectations: [], projects: [{ id: "p", root: ".", protectedInputs: ["a"], mode, ...(gates ? { gates } : {}), suites: [{ id: "s", adapter: "managed-contracts" }], scenarios: [{ id: "x", suite: "s", affects: ["a"], contractIds: ["c"], required: true }] }] }));
        expect(gateDecision(policy(), "commit")).toEqual({ enforced: true, projects: ["p"] });
        expect(gateDecision(policy({ commit: "warn" }), "commit")).toEqual({ enforced: false, projects: [] });
        expect(gateDecision(policy({ ci: "off" }), "ci")).toEqual({ enforced: false, projects: [] });
        expect(gateDecision(policy({ ci: "require" }, "advisory"), "ci")).toEqual({ enforced: false, projects: [] });
    });
    it("P5: pushTargets parses git's pre-push stdin into per-ref targets with deletions and new refs classified", () => {
        const zero = "0".repeat(40), a = "a".repeat(40), b = "b".repeat(40);
        expect(pushTargets(`refs/heads/main ${a} refs/heads/main ${b}\nrefs/heads/f ${a} refs/heads/f ${zero}\n(delete) ${zero} refs/heads/old ${b}\n`)).toEqual([
            { remoteRef: "refs/heads/main", revision: a, base: b, kind: "update" },
            { remoteRef: "refs/heads/f", revision: a, base: null, kind: "new" },
            { remoteRef: "refs/heads/old", revision: null, base: b, kind: "delete" },
        ]);
    });
});
describe("gate hooks — negative (a passing worktree never certifies broken staged bytes; a broken push is refused)", () => {
    it("N1 (PE-35): broken source staged with a passing unstaged fix — the pre-commit gate refuses with the recovery command, and HEAD does not move", async () => {
        const project = tracked();
        installGateHooks(project.root, { commit: true, push: false });
        await satisfiedAndCommitted(project, "satisfied");
        const head = git(project.root, "rev-parse", "HEAD");
        const good = readFileSync(join(project.root, project.sourceFile), "utf8");
        injectPersistenceDefect(project);
        git(project.root, "add", project.sourceFile);
        writeFileSync(join(project.root, project.sourceFile), good);
        const commit = gitTry(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "broken staged");
        expect(commit.status).not.toBe(0);
        expect(commit.out).toMatch(/interlinked tests e2e run/);
        expect(commit.out).toMatch(/staged bytes only/);
        expect(git(project.root, "rev-parse", "HEAD")).toBe(head);
    }, TIMEOUT);
    it("N2: a pushed revision without a qualifying receipt is refused per ref with the recovery command; a project whose gates.ci is warn pushes with a warning", async () => {
        const project = tracked();
        bareRemote(project);
        installGateHooks(project.root, { commit: false, push: true });
        await satisfiedAndCommitted(project, "satisfied");
        expect(gitTry(project.root, "push", "--quiet", "origin", "main").status).toBe(0);
        injectPersistenceDefect(project);
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "regression");
        const refused = gitTry(project.root, "push", "--quiet", "origin", "main");
        expect(refused.status).not.toBe(0);
        expect(refused.out).toMatch(/refs\/heads\/main/);
        expect(refused.out).toMatch(/interlinked tests e2e run/);
        const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as { projects: Array<{ gates: Record<string, string> }> }; // SAFETY: fixture-authored
        policy.projects[0]!.gates = { commit: "require", ci: "warn" };
        writeFileSync(path, JSON.stringify(policy));
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "ci gate warn");
        const weakened = gitTry(project.root, "push", "--quiet", "origin", "main");
        expect(weakened.status).not.toBe(0); // review F-R2/F-R6: the candidate cannot switch off the gate that judges the switch
        expect(weakened.out).toMatch(/POLICY_WEAKENED \[gate-loosened\]/);
        recordPolicyReplacement({ root: project.root, base: git(project.root, "rev-parse", "origin/main"), projectId: "orders", rationale: "CI gate demoted by team decision", atMs: 5 });
        git(project.root, "add", "-f", ".interlinked/e2e-policy-changes.jsonl");
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "reviewed replacement");
        const warned = gitTry(project.root, "push", "--quiet", "origin", "main");
        expect(warned.status, warned.out).toBe(0);
        expect(warned.out).toMatch(/gate ci is warn/);
    }, TIMEOUT);
});
