// Unit D3: counterfactual and fault-sensitivity qualification (plan §9.4).
// The classifier is pure over the two sides' case outcomes and the declared
// designated expectations; the snapshot builders export a pinned git
// revision or apply one recorded fault, and refuse anything they cannot
// build exactly (INCONCLUSIVE with the incompatible input named).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { E2eDesignated } from "./policy.js";
import { applyFault, classifySensitivity, exportRevision, proofCaseIds, type SensitivityInput, type SideOutcome } from "./sensitivity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Evidence = Pick<SideOutcome, "matched" | "mismatched" | "primaryOutput" | "exitCode" | "status">;
const outcome = (id: string, state: SideOutcome["state"], evidence: Partial<Evidence> = {}): SideOutcome => ({ id, state, ...evidence });
/** The py fixture's cases as observed on a passing side: orders.create declares exitCode + json + files, orders.invalid declares exitCode + stderr. */
const CREATE_OK = outcome("orders.create", "passed", { matched: ["files", "exitCode", "json"], mismatched: [], primaryOutput: true, exitCode: 0 });
const INVALID_OK = outcome("orders.invalid", "passed", { matched: ["exitCode", "stderr"], mismatched: [], primaryOutput: false, exitCode: 2 });
const passing = [CREATE_OK, INVALID_OK];
/** The persistence regression as observed: the action ran (exit 0, printed the order) and only the designated outcome (the file) differs. */
const CREATE_LOST = outcome("orders.create", "failed", { matched: ["exitCode", "json"], mismatched: ["files"], primaryOutput: true, exitCode: 0 });
const PERSISTS: E2eDesignated = { id: "orders.create", outcome: ["files"] };
const classify = (input: Pick<SensitivityInput, "mode" | "designated" | "compared"> & Partial<SensitivityInput>) =>
    classifySensitivity({ candidate: passing, comparisonPrepared: true, comparisonComplete: true, ...input });
const FAULT = { id: "drop-save", path: "orders_cli.py", find: "save(orders)", replace: "pass  # fault", rationale: "persistence is the contract" };
function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" }).trim();
}
function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "e2e-sensitivity-"));
    roots.push(root);
    writeFileSync(join(root, "orders_cli.py"), "def add():\n    save(orders)\n");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "app.txt"), "old\n");
    git(root, "init", "--quiet");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "old");
    return root;
}

describe("classifySensitivity — positive (the comparison distinguishes the snapshots through DECLARED evidence)", () => {
    it("P1: old-new — the designated outcome (files) differs on the comparison while the case's action evidence (exitCode, json) holds ⇒ demonstrated", () => {
        const result = classify({ mode: "old-new", designated: [PERSISTS], compared: [CREATE_LOST, INVALID_OK] });
        expect(result).toMatchObject({ verdict: "demonstrated", category: "designated-expectation-mismatch" });
        expect(result.reasons[0]).toMatch(/orders\.create failed on the comparison at its designated outcome \(files\) with its action evidence established/);
    });
    it("P2: characterization — both sides pass ⇒ preserved (comparison passes is the valid outcome for this mode)", () => {
        expect(classify({ mode: "characterization", designated: [{ id: "orders.create" }, { id: "orders.invalid" }], compared: passing })).toMatchObject({ verdict: "preserved", category: "comparison-passes" });
    });
    it("P3: controlled-fault — a non-designated failure AFTER the designated one does not demote the verdict", () => {
        const invalidLater = outcome("orders.invalid", "failed", { matched: ["stderr"], mismatched: ["exitCode"], exitCode: 0 });
        expect(classify({ mode: "controlled-fault", designated: [PERSISTS], compared: [CREATE_LOST, invalidLater] }).verdict).toBe("demonstrated");
    });
    it("P4 (review round 2): evidence-based positives — an error-path outcome (exit code) whose usage text is the action evidence, and a workflow whose action is an earlier case (create passes, read-back fails)", () => {
        const usageExit0 = outcome("orders.invalid", "failed", { matched: ["stderr"], mismatched: ["exitCode"], primaryOutput: false, exitCode: 0 });
        expect(classify({ mode: "old-new", designated: [{ id: "orders.invalid", outcome: ["exitCode"] }], compared: [CREATE_OK, usageExit0] })).toMatchObject({ verdict: "demonstrated", category: "designated-expectation-mismatch" });
        const createOk = outcome("orders.create", "passed", { matched: ["status", "json"], mismatched: [], primaryOutput: true, status: 201 });
        const readLost = outcome("orders.read-after-restart", "failed", { matched: [], mismatched: ["status", "json"], primaryOutput: true, status: 404 });
        const workflow: E2eDesignated = { id: "orders.read-after-restart", action: ["orders.create"] };
        const httpCandidate = [createOk, outcome("orders.read-after-restart", "passed", { matched: ["status", "json"], mismatched: [], primaryOutput: true, status: 200 })];
        expect(classify({ mode: "old-new", designated: [workflow], candidate: httpCandidate, compared: [createOk, readLost] })).toMatchObject({ verdict: "demonstrated", category: "designated-expectation-mismatch", reasons: [expect.stringMatching(/at its designated outcome \(status, json\)/)] });
        expect(proofCaseIds([workflow, PERSISTS])).toEqual(["orders.read-after-restart", "orders.create"]);
    });
});
describe("classifySensitivity — negative (never a demonstrated verdict)", () => {
    it("N1: both sides pass ⇒ old-new is NOT_DEMONSTRATED, never a defect claim; a partially passing designated set is the same", () => {
        expect(classify({ mode: "old-new", designated: [PERSISTS], compared: passing })).toMatchObject({ verdict: "not-demonstrated", category: "comparison-passes" });
        expect(classify({ mode: "old-new", designated: [PERSISTS, { id: "orders.invalid", outcome: ["exitCode"] }], compared: [CREATE_LOST, INVALID_OK] }).verdict).toBe("not-demonstrated");
    });
    it("N2: an unrelated case failed BEFORE the designated one ⇒ not demonstrated (unrelated assertion failure); a failed ACTION case is never 'unrelated' — the action was not established", () => {
        const usageExit0 = outcome("orders.invalid", "failed", { matched: ["stderr"], mismatched: ["exitCode"], exitCode: 0 });
        expect(classify({ mode: "old-new", designated: [{ id: "orders.invalid", outcome: ["exitCode"] }], compared: [CREATE_LOST, usageExit0] })).toMatchObject({ verdict: "not-demonstrated", category: "unrelated-assertion-failure" });
        const createFailed = outcome("orders.create", "failed", { matched: [], mismatched: ["status", "json"], status: 500 });
        const readLost = outcome("orders.read-after-restart", "failed", { matched: [], mismatched: ["status", "json"], status: 404 });
        const httpCandidate = [outcome("orders.create", "passed", { matched: ["status", "json"], mismatched: [] }), outcome("orders.read-after-restart", "passed", { matched: ["status", "json"], mismatched: [] })];
        expect(classify({ mode: "old-new", designated: [{ id: "orders.read-after-restart", action: ["orders.create"] }], candidate: httpCandidate, compared: [createFailed, readLost] })).toMatchObject({ verdict: "inconclusive", category: "setup-build-dependency-failure", reasons: [expect.stringMatching(/action case orders\.create did not pass on the comparison/)] });
    });
    it("N3: a comparison that could not be prepared, a crashed/unavailable designated case, or a candidate that does not pass (a designated OR an action case) ⇒ inconclusive", () => {
        expect(classify({ mode: "old-new", designated: [PERSISTS], compared: [], comparisonPrepared: false }).category).toBe("setup-build-dependency-failure");
        expect(classify({ mode: "old-new", designated: [PERSISTS], compared: [outcome("orders.create", "unavailable"), INVALID_OK] })).toMatchObject({ verdict: "inconclusive", category: "generic-runner-timeout-crash" });
        expect(classify({ mode: "controlled-fault", designated: [PERSISTS], candidate: [CREATE_LOST, INVALID_OK], compared: [CREATE_LOST, INVALID_OK] })).toMatchObject({ verdict: "inconclusive", category: "candidate-not-passing" });
        expect(classify({ mode: "old-new", designated: [{ id: "orders.invalid", action: ["orders.create"] }], candidate: [CREATE_LOST, INVALID_OK], compared: passing }).category).toBe("candidate-not-passing");
        expect(classify({ mode: "characterization", designated: [{ id: "orders.create" }], compared: [CREATE_LOST, INVALID_OK] })).toMatchObject({ verdict: "not-demonstrated", category: "designated-expectation-mismatch" });
    });
    it("N4 (review D1 + round 2): a designated failure whose action evidence did NOT hold is INCONCLUSIVE — a bare crash, a crash after a startup banner, a 500 with a dependency-error body; output presence and exit/status classes never decide", () => {
        const crash = outcome("orders.create", "failed", { matched: [], mismatched: ["files", "exitCode", "json"], primaryOutput: false, exitCode: 1 });
        const invalidCrash = outcome("orders.invalid", "failed", { matched: [], mismatched: ["exitCode", "stderr"], exitCode: 1 });
        expect(classify({ mode: "old-new", designated: [PERSISTS], compared: [crash, invalidCrash] })).toMatchObject({ verdict: "inconclusive", category: "setup-build-dependency-failure", reasons: [expect.stringMatching(/orders\.create did not establish its action on the comparison: exitCode, json differed \(exit 1\)/)] });
        const banner = outcome("orders.create", "failed", { matched: [], mismatched: ["files", "exitCode", "json"], primaryOutput: true, exitCode: 1 });
        expect(classify({ mode: "old-new", designated: [PERSISTS], compared: [banner, INVALID_OK] })).toMatchObject({ verdict: "inconclusive", category: "setup-build-dependency-failure" });
        const dependencyError = outcome("orders.create", "failed", { matched: [], mismatched: ["status", "json"], primaryOutput: true, status: 500 });
        const httpCandidate = [outcome("orders.create", "passed", { matched: ["status", "json"], mismatched: [], primaryOutput: true, status: 201 })];
        expect(classify({ mode: "old-new", designated: [{ id: "orders.create", outcome: ["json"] }], candidate: httpCandidate, compared: [dependencyError] })).toMatchObject({ verdict: "inconclusive", category: "setup-build-dependency-failure", reasons: [expect.stringMatching(/status differed \(HTTP 500\)/)] });
        expect(classify({ mode: "characterization", designated: [{ id: "orders.create" }], compared: [banner, INVALID_OK] }).verdict).toBe("not-demonstrated"); // characterization has no action split: a difference is a behavior difference, never a proof
    });
    it("N5 (review round 2): without declared action evidence the cause of a failure is unknown ⇒ INCONCLUSIVE action-evidence-undeclared — an outcome covering every declared observable, an outcome the case never declares, a record without observations", () => {
        const dependencyError = outcome("orders.create", "failed", { matched: [], mismatched: ["status", "json"], primaryOutput: true, status: 500 });
        const httpCandidate = [outcome("orders.create", "passed", { matched: ["status", "json"], mismatched: [], status: 201 })];
        expect(classify({ mode: "old-new", designated: [{ id: "orders.create", outcome: ["status", "json"] }], candidate: httpCandidate, compared: [dependencyError] })).toMatchObject({ verdict: "inconclusive", category: "action-evidence-undeclared", reasons: [expect.stringMatching(/declares no action evidence/)] });
        expect(classify({ mode: "old-new", designated: [{ id: "orders.create", outcome: ["files"] }], candidate: httpCandidate, compared: [dependencyError] })).toMatchObject({ verdict: "inconclusive", category: "action-evidence-undeclared", reasons: [expect.stringMatching(/names outcome files that the case does not declare/)] });
        expect(classify({ mode: "old-new", designated: [PERSISTS], compared: [outcome("orders.create", "failed"), INVALID_OK] })).toMatchObject({ verdict: "inconclusive", category: "action-evidence-undeclared" });
    });
    it("N7 (review round 3): an action case that executed AFTER the designated observation establishes nothing — on the comparison and on the candidate alike", () => {
        const createOk = outcome("orders.create", "passed", { matched: ["status", "json"], mismatched: [], status: 201 });
        const readLost = outcome("orders.read-after-restart", "failed", { matched: [], mismatched: ["status", "json"], status: 404 });
        const readOk = outcome("orders.read-after-restart", "passed", { matched: ["status", "json"], mismatched: [], status: 200 });
        const workflow: E2eDesignated = { id: "orders.read-after-restart", action: ["orders.create"] };
        expect(classify({ mode: "old-new", designated: [workflow], candidate: [createOk, readOk], compared: [readLost, createOk] })).toMatchObject({ verdict: "inconclusive", category: "action-evidence-undeclared", reasons: [expect.stringMatching(/orders\.create executed AFTER orders\.read-after-restart on the comparison/)] });
        expect(classify({ mode: "old-new", designated: [workflow], candidate: [readOk, createOk], compared: [createOk, readLost] })).toMatchObject({ verdict: "inconclusive", category: "action-evidence-undeclared", reasons: [expect.stringMatching(/executed after orders\.read-after-restart on the candidate/)] });
        expect(classify({ mode: "old-new", designated: [workflow], candidate: [createOk, readOk], compared: [createOk, readLost] }).verdict).toBe("demonstrated"); // the ordered workflow still qualifies
    });
    it("N6 (review D2): a comparison whose lifecycle did not complete (teardown failed, port still answering) is INCONCLUSIVE whatever its cases say", () => {
        expect(classify({ mode: "characterization", designated: [{ id: "orders.create" }], compared: passing, comparisonComplete: false, comparisonReasons: ["service api shutdown failed: port 1 still answers"] })).toMatchObject({ verdict: "inconclusive", category: "comparison-lifecycle-failure", reasons: [expect.stringMatching(/port 1 still answers/)] });
        expect(classify({ mode: "old-new", designated: [PERSISTS], compared: [CREATE_LOST, INVALID_OK], comparisonComplete: false })).toMatchObject({ verdict: "inconclusive", category: "comparison-lifecycle-failure" });
    });
});
describe("comparison snapshots", () => {
    it("P4: exportRevision writes the pinned revision's tree (the project subdirectory when the project is nested) and names the commit sha", async () => {
        const root = repo();
        writeFileSync(join(root, "orders_cli.py"), "def add():\n    pass\n"); // dirty worktree: NOT what gets exported
        const target = mkdtempSync(join(tmpdir(), "e2e-export-")); roots.push(target);
        const result = await exportRevision(root, "HEAD", target);
        expect(result.ok).toBe(true);
        expect(result.ok && result.identity).toMatch(/^[a-f0-9]{40}$/);
        expect(readFileSync(join(target, "orders_cli.py"), "utf8")).toBe("def add():\n    save(orders)\n");
        const nestedTarget = mkdtempSync(join(tmpdir(), "e2e-export-")); roots.push(nestedTarget);
        expect((await exportRevision(join(root, "nested"), "HEAD", nestedTarget)).ok).toBe(true);
        expect(readFileSync(join(nestedTarget, "app.txt"), "utf8")).toBe("old\n");
        expect(readFileSync(join(root, "orders_cli.py"), "utf8")).toBe("def add():\n    pass\n"); // the live tree was never touched
    });
    it("N4: an unknown revision or a directory outside any git repository cannot be exported ⇒ not ok with the reason", async () => {
        const root = repo();
        const target = mkdtempSync(join(tmpdir(), "e2e-export-")); roots.push(target);
        const missing = await exportRevision(root, "no-such-revision", target);
        expect(missing.ok).toBe(false);
        expect(!missing.ok && missing.reason).toMatch(/no-such-revision/);
        const plain = mkdtempSync(join(tmpdir(), "e2e-plain-")); roots.push(plain);
        expect((await exportRevision(plain, "HEAD", target)).ok).toBe(false);
    });
    it("P5/N5: applyFault replaces exactly one occurrence and names the changed bytes; an absent or ambiguous anchor is refused", () => {
        const snapshot = mkdtempSync(join(tmpdir(), "e2e-fault-")); roots.push(snapshot);
        writeFileSync(join(snapshot, "orders_cli.py"), "def add():\n    save(orders)\n");
        const applied = applyFault(snapshot, FAULT);
        expect(applied.ok).toBe(true);
        expect(readFileSync(join(snapshot, "orders_cli.py"), "utf8")).toBe("def add():\n    pass  # fault\n");
        expect(applied.ok && applied.identity).toMatch(/^drop-save@[a-f0-9]{64}$/);
        expect(applyFault(snapshot, FAULT).ok).toBe(false); // anchor already replaced: absent
        writeFileSync(join(snapshot, "orders_cli.py"), "save(orders)\nsave(orders)\n");
        const ambiguous = applyFault(snapshot, FAULT);
        expect(!ambiguous.ok && ambiguous.reason).toMatch(/2 times/);
    });
});
