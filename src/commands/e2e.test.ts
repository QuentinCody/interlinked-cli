import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldE2e } from "./e2e.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(name = "interlinked-cli") { const path = mkdtempSync(join(tmpdir(), "scaffold-e2e-")); roots.push(path); writeFileSync(join(path, "package.json"), JSON.stringify({ name })); return path; }
describe("e2e scaffold — plan 31 §15 confinement", () => {
    it("refuses in a host repository with a pointer to the project-aware scaffold, and writes only with --developer-preset", () => {
        const cwd = root("some-app");
        expect(() => scaffoldE2e("stop-policy", { cwd, dryRun: true })).toThrow(/interlinked tests e2e scaffold/);
        expect(existsSync(join(cwd, "src/e2e"))).toBe(false);
        const preset = scaffoldE2e("stop-policy", { cwd, developerPreset: true });
        expect(existsSync(preset.path)).toBe(true);
    });
});
describe("e2e scaffold", () => {
    it("wires the fixture and leaves an explicit failing behavioral assertion", () => {
        const cwd = root();
        const result = scaffoldE2e("stop-policy", { cwd, event: "Stop" });
        expect(readFileSync(result.path, "utf8")).toBe(result.content);
        expect(result.content).toContain('event: "Stop"');
        expect(result.content).toContain("fixture.assertServed(result)");
        expect(result.content).toContain('fixture.ledger("activity.jsonl")');
        expect(result.content).toContain("expect.fail(");
        expect(() => scaffoldE2e("stop-policy", { cwd })).toThrow(/exists/);
    });
    it("dry-run has no writes and names cannot escape the test directory", () => {
        const cwd = root();
        const result = scaffoldE2e("tool-policy", { cwd, dryRun: true, event: "PostToolUse", tool: "Bash" });
        expect(existsSync(result.path)).toBe(false);
        expect(result.content).toContain('tool: "Bash"');
        expect(() => scaffoldE2e("../escape", { cwd })).toThrow(/name/);
        expect(() => scaffoldE2e("name", { cwd, event: "Unknown" })).toThrow(/event/);
    });
});
