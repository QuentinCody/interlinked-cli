import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprintBuildInputs, fingerprintTestInputs, hashBytes } from "../../scripts/e2e-evidence.mjs";
import { createFixture, type E2eFixture, PROJECT_ROOT } from "./fixture.js";

describe("e2e baseline commands through Bash hook cycles", () => {
    let fixture: E2eFixture;
    const A = "src/harness/adapters/a.ts";
    const B = "src/harness/adapters/b.ts";
    const entry = { lines_pct: 90, statements_pct: 90, branches_pct: 90, functions_pct: 90, lines_total: 100, lines_covered: 90 };
    const baseline = ".interlinked/coverage-e2e-baseline.json";
    beforeAll(async () => {
        fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } } });
        fixture.file(A, "export const value = 1;\n");
        fixture.file(baseline, JSON.stringify({ version: 1, updated_at: "fixture", files: { [A]: entry } }));
        execFileSync("git", ["add", "-f", A, baseline], { cwd: fixture.cwd });
        execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=e2e@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "baseline"], { cwd: fixture.cwd });
    });
    afterAll(async () => { await fixture?.close(); });
    function buildInventory(paths: string[]) {
        const inputs = Object.fromEntries(paths.map((path) => [path, { bytesInOutput: 1 }]));
        fixture.file("dist/metafile-esm.json", JSON.stringify({ inputs, outputs: { "dist/index.js": { inputs } } }));
        fixture.file("dist/.build-input-fingerprint", fingerprintBuildInputs(fixture.cwd, { mode: "e2e" }));
    }
    async function command(args: string[]) {
        const sessionId = `${fixture.sessionPrefix}-identity`;
        const tool_use_id = randomUUID();
        const input = { command: [process.execPath, join(PROJECT_ROOT, "dist/index.js"), ...args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ") };
        const pre = await fixture.hook({ sessionId, tool: "Bash", input, payload: { tool_use_id } });
        fixture.assertServed(pre);
        expect(pre.stdout).not.toContain('"deny"');
        const execution = await fixture.cli(args);
        const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Bash", input, payload: { tool_use_id, tool_response: execution.stdout, tool_exit_code: execution.code } });
        fixture.assertServed(post);
        expect(post.stdout + post.stderr).not.toContain("baseline-integrity");
        expect(post.stdout + post.stderr).not.toContain("coverage-e2e-loosening");
        expect(existsSync(join(fixture.dataDir, "baseline-undo", `${tool_use_id}.json`))).toBe(false);
        return execution;
    }
    it("allows a real move and retirement, refuses a lowered Edit and leaves a failed update unchanged", async () => {
        fixture.file(B, readFileSync(join(fixture.cwd, A), "utf8"));
        rmSync(join(fixture.cwd, A));
        buildInventory([B]);
        const moved = await command(["coverage", "move", "--lane", "e2e", A, B]);
        expect(moved.code, moved.stderr).toBe(0);
        const before = readFileSync(join(fixture.cwd, baseline), "utf8");
        expect(JSON.parse(before).files).toEqual({ [B]: entry });
        const lower = await fixture.hook({ tool: "Edit", input: { file_path: join(fixture.cwd, baseline), old_string: '"branches_pct": 90', new_string: '"branches_pct": 10' } });
        fixture.assertServed(lower);
        expect(lower.stdout).toContain('"deny"');
        const failed = await command(["coverage", "check", "--lane", "e2e", "--update-baseline", "--require-measured"]);
        expect(failed.code).toBe(1);
        expect(readFileSync(join(fixture.cwd, baseline), "utf8")).toBe(before);
        rmSync(join(fixture.cwd, B));
        buildInventory([]);
        const retired = await command(["coverage", "retire", "--lane", "e2e", B]);
        expect(retired.code, retired.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(fixture.cwd, baseline), "utf8")).files).toEqual({});
    });
    it("allows a measured deletion update through both guards without an undo record", async () => {
        fixture.file(baseline, JSON.stringify({ version: 1, updated_at: "fixture", files: { [B]: entry } }));
        symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fixture.cwd, "node_modules"));
        fixture.file("package.json", '{"type":"module"}');
        fixture.file("vitest.e2e.config.ts", 'export default { test: { include: ["src/e2e/*.e2e.test.ts"] } };');
        fixture.file("src/e2e/example.e2e.test.ts", 'import { it } from "vitest"; it("fixture", () => {});');
        fixture.file("scripts/e2e-run.mjs", "export {};\n");
        fixture.file("scripts/e2e-coverage-merge.mjs", "export {};\n");
        buildInventory([]);
        // Synthetic report metadata isolates guard acceptance; actual child
        // collection is verified by this lane's mandatory coverage proofs.
        fixture.file("coverage-e2e/coverage-summary.json", "{}");
        fixture.file("coverage-e2e/run.json", JSON.stringify({ schema: 1, lane: "e2e", passed: true,
            build: fingerprintBuildInputs(fixture.cwd, { mode: "e2e" }), tests: await fingerprintTestInputs(fixture.cwd),
            inventory: hashBytes("[]"), report: hashBytes("{}") }));
        const updated = await command(["coverage", "check", "--lane", "e2e", "--strict", "--require-measured", "--update-baseline"]);
        expect(updated.code, updated.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(fixture.cwd, baseline), "utf8")).files).toEqual({});
    });
    it.each(["lower", "remove"])("detects a shell's %s of a surviving floor from the bytes written", async (change) => {
        fixture.file(B, "export const value = 1;\n");
        fixture.file(baseline, JSON.stringify({ version: 1, updated_at: "fixture", files: { [B]: entry } }));
        buildInventory([B]);
        const sessionId = `${fixture.sessionPrefix}-tamper-${change}`;
        const tool_use_id = randomUUID();
        const input = { command: "node change-policy.mjs" };
        const pre = await fixture.hook({ sessionId, tool: "Bash", input, payload: { tool_use_id } });
        fixture.assertServed(pre);
        expect(pre.stdout).not.toContain('"deny"');
        fixture.file(baseline, JSON.stringify({ version: 1, updated_at: "fixture", files: change === "remove" ? {} : { [B]: { ...entry, branches_pct: 10 } } }));
        const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Bash", input, payload: { tool_use_id, tool_response: "success" } });
        fixture.assertServed(post);
        expect(post.stdout + post.stderr).toMatch(/baseline.*(?:loosen|tamper)|coverage-e2e-loosening/i);
    });
});
