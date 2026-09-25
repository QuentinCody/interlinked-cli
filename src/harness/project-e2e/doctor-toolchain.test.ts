import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { doctorE2e } from "./doctor.js";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { E2E_POLICY_PATH } from "./policy.js";

const fixtures: FixtureProject[] = [];
afterEach(() => {
    for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

describe("doctor command provenance", () => {
    it("rejects an existing non-executable file even when it matches a declared artifact", () => {
        const fixture = fixtureProject("ts");
        fixtures.push(fixture);
        const file = join(fixture.root, "not-executable");
        writeFileSync(file, "echo unavailable", { mode: 0o644 });
        const path = join(fixture.root, CONTRACT_MANIFEST);
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.cases[0].runner.argv = ["./not-executable"];
        writeFileSync(path, JSON.stringify(manifest));
        const policyPath = join(fixture.root, E2E_POLICY_PATH);
        const policy = JSON.parse(readFileSync(policyPath, "utf8"));
        policy.projects[0].suites[0].artifacts.push("not-executable");
        writeFileSync(policyPath, JSON.stringify(policy));
        expect(doctorE2e(fixture.root).checks.find(item => item.id === "orders:toolchain")?.status).toBe("fail");
    });
    it("reports a missing same-suite build output as expected rather than executable", () => {
        const fixture = fixtureProject("ts");
        fixtures.push(fixture);
        const path = join(fixture.root, CONTRACT_MANIFEST);
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.cases[0].runner.argv = ["./dist/generated-command"];
        writeFileSync(path, JSON.stringify(manifest));
        const check = doctorE2e(fixture.root).checks.find(item => item.id === "orders:toolchain");
        expect(check).toMatchObject({ status: "warn", detail: expect.stringContaining("expected after cli preparation") });
    });

    it("does not borrow an unrelated suite's artifact declaration", () => {
        const fixture = fixtureProject("ts");
        fixtures.push(fixture);
        const path = join(fixture.root, CONTRACT_MANIFEST);
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.cases[0].runner.argv = ["./other/generated-command"];
        writeFileSync(path, JSON.stringify(manifest));
        const policyPath = join(fixture.root, E2E_POLICY_PATH);
        const policy = JSON.parse(readFileSync(policyPath, "utf8"));
        policy.projects[0].suites.push({ id: "other", adapter: "managed-contracts", artifacts: ["other/**"] });
        writeFileSync(policyPath, JSON.stringify(policy));
        expect(doctorE2e(fixture.root).checks.find(item => item.id === "orders:toolchain")?.status).toBe("fail");
    });
});
