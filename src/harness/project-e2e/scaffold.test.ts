// Unit E3: `tests e2e scaffold <name>` proposes a scenario plus a test
// skeleton whose assumptions are explicit and whose deliberate failure earns
// no pass. It never edits the policy and never overwrites a file.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserFixtureProject } from "./__tests__/fixture-browser.js";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { E2E_POLICY_PATH, parseE2ePolicy } from "./policy.js";
import { scaffoldScenario, writeScaffold } from "./scaffold.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });

describe("scaffold — positive", () => {
    it("P1: a playwright suite gets a spec skeleton whose only assertion fails deliberately, a proposed scenario naming that case id, and explicit assumptions", () => {
        const project = browserFixtureProject();
        projects.push(project);
        const result = scaffoldScenario({ root: project.root, name: "cancel-order" });
        expect(result.suite.adapter).toBe("playwright");
        expect(result.files).toEqual([expect.objectContaining({ path: "tests/cancel-order.spec.mjs" })]);
        expect(result.files[0]!.content).toMatch(/deliberate failure/);
        expect(result.files[0]!.content).toMatch(/ASSUMPTION/);
        expect(result.scenario).toMatchObject({ id: "cancel-order", suite: "ui", required: false, affects: [], contractIds: ["REPLACE-with-a-declared-contract-case-id"], caseIds: ["cancel-order.spec.mjs › cancel-order › REPLACE: the user-observable outcome [chromium]"] });
        expect(result.notes.join("\n")).toMatch(/contractIds/);
        expect(result.notes.join("\n")).toMatch(/never a pass/);
    });
    it("P2: a managed-contracts suite gets a proposed contract case whose expectation is a placeholder that cannot match, and the scenario binds it", () => {
        const project = fixtureProject("py");
        projects.push(project);
        const result = scaffoldScenario({ root: project.root, name: "list-orders" });
        expect(result.suite.adapter).toBe("managed-contracts");
        expect(result.files).toEqual([expect.objectContaining({ path: ".interlinked/e2e-scaffold/list-orders.contract.json" })]);
        const proposed = JSON.parse(result.files[0]!.content) as { id: string; expect: { stdout: string } }; // SAFETY: the scaffold's own JSON
        expect(proposed.id).toBe("list-orders");
        expect(proposed.expect.stdout).toMatch(/^REPLACE:/);
        expect(result.scenario.contractIds).toEqual(["list-orders"]);
    });
    it("P3: writeScaffold creates the skeleton files and leaves the policy byte-identical", () => {
        const project = browserFixtureProject();
        projects.push(project);
        const policyBefore = readFileSync(join(project.root, E2E_POLICY_PATH), "utf8");
        const result = scaffoldScenario({ root: project.root, name: "cancel-order" });
        const written = writeScaffold(project.root, result);
        expect(written).toEqual([join(project.root, "tests/cancel-order.spec.mjs")]);
        expect(existsSync(written[0]!)).toBe(true);
        expect(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")).toBe(policyBefore);
        expect(() => parseE2ePolicy(JSON.stringify({ ...JSON.parse(policyBefore), projects: [{ ...JSON.parse(policyBefore).projects[0], scenarios: [...JSON.parse(policyBefore).projects[0].scenarios, result.scenario] }] }))).not.toThrow(); // SAFETY: fixture-authored policy
    });
});
describe("scaffold — negative", () => {
    it("N1: an unknown suite, an unknown project, an invalid name and an existing file are refused", () => {
        const project = browserFixtureProject();
        projects.push(project);
        expect(() => scaffoldScenario({ root: project.root, name: "x", suiteId: "nope" })).toThrow(/suite nope/);
        expect(() => scaffoldScenario({ root: project.root, name: "x", projectId: "nope" })).toThrow(/project nope/);
        expect(() => scaffoldScenario({ root: project.root, name: "bad name!" })).toThrow(/name/);
        expect(() => scaffoldScenario({ root: project.root, name: "order-via-page" })).toThrow(/already declares scenario/);
        mkdirSync(join(project.root, "tests"), { recursive: true });
        writeFileSync(join(project.root, "tests/cancel-order.spec.mjs"), "existing");
        expect(() => writeScaffold(project.root, scaffoldScenario({ root: project.root, name: "cancel-order" }))).toThrow(/already exists/);
        expect(readFileSync(join(project.root, "tests/cancel-order.spec.mjs"), "utf8")).toBe("existing");
    });
    it("N2: a repository without a policy is refused with the adoption command", () => {
        const project = fixtureProject("py");
        projects.push(project);
        rmSync(join(project.root, E2E_POLICY_PATH));
        expect(() => scaffoldScenario({ root: project.root, name: "x" })).toThrow(/tests e2e discover/);
    });
});
