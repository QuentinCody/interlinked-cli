import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldE2e } from "./e2e.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), "scaffold-e2e-")); roots.push(path); return path; }
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
