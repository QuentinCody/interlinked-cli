// Regressions for review round 3 (scratch/review-project-e2e-unit-a/REVIEW-round3.md,
// G1–G3). Each case is the reviewer's reproduced false pass, now asserted red.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_POLICY } from "../contracts/paths.js";
import { fixturePolicy, fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { expectationRevision } from "./expectations.js";
import { digestOf, E2E_POLICY_PATH } from "./policy.js";
import { runProjectE2e } from "./run.js";
import { acceptExpectationInStore, proposeExpectationInStore, reviewExpectations } from "./store.js";

const TIMEOUT = 120_000;
const projects: FixtureProject[] = [];
const roots: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(prefix: string): string { const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root); return root; }
function codes(root: string): string[] { return evaluateE2e({ root, atMs: Date.now() }).verdicts[0]?.reasons.map(row => row.code) ?? []; }
// SAFETY (test): the policy fixture is a plain JSON object with these keys.
type Raw = Record<string, unknown>;
function editPolicy(root: string, mutate: (raw: Raw) => void): void {
    const raw = JSON.parse(readFileSync(join(root, E2E_POLICY_PATH), "utf8")) as Raw;
    mutate(raw);
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(raw));
}
function project0(raw: Raw): Raw { return (raw.projects as Raw[])[0]!; }
function suite0(raw: Raw): Raw { return (project0(raw).suites as Raw[])[0]!; }

describe("G1 — absence of acceptance is frozen too", () => {
    it("a prepare step that creates contract-policy.json in the snapshot cannot turn an unaccepted run into an accepted pass", async () => {
        const project = fixtureProject("py"); projects.push(project); // NOT accepted: no contract-policy.json
        const script = [
            "const fs=require('node:fs');const crypto=require('node:crypto');",
            "const m=JSON.parse(fs.readFileSync('.interlinked/behavioral-contracts.json','utf8'));",
            "const accepted=Object.fromEntries(m.cases.map(c=>[crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'),'manufactured']));",
            "fs.writeFileSync('.interlinked/contract-policy.json',JSON.stringify({version:1,accepted}));",
        ].join("\n");
        writeFileSync(join(project.root, "prepare.cjs"), script);
        editPolicy(project.root, raw => { suite0(raw).prepare = [{ argv: ["node", "prepare.cjs"] }]; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(existsSync(join(project.root, CONTRACT_POLICY))).toBe(false);
        expect(result.verdicts[0]?.satisfied).toBe(false);
        expect(result.verdicts[0]?.reasons.map(row => row.code)).toContain("EXPECTATION_PROPOSED");
        expect(result.exitCode).not.toBe(0);
    }, TIMEOUT);
});
describe("G2 — wildcard patterns see symlinked ancestors", () => {
    it("with sharedInputs src/**/*.ts a link at src/linked is a capture gap and the run cannot claim complete scope", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const external = temp("e2e-external-");
        writeFileSync(join(external, "helper.ts"), "export const a = 1;\n");
        mkdirSync(join(project.root, "src"), { recursive: true });
        symlinkSync(external, join(project.root, "src/linked"), "dir");
        editPolicy(project.root, raw => { project0(raw).sharedInputs = ["src/**/*.ts"]; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.dimensions.scope).toBe("incomplete");
        expect(result.verdicts[0]?.reasons.map(row => row.code)).toContain("SCOPE_INCOMPLETE");
        writeFileSync(join(external, "helper.ts"), "export const a = 2;\n");
        expect(evaluateE2e({ root: project.root, atMs: Date.now() }).exitCode).not.toBe(0);
    }, TIMEOUT);
});
describe("G3 — nested-project citations resolve from one root", () => {
    it("for root package/, review provenance and check agree when the project-level cited document is rewritten", async () => {
        const repo = temp("e2e-nested-");
        const inner = fixtureProject("py"); projects.push(inner);
        cpSync(inner.root, join(repo, "package"), { recursive: true });
        rmSync(join(repo, "package", E2E_POLICY_PATH));
        mkdirSync(join(repo, ".interlinked"), { recursive: true });
        const policy = fixturePolicy("py");
        ((policy.projects as Raw[])[0]!).root = "package";
        writeFileSync(join(repo, E2E_POLICY_PATH), JSON.stringify(policy));
        writeFileSync(join(repo, "package", "EXPECTATION.md"), "Orders remain durable\n");
        const draft = { id: "durable", projectId: "orders", scenarioIds: ["order-persists"], statement: "orders remain durable", origin: "user-requirement" as const, sources: [{ kind: "requirement" as const, path: "EXPECTATION.md", sha256: digestOf("Orders remain durable\n"), quote: "remain durable" }], assumptions: [], questions: [], examples: { positive: [], negative: [] }, contractIds: ["orders.create", "orders.invalid"] };
        const proposed = proposeExpectationInStore(repo, draft, 1);
        expect(proposed.sources).toEqual([{ path: "EXPECTATION.md", provenance: "matched" }]); // resolved under package/, not the repository root
        acceptExpectationInStore(repo, { expectationId: "durable", revision: expectationRevision(draft), rationale: "ok" }, 2);
        const result = await runProjectE2e({ root: repo, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.reasons).toEqual([]);
        writeFileSync(join(repo, "package", "EXPECTATION.md"), "Requirement withdrawn\n");
        expect(reviewExpectations(repo)[0]?.sources[0]?.provenance).toBe("stale");
        expect(codes(repo)).toContain("STALE_GENERATION");
        // A document that exists only at the repository root is outside the project: unavailable in review AND absent from the generation — the same answer.
        rmSync(join(repo, "package", "EXPECTATION.md"));
        writeFileSync(join(repo, "EXPECTATION.md"), "Orders remain durable\n");
        expect(reviewExpectations(repo)[0]?.sources[0]?.provenance).toBe("unavailable");
        expect(codes(repo)).toContain("STALE_GENERATION");
    }, TIMEOUT);
});
