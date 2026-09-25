// Unit F review round 1 (2026-09-25, F-R1–F-R7 in scratch/review-project-e2e-unit-f/REVIEW.md).
// Every case is the reviewer's counterexample, reproduced through real git
// (commits, a bare remote, real pushes) and pinned in the direction the gate
// must now take. Nothing here trusts a mocked verdict.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { runCi } from "./ci.js";
import { qualifyStability } from "./cohort.js";
import { evaluateE2e } from "./evaluate.js";
import { installGateHooks } from "./gate.js";
import { recordPolicyReplacement } from "./policy-base.js";
import { comparePolicies } from "./policy-diff.js";
import { E2E_POLICY_PATH, parseE2ePolicy, type E2ePolicy } from "./policy.js";
import { runProjectE2e } from "./run.js";
import { exportTarget } from "./target.js";

const projects: FixtureProject[] = [];
const dirs: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const TIMEOUT = 240_000;
const AT_MS = 1_700_000_000_000;
const CLI = resolve("dist/index.js");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", env: ENV }).trim(); }
function gitTry(root: string, ...args: string[]): { status: number; out: string } { const run = spawnSync("git", args, { cwd: root, encoding: "utf8", env: ENV }); return { status: run.status ?? -1, out: `${run.stdout}\n${run.stderr}` }; }
function check(root: string, ...args: string[]): { status: number; out: string } { const run = spawnSync(process.execPath, [CLI, "tests", "e2e", "check", ...args], { cwd: root, encoding: "utf8", env: ENV }); return { status: run.status ?? -1, out: `${run.stdout}\n${run.stderr}` }; }
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
    const remote = mkdtempSync(join(tmpdir(), "e2e-remote-")); dirs.push(remote);
    git(remote, "init", "--quiet", "--bare");
    git(project.root, "remote", "add", "origin", remote);
    return remote;
}
type Json = { projects: Array<{ mode: string; gates: Record<string, string>; scenarios: Array<{ stability?: { qualificationRuns: number } }> }> };
function patchPolicy(project: FixtureProject, mutate: (policy: Json) => void): void {
    const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as Json; // SAFETY: fixture-authored
    mutate(policy);
    writeFileSync(path, JSON.stringify(policy));
}
async function satisfied(project: FixtureProject): Promise<void> {
    const run = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
    expect(run.exitCode, run.messages.join("\n")).toBe(0);
}
const flag = (revision: string) => ({ revision, source: "flag" as const, bootstrap: false });

describe("F-R1 — chained pre-push keeps git's ref stream", () => {
    it("N1: an existing pre-push hook plus an unqualified revision ⇒ the push is REFUSED, the original hook still saw the ref row, the remote has no branch", () => {
        const project = tracked(), remote = bareRemote(project);
        const hook = join(project.root, ".git", "hooks", "pre-push");
        writeFileSync(hook, "#!/bin/sh\ncat > original-input.txt\nexit 0\n");
        chmodSync(hook, 0o755);
        installGateHooks(project.root, { commit: false, push: true });
        expect(check(project.root, "--revision", "HEAD").status).toBe(1);
        const push = gitTry(project.root, "push", "--quiet", "origin", "main");
        expect(push.status, push.out).not.toBe(0);
        expect(push.out).toMatch(/refs\/heads\/main/);
        expect(push.out).toMatch(/interlinked tests e2e run/);
        expect(readFileSync(join(project.root, "original-input.txt"), "utf8")).toMatch(/^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main 0{40}/);
        expect(gitTry(remote, "rev-parse", "--verify", "refs/heads/main").status).not.toBe(0);
    }, TIMEOUT);
    it("P1: with a qualifying receipt, a push of TWO refs through the chained hook judges each ref and succeeds", async () => {
        const project = tracked(); bareRemote(project);
        const hook = join(project.root, ".git", "hooks", "pre-push");
        writeFileSync(hook, "#!/bin/sh\ncat > original-input.txt\nexit 0\n");
        chmodSync(hook, 0o755);
        installGateHooks(project.root, { commit: false, push: true });
        await satisfied(project);
        git(project.root, "branch", "feature");
        const push = gitTry(project.root, "push", "--quiet", "origin", "main", "feature");
        expect(push.status, push.out).toBe(0);
        expect(push.out).toMatch(/refs\/heads\/main ←/);
        expect(push.out).toMatch(/refs\/heads\/feature ←/);
        expect(readFileSync(join(project.root, "original-input.txt"), "utf8").trim().split("\n")).toHaveLength(2);
    }, TIMEOUT);
});
describe("F-R2 — gate decisions come from the judged target, and never waive POLICY_WEAKENED", () => {
    it("N1: an UNSTAGED gates.commit: off does not soften the staged check; STAGING it is POLICY_WEAKENED and still exit 1 under --gate commit", () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.gates.commit = "off"; });
        const unstaged = check(project.root, "--staged", "--base", "HEAD", "--gate", "commit");
        expect(unstaged.status, unstaged.out).toBe(1);
        expect(unstaged.out).toMatch(/gate commit is required/);
        git(project.root, "add", E2E_POLICY_PATH);
        const staged = check(project.root, "--staged", "--base", "HEAD", "--gate", "commit");
        expect(staged.status, staged.out).toBe(1);
        expect(staged.out).toMatch(/POLICY_WEAKENED \[gate-loosened\] .*gates\.commit require → off/);
        expect(staged.out).toMatch(/never waived by the candidate/);
    }, TIMEOUT);
    it("P1: a gate the TRUSTED BASE already set to warn softens the staged check (reported, exit 0) — the decision is the judged policy's, not the worktree's", () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.gates.commit = "warn"; });
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "warn gate");
        const result = check(project.root, "--staged", "--base", "HEAD", "--gate", "commit");
        expect(result.status, result.out).toBe(0);
        expect(result.out).toMatch(/reported only, exit 0/);
    }, TIMEOUT);
});
describe("F-R3 — CI judges the candidate commit, never the working tree", () => {
    it("N1: a committed defect with an unstaged repair ⇒ CI exit 1 against the candidate commit (target: revision), while the working tree would have passed", async () => {
        const project = tracked(), base = git(project.root, "rev-parse", "HEAD");
        const good = readFileSync(join(project.root, project.sourceFile), "utf8");
        injectPersistenceDefect(project);
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "broken revision");
        writeFileSync(join(project.root, project.sourceFile), good);
        const ci = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: flag(base) });
        expect(ci.exitCode).toBe(1);
        expect(ci.evaluation.target).toMatchObject({ mode: "revision", commit: git(project.root, "rev-parse", "HEAD") });
        expect(ci.evaluation.verdicts.some(row => row.satisfied)).toBe(false);
        expect(ci.trust.join("\n")).toMatch(/exact tree of commit/);
        expect(existsSync(ci.candidate!.evidence)).toBe(true);
    }, TIMEOUT);
});
describe("F-R4 — replacement records are read from the judged target", () => {
    it("N1: a local, uncommitted §13 record does not discharge a committed demotion; the COMMITTED record does", async () => {
        const project = tracked(), base = git(project.root, "rev-parse", "HEAD");
        patchPolicy(project, policy => { policy.projects[0]!.mode = "advisory"; });
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "demote");
        await satisfied(project);
        const revision = { root: project.root, atMs: AT_MS, target: { mode: "revision" as const, revision: "HEAD" }, base };
        expect(evaluateE2e(revision).exitCode).toBe(1);
        recordPolicyReplacement({ root: project.root, base, projectId: "orders", rationale: "local uncommitted decision", atMs: AT_MS });
        const local = evaluateE2e(revision);
        expect(local.exitCode).toBe(1);
        expect(local.policy).toMatchObject({ recordsFrom: "target", replaced: [] });
        expect(evaluateE2e({ ...revision, target: { mode: "working-tree" } }).policy?.recordsFrom).toBe("working-tree");
        git(project.root, "add", "-f", ".interlinked/e2e-policy-changes.jsonl");
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "reviewed replacement");
        const committed = evaluateE2e(revision);
        expect(committed.exitCode, JSON.stringify(committed.policy)).toBe(0);
        expect(committed.policy?.replaced.map(row => row.kind)).toEqual(["project-demoted"]);
    }, TIMEOUT);
});
describe("F-R5 — the base policy is read from the exact tree, never through archive attributes", () => {
    it("N1: `.gitattributes export-ignore` on the policy at the base hides nothing: the demotion is POLICY_WEAKENED, not a bootstrap", async () => {
        const project = tracked();
        writeFileSync(join(project.root, ".gitattributes"), `${E2E_POLICY_PATH} export-ignore\n`);
        git(project.root, "add", ".gitattributes");
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "archive attributes");
        const base = git(project.root, "rev-parse", "HEAD");
        const exported = exportTarget(project.root, { mode: "revision", revision: base });
        expect(exported.ok && existsSync(join(exported.directory, E2E_POLICY_PATH))).toBe(true);
        if (exported.ok) exported.cleanup();
        patchPolicy(project, policy => { policy.projects[0]!.mode = "advisory"; });
        writeFileSync(join(project.root, ".gitattributes"), "");
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "demote and drop the attribute");
        await satisfied(project);
        const result = evaluateE2e({ root: project.root, atMs: AT_MS, target: { mode: "revision", revision: "HEAD" }, base });
        expect(result.exitCode).toBe(1);
        expect(result.policy).toMatchObject({ bootstrap: false });
        expect(result.policy?.weakening.map(row => row.kind)).toEqual(["project-demoted"]);
    }, TIMEOUT);
});
describe("F-R6 — an omitted gate compares as its effective default", () => {
    const policy = (gates: Record<string, string>): E2ePolicy => parseE2ePolicy(JSON.stringify({ version: 1, expectations: [], projects: [{ id: "p", root: ".", protectedInputs: ["a"], mode: "required", gates, suites: [{ id: "s", adapter: "managed-contracts" }], scenarios: [{ id: "x", suite: "s", affects: ["a"], contractIds: ["c"], required: true }] }] }));
    it("N1: omitted (require) → explicit off is gate-loosened", () => {
        expect(comparePolicies(policy({}), policy({ commit: "off" }), []).weakening.map(row => `${row.kind}: ${row.detail}`)).toEqual(["gate-loosened: project p gates.commit require (default) → off"]);
        expect(comparePolicies(policy({ ci: "warn" }), policy({}), []).weakening).toEqual([]); // warn → default require is a tightening
    });
    it("P1: omitted → omitted, omitted → explicit require, and review advisory → omitted (its default) are silent", () => {
        expect(comparePolicies(policy({}), policy({}), []).weakening).toEqual([]);
        expect(comparePolicies(policy({}), policy({ commit: "require", ci: "require" }), []).weakening).toEqual([]);
        expect(comparePolicies(policy({ review: "advisory" }), policy({}), []).weakening).toEqual([]);
        expect(comparePolicies(policy({ review: "require" }), policy({}), []).weakening.map(row => row.kind)).toEqual(["gate-loosened"]);
    });
});
describe("round 2 F2-1 — the exported candidate is the committed bytes, whatever checkout conversion is configured", () => {
    it("N1: a smudge filter that repairs the committed defect on checkout changes nothing: the export equals `git show`, and CI on the broken commit exits 1 (revision AND index routes)", async () => {
        const project = tracked(), good = readFileSync(join(project.root, project.sourceFile), "utf8");
        injectPersistenceDefect(project);
        writeFileSync(join(project.root, ".gitattributes"), `${project.sourceFile} filter=review\n`);
        git(project.root, "add", ".gitattributes", project.sourceFile);
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "committed defect");
        const repair = join(project.root, ".git", "review-good-source.py");
        writeFileSync(repair, good);
        git(project.root, "config", "filter.review.smudge", `cat '${repair}'`);
        const committed = git(project.root, "show", `HEAD:${project.sourceFile}`);
        for (const mode of ["revision", "index"] as const) {
            const exported = exportTarget(project.root, mode === "revision" ? { mode, revision: "HEAD" } : { mode });
            expect(exported.ok).toBe(true);
            expect(exported.ok && readFileSync(join(exported.directory, project.sourceFile), "utf8").trim()).toBe(committed);
            if (exported.ok) exported.cleanup();
        }
        const ci = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: flag("HEAD") });
        expect(ci.exitCode).toBe(1);
    }, TIMEOUT);
});
describe("round 3 — a committed symlink is exported as a link, in both modes", () => {
    it("P1: an ordinary documentation symlink outside every input scope exports (index and revision) as a symlink with the committed target, never followed", () => {
        const project = tracked();
        symlinkSync("REQUIREMENTS.md", join(project.root, "docs-link.md"));
        git(project.root, "add", "docs-link.md");
        for (const mode of ["index", "revision"] as const) {
            const exported = exportTarget(project.root, mode === "revision" ? { mode, revision: "HEAD" } : { mode });
            expect(exported.ok, exported.ok ? "" : exported.reason).toBe(true);
            if (!exported.ok) continue;
            const link = join(exported.directory, mode === "index" ? "docs-link.md" : "REQUIREMENTS.md");
            expect(lstatSync(link).isSymbolicLink()).toBe(mode === "index");
            if (mode === "index") expect(readlinkSync(link)).toBe("REQUIREMENTS.md");
            exported.cleanup();
        }
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "link");
        const committed = exportTarget(project.root, { mode: "revision", revision: "HEAD" });
        expect(committed.ok, committed.ok ? "" : committed.reason).toBe(true);
        if (committed.ok) { expect(readlinkSync(join(committed.directory, "docs-link.md"))).toBe("REQUIREMENTS.md"); committed.cleanup(); }
        expect(check(project.root, "--revision", "HEAD").status).toBe(1); // still judged: the obligation is open, not unavailable
    }, TIMEOUT);
});
describe("round 4 — CI never resolves execution state through a candidate-controlled symlink", () => {
    for (const linked of [".interlinked/test-runs", ".interlinked"] as const) {
        it(`N: a committed symlink at ${linked} pointing outside the export ⇒ CI is UNAVAILABLE (exit 2), nothing runs, the external sentinel survives and nothing external is created`, async () => {
            const project = tracked();
            const outside = mkdtempSync(join(tmpdir(), "e2e-outside-")); dirs.push(outside);
            mkdirSync(join(outside, "e2e"), { recursive: true });
            writeFileSync(join(outside, "e2e", "sentinel.txt"), "keep me\n");
            const before = readdirSync(outside).sort();
            if (linked === ".interlinked") {
                // the policy must still be reachable through the link for the candidate to look configured
                cpSync(join(project.root, ".interlinked"), join(outside, "state"), { recursive: true });
                rmSync(join(project.root, ".interlinked"), { recursive: true, force: true });
                symlinkSync(join(outside, "state"), join(project.root, ".interlinked"));
            } else {
                rmSync(join(project.root, ".interlinked", "test-runs"), { recursive: true, force: true });
                symlinkSync(outside, join(project.root, ".interlinked", "test-runs"));
            }
            git(project.root, "add", "-A");
            git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "state symlink");
            const ci = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: flag("HEAD") });
            expect(ci.exitCode).toBe(2);
            expect(ci.evaluation.status).toBe("unavailable");
            expect(ci.evaluation.reason ?? "").toMatch(/symlink/);
            expect(ci.run.receipts).toEqual([]);
            expect(existsSync(join(outside, "e2e", "sentinel.txt"))).toBe(true);
            expect(readdirSync(outside).sort()).toEqual(before.concat(linked === ".interlinked" ? ["state"] : []).sort());
        }, TIMEOUT);
    }
    it("N: an evidence-retention destination whose ancestor under the checkout is a symlink is refused (reported, nothing written through it)", async () => {
        const project = tracked();
        const outside = mkdtempSync(join(tmpdir(), "e2e-outside-")); dirs.push(outside);
        mkdirSync(join(project.root, ".interlinked", "test-runs", "e2e"), { recursive: true });
        symlinkSync(outside, join(project.root, ".interlinked", "test-runs", "e2e", "ci"));
        const ci = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: flag("HEAD") });
        expect(ci.exitCode, ci.messages.join("\n")).toBe(0); // the candidate itself is fine; only retention is refused
        expect(ci.messages.join("\n")).toMatch(/evidence not retained: .*ci under the checkout is a symlink/);
        expect(ci.candidate?.evidence).toBe("");
        expect(readdirSync(outside)).toEqual([]);
    }, TIMEOUT);
});
describe("round 2 F2-2 — CI starts with empty execution state whatever the candidate commits", () => {
    it("N1: a COMMITTED deferred one-attempt cohort and a committed quarantine row are discarded: CI runs both attempts itself and counts only executions it started", async () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.scenarios[0]!.stability = { qualificationRuns: 2 }; });
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "stability");
        let clockCalls = 0;
        const local = await qualifyStability({ root: project.root, projectId: "orders", scenarioId: "order-persists", timeoutMs: TIMEOUT, now: () => (clockCalls++ < 2 ? 0 : TIMEOUT + 1) });
        expect(local.cohort.attempts).toHaveLength(1);
        writeFileSync(join(project.root, ".interlinked/e2e-quarantine.jsonl"), `${JSON.stringify({ key: "orders/order-persists", generation: local.cohort.generation, cohortId: "stale", attempts: [], reason: "committed quarantine", atMs: 1, reviewAtMs: 2 })}\n`);
        git(project.root, "add", "-f", ".interlinked/e2e-obligations.jsonl", ".interlinked/e2e-quarantine.jsonl", ".interlinked/test-runs/e2e");
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "tracked previous evidence");
        const ci = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: flag("HEAD") });
        expect(ci.exitCode, ci.messages.join("\n")).toBe(0);
        expect(ci.run.receipts).toHaveLength(2);
        const localIds = new Set(local.cohort.attempts.map(row => row.runId));
        for (const receipt of ci.run.receipts) expect(localIds.has(receipt.runId)).toBe(false);
        expect(ci.run.messages.join("\n")).not.toMatch(/resumed/);
    }, TIMEOUT);
});
describe("round 2 F2-3 — revision-based proofs resolve in the real repository from inside the CI export", () => {
    it("P1: a committed characterization proof pinned to the base commit passes CI exactly as it passes a local supervised run", async () => {
        const project = tracked(), pinned = git(project.root, "rev-parse", "HEAD");
        patchPolicy(project, policy => { (policy.projects[0]!.scenarios[0]! as { proof?: unknown }).proof = { mode: "characterization", revision: pinned }; });
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "characterization");
        const local = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(local.exitCode, local.messages.join("\n")).toBe(0);
        const ci = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: flag("HEAD") });
        expect(ci.exitCode, [...ci.messages, ...ci.evaluation.verdicts.flatMap(row => row.reasons.map(reason => reason.message))].join("\n")).toBe(0);
        expect(ci.evaluation.verdicts[0]).toMatchObject({ satisfied: true, dimensions: { sensitivity: "preserved" } });
    }, TIMEOUT);
});
describe("F-R7 — CI produces the stability evidence itself and inherits none", () => {
    it("P1: a committed two-run profile is qualified by CI in one invocation, with every attempt produced inside the export; a prior workstation cohort contributes nothing", async () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.scenarios[0]!.stability = { qualificationRuns: 2 }; });
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "require stability");
        const local = await qualifyStability({ root: project.root, projectId: "orders", scenarioId: "order-persists", timeoutMs: TIMEOUT });
        expect(local.exitCode).toBe(0);
        const ci = await runCi({ root: project.root, timeoutMs: TIMEOUT, atMs: AT_MS, base: flag("HEAD") });
        expect(ci.exitCode, ci.messages.join("\n")).toBe(0);
        expect(ci.run.receipts).toHaveLength(2);
        const localIds = new Set(local.cohort.attempts.map(row => row.runId));
        for (const receipt of ci.run.receipts) expect(localIds.has(receipt.runId)).toBe(false);
        expect(ci.evaluation.verdicts[0]).toMatchObject({ satisfied: true, dimensions: { stability: "qualified" } });
        expect(ci.trust.join("\n")).toMatch(/fresh state directory/);
    }, TIMEOUT);
});
