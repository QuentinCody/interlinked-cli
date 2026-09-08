import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { discoverLint } from "./discovery.js";
import { planLintImport } from "./policy.js";
import { measureImportedLint } from "./runner.js";
import { prepareLintImport } from "./selection.js";

vi.mock("../../harness/check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const directories: string[] = [];
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-runner-")));
    directories.push(root);
    writeFileSync(join(root, "ruff.toml"), 'select = ["F"]\n');
    writeFileSync(join(root, "a.py"), "import unused\n");
    return root;
}
beforeEach(() => { vi.mocked(runProcessAsync).mockReset(); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("imported lint execution", () => {
    it("passes a selected config as one argument with an independent working scope", async () => {
        const root = project();
        rmSync(join(root, "ruff.toml"));
        mkdirSync(join(root, "packages/app"), { recursive: true });
        const config = "named config.mjs";
        writeFileSync(join(root, config), "export default [];\n");
        const policy = prepareLintImport(root, { eslintConfig: [config], eslintScope: "packages/app" }).policy;
        vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: "[]", stderr: "", timedOut: false, killed: false });
        expect((await measureImportedLint(root, policy))[0]?.status).toBe("measured");
        expect(runProcessAsync).toHaveBeenCalledWith("eslint", ["--config", join(root, config), "--format", "json", "."], expect.objectContaining({ cwd: join(root, "packages/app") }));
    });
    it.each([0, 1])("ratchets Oxlint warnings/errors with analyzer exit %i", async (code) => {
        const root = project();
        rmSync(join(root, "ruff.toml"));
        writeFileSync(join(root, ".oxlintrc.json"), "{}");
        writeFileSync(join(root, "app.js"), "debugger;\n");
        const stdout = JSON.stringify({ number_of_files: 1, diagnostics: [{ filename: "app.js", code: "eslint(no-debugger)", message: "debugger", labels: [{ span: { line: 1 } }] }] });
        vi.mocked(runProcessAsync).mockResolvedValue({ code, stdout, stderr: "", timedOut: false, killed: false });
        const result = (await measureImportedLint(root, planLintImport(discoverLint(root)).policy))[0];
        expect(result).toMatchObject({ status: "measured", findings: [expect.objectContaining({ tool: "oxlint", rule: "eslint(no-debugger)" })] });
        expect(runProcessAsync).toHaveBeenCalledWith("oxlint", ["--format=json", "."], expect.objectContaining({ cwd: root }));
    });
    it("does not accept Oxlint execution failures or empty failing reports as measurements", async () => {
        const root = project();
        rmSync(join(root, "ruff.toml"));
        writeFileSync(join(root, ".oxlintrc.json"), "{}");
        const policy = planLintImport(discoverLint(root)).policy;
        for (const code of [1, 2]) {
            vi.mocked(runProcessAsync).mockResolvedValue({ code, stdout: '{"number_of_files":1,"diagnostics":[]}', stderr: "failure", timedOut: false, killed: false });
            expect((await measureImportedLint(root, policy))[0]?.status).toBe("unavailable");
        }
    });
    it("shares a monotonic deadline across scopes and reports exhausted scopes as unmeasured", async () => {
        const root = project();
        mkdirSync(join(root, "nested"));
        writeFileSync(join(root, "nested/ruff.toml"), 'select = ["F"]\n');
        const policy = planLintImport(discoverLint(root)).policy;
        const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(5).mockReturnValue(25);
        vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: "[]", stderr: "", timedOut: false, killed: false });
        const report = await measureImportedLint(root, policy, { timeoutMs: 20, now });
        expect(report.map((entry) => entry.status)).toEqual(["measured", "unavailable"]);
        expect(report[1]?.reason).toContain("budget exhausted");
        expect(runProcessAsync).toHaveBeenCalledTimes(1);
        expect(runProcessAsync).toHaveBeenCalledWith("ruff", ["check", "--output-format=json", "."], expect.objectContaining({ timeout: 15 }));
    });
    it("keeps warnings from successful processes and uses the project executable", async () => {
        const root = project();
        mkdirSync(join(root, ".venv/bin"), { recursive: true });
        writeFileSync(join(root, ".venv/bin/ruff"), "placeholder");
        vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: JSON.stringify([{ filename: "a.py", location: { row: 1 }, code: "F401", message: "unused" }]), stderr: "", timedOut: false, killed: false });
        const report = await measureImportedLint(root, planLintImport(discoverLint(root)).policy);
        expect(report).toHaveLength(1);
        expect(report[0]?.status).toBe("measured");
        expect(report[0]?.findings).toHaveLength(1);
        expect(report[0]?.findings[0]).toMatchObject({ file: "a.py", rule: "F401" });
        expect(runProcessAsync).toHaveBeenCalledWith(join(root, ".venv/bin/ruff"), ["check", "--output-format=json", "."], expect.objectContaining({ cwd: root }));
    });
    it("reports missing executables and malformed output as unavailable", async () => {
        const root = project();
        const policy = planLintImport(discoverLint(root)).policy;
        vi.mocked(runProcessAsync).mockResolvedValueOnce({ code: null, stdout: "", stderr: "", timedOut: false, killed: false });
        expect((await measureImportedLint(root, policy))[0]?.status).toBe("unavailable");
        vi.mocked(runProcessAsync).mockResolvedValueOnce({ code: 0, stdout: "{", stderr: "", timedOut: false, killed: false });
        expect((await measureImportedLint(root, policy))[0]?.status).toBe("unavailable");
    });
    it("refuses a changed configuration before running any analyzer", async () => {
        const root = project();
        const policy = planLintImport(discoverLint(root)).policy;
        writeFileSync(join(root, "ruff.toml"), 'select = []\n');
        await expect(measureImportedLint(root, policy)).rejects.toThrow("configuration changed");
        expect(runProcessAsync).not.toHaveBeenCalled();
    });
    it("requires review when a newly added configuration changes an adopted scope", async () => {
        const root = project();
        const policy = planLintImport(discoverLint(root)).policy;
        mkdirSync(join(root, "nested"));
        writeFileSync(join(root, "nested/ruff.toml"), "select = []\n");
        await expect(measureImportedLint(root, policy)).rejects.toThrow("New lint configuration");
        expect(runProcessAsync).not.toHaveBeenCalled();
    });
    it("refuses new shared ignore files before measuring or retiring debt", async () => {
        const root = project();
        const policy = planLintImport(discoverLint(root)).policy;
        writeFileSync(join(root, ".gitignore"), "*.py\n");
        await expect(measureImportedLint(root, policy)).rejects.toThrow("New lint configuration: .gitignore");
        expect(runProcessAsync).not.toHaveBeenCalled();
    });
    it("rejects diagnostics outside the selected codebase", async () => {
        const root = project();
        vi.mocked(runProcessAsync).mockResolvedValue({ code: 1, stdout: JSON.stringify([{ filename: "../foreign.py", location: { row: 1 }, code: "F401", message: "unused" }]), stderr: "", timedOut: false, killed: false });
        const measurement = (await measureImportedLint(root, planLintImport(discoverLint(root)).policy))[0];
        expect(measurement?.status).toBe("unavailable");
        expect(measurement?.reason).toContain("Out-of-project");
    });
});
