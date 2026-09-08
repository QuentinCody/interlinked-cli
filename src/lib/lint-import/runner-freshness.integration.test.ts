import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { lintCheckCommand } from "../../commands/lint.js";
import { runImportedLintAsync } from "../../harness/check-engine/tool-runners/lint-import.js";
import { tightenLintBaseline } from "./baseline.js";
import { LINT_BASELINE_PATH, LINT_POLICY_PATH, writeLintJson } from "./policy.js";
import { measureImportedLint } from "./runner.js";
import { prepareLintImport } from "./selection.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-freshness-integration-")));
    roots.push(root);
    mkdirSync(join(root, ".venv/bin"), { recursive: true });
    writeFileSync(join(root, ".flake8"), "[flake8]\n");
    writeFileSync(join(root, "a.py"), "import os\n");
    const executable = join(root, ".venv/bin/flake8");
    // Model the critical interleaving deterministically at the actual process
    // boundary: report the bytes read, after a newer edit reached the same file.
    writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const analyzed = fs.readFileSync("a.py", "utf8");
if (fs.existsSync(".interlinked/reintroduce")) fs.writeFileSync("a.py", "import os\\n");
if (analyzed.includes("import os")) {
    fs.writeSync(1, "a.py\\t1\\tF401\\tunused os\\n");
    process.exitCode = 1;
}
`);
    chmodSync(executable, 0o700);
    return root;
}

async function adoptedProject(): Promise<{ root: string; baseline: string }> {
    const root = project();
    const { policy } = prepareLintImport(root, {});
    writeLintJson(root, LINT_POLICY_PATH, policy);
    const initial = await measureImportedLint(root, policy);
    expect(initial[0]).toMatchObject({ status: "measured", findings: [{ rule: "F401" }] });
    tightenLintBaseline(root, initial);
    const baseline = readFileSync(join(root, LINT_BASELINE_PATH), "utf8");
    writeFileSync(join(root, "a.py"), "pass\n");
    writeFileSync(join(root, ".interlinked/reintroduce"), "enabled");
    return { root, baseline };
}

it.each([false, true])("CLI preserves debt after a stale clean result (updateBaseline=%s)", async (updateBaseline) => {
    const { root, baseline } = await adoptedProject();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await lintCheckCommand(root, { json: true, updateBaseline });
    expect(process.exitCode).toBe(2);
    const report: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(report).toMatchObject({ complete: false, baseline_updated: false, measurements: [{ status: "unavailable", findings: [], reason: expect.stringContaining("a.py") }] });
    expect(readFileSync(join(root, LINT_BASELINE_PATH), "utf8")).toBe(baseline);
});

it("hook execution preserves adopted debt when source changes after the analyzer reads it", async () => {
    const { root, baseline } = await adoptedProject();
    await expect(runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 10_000 })).rejects.toThrow("Lint source changed during analysis: a.py");
    expect(readFileSync(join(root, LINT_BASELINE_PATH), "utf8")).toBe(baseline);
});

it("measures real ESLint source with other installed executable links and large ignored runtime output", async () => {
    const root = project();
    rmSync(join(root, ".flake8"));
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    symlinkSync(resolve("node_modules/.bin/eslint"), join(root, "node_modules/.bin/eslint"));
    symlinkSync(resolve("node_modules/.bin/tsc"), join(root, "node_modules/.bin/tsc"));
    mkdirSync(join(root, "scratch"));
    writeFileSync(join(root, "scratch/run.log"), "");
    truncateSync(join(root, "scratch/run.log"), 16 * 1024 * 1024);
    writeFileSync(join(root, "node_modules/unrelated.js"), "");
    truncateSync(join(root, "node_modules/unrelated.js"), 16 * 1024 * 1024);
    writeFileSync(join(root, ".gitignore"), "scratch/\n");
    writeFileSync(join(root, "eslint.config.mjs"), 'export default [{ ignores: ["scratch/**"] }, { files: ["**/*.js"], rules: { "no-debugger": "error" } }];\n');
    writeFileSync(join(root, "app.js"), "debugger;\n");
    const { policy } = prepareLintImport(root, {});
    const report = await measureImportedLint(root, policy);
    expect(report).toMatchObject([{ status: "measured", findings: [{ file: "app.js", rule: "no-debugger" }] }]);
});
