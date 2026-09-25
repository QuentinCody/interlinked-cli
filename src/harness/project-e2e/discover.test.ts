import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { discoverProjects, formatDiscovery } from "./discover.js";
import { parseE2ePolicy } from "./policy.js";

const projects: FixtureProject[] = [];
const roots: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(prefix: string): string { const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root); return root; }

describe("discoverProjects — positive (must propose)", () => {
    it("P1: the TypeScript fixture yields one project with a build proposal, artifacts, executables, existing contracts and a parseable advisory policy", () => {
        const project = fixtureProject("ts"); projects.push(project);
        const report = discoverProjects(project.root);
        expect(report.projects).toHaveLength(1);
        const found = report.projects[0]!;
        expect(found.languages).toContain("typescript");
        expect(found.build?.prepare).toEqual([{ argv: ["npm", "run", "build"] }]);
        expect(found.contracts.cases).toEqual(["orders.create", "orders.invalid"]);
        expect(found.proposal.mode).toBe("advisory");
        expect(found.proposal.scenarios.map(row => row.contractIds)).toEqual([["orders.create"], ["orders.invalid"]]);
        expect(found.proposal.scenarios.every(row => row.required === false)).toBe(true);
        expect(() => parseE2ePolicy(JSON.stringify(report.proposal))).not.toThrow();
        expect(report.proposal.expectations).toEqual([]); // discovery never invents expectations
    });
    it("P2: the Python fixture yields an interpreted project with no prepare step, a script executable and a unittest layout", () => {
        const project = fixtureProject("py"); projects.push(project);
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.languages).toEqual(["python"]);
        expect(found.build).toBeNull();
        expect(found.executables.map(row => row.argv)).toContainEqual(["python3", "orders_cli.py"]);
        expect(found.tests.layouts).toContain("tests");
        expect(found.proposal.protectedInputs).toContain("orders_cli.py");
    });
    it("P3: a monorepo with a TypeScript package and a Python package yields two projects with distinct roots and ids", () => {
        const repo = temp("e2e-mono-");
        const ts = fixtureProject("ts"), py = fixtureProject("py"); projects.push(ts, py);
        cpSync(ts.root, join(repo, "packages/orders-ts"), { recursive: true });
        cpSync(py.root, join(repo, "packages/orders-py"), { recursive: true });
        writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] }));
        const report = discoverProjects(repo);
        expect(report.projects.map(row => [row.id, row.root]).sort()).toEqual([["mono", "."], ["orders-py", "packages/orders-py"], ["orders-ts", "packages/orders-ts"]]);
        expect(report.ambiguities).toEqual([]); // declared workspaces are not ambiguous
        expect(() => parseE2ePolicy(JSON.stringify(report.proposal))).not.toThrow();
    });
});
describe("discoverProjects — negative (must report gaps, never invent)", () => {
    it("N1: a nested manifest without a declared workspace is an ambiguity the author must resolve", () => {
        const repo = temp("e2e-ambig-");
        writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "outer" }));
        mkdirSync(join(repo, "inner"), { recursive: true });
        writeFileSync(join(repo, "inner/package.json"), JSON.stringify({ name: "inner" }));
        const report = discoverProjects(repo);
        expect(report.ambiguities[0]).toMatch(/inner\/package\.json is nested under package\.json without a declared workspace/);
    });
    it("N2: a project with executables but no contract cases proposes no scenarios and names the gap with the next command", () => {
        const project = fixtureProject("py"); projects.push(project);
        rmSync(join(project.root, ".interlinked/behavioral-contracts.json"));
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.proposal.scenarios).toEqual([]);
        expect(found.gaps.join("\n")).toMatch(/no contract cases declared.*python3 orders_cli\.py.*tests contracts import/s);
    });
    it("N3: an invalid existing manifest is reported, not silently dropped; an unsupported framework and a missing test layout are named", () => {
        const project = fixtureProject("ts"); projects.push(project);
        writeFileSync(join(project.root, ".interlinked/behavioral-contracts.json"), "{\"version\":9}");
        writeFileSync(join(project.root, "package.json"), JSON.stringify({ name: "x", scripts: { build: "node build.mjs" }, devDependencies: { ava: "1" } }));
        const found = discoverProjects(project.root).projects[0]!;
        expect(found.contracts.invalid).toMatch(/version/);
        expect(found.tests.layouts).toEqual([]);
        expect(found.gaps.join("\n")).toMatch(/test runner "ava" has no native integration; declare a structured-runner suite .* no plugin is needed/);
        expect(found.gaps.join("\n")).toMatch(/No test layout was detected/);
    });
    it("N4: an empty directory yields no projects, no proposal projects and an explicit gap", () => {
        const repo = temp("e2e-empty-");
        const report = discoverProjects(repo);
        expect(report.projects).toEqual([]);
        expect(report.gaps[0]).toMatch(/no project manifest/);
        expect(formatDiscovery(report).join("\n")).toMatch(/no project manifest/);
    });
    it("N5: discovery is read-only and bounded — it never runs a build script and records its scan limits", () => {
        const project = fixtureProject("ts"); projects.push(project);
        writeFileSync(join(project.root, "build.mjs"), "require('node:fs').writeFileSync('EXECUTED', '1');\n");
        const report = discoverProjects(project.root);
        expect(report.limits.directoriesScanned).toBeGreaterThan(0);
        expect(report.limits.capped).toBe(false);
        expect(() => rmSync(join(project.root, "EXECUTED"))).toThrow(); // never created
    });
});
