import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const ZERO = "0".repeat(40);
const TARGET = "src/well0.ts";
const COMMIT_DATE = "2026-01-01T00:00:00Z";
const FILES = Array.from({ length: 20 }, (_, index) => `src/well${index}.ts`);

describe("pre-push coverage integration", () => {
    let root: string;
    let base: string;
    const git = (...args: string[]) => execFileSync("git", args, {
        cwd: root, encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
    }).trim();
    const write = (path: string, text: string) => writeFileSync(join(root, path), text);
    const commit = (message: string) => {
        git("add", "--all");
        git("commit", "-qm", message);
        return git("rev-parse", "HEAD");
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "prepush-coverage-"));
        git("init", "-q");
        git("config", "user.name", "Coverage fixture");
        git("config", "user.email", "fixture@example.com");
        git("config", "core.hooksPath", "/dev/null");
        for (const path of ["src", "scripts/git-hooks", "dist", "coverage", ".interlinked"]) {
            mkdirSync(join(root, path), { recursive: true });
        }
        copyFileSync(join(REPO, "scripts/git-hooks/pre-push"), join(root, "scripts/git-hooks/pre-push"));
        write("scripts/ci-packaging.sh", "echo PACKAGE_GATE\n");
        write(".gitignore", "coverage/\n.interlinked/\ncaptured.json\n");
        write("package.json", JSON.stringify({ name: "gate-fixture", scripts: {
            "typecheck:stable": "echo TYPECHECK_GATE", "docs:check": "echo DOC_GATE", test: "echo TEST_GATE",
        } }));
        // Keep the hook's real coverage CLI boundary; only the expensive CI gates
        // above are stubs. The committed wrapper also works in its clean export.
        write("dist/index.js", `
const { spawnSync } = require("node:child_process");
require("node:fs").writeFileSync(process.env.COVERAGE_CAPTURE, JSON.stringify(process.argv.slice(2)));
const result = spawnSync(process.execPath, [${JSON.stringify(join(REPO, "dist/index.js"))}, ...process.argv.slice(2)], { encoding: "utf8" });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exitCode = result.status ?? 1;
`);
        for (const path of FILES) write(path, "export const value = 1;\n");
        base = commit("base");
        write(".interlinked/coverage-baseline.json", JSON.stringify({ version: 1, updated_at: "2026-01-01T00:00:00Z",
            files: Object.fromEntries(FILES.map(path => [path, { lines_pct: 90, branches_pct: 80 }])) }));
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function report(partial = false, regression = false): void {
        write("coverage/coverage-summary.json", JSON.stringify(Object.fromEntries(FILES.map((path, index) => [path, {
            lines: { pct: partial ? 0 : regression && index === 0 ? 40 : 90 }, branches: { pct: partial ? 0 : 80 },
        }]))));
        const fresh = new Date("2026-01-01T00:01:00Z");
        utimesSync(join(root, "coverage/coverage-summary.json"), fresh, fresh);
    }

    function run(updates: { sha: string; remote: string; old: string }[]) {
        const result = spawnSync("bash", [join(root, "scripts/git-hooks/pre-push"), "origin", "unused"], {
            cwd: root, encoding: "utf8", timeout: 60_000,
            env: { ...process.env, COVERAGE_CAPTURE: join(root, "captured.json") },
            input: updates.map(({ sha, remote, old }) => `refs/heads/local ${sha} refs/heads/${remote} ${old}\n`).join(""),
        });
        return { status: result.status, output: result.stdout + result.stderr };
    }

    function codeCommit(): string {
        write(TARGET, "export const value = 2;\n");
        return commit("change code");
    }

    function capturedScope(): string[] {
        const args: unknown = JSON.parse(readFileSync(join(root, "captured.json"), "utf8"));
        if (!Array.isArray(args) || !args.every(value => typeof value === "string")) throw new Error("Invalid CLI argument capture");
        const index = args.indexOf("--changed-files");
        const value = args[index + 1];
        if (index < 0 || typeof value !== "string") throw new Error("Missing coverage scope");
        return value.split(",");
    }

    it("blocks a real partial CLI verdict even though strict coverage exits zero", () => {
        const sha = codeCommit();
        report(true);
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.output).toContain("TEST_GATE");
        expect(result.status).toBe(1);
        expect(result.output).toContain("Coverage is partial or unmeasured");
    });

    it("accepts measured unchanged coverage and rejects a measured decrease", () => {
        const sha = codeCommit();
        report();
        const updates = [{ sha, remote: "main", old: base }];
        const passing = run(updates);
        expect(passing.status).toBe(0);
        expect(passing.output).toContain("1 measured file(s)");
        report(false, true);
        expect(run(updates).status).toBe(1);
    });

    it("retains code from an earlier ref when the last ref changes only docs", () => {
        const code = codeCommit();
        write("README.md", "Documentation\n");
        const docs = commit("docs");
        report();
        const result = run([{ sha: code, remote: "main", old: base }, { sha: docs, remote: "master", old: code }]);
        expect(result.status).toBe(0);
        expect(capturedScope()).toEqual([TARGET]);
        expect(result.output).toContain("1 measured file(s)");
    });

    it.each([ZERO, "f".repeat(40)])("covers the full tree when the remote base is %s", old => {
        codeCommit();
        write("README.md", "Documentation\n");
        const sha = commit("docs tip");
        report();
        const result = run([{ sha, remote: "main", old }]);
        expect(result.status).toBe(0);
        expect(capturedScope().sort()).toEqual([...FILES].sort());
        expect(result.output).toContain("20 measured file(s)");
    });

    it("requires coverage newer than every protected ref, including an earlier update", () => {
        write(TARGET, "export const value = 2;\n");
        git("add", "--all");
        execFileSync("git", ["commit", "-qm", "newer code commit"], {
            cwd: root,
            env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:02:00Z" },
        });
        const code = git("rev-parse", "HEAD");
        write("README.md", "Documentation\n");
        const docs = commit("older timestamp on last ref");
        report();
        const result = run([{ sha: code, remote: "main", old: base }, { sha: docs, remote: "master", old: code }]);
        expect(result.status).toBe(1);
        expect(result.output).toContain(`no coverage report newer than ${code}`);
    });

    it("runs code and package checks for a path list larger than the pipe buffer", () => {
        mkdirSync(join(root, "zz-changes"));
        for (let index = 0; index < 1000; index++) write(`zz-changes/${index}-${"x".repeat(160)}.txt`, "change\n");
        write("package.json", JSON.stringify({ scripts: {
            "typecheck:stable": "echo TYPECHECK_GATE", "docs:check": "echo DOC_GATE", test: "echo TEST_GATE",
        } }));
        const sha = commit("large code and package range");
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(0);
        expect(result.output).toContain("TYPECHECK_GATE");
        expect(result.output).toContain("TEST_GATE");
        expect(result.output).toContain("PACKAGE_GATE");
    });
});
