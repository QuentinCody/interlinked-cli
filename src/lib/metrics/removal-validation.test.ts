import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashBytes } from "./inventory.js";
import { validateRemoval } from "./removal-validation.js";
import type { RemovalPlan } from "./removal-plan.js";

const roots: string[] = [];
const SOURCE = 'export function used() { return 2; }\nfunction unused() { return 3; }\n';
const CHECKER = resolve("node_modules/typescript/bin/tsc");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(start: number, end: number): { root: string; plan: RemovalPlan } {
    const root = mkdtempSync(join(tmpdir(), "metrics-removal-")); roots.push(root);
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "index.js"), SOURCE);
    return { root, plan: { schemaVersion: 1, edits: [{ path: "index.js", sourceSha256: hashBytes(SOURCE), start, end }], checks: [
        { kind: "typecheck", argv: [process.execPath, CHECKER, "--noEmit", "--allowJs", "--checkJs", "--skipLibCheck", "--target", "es2022", "index.js"] },
        { kind: "test", argv: [process.execPath, "--input-type=module", "-e", 'import { used } from "./index.js"; import assert from "node:assert/strict"; assert.equal(used(), 2);'] },
    ] } };
}

it("validates a removal against baseline tests and compiler without editing the repository", async () => {
    const input = fixture(SOURCE.indexOf("function unused"), SOURCE.length);
    const result = await validateRemoval({ ...input, timeoutMs: 20_000 });
    expect(result.verdict).toBe("checks-passed");
    expect(result.before.every(row => row.outcome === "passed")).toBe(true);
    expect(result.after.every(row => row.outcome === "passed")).toBe(true);
    expect(readFileSync(join(input.root, "index.js"), "utf8")).toBe(SOURCE);
}, 25_000);

it("rejects removing behavior that the existing tests observe", async () => {
    const input = fixture(0, SOURCE.indexOf("function unused"));
    const result = await validateRemoval({ ...input, timeoutMs: 20_000 });
    expect(result.verdict).toBe("candidate-failed");
    expect(result.after.some(row => row.kind === "test" && row.outcome === "failed")).toBe(true);
    expect(readFileSync(join(input.root, "index.js"), "utf8")).toBe(SOURCE);
}, 25_000);

it("starts candidate tests from the original runtime state instead of baseline side effects", async () => {
    const input = fixture(0, 1), branch = "if (enabled) return 42; ";
    const source = `export function used(enabled) { ${branch}return 0; }\n`;
    const start = source.indexOf(branch);
    writeFileSync(join(input.root, "index.js"), source);
    writeFileSync(join(input.root, "state.json"), "true");
    input.plan.edits = [{ path: "index.js", sourceSha256: hashBytes(source), start, end: start + branch.length }];
    input.plan.checks[1] = { kind: "test", argv: [process.execPath, "--input-type=module", "-e",
        "import fs from 'node:fs'; import assert from 'node:assert/strict'; import { used } from './index.js'; const enabled = JSON.parse(fs.readFileSync('state.json','utf8')); assert.equal(used(enabled), enabled ? 42 : 0); fs.writeFileSync('state.json','false');"] };
    const result = await validateRemoval({ ...input, timeoutMs: 20_000 });
    expect(result.before.every(row => row.outcome === "passed")).toBe(true);
    expect(result.verdict).toBe("candidate-failed");
    expect(result.after.find(row => row.kind === "test")?.outcome).toBe("failed");
    expect(readFileSync(join(input.root, "state.json"), "utf8")).toBe("true");
    expect(readFileSync(join(input.root, "index.js"), "utf8")).toBe(source);
}, 25_000);

it("keeps compiler output available to later checks within each independent phase", async () => {
    const input = fixture(SOURCE.indexOf("function unused"), SOURCE.length);
    input.plan.checks = [
        { kind: "typecheck", argv: [process.execPath, CHECKER, "--allowJs", "--checkJs", "--skipLibCheck", "--target", "es2022", "--outDir", "compiled", "index.js"] },
        { kind: "test", argv: [process.execPath, "--input-type=module", "-e", "import assert from 'node:assert/strict'; import { used } from './compiled/index.js'; assert.equal(used(),2);"] },
    ];
    const result = await validateRemoval({ ...input, timeoutMs: 20_000 });
    expect(result.verdict, result.issues.join()).toBe("checks-passed");
    expect(result.before.map(row => row.outcome)).toEqual(["passed", "passed"]);
    expect(result.after.map(row => row.outcome)).toEqual(["passed", "passed"]);
    expect(existsSync(join(input.root, "compiled"))).toBe(false);
}, 25_000);

it("qualifies a trial when ignored original runtime inputs change after phase preparation", async () => {
    const input = fixture(SOURCE.indexOf("function unused"), SOURCE.length);
    execFileSync("git", ["init", "--quiet"], { cwd: input.root });
    writeFileSync(join(input.root, ".gitignore"), ".env\n");
    writeFileSync(join(input.root, ".env"), "before");
    input.plan.checks[1] = { kind: "test", argv: [process.execPath, "--input-type=module", "-e",
        `import fs from 'node:fs'; import assert from 'node:assert/strict'; import { used } from './index.js'; assert.equal(used(),2); fs.writeFileSync(${JSON.stringify(join(input.root, ".env"))},'after');`] };
    const result = await validateRemoval({ ...input, timeoutMs: 20_000 });
    expect(result.before.map(row => row.outcome)).toEqual(["passed", "passed"]);
    expect(result.after.map(row => row.outcome)).toEqual(["passed", "passed"]);
    expect(result.verdict).toBe("inconclusive");
    expect(result.issues).toContain("Repository runtime inputs changed during removal validation");
    expect(readFileSync(join(input.root, "index.js"), "utf8")).toBe(SOURCE);
}, 25_000);
