import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { prepareLintImport } from "./selection.js";
import { measureImportedLint } from "./runner.js";
import { captureLintSourceSnapshot } from "./source-snapshot.js";

vi.mock("../../harness/check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const roots: string[] = [];
const clean = { code: 0, stdout: "[]", stderr: "", timedOut: false, killed: false };
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-freshness-")));
    roots.push(root);
    writeFileSync(join(root, "ruff.toml"), 'select = ["F"]\n');
    return root;
}
function write(root: string, file: string, content = "pass\n"): void {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
}
beforeEach(() => { vi.mocked(runProcessAsync).mockReset(); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("imported lint source freshness", () => {
    it.each(["a.py", "dist/generated.py", "build/generated.py", "ignored/generated.py"])("rejects a clean result after %s changed", async (file) => {
        const root = project();
        write(root, ".gitignore", "ignored/\n");
        write(root, file);
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockImplementation(async () => {
            expect(readFileSync(join(root, file), "utf8")).toBe("pass\n");
            write(root, file, "import unused\n");
            return clean;
        });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({
            status: "unavailable", findings: [], reason: `Lint source changed during analysis: ${file}; no verdict`,
        });
    });

    it.each(["added", "deleted"])("rejects a clean report when a source file is %s", async (operation) => {
        const root = project();
        if (operation === "deleted") write(root, "a.py");
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockImplementation(async () => {
            if (operation === "added") write(root, "a.py");
            else rmSync(join(root, "a.py"));
            return clean;
        });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("a.py") });
    });

    it("discards stale diagnostics instead of anchoring them against replacement source", async () => {
        const root = project();
        write(root, "a.py", "import unused\n");
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockImplementation(async () => {
            write(root, "a.py", "pass\n");
            return { ...clean, code: 1, stdout: JSON.stringify([{ filename: "a.py", location: { row: 1 }, code: "F401", message: "unused" }]) };
        });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", findings: [] });
    });

    it("rechecks earlier profiles after later analyzers finish", async () => {
        const root = project();
        rmSync(join(root, "ruff.toml"));
        for (const scope of ["one", "two"]) {
            write(root, `${scope}/ruff.toml`, 'select = ["F"]\n');
            write(root, `${scope}/a.py`);
        }
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockImplementation(async (_command, _args, options) => {
            if (options?.cwd === join(root, "two")) write(root, "one/a.py", "import unused\n");
            return clean;
        });
        const measured = await measureImportedLint(root, policy);
        expect(measured.find(({ entry }) => entry.scope === "one")).toMatchObject({ status: "unavailable", reason: expect.stringContaining("one/a.py") });
        expect(measured.find(({ entry }) => entry.scope === "two")).toMatchObject({ status: "measured" });
    });

    it.each(["src", "src/a.py", "src/**/*.py"])("retains working-scope source context outside explicit target %s", async (target) => {
        const root = project();
        write(root, "src/a.py");
        write(root, "scratch/large.bin", "");
        truncateSync(join(root, "scratch/large.bin"), 9 * 1024 * 1024);
        const { policy } = prepareLintImport(root, {});
        for (const entry of policy.entries) entry.targets = [target];
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, "unrelated.py", "import unused\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("unrelated.py") });
    });

    it("captures an explicitly selected Git-ignored scope", async () => {
        const root = project();
        write(root, ".gitignore", "ignored/\n");
        write(root, "ignored/a.py");
        const { policy } = prepareLintImport(root, { config: ["ruff=ruff.toml"], scope: "ignored" });
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, "ignored/a.py", "import unused\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("ignored/a.py") });
    });

    it.each([
        { targets: ["."], flags: [] },
        { targets: ["src/data.custom"], flags: [] },
        { targets: ["src/*.custom"], flags: [] },
        { targets: ["src"], flags: ["--ext", ".custom"] },
    ])("retains custom plugin file types declared by a target or extension flag: %j", async (options) => {
        const root = project();
        rmSync(join(root, "ruff.toml"));
        write(root, "eslint.config.mjs", 'export default [{ files: ["**/*.custom"] }];\n');
        write(root, "src/data.custom", "const value = 1;\n");
        const { policy } = prepareLintImport(root, {});
        for (const entry of policy.entries) Object.assign(entry, options);
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, "src/data.custom", "debugger;\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("src/data.custom") });
    });

    it("captures dependency source even when configuration changes native ignores", async () => {
        const root = project();
        rmSync(join(root, "ruff.toml"));
        write(root, "eslint.config.mjs", 'export default [{ ignores: ["!node_modules/", "!node_modules/**"] }];\n');
        write(root, "node_modules/a.js", "debugger;\n");
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, "node_modules/a.js", "const changed = 1;\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("node_modules/a.js") });
    });

    it("captures confined directory aliases and terminates directory cycles", async () => {
        const root = project();
        write(root, "actual/a.py");
        symlinkSync("actual", join(root, "linked"));
        symlinkSync("..", join(root, "actual/back"));
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockResolvedValue(clean);
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "measured" });
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, "linked/a.py", "import unused\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("actual/a.py") });
    });

    it("does not pretend dependency directories are ignored by every analyzer", async () => {
        const root = project();
        write(root, "vendor/a.py");
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, "vendor/a.py", "import unused\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("vendor/a.py") });
    });

    it("allows runtime receipts to change without treating them as source edits", async () => {
        const root = project();
        write(root, "a.py");
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, ".interlinked/activity.jsonl", "{}\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "measured", findings: [] });
    });

    it("snapshots imported-module context outside a type-checker's explicit target", async () => {
        const root = project();
        rmSync(join(root, "ruff.toml"));
        write(root, "mypy.ini", "[mypy]\n");
        write(root, "src/a.py", "from shared import value\n");
        write(root, "shared.py", "value = 1\n");
        const { policy } = prepareLintImport(root, {});
        for (const entry of policy.entries) entry.targets = ["src/a.py"];
        vi.mocked(runProcessAsync).mockImplementation(async () => {
            write(root, "shared.py", 'value = "changed"\n');
            return { ...clean, stdout: "" };
        });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("shared.py") });
    });

    it.each([
        { targets: [".interlinked/hooks/a.py"], flags: [] },
        { targets: ["."], flags: ["--no-respect-gitignore"] },
    ])("refuses target/ignore overrides that cross omitted runtime state: %j", async (options) => {
        const root = project();
        write(root, ".interlinked/hooks/a.py");
        const { policy } = prepareLintImport(root, {});
        for (const entry of policy.entries) Object.assign(entry, options);
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("omitted runtime") });
        expect(runProcessAsync).not.toHaveBeenCalled();
    });

    it("streams large files and captures changes behind regular file symlinks", async () => {
        const root = project();
        write(root, "a.py", "");
        truncateSync(join(root, "a.py"), 9 * 1024 * 1024);
        const { policy } = prepareLintImport(root, {});
        vi.mocked(runProcessAsync).mockResolvedValue(clean);
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "measured" });
        rmSync(join(root, "a.py"));
        write(root, "real.py");
        symlinkSync("real.py", join(root, "a.py"));
        vi.mocked(runProcessAsync).mockImplementation(async () => { write(root, "real.py", "import unused\n"); return clean; });
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("a.py") });
    });

    it("refuses a census exceeding four GiB without reading the oversized file", async () => {
        const root = project();
        write(root, "large.bin", "");
        truncateSync(join(root, "large.bin"), 4 * 1024 * 1024 * 1024 + 1);
        const { policy } = prepareLintImport(root, {});
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("byte budget") });
        expect(runProcessAsync).not.toHaveBeenCalled();
    });

    it("refuses linked external directory contents whose closure is outside the project", async () => {
        const root = project();
        const external = project();
        write(external, "a.py");
        symlinkSync(external, join(root, "external"));
        const { policy } = prepareLintImport(root, {});
        expect((await measureImportedLint(root, policy))[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("External symlinked lint directory") });
        expect(runProcessAsync).not.toHaveBeenCalled();
    });

    it("refuses an already-expired census budget even for an empty selected directory", () => {
        const root = project();
        mkdirSync(join(root, "empty"));
        expect(() => captureLintSourceSnapshot(root, { tool: "ruff", scope: "empty", sources: [] }, 0)).toThrow("time budget exhausted");
    });
});
