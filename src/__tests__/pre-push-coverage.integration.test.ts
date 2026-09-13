import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
        measurement = {};
        root = mkdtempSync(join(tmpdir(), "prepush-coverage-"));
        git("init", "-q");
        git("config", "user.name", "Coverage fixture");
        git("config", "user.email", "fixture@example.com");
        git("config", "core.hooksPath", "/dev/null");
        for (const path of ["src", "scripts/git-hooks", "dist", "coverage", ".interlinked"]) {
            mkdirSync(join(root, path), { recursive: true });
        }
        copyFileSync(join(REPO, "scripts/git-hooks/pre-push"), join(root, "scripts/git-hooks/pre-push"));
        copyFileSync(join(REPO, "scripts/pre-push-coverage.mjs"), join(root, "scripts/pre-push-coverage.mjs"));
        symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
        write("scripts/ci-packaging.sh", "echo PACKAGE_GATE\n");
        write(".gitignore", "coverage/\n.interlinked/\ncaptured.json\nnode_modules\n");
        write("package.json", JSON.stringify({ name: "gate-fixture", scripts: {
            "typecheck:stable": "echo TYPECHECK_GATE", "docs:check": "echo DOC_GATE", test: "node scripts/coverage-fixture.cjs",
        } }));
        write("scripts/coverage-fixture.cjs", `
const fs = require("node:fs");
console.log("TEST_GATE");
if (process.env.INTERLINKED_PRE_PUSH_COVERAGE_SCOPE && process.env.COVERAGE_OMIT_SCOPE !== "1") {
    fs.mkdirSync(require("node:path").dirname(process.env.INTERLINKED_PRE_PUSH_COVERAGE_SCOPE), { recursive: true });
    fs.writeFileSync(process.env.INTERLINKED_PRE_PUSH_COVERAGE_SCOPE, JSON.stringify({ version: 1, root: process.cwd(),
        included: Object.fromEntries(process.env.INTERLINKED_PRE_PUSH_COVERAGE_TARGETS.split(",").map(path => [path, true])) }));
}
fs.mkdirSync("coverage", { recursive: true });
const entries = ${JSON.stringify(FILES)}.filter(path => !String(process.env.COVERAGE_OMIT || "").split(",").includes(path)).map(path => [path, {
    lines: { pct: process.env.COVERAGE_PARTIAL === "1" ? 0 : process.env.COVERAGE_REGRESSION === "1" && path === ${JSON.stringify(TARGET)} ? 40 : 90 },
    branches: { pct: process.env.COVERAGE_PARTIAL === "1" ? 0 : 80 }
}]);
fs.writeFileSync("coverage/coverage-summary.json", JSON.stringify(Object.fromEntries(entries)));
`);
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

    let measurement: Record<string, string> = {};
    function report(partial = false, regression = false): void {
        measurement = { COVERAGE_PARTIAL: partial ? "1" : "0", COVERAGE_REGRESSION: regression ? "1" : "0" };
    }

    function run(updates: { sha: string; remote: string; old: string }[]) {
        // This suite itself runs inside the real pre-push gate, whose reporter
        // variables would otherwise reach the fixture's coverage stub and make
        // it overwrite the OUTER gate's scope file with this fixture's root
        // (found 2026-09-10: every push was refused with "scope does not
        // describe this pushed revision" after the full suite went green).
        const { INTERLINKED_PRE_PUSH_COVERAGE_SCOPE: _scope, INTERLINKED_PRE_PUSH_COVERAGE_TARGETS: _targets, ...inherited } = process.env;
        const result = spawnSync("bash", [join(root, "scripts/git-hooks/pre-push"), "origin", "unused"], {
            cwd: root, encoding: "utf8", timeout: 60_000,
            env: { ...inherited, ...measurement, COVERAGE_CAPTURE: join(root, "captured.json") },
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

    it("rejects an omitted changed baseline file even when another changed file is measured", () => {
        write("src/well1.ts", "export const value = 2;\n");
        const sha = codeCommit();
        report();
        measurement.COVERAGE_OMIT = TARGET;
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(1);
        expect(result.output).toContain(`unmeasured for changed baselined source: ${TARGET}`);
    });

    it("rejects an omitted sole changed baseline file", () => {
        const sha = codeCommit();
        measurement.COVERAGE_OMIT = TARGET;
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(1);
        expect(result.output).toContain(`unmeasured for changed baselined source: ${TARGET}`);
    });

    it.each(["deleted", "type-only"])("permits an omitted %s file", change => {
        if (change === "deleted") rmSync(join(root, TARGET));
        else write(TARGET, "export interface Value { count: number }\n");
        const sha = commit(change);
        measurement.COVERAGE_OMIT = TARGET;
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(0);
        expect(result.output).toContain("No runtime coverage targets");
    });

    it("does not erase a runtime import when classifying a type-declaration module", () => {
        write("tsconfig.json", JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }));
        write(TARGET, 'import { value } from "./well1"; export interface PublicShape { count: number }\n');
        const sha = commit("preserved runtime import");
        measurement.COVERAGE_OMIT = TARGET;
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(1);
        expect(result.output).toContain(`unmeasured for changed baselined source: ${TARGET}`);
    });

    it("refuses a working-tree checker when the pushed revision has no built checker", () => {
        const checker = readFileSync(join(root, "dist/index.js"), "utf8");
        rmSync(join(root, "dist/index.js"));
        const sha = codeCommit();
        write("dist/index.js", checker);
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("Pushed revision has no built coverage checker");
    });

    it("unions different comparison ranges for the same pushed revision without running it twice", () => {
        const middle = codeCommit();
        write("src/well1.ts", "export const value = 2;\n");
        const sha = commit("second changed source");
        const result = run([{ sha, remote: "main", old: base }, { sha, remote: "master", old: middle }]);
        expect(result.status).toBe(0);
        expect(capturedScope().sort()).toEqual([TARGET, "src/well1.ts"]);
        expect(result.output.split(`typecheck + tests pass for ${sha}`).length - 1).toBe(1);
    });

    it("rejects a dangling changed source link instead of treating it as a deletion", () => {
        rmSync(join(root, TARGET));
        symlinkSync("missing.ts", join(root, TARGET));
        const sha = commit("dangling source");
        measurement.COVERAGE_OMIT = TARGET;
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("ENOENT");
    });

    it("does not require coverage entries for test-only changes", () => {
        const path = "src/covered.test.ts";
        write(path, "export const testValue = 1;\n");
        const sha = commit("test-only change");
        const baseline = JSON.parse(readFileSync(join(root, ".interlinked/coverage-baseline.json"), "utf8"));
        baseline.files[path] = { lines_pct: 90, branches_pct: 80 };
        write(".interlinked/coverage-baseline.json", JSON.stringify(baseline));
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(0);
        expect(result.output).toContain("No runtime coverage targets");
    });

    it("rejects a coverage result without the native scope snapshot", () => {
        const sha = codeCommit();
        measurement.COVERAGE_OMIT_SCOPE = "1";
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("pre-push-coverage-scope.json");
    });

    it("uses native dynamic coverage exclusions instead of requiring retained out-of-scope baseline entries", () => {
        write("package.json", JSON.stringify({ scripts: {
            "typecheck:stable": "echo TYPECHECK_GATE", "docs:check": "echo DOC_GATE",
            test: `node "${join(REPO, "node_modules/vitest/vitest.mjs")}" run`,
        } }));
        write("vitest.config.mjs", `export default { test: { include: ["src/probe.test.ts"], coverage: { provider: "v8", reporter: ["json-summary"], include: ["${TARGET}"], exclude: process.env.COVERAGE_DYNAMIC_EXCLUDE === "1" ? ["${TARGET}"] : [] } } };`);
        write("src/probe.test.ts", `import { expect, it } from "vitest"; import { value } from "./well0"; it("returns its value", () => { expect(value()).toBe(1); });`);
        write(TARGET, "export function value() { return 1; }\n");
        const sha = commit("dynamic coverage policy");
        measurement.COVERAGE_DYNAMIC_EXCLUDE = "1";
        const excluded = run([{ sha, remote: "main", old: base }]);
        expect(excluded.status, excluded.output).toBe(0);
        expect(excluded.output).toContain("No runtime coverage targets");
        measurement.COVERAGE_DYNAMIC_EXCLUDE = "0";
        const included = run([{ sha, remote: "main", old: base }]);
        expect(included.status, included.output).toBe(0);
        expect(included.output).toContain("1 measured file(s)");
    });

    it("measures each pushed revision with real Vitest instead of reusing the working-tree report", () => {
        write("package.json", JSON.stringify({ scripts: {
            "typecheck:stable": "echo TYPECHECK_GATE", "docs:check": "echo DOC_GATE",
            test: `node "${join(REPO, "node_modules/vitest/vitest.mjs")}" run`,
        } }));
        write("vitest.config.mjs", `export default { test: { include: ["src/probe.test.ts"], coverage: { provider: "v8", reporter: ["json-summary"], include: ["${TARGET}"] } } };`);
        write("src/probe.test.ts", `import { expect, it } from "vitest"; import { value } from "./well0"; it("returns its value", () => { expect(value()).toBe(1); });`);
        const goodSource = "export function value() {\n    return 1;\n}\n";
        write(TARGET, goodSource);
        const good = commit("fully covered revision");
        write(TARGET, `${goodSource}export function untested() {\n    return 2;\n}\n`);
        const bad = commit("uncovered additional function");
        // A newer working-tree report claims full coverage for both revisions.
        // It has no authority over either disposable export.
        write("coverage/coverage-summary.json", JSON.stringify({ [TARGET]: { lines: { pct: 100 }, branches: { pct: 100 } } }));
        const reportBefore = readFileSync(join(root, "coverage/coverage-summary.json"), "utf8");
        const cleanOlderRevision = run([{ sha: good, remote: "main", old: base }]);
        expect(cleanOlderRevision.status).toBe(0);
        const both = run([{ sha: good, remote: "main", old: base }, { sha: bad, remote: "master", old: good }]);
        expect(both.status).toBe(1);
        expect(both.output).toContain(`typecheck + tests pass for ${good}`);
        expect(both.output).toContain(`verification failed or unavailable for ${bad}`);
        expect(both.output).toContain('"current_pct": 50');
        expect(readFileSync(join(root, "coverage/coverage-summary.json"), "utf8")).toBe(reportBefore);
        expect(git("status", "--porcelain")).toBe("");
    });

    it("runs code and package checks for a path list larger than the pipe buffer", () => {
        mkdirSync(join(root, "zz-changes"));
        for (let index = 0; index < 1000; index++) write(`zz-changes/${index}-${"x".repeat(160)}.txt`, "change\n");
        write("package.json", JSON.stringify({ scripts: {
            "typecheck:stable": "echo TYPECHECK_GATE", "docs:check": "echo DOC_GATE", test: "node scripts/coverage-fixture.cjs",
        } }));
        const sha = commit("large code and package range");
        const result = run([{ sha, remote: "main", old: base }]);
        expect(result.status).toBe(0);
        expect(result.output).toContain("TYPECHECK_GATE");
        expect(result.output).toContain("TEST_GATE");
        expect(result.output).toContain("PACKAGE_GATE");
    });
});
