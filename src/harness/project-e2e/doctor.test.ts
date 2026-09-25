import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { doctorE2e, formatDoctor } from "./doctor.js";
import { E2E_POLICY_PATH } from "./policy.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 60_000;
function byId(report: ReturnType<typeof doctorE2e>, id: string) { return report.checks.find(check => check.id === id); }

describe("doctorE2e — positive", () => {
    it("P1: a healthy accepted Python fixture reports ok for policy, manifest, contracts, acceptance, toolchain and ledger, and lists the next command", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const report = doctorE2e(project.root);
        expect(report.status).toBe("ok");
        for (const id of ["policy", "orders:root", "orders:manifest", "orders:contracts", "orders:acceptance", "orders:toolchain", "ledger", "orders:receipts"]) expect(byId(report, id)?.status, id).toBe("ok");
        expect(formatDoctor(report).join("\n")).toMatch(/interlinked tests e2e check/);
    }, TIMEOUT);
});
describe("doctorE2e — negative (prerequisite gaps are actionable)", () => {
    it("N1: unconfigured is a fail with the discover command; an invalid policy is a fail with the parser reason (exit 2)", () => {
        const project = fixtureProject("py"); projects.push(project);
        rmSync(join(project.root, E2E_POLICY_PATH));
        let report = doctorE2e(project.root);
        expect(report.exitCode).toBe(2);
        expect(byId(report, "policy")).toMatchObject({ status: "fail", detail: expect.stringMatching(/tests e2e discover/) });
        writeFileSync(join(project.root, E2E_POLICY_PATH), "{\"version\":2}");
        report = doctorE2e(project.root);
        expect(byId(report, "policy")).toMatchObject({ status: "fail", detail: expect.stringMatching(/unknown schema version/) });
    });
    it("N2: a missing prepare executable, a missing contract case and unaccepted contracts are each named", () => {
        const project = fixtureProject("ts"); projects.push(project);
        const raw = JSON.parse(readPolicy(project.root));
        raw.projects[0].suites[0].prepare = [{ argv: ["definitely-not-a-tool-xyz", "build"] }];
        raw.projects[0].scenarios[0].contractIds = ["orders.create", "orders.ghost"];
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(raw));
        const report = doctorE2e(project.root);
        expect(byId(report, "orders:toolchain")).toMatchObject({ status: "fail", detail: expect.stringMatching(/definitely-not-a-tool-xyz/) });
        expect(byId(report, "orders:contracts")).toMatchObject({ status: "fail", detail: expect.stringMatching(/orders\.ghost/) });
        expect(byId(report, "orders:acceptance")).toMatchObject({ status: "warn", evaluation: "not-evaluated", prerequisites: ["orders:contracts"] });
        expect(report.status).toBe("fail");
        expect(report.exitCode).toBe(1);
    });
    it("N3: an unmapped protected input and a tampered receipt are surfaced as warnings/failures rather than hidden", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        writeFileSync(join(project.root, result.receipts[0]!.path), "{\"version\":1");
        writeFileSync(join(project.root, "unmapped.py"), "x = 1\n");
        const raw = JSON.parse(readPolicy(project.root));
        raw.projects[0].protectedInputs = ["*.py"];
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(raw));
        const report = doctorE2e(project.root);
        expect(byId(report, "orders:receipts")).toMatchObject({ status: "fail", detail: expect.stringMatching(/could not be validated/) });
        expect(byId(report, "orders:mapping")).toMatchObject({ status: "warn", detail: expect.stringMatching(/unmapped\.py/) });
    }, TIMEOUT);
});
function readPolicy(root: string): string { return readFileSync(join(root, E2E_POLICY_PATH), "utf8"); }
