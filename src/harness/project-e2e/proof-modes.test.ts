// Unit D3 acceptance: counterfactual proof modes through the supervisor (plan
// §9.4, §16 Unit D counterfactual variants): a real regression (old-new
// demonstrated), a both-pass refactor (NOT_DEMONSTRATED), an incompatible old
// snapshot (INCONCLUSIVE), an unrelated assertion failure, a recorded
// controlled fault, characterization, and the dirty live worktree left
// byte-identical throughout.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, parseE2ePolicy, type E2ePolicy, type E2eProof } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 120_000;
const SAVE_LINE = "        json.dump(orders, handle, separators=(\",\", \":\"))";
const FAULT = { id: "drop-save", path: "orders_cli.py", find: SAVE_LINE, replace: "        pass  # controlled fault: nothing is written", rationale: "persistence is the accepted requirement" };
function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" }).trim();
}
/** A git-tracked copy of the Python fixture whose HEAD is the ORIGINAL (good) source, plus the candidate edit the test applies afterwards. */
function repo(): FixtureProject {
    const project = fixtureProject("py", { accept: true }); projects.push(project);
    git(project.root, "init", "--quiet");
    git(project.root, "add", ".");
    git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "good");
    return project;
}
function source(project: FixtureProject): string { return readFileSync(join(project.root, project.sourceFile), "utf8"); }
function commitDefect(project: FixtureProject, message = "old: defect"): void {
    injectPersistenceDefect(project);
    git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", message);
}
function setProof(project: FixtureProject, proof: E2eProof): void {
    const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as E2ePolicy; // SAFETY: fixture-authored
    policy.projects[0]!.scenarios[0]!.proof = proof;
    writeFileSync(path, JSON.stringify(policy));
}
function receiptOf(project: FixtureProject, path: string): E2eReceipt { return JSON.parse(readFileSync(join(project.root, path), "utf8")) as E2eReceipt; } // SAFETY: the receipt this run wrote
function verdict(project: FixtureProject) { return evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!; }
/** The worktree as git sees it, minus Interlinked's own ledger under .interlinked/ (the run legitimately appends there). */
function worktree(project: FixtureProject): { source: string; status: string[] } {
    return { source: source(project), status: git(project.root, "status", "--porcelain").split("\n").filter(line => !line.includes(".interlinked/")) };
}
async function run(project: FixtureProject) {
    const before = worktree(project);
    const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
    expect(worktree(project)).toEqual(before); // the live worktree is only ever read
    return { result, sensitivity: receiptOf(project, result.receipts[0]!.path).sensitivity?.["order-persists"] };
}

describe("proof modes — positive (the comparison demonstrates the requirement)", () => {
    it("P1: old-new — HEAD carries the persistence defect, the candidate fixes it: the designated case fails on the old export and passes on the candidate ⇒ demonstrated, satisfied", async () => {
        const project = repo();
        const good = source(project);
        commitDefect(project);
        writeFileSync(join(project.root, project.sourceFile), good); // the candidate: fixed in the working tree, dirty against HEAD
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] }); // action evidence = exitCode + json must hold on the old side
        const { result, sensitivity } = await run(project);
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        expect(sensitivity).toMatchObject({ mode: "old-new", verdict: "demonstrated", category: "designated-expectation-mismatch", comparison: { kind: "revision" }, designated: [{ id: "orders.create", outcome: ["files"] }] });
        expect(sensitivity?.comparison.identity).toMatch(/^[a-f0-9]{40}$/);
        expect(sensitivity?.compared.find(row => row.id === "orders.create")?.state).toBe("failed");
        expect(verdict(project)).toMatchObject({ satisfied: true, dimensions: { sensitivity: "demonstrated" } });
    }, TIMEOUT);
    it("P2: controlled-fault — the recorded fault makes the designated case fail while the unmodified candidate passes ⇒ demonstrated; the identity binds the fault id to the changed bytes", async () => {
        const project = repo();
        setProof(project, { mode: "controlled-fault", fault: FAULT, designated: [{ id: "orders.create", outcome: ["files"] }] });
        const { result, sensitivity } = await run(project);
        expect(result.exitCode).toBe(0);
        expect(sensitivity).toMatchObject({ mode: "controlled-fault", verdict: "demonstrated", comparison: { kind: "fault" } });
        expect(sensitivity?.comparison.identity).toMatch(/^drop-save@[a-f0-9]{64}$/);
        expect(verdict(project).satisfied).toBe(true);
    }, TIMEOUT);
    it("P3: characterization — the observations hold on the baseline revision and the candidate ⇒ preserved, satisfied", async () => {
        const project = repo();
        setProof(project, { mode: "characterization", revision: "HEAD" });
        const { result, sensitivity } = await run(project);
        expect(result.exitCode).toBe(0);
        expect(sensitivity).toMatchObject({ verdict: "preserved", category: "comparison-passes" });
        expect(verdict(project).dimensions.sensitivity).toBe("preserved");
    }, TIMEOUT);
});
describe("proof modes — negative (nothing short of a demonstrated comparison satisfies a required proof)", () => {
    it("N1: a both-pass refactor is NOT_DEMONSTRATED for old-new — the obligation stays open, the test is not called defective", async () => {
        const project = repo();
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const { result, sensitivity } = await run(project);
        expect(result.exitCode).not.toBe(0);
        expect(sensitivity).toMatchObject({ verdict: "not-demonstrated", category: "comparison-passes" });
        const row = verdict(project);
        expect(row.satisfied).toBe(false);
        expect(row.reasons.map(reason => reason.code)).toContain("SENSITIVITY_NOT_DEMONSTRATED");
        expect(row.status).toBe("unavailable");
    }, TIMEOUT);
    it("N2: an old snapshot without the executable, an unknown revision, and an absent fault anchor are each INCONCLUSIVE with the incompatible input named", async () => {
        const project = repo();
        git(project.root, "rm", "--quiet", project.sourceFile);
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "old: no executable");
        git(project.root, "checkout", "--quiet", "HEAD~1", "--", project.sourceFile); // the candidate has it back (dirty)
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] });
        expect((await run(project)).sensitivity).toMatchObject({ verdict: "inconclusive", category: "generic-runner-timeout-crash" });
        setProof(project, { mode: "old-new", revision: "no-such-revision", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const unknown = await run(project);
        expect(unknown.sensitivity).toMatchObject({ verdict: "inconclusive", category: "comparison-unavailable" });
        expect(unknown.sensitivity?.comparison.description).toMatch(/no-such-revision/);
        setProof(project, { mode: "controlled-fault", fault: { ...FAULT, find: "this anchor does not exist" }, designated: [{ id: "orders.create", outcome: ["files"] }] });
        expect((await run(project)).sensitivity).toMatchObject({ verdict: "inconclusive", category: "comparison-unavailable" });
        expect(verdict(project).reasons.map(reason => reason.code)).toContain("SENSITIVITY_INCONCLUSIVE");
    }, TIMEOUT);
    it("N3: an unrelated case fails BEFORE the designated one on the old snapshot ⇒ not demonstrated (unrelated assertion failure)", async () => {
        const project = repo();
        const good = source(project);
        // Old: `add` never saves (orders.create fails FIRST, unrelated to the designated case) and the usage path prints its message but exits 0 —
        // orders.invalid's action evidence (stderr) holds on the old side while its designated outcome (the exit code) differs.
        const old = good.replace(SAVE_LINE, "        pass").replace("    return 2", "    return 0");
        expect(old).not.toBe(good);
        writeFileSync(join(project.root, project.sourceFile), old);
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", "old: never saves, usage exits 0");
        writeFileSync(join(project.root, project.sourceFile), good);
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.invalid", outcome: ["exitCode"] }] });
        const { sensitivity } = await run(project);
        expect(sensitivity).toMatchObject({ verdict: "not-demonstrated", category: "unrelated-assertion-failure" });
        expect(sensitivity?.compared.find(row => row.id === "orders.invalid")).toMatchObject({ state: "failed", matched: ["stderr"], mismatched: ["exitCode"] });
    }, TIMEOUT);
    it("N4: a candidate that does not itself pass makes every proof mode INCONCLUSIVE (candidate not passing); no comparison is built", async () => {
        const project = repo();
        injectPersistenceDefect(project);
        setProof(project, { mode: "controlled-fault", fault: FAULT, designated: [{ id: "orders.create", outcome: ["files"] }] });
        const { sensitivity } = await run(project);
        expect(sensitivity).toMatchObject({ verdict: "inconclusive", category: "candidate-not-passing", comparison: { identity: "not-built" } });
    }, TIMEOUT);
    it("N5: the policy parser refuses a mode without its comparison input, a stray input, a designated id outside the scenario, a non-string revision, and (review round 2) a counterfactual proof without declared action evidence", () => {
        const base = JSON.parse(readFileSync(join(fixtureProject("py").root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored
        const attempt = (proof: unknown) => () => parseE2ePolicy(JSON.stringify({ ...base, projects: [{ ...base.projects[0], scenarios: [{ ...base.projects[0]!.scenarios[0], proof }] }] }));
        expect(attempt({ mode: "old-new" })).toThrow(/revision is required/);
        expect(attempt({ mode: "controlled-fault" })).toThrow(/fault is required/);
        expect(attempt({ mode: "execution", revision: "HEAD" })).toThrow(/revision is not used/);
        expect(attempt({ mode: "characterization", revision: "HEAD", fault: FAULT })).toThrow(/fault is not used/);
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.nope", outcome: ["files"] }] })).toThrow(/"orders.nope" is not one of the scenario's contractIds/);
        expect(attempt({ mode: "old-new", revision: 12 })).toThrow(/revision must be a string/);
        expect(attempt({ mode: "old-new", revision: "HEAD" })).toThrow(/designated is required for mode old-new/);
        expect(attempt({ mode: "controlled-fault", fault: FAULT, designated: ["orders.create"] })).toThrow(/needs action evidence/);
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create" }] })).toThrow(/needs action evidence/);
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["receipt"] }] })).toThrow(/outcome/);
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: [] }] })).toThrow(/at least one observable/);
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", action: ["orders.create"] }] })).toThrow(/must be another of the scenario's contractIds/);
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }, { id: "orders.create", outcome: ["json"] }] })).toThrow(/duplicate|unique/i);
        expect(attempt({ mode: "characterization", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] })).toThrow(/not used for mode characterization/);
        expect(attempt({ mode: "execution", designated: [{ id: "orders.create", outcome: ["files"] }] })).toThrow(/designated is not used for mode execution/);
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] })).not.toThrow();
        expect(attempt({ mode: "old-new", revision: "HEAD", designated: [{ id: "orders.invalid", action: ["orders.create"] }] })).not.toThrow();
        expect(attempt({ mode: "characterization", revision: "HEAD", designated: ["orders.create"] })).not.toThrow();
        expect(attempt({ mode: "characterization", revision: "HEAD" })).not.toThrow();
    });
});
