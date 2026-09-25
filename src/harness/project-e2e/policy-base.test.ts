// Unit F3 at the evaluation surface (plan §13, PE-33, PE-37, PE-38, PE-74):
// `check --base <rev>` compares the judged policy with the TRUSTED base
// policy exported from that revision. A weakening is `POLICY_WEAKENED`
// (exit 1) unless a reviewed replacement record binds exactly the base and
// head digests; an unresolvable base is UNAVAILABLE (exit 2), a base without
// a policy is a bootstrap, and the base is independent of `proof.revision`.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { loadBasePolicy, recordPolicyReplacement } from "./policy-base.js";
import { readPolicyChanges } from "./policy-changes.js";
import { E2E_POLICY_PATH, type E2ePolicy } from "./policy.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim(); }
function tracked(paths: string[] = ["."]): FixtureProject {
    const project = fixtureProject("py", { accept: true });
    projects.push(project);
    git(project.root, "init", "--quiet");
    git(project.root, "add", ...paths);
    git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
    return project;
}
function patchPolicy(project: FixtureProject, mutate: (policy: E2ePolicy) => void): void {
    const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as E2ePolicy; // SAFETY: fixture-authored
    mutate(policy);
    writeFileSync(path, JSON.stringify(policy));
}
const codes = (project: FixtureProject, base: string) => { const evaluation = evaluateE2e({ root: project.root, atMs: 5, base }); return { evaluation, codes: evaluation.policy?.weakening.map(row => row.kind) ?? [] }; };

describe("base policy — positive", () => {
    it("P1: an unchanged policy against HEAD has no weakening and does not change the exit; the base identity (commit + digest) is recorded", () => {
        const project = tracked();
        const { evaluation, codes: kinds } = codes(project, "HEAD");
        expect(kinds).toEqual([]);
        expect(evaluation.policy).toMatchObject({ base: { revision: "HEAD", commit: git(project.root, "rev-parse", "HEAD") }, bootstrap: false });
        expect(evaluation.policy?.baseDigest).toBe(evaluation.policyDigest);
        expect(evaluation.exitCode).toBe(1); // still the open obligation, never the policy
    });
    it("P2: a reviewed replacement record discharges the weakening; the record binds the base commit's digest and the head digest and is read back", () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.scenarios[0]!.required = false; }); // demotion keeps the input mapped; a removal would also leave a needs-mapping gap
        expect(codes(project, "HEAD").codes).toEqual(["scenario-demoted"]);
        const record = recordPolicyReplacement({ root: project.root, base: "HEAD", projectId: "orders", scenarioId: "order-persists", rationale: "requirement R1 retired by product decision", atMs: 5 });
        const base = loadBasePolicy(project.root, "HEAD");
        expect(base.status === "configured" ? base.digest : null).toBe(record.baseDigest);
        expect(readPolicyChanges(project.root).records).toHaveLength(1);
        const after = codes(project, "HEAD");
        expect(after.codes).toEqual([]);
        expect(after.evaluation.policy?.replaced.map(row => row.kind)).toEqual(["scenario-demoted"]);
        expect(after.evaluation.exitCode).toBe(0); // the scenario is advisory now and the demotion is reviewed
    });
    it("P3 (PE-38): a base commit with no policy is a bootstrap — every scenario is new, nothing is weakened", () => {
        const project = tracked(["orders_cli.py", "REQUIREMENTS.md"]);
        const { evaluation } = codes(project, "HEAD");
        expect(evaluation.policy).toMatchObject({ bootstrap: true, baseDigest: null, weakening: [] });
    });
});
describe("base policy — negative", () => {
    it("N1 (PE-33): a removed required scenario is POLICY_WEAKENED at the evaluation surface — exit 1 with the scenario named, even though no obligation remains to be open", () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.scenarios = []; });
        const { evaluation } = codes(project, "HEAD");
        expect(evaluation.verdicts).toHaveLength(0);
        expect(evaluation.exitCode).toBe(1);
        expect(evaluation.policy?.weakening[0]).toMatchObject({ kind: "scenario-removed", scenarioId: "order-persists" });
    });
    it("N2 (PE-37): an unresolvable base is UNAVAILABLE (exit 2) — never a fallback to HEAD, never a pass", () => {
        const project = tracked();
        const evaluation = evaluateE2e({ root: project.root, atMs: 5, base: "no-such-base" });
        expect(evaluation.status).toBe("unavailable");
        expect(evaluation.exitCode).toBe(2);
        expect(evaluation.reason).toMatch(/no-such-base/);
    });
    it("N3 (PE-74): the trusted base and the proof comparison revision are recorded independently — the base is HEAD~1 while the proof compares against HEAD, and neither substitutes for the other", () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.scenarios[0]!.proof = { mode: "characterization", revision: "HEAD" }; });
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "proof declared");
        const head = git(project.root, "rev-parse", "HEAD"), base = git(project.root, "rev-parse", "HEAD~1");
        const evaluation = evaluateE2e({ root: project.root, atMs: 5, base: "HEAD~1" });
        expect(evaluation.policy?.base.commit).toBe(base);
        expect(evaluation.policy?.weakening).toEqual([]); // adding a proof is a tightening
        expect(evaluation.verdicts[0]!.reasons.map(row => row.code)).not.toContain("SCOPE_INCOMPLETE"); // the proof revision resolved in the real repository
        expect(head).not.toBe(base);
    });
    it("N4: a replacement recorded against another base digest does not discharge the weakening at this base", () => {
        const project = tracked();
        patchPolicy(project, policy => { policy.projects[0]!.scenarios = []; });
        recordPolicyReplacement({ root: project.root, base: "HEAD", projectId: "orders", scenarioId: "order-persists", rationale: "retired", atMs: 5 });
        patchPolicy(project, policy => { policy.projects[0]!.protectedInputs = ["orders_cli.py", "README.md"]; }); // a different head digest (a tightening) ⇒ the record no longer binds
        expect(codes(project, "HEAD").codes).toEqual(["scenario-removed"]);
    });
});
