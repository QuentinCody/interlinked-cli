import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { doctorE2e } from "./doctor.js";
import { E2E_LEDGER_PATH } from "./ledger.js";
import { E2E_POLICY_PATH } from "./policy.js";

const fixtures: FixtureProject[] = [];
afterEach(() => {
    for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});
function fixture(): FixtureProject {
    const project = fixtureProject("ts", { accept: true });
    fixtures.push(project);
    return project;
}

describe("doctor prerequisite invariants", () => {
    it("returns a failed report when a persistent ledger read fails, without retrying through receipts", () => {
        const project = fixture();
        mkdirSync(join(project.root, E2E_LEDGER_PATH));
        const report = doctorE2e(project.root);
        expect(report.exitCode).toBe(1);
        expect(report.checks.find(check => check.id === "ledger")?.status).toBe("fail");
        expect(report.checks.find(check => check.id === "orders:receipts")).toMatchObject({
            status: "warn", evaluation: "not-evaluated", prerequisites: ["ledger"],
        });
    });

    it("cannot claim complete acceptance when a required reference is absent and every present case is accepted", () => {
        const project = fixture();
        const path = join(project.root, E2E_POLICY_PATH);
        const policy = JSON.parse(readFileSync(path, "utf8"));
        policy.projects[0].scenarios[0].contractIds.push("orders.ghost");
        writeFileSync(path, JSON.stringify(policy));
        const report = doctorE2e(project.root);
        expect(report.checks.find(check => check.id === "orders:contracts")?.status).toBe("fail");
        expect(report.checks.find(check => check.id === "orders:acceptance")).toMatchObject({
            status: "warn", evaluation: "not-evaluated", prerequisites: ["orders:contracts"],
        });
        expect(report.checks.find(check => check.id === "orders:toolchain")).toMatchObject({
            status: "warn", evaluation: "not-evaluated", prerequisites: ["orders:contracts"],
        });
    });

    it("does not exempt a missing preparation executable merely because an artifact matches it", () => {
        const project = fixture();
        const path = join(project.root, E2E_POLICY_PATH);
        const policy = JSON.parse(readFileSync(path, "utf8"));
        policy.projects[0].suites[0].prepare = [{ argv: ["./dist/missing-builder"] }];
        writeFileSync(path, JSON.stringify(policy));
        const report = doctorE2e(project.root);
        expect(report.checks.find(check => check.id === "orders:toolchain")).toMatchObject({
            status: "fail", detail: expect.stringContaining("missing-builder"),
        });
    });

    it("does not describe an existing directory as an executable", () => {
        const project = fixture();
        mkdirSync(join(project.root, "fake-tool"));
        const path = join(project.root, E2E_POLICY_PATH);
        const policy = JSON.parse(readFileSync(path, "utf8"));
        policy.projects[0].suites[0].prepare = [{ argv: ["./fake-tool"] }];
        writeFileSync(path, JSON.stringify(policy));
        expect(doctorE2e(project.root).checks.find(check => check.id === "orders:toolchain")?.status).toBe("fail");
    });
});
