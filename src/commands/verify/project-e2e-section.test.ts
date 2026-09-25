// Unit F6: `interlinked verify` reports the project e2e status as its own
// section with the SAME reason codes as `tests e2e check`. No policy ⇒ no
// section and no failure; an open required obligation fails the section
// under verify's existing exit convention; an unavailable evaluation is a
// failure too (never a pass).
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "../../harness/project-e2e/__tests__/fixture-projects.js";
import { runProjectE2e } from "../../harness/project-e2e/run.js";
import { projectE2eSection } from "./project-e2e-section.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 180_000;
function fresh(): FixtureProject { const project = fixtureProject("py", { accept: true }); projects.push(project); return project; }

describe("verify e2e section — positive", () => {
    it("P1: a satisfied policy renders a passing section that names the scenario and its status", async () => {
        const project = fresh();
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const section = projectE2eSection(project.root);
        expect(section.status).toBe("configured");
        expect(section.failed).toBe(false);
        expect(section.lines.join("\n")).toMatch(/orders\/order-persists: satisfied/);
        expect(section.json).toMatchObject({ status: "configured", exit_code: 0, open_required: 0 });
    }, TIMEOUT);
    it("P2: no policy ⇒ status unconfigured, no lines, not failed (the section is absent from the run)", () => {
        const project = fresh();
        rmSync(join(project.root, ".interlinked/e2e-policy.json"));
        expect(projectE2eSection(project.root)).toMatchObject({ status: "unconfigured", failed: false, lines: [] });
    });
});
describe("verify e2e section — negative", () => {
    it("N1: an open required obligation fails the section with the check's reason code and the run command", () => {
        const project = fresh();
        const section = projectE2eSection(project.root);
        expect(section.failed).toBe(true);
        expect(section.json).toMatchObject({ exit_code: 1, open_required: 1 });
        expect(section.lines.join("\n")).toMatch(/interlinked tests e2e run/);
    });
    it("N2: an invalid policy is a failure, never a pass", () => {
        const project = fresh();
        execFileSync("sh", ["-c", "printf '{\"version\": 1' > .interlinked/e2e-policy.json"], { cwd: project.root });
        const section = projectE2eSection(project.root);
        expect(section.status).toBe("invalid");
        expect(section.failed).toBe(true);
    });
});
