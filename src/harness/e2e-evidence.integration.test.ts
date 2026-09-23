import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintBuildInputs, fingerprintTestInputs, hashBytes } from "../../scripts/e2e-evidence.mjs";
import { baseE2eFiles, checkE2eBaseline, E2E_BASELINE_PATH } from "./e2e-store.js";

const A = "src/harness/adapters/a.ts";
const metric = { pct: 50, covered: 50, total: 100 };
const report = { [A]: { lines: metric, statements: metric, branches: metric, functions: metric } };
const entry = { lines_pct: 50, branches_pct: 50, statements_pct: 50, functions_pct: 50, lines_covered: 50, lines_total: 100 };
let root = "";
let evidence: Record<string, unknown>;
const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=e2e@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const baseline = () => readFileSync(join(root, E2E_BASELINE_PATH), "utf8");

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "e2e-evidence-"));
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));
    put("package.json", '{"type":"module"}');
    put(A, "export function a() { return 1; }\n");
    put("src/e2e/helper.ts", "export const expected = 1;\n");
    put("src/e2e/a.e2e.test.ts", 'import { it, expect } from "vitest"; import { expected } from "./helper"; it("a", () => expect(expected).toBe(1));');
    put("vitest.e2e.config.ts", 'export default { test: { include: ["src/e2e/*.e2e.test.ts"] } };');
    put("scripts/e2e-run.mjs", "export {};\n");
    put("scripts/e2e-coverage-merge.mjs", "export {};\n");
    put("scripts/build-atomic.mjs", "export {};\n");
    put("tsconfig.json", "{}");
    put("dist/metafile-esm.json", JSON.stringify({ inputs: { [A]: {} }, outputs: { "dist/index.js": { inputs: { [A]: { bytesInOutput: 1 } } } } }));
    put("dist/.build-input-fingerprint", fingerprintBuildInputs(root, { mode: "e2e" }));
    put("coverage-e2e/coverage-summary.json", JSON.stringify(report));
    // Synthetic artifacts exercise validation. Actual V8 collection has its
    // separate subprocess proofs; this fixture does not claim to collect it.
    evidence = { schema: 1, lane: "e2e", passed: true, build: fingerprintBuildInputs(root, { mode: "e2e" }),
        tests: await fingerprintTestInputs(root), inventory: hashBytes(JSON.stringify([A])), report: hashBytes(JSON.stringify(report)) };
    put("coverage-e2e/run.json", JSON.stringify(evidence));
    put(".interlinked/coverage-baseline.json", "ordinary lane bytes stay untouched");
    put(E2E_BASELINE_PATH, JSON.stringify({ version: 1, updated_at: "fixture", files: { [A]: entry } }));
    git("init", "--quiet");
    git("add", A);
    git("commit", "--quiet", "--no-gpg-sign", "-m", "first source");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("measured e2e evidence and first-baseline acceptance", () => {
    it("initializes only the e2e lane and retains source floors from the selected base", async () => {
        rmSync(join(root, E2E_BASELINE_PATH));
        await checkE2eBaseline({ root, init: true });
        expect(JSON.parse(baseline()).files).toEqual({ [A]: entry });
        expect(readFileSync(join(root, ".interlinked/coverage-baseline.json"), "utf8")).toBe("ordinary lane bytes stay untouched");
        const original = baseline();
        await expect(checkE2eBaseline({ root, init: true })).rejects.toThrow("exists");
        expect(baseline()).toBe(original);
        git("add", E2E_BASELINE_PATH);
        git("commit", "--quiet", "--no-gpg-sign", "-m", "baseline");
        expect(baseE2eFiles(root)).toEqual({ [A]: entry });
        rmSync(join(root, E2E_BASELINE_PATH));
        await expect(checkE2eBaseline({ root })).rejects.toThrow("Missing e2e baseline");
        const lower = { pct: 49, covered: 49, total: 100 };
        const bytes = JSON.stringify({ [A]: { lines: lower, statements: lower, branches: lower, functions: lower } });
        put("coverage-e2e/coverage-summary.json", bytes);
        put("coverage-e2e/run.json", JSON.stringify({ ...evidence, report: hashBytes(bytes) }));
        await expect(checkE2eBaseline({ root, init: true })).rejects.toThrow("fell");
        expect(existsSync(join(root, E2E_BASELINE_PATH))).toBe(false);
        expect(() => baseE2eFiles(root, "f".repeat(40))).toThrow();
    });

    for (const mode of ["compare", "init", "update"] as const) {
        it.each(["missing evidence", "failed run", "stale build", "changed report"])(`${mode} refuses %s without writing`, async (failure) => {
            if (mode === "init") rmSync(join(root, E2E_BASELINE_PATH));
            const before = mode === "init" ? null : baseline();
            if (failure === "missing evidence") rmSync(join(root, "coverage-e2e/run.json"));
            if (failure === "failed run") put("coverage-e2e/run.json", JSON.stringify({ ...evidence, passed: false }));
            if (failure === "stale build") put("coverage-e2e/run.json", JSON.stringify({ ...evidence, build: "older checkout" }));
            if (failure === "changed report") put("coverage-e2e/coverage-summary.json", "{}");
            await expect(checkE2eBaseline({ root, init: mode === "init", update: mode === "update" })).rejects.toThrow();
            if (before === null) expect(existsSync(join(root, E2E_BASELINE_PATH))).toBe(false);
            else expect(baseline()).toBe(before);
        });
    }

    it.each(["tsconfig.json", "scripts/build-atomic.mjs"])("rejects a dirty build input: %s", async (file) => {
        const before = baseline();
        put(file, "changed");
        await expect(checkE2eBaseline({ root, update: true })).rejects.toThrow("Stale");
        expect(baseline()).toBe(before);
    });
    it.each(["edit", "add", "delete", "helper", "config"])("invalidates a run after a test-input %s", async (change) => {
        const before = baseline();
        if (change === "edit") put("src/e2e/a.e2e.test.ts", 'import { it } from "vitest"; it("different", () => {});');
        if (change === "add") put("src/e2e/b.e2e.test.ts", 'import { it } from "vitest"; it("new", () => {});');
        if (change === "delete") rmSync(join(root, "src/e2e/a.e2e.test.ts"));
        if (change === "helper") put("src/e2e/helper.ts", "export const expected = 2;\n");
        if (change === "config") put("vitest.e2e.config.ts", 'export default { test: { include: ["src/e2e/*.e2e.test.ts"], retry: 1 } };');
        await expect(checkE2eBaseline({ root, update: true })).rejects.toThrow();
        expect(baseline()).toBe(before);
    });
    it.each(["missing file", "partial metrics", "corrupt baseline", "standard build"])("fails closed for %s", async (failure) => {
        if (failure === "corrupt baseline") put(E2E_BASELINE_PATH, "malformed");
        const before = baseline();
        if (failure === "standard build") put("dist/.build-input-fingerprint", fingerprintBuildInputs(root));
        if (failure === "missing file" || failure === "partial metrics") {
            const bytes = JSON.stringify(failure === "missing file" ? {} : { [A]: { lines: metric } });
            put("coverage-e2e/coverage-summary.json", bytes);
            put("coverage-e2e/run.json", JSON.stringify({ ...evidence, report: hashBytes(bytes) }));
        }
        await expect(checkE2eBaseline({ root, update: true })).rejects.toThrow();
        expect(baseline()).toBe(before);
    });
});
