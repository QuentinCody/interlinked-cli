import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizeTestInput, readTestDependencies, changedTestInputs } from "./test-plan-inputs.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const path = mkdtempSync(join(tmpdir(), "test-inputs-")); roots.push(path); mkdirSync(join(path, ".interlinked")); return path; }
it("accepts additive literal dependency declarations and rejects escaping inputs", () => {
    const cwd = root(), path = join(cwd, ".interlinked/test-dependencies.json");
    writeFileSync(path, JSON.stringify({ version: 1, tests: { "a.test.ts": ["fixtures/example.txt"] } }));
    expect(readTestDependencies(cwd)).toEqual({ "a.test.ts": ["fixtures/example.txt"] });
    writeFileSync(path, JSON.stringify({ version: 1, tests: { "a.test.ts": ["../secret"] } }));
    expect(() => readTestDependencies(cwd)).toThrow("outside project");
});
it("rejects malformed declarations and does not treat missing Git history as no changes", () => {
    const cwd = root();
    writeFileSync(join(cwd, ".interlinked/test-dependencies.json"), '{"version":1,"tests":{"a.test.ts":[4]}}');
    expect(() => readTestDependencies(cwd)).toThrow("Invalid dependencies");
    expect(() => changedTestInputs(cwd)).toThrow();
    expect(normalizeTestInput(cwd, join(cwd, "a.test.ts"))).toBe("a.test.ts");
});

it("normalizes aliases and deleted paths while rejecting an escaping symlink", () => {
    const cwd = root(), outside = root();
    mkdirSync(join(cwd, "fixtures"));
    symlinkSync(join(cwd, "fixtures"), join(cwd, "alias"));
    expect(normalizeTestInput(cwd, "alias/deleted.txt")).toBe("fixtures/deleted.txt");
    symlinkSync(outside, join(cwd, "escape"));
    expect(() => normalizeTestInput(cwd, "escape/deleted.txt")).toThrow("outside project");
});
