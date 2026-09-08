import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runImportedLintAsync } from "../harness/check-engine/tool-runners/lint-import.js";
import { loadRules } from "../harness/rules-loader.js";
import { loadLintBaseline } from "../lib/lint-import/baseline.js";
import { lintEntryKey } from "../lib/lint-import/identity.js";
import { LINT_BASELINE_PATH, LINT_POLICY_PATH, loadLintPolicy } from "../lib/lint-import/policy.js";
import { lintCheckCommand, lintImportCommand } from "./lint.js";

const directories: string[] = [];
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-import-integration-")));
    directories.push(root);
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    symlinkSync(resolve("node_modules/.bin/eslint"), join(root, "node_modules/.bin/eslint"));
    writeFileSync(join(root, "eslint.config.mjs"), 'export default [{ files: ["**/*.js"], rules: { "no-debugger": "error" } }];\n');
    writeFileSync(join(root, "app.js"), "debugger;\n");
    return root;
}
afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("lint adoption with a real ESLint executable", () => {
    it("runs multiple named profiles and keeps their retirement and reimport histories separate", async () => {
        const root = project();
        vi.spyOn(console, "log").mockImplementation(() => {});
        const configs = ["eslint.named.config.mjs", "custom rules.mjs"];
        for (const config of configs) writeFileSync(join(root, config), 'export default [{ files: ["**/*.js"], rules: { "no-debugger": "warn" } }];\n');
        await lintImportCommand(root, { eslintConfig: configs, write: true, baseline: true, json: true });
        expect(process.exitCode ?? 0).toBe(0);
        const entries = loadLintPolicy(root)!.entries;
        expect(entries).toHaveLength(3);
        expect(new Set(Object.keys(loadLintBaseline(root).entries)).size).toBe(3);

        writeFileSync(join(root, "app.js"), "export const answer = 42;\n");
        await lintCheckCommand(root, { json: true });
        expect(Object.values(loadLintBaseline(root).entries).flatMap(Object.values)).toEqual([0, 0, 0]);
        await lintImportCommand(root, { write: true, json: true });
        expect(loadLintPolicy(root)!.entries.map(lintEntryKey)).toEqual(entries.map(lintEntryKey));
        writeFileSync(join(root, "app.js"), "debugger;\n");
        const findings = await runImportedLintAsync({ scope: { projectRoot: root, mode: "project", lintCadence: "all" }, timeoutMs: 10_000 });
        expect(findings).toHaveLength(3);
        for (const config of configs) expect(findings.some((finding) => finding.message.includes(`config: ${config}`))).toBe(true);
        await lintCheckCommand(root, { updateBaseline: true, json: true });
        expect(process.exitCode).toBe(1);
    });

    it("uses the requested package scope for a centrally stored named configuration", async () => {
        const root = project();
        rmSync(join(root, "eslint.config.mjs"));
        mkdirSync(join(root, "tools"));
        mkdirSync(join(root, "packages/app"), { recursive: true });
        writeFileSync(join(root, "tools/typed.mjs"), 'export default [{ files: ["**/*.js"], rules: { "no-debugger": "error" } }];\n');
        writeFileSync(join(root, "packages/app/index.js"), "debugger;\n");
        vi.spyOn(console, "log").mockImplementation(() => {});
        await lintImportCommand(root, { eslintConfig: ["tools/typed.mjs"], eslintScope: "packages/app", write: true, json: true });
        const findings = await runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 10_000 });
        expect(findings).toEqual([expect.objectContaining({ file: "packages/app/index.js", ruleId: "eslint/no-debugger" })]);
    });

    it("rejects invalid options before writing any adoption artifacts", async () => {
        const root = project();
        await expect(lintImportCommand(root, { write: true, timeout: "invalid" })).rejects.toThrow("--timeout");
        await expect(lintImportCommand(root, { baseline: true })).rejects.toThrow("--baseline requires --write");
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
    });
    it("previews without writes, adopts debt, retires a fix, and surfaces reintroduced debt in hooks", async () => {
        const root = project();
        vi.spyOn(console, "log").mockImplementation(() => {});
        await lintImportCommand(root, { json: true });
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
        await lintImportCommand(root, { write: true, baseline: true, json: true });
        expect(existsSync(join(root, LINT_POLICY_PATH))).toBe(true);
        expect(existsSync(join(root, LINT_BASELINE_PATH))).toBe(true);
        expect(loadRules(root).quality_checks.lint_import?.enabled).toBe(true);
        expect(await runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 10_000 })).toEqual([]);

        writeFileSync(join(root, "app.js"), "export const answer = 42;\n");
        await lintCheckCommand(root, { json: true });
        writeFileSync(join(root, "app.js"), "debugger;\n");
        const findings = await runImportedLintAsync({ scope: { projectRoot: root, mode: "file", targetFile: "app.js", filterToFile: true }, timeoutMs: 10_000 });
        expect(findings).toEqual([expect.objectContaining({ tool: "lint-import", file: "app.js", ruleId: "eslint/no-debugger", line: 1 })]);
        await lintCheckCommand(root, { updateBaseline: true, json: true });
        expect(process.exitCode).toBe(1);
    });

    it("keeps original configs unchanged and preserves failed measurements as unknown", async () => {
        const root = project();
        const original = readFileSync(join(root, "eslint.config.mjs"), "utf8");
        vi.spyOn(console, "log").mockImplementation(() => {});
        await lintImportCommand(root, { write: true, json: true });
        expect(readFileSync(join(root, "eslint.config.mjs"), "utf8")).toBe(original);
        writeFileSync(join(root, "app.js"), "const broken = ;\n");
        await lintCheckCommand(root, { updateBaseline: true, json: true });
        expect(process.exitCode).toBe(2);
        expect(existsSync(join(root, LINT_BASELINE_PATH))).toBe(false);
    });
});
