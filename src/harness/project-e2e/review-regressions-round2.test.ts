// Regressions for review round 2 (scratch/review-project-e2e-unit-a/REVIEW-round2.md,
// F1–F6). Each case is the reviewer's reproduced false pass, now asserted red.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_MANIFEST, CONTRACT_POLICY, contractDigest } from "../contracts/paths.js";
import { acceptAllContracts, fixturePolicy, fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { expectationRevision } from "./expectations.js";
import { digestOf, E2E_POLICY_PATH } from "./policy.js";
import { readE2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";
import { acceptExpectationInStore, proposeExpectationInStore } from "./store.js";

const TIMEOUT = 120_000;
const projects: FixtureProject[] = [];
const roots: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fresh(language: "ts" | "py" = "py"): FixtureProject { const project = fixtureProject(language, { accept: true }); projects.push(project); return project; }
function temp(prefix: string): string { const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root); return root; }
function check(root: string) { return evaluateE2e({ root, atMs: Date.now() }); }
function codes(root: string): string[] { return check(root).verdicts[0]?.reasons.map(row => row.code) ?? []; }
// SAFETY (test): the policy fixture is a plain JSON object with these keys.
type Raw = Record<string, unknown>;
function editPolicy(root: string, mutate: (raw: Raw) => void): void {
    const raw = JSON.parse(readFileSync(join(root, E2E_POLICY_PATH), "utf8")) as Raw;
    mutate(raw);
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(raw));
}
function project0(raw: Raw): Raw { return (raw.projects as Raw[])[0]!; }
function suite0(raw: Raw): Raw { return (project0(raw).suites as Raw[])[0]!; }
async function satisfied(project: FixtureProject): Promise<void> {
    const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
    expect(result.verdicts[0]?.satisfied, JSON.stringify(result.verdicts[0]?.reasons)).toBe(true);
}

describe("F1 — preparation cannot replace the accepted test", () => {
    it("a prepare step that rewrites the snapshot's contract and acceptance cannot certify a broken application", async () => {
        const project = fresh("py");
        injectPersistenceDefect(project);
        const script = [
            "const fs=require('node:fs');const crypto=require('node:crypto');",
            "const path='.interlinked/behavioral-contracts.json';const m=JSON.parse(fs.readFileSync(path,'utf8'));",
            "m.cases[0].expect={exitCode:0};fs.writeFileSync(path,JSON.stringify(m));",
            "const accepted=Object.fromEntries(m.cases.map(c=>[crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'),'generated']));",
            "fs.writeFileSync('.interlinked/contract-policy.json',JSON.stringify({version:1,accepted}));",
        ].join("\n");
        writeFileSync(join(project.root, "prepare.cjs"), script);
        editPolicy(project.root, raw => { suite0(raw).prepare = [{ argv: ["node", "prepare.cjs"] }]; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        expect(result.verdicts[0]?.satisfied).toBe(false);
        const receipt = readE2eReceipt(project.root, result.receipts[0]!.path)!;
        expect(receipt.cases.find(row => row.id === "orders.create")?.state).toBe("failed"); // the FROZEN contract ran, and the defect is real
    }, TIMEOUT);
    it("a case whose executed digest is not the live accepted contract is RECEIPT_MISMATCH even if the receipt says passed", async () => {
        const project = fresh("py");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const path = join(project.root, result.receipts[0]!.path);
        const tampered = JSON.parse(readFileSync(path, "utf8"));
        tampered.cases[0].digest = "e".repeat(64);
        writeFileSync(path, JSON.stringify(tampered));
        expect(codes(project.root)).toContain("RECEIPT_MISMATCH");
    }, TIMEOUT);
});
describe("F2 — directory symlinks neither escape the snapshot nor vanish from scope", () => {
    it("a linked directory under a declared input is a capture gap, and preparation cannot write through it", async () => {
        const project = fresh("py");
        const external = temp("e2e-external-");
        writeFileSync(join(external, "state.txt"), "original");
        symlinkSync(external, join(project.root, "linked"), "dir");
        writeFileSync(join(project.root, "prepare.cjs"), "require('node:fs').writeFileSync('linked/state.txt', 'changed by preparation');\n");
        editPolicy(project.root, raw => { project0(raw).sharedInputs = ["linked/**"]; suite0(raw).prepare = [{ argv: ["node", "prepare.cjs"] }]; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(readFileSync(join(external, "state.txt"), "utf8")).toBe("original");
        expect(result.verdicts[0]?.dimensions.scope).toBe("incomplete");
        expect(result.verdicts[0]?.reasons.map(row => row.code)).toContain("SCOPE_INCOMPLETE");
        expect(result.exitCode).not.toBe(0);
    }, TIMEOUT);
});
describe("F3 — generation covers build scripts, bound citations and executable modes", () => {
    it("breaking the TypeScript fixture's build script after a pass makes check stale", async () => {
        const project = fresh("ts");
        await satisfied(project);
        writeFileSync(join(project.root, "build.mjs"), "process.exit(7);\n");
        expect(codes(project.root)).toContain("STALE_GENERATION");
    }, TIMEOUT);
    it("rewriting a bound expectation's own cited document after a pass makes check stale", async () => {
        const project = fresh("py");
        writeFileSync(join(project.root, "EXPECTATION.md"), "Orders remain durable\n");
        const draft = { id: "durable", projectId: "orders", scenarioIds: ["order-persists"], statement: "orders remain durable", origin: "user-requirement" as const, sources: [{ kind: "requirement" as const, path: "EXPECTATION.md", sha256: digestOf("Orders remain durable\n"), quote: "remain durable" }], assumptions: [], questions: [], examples: { positive: [], negative: [] }, contractIds: ["orders.create", "orders.invalid"] };
        proposeExpectationInStore(project.root, draft, 1);
        acceptExpectationInStore(project.root, { expectationId: "durable", revision: expectationRevision(draft), rationale: "ok" }, 2);
        await satisfied(project);
        writeFileSync(join(project.root, "EXPECTATION.md"), "Requirement withdrawn\n");
        expect(codes(project.root)).toContain("STALE_GENERATION");
    }, TIMEOUT);
    it("removing the execute bit from a literal executable input, bytes unchanged, makes check stale", async () => {
        const project = fresh("py");
        const target = join(project.root, "app");
        writeFileSync(target, "#!/bin/sh\necho hello\n", { mode: 0o755 });
        const manifest = JSON.parse(readFileSync(join(project.root, CONTRACT_MANIFEST), "utf8"));
        manifest.cases = [{ ...manifest.cases[0], inputs: ["app"], runner: { kind: "process", argv: ["./app", "hello"] }, expect: { exitCode: 0, stdout: "hello\n" } }];
        writeFileSync(join(project.root, CONTRACT_MANIFEST), JSON.stringify(manifest));
        editPolicy(project.root, raw => { ((project0(raw).scenarios as Raw[])[0]!).contractIds = ["orders.create"]; });
        acceptAllContracts(project.root);
        await satisfied(project);
        chmodSync(target, 0o644);
        expect(codes(project.root)).toContain("STALE_GENERATION");
    }, TIMEOUT);
});
describe("F4 — protected-inventory capture failures reach the verdict", () => {
    it("an unmapped protected file over 8 MiB is a mapping gap with an issue and check exits 1", async () => {
        const project = fresh("py");
        editPolicy(project.root, raw => { project0(raw).protectedInputs = ["orders_cli.py", "large.bin"]; });
        await satisfied(project);
        writeFileSync(join(project.root, "large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
        const evaluation = check(project.root);
        expect(evaluation.mappingGaps).toEqual([{ projectId: "orders", path: "large.bin", issue: expect.stringMatching(/large\.bin not captured: larger than/) }]);
        expect(evaluation.exitCode).toBe(1);
    }, TIMEOUT);
});
describe("F5 — a required project with no scenarios does not pass", () => {
    it("protected source with scenarios: [] is a mapping gap for the whole-project check and for the explicit project selection", () => {
        const project = fresh("py");
        editPolicy(project.root, raw => { project0(raw).scenarios = []; });
        const whole = check(project.root);
        expect(whole.verdicts).toEqual([]);
        expect(whole.mappingGaps).toEqual([{ projectId: "orders", path: "orders_cli.py" }]);
        expect(whole.exitCode).toBe(1);
        expect(evaluateE2e({ root: project.root, atMs: Date.now(), projectId: "orders" }).exitCode).toBe(1);
    });
});
describe("F6 — acceptance is written beside the nested project's manifest", () => {
    it("a project rooted at package/ accepts into package/.interlinked/contract-policy.json and its run then satisfies", async () => {
        const repo = temp("e2e-nested-");
        const inner = fixtureProject("py"); projects.push(inner);
        cpSync(inner.root, join(repo, "package"), { recursive: true });
        rmSync(join(repo, "package", E2E_POLICY_PATH));
        mkdirSync(join(repo, ".interlinked"), { recursive: true });
        const policy = fixturePolicy("py");
        ((policy.projects as Raw[])[0]!).root = "package";
        writeFileSync(join(repo, E2E_POLICY_PATH), JSON.stringify(policy));
        const draft = { id: "persist", projectId: "orders", scenarioIds: ["order-persists"], statement: "orders persist", origin: "user-requirement" as const, sources: [], assumptions: [], questions: [], examples: { positive: [], negative: [] }, contractIds: ["orders.create", "orders.invalid"] };
        proposeExpectationInStore(repo, draft, 1);
        acceptExpectationInStore(repo, { expectationId: "persist", revision: expectationRevision(draft), rationale: "ok" }, 2);
        expect(existsSync(join(repo, "package", CONTRACT_POLICY))).toBe(true);
        expect(existsSync(join(repo, CONTRACT_POLICY))).toBe(false);
        const manifest = JSON.parse(readFileSync(join(repo, "package", CONTRACT_MANIFEST), "utf8"));
        const accepted = JSON.parse(readFileSync(join(repo, "package", CONTRACT_POLICY), "utf8")).accepted;
        expect(Object.keys(accepted)).toEqual(expect.arrayContaining(manifest.cases.map((row: unknown) => contractDigest(row))));
        const result = await runProjectE2e({ root: repo, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.reasons).toEqual([]);
    }, TIMEOUT);
});
