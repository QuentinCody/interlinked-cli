// End to end: recorded faults applied one at a time to a git-visible copy; the real vitest binary decides.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RequirementFault } from "./corpus.js";
import { runFaults } from "./run.js";

const TIMEOUT = 120_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SOURCE = "export function sum(a: number, b: number): number { return a + b; }\n";
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rf-run-"))); roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rf-fixture", type: "module" }));
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    writeFileSync(join(root, "src/sum.ts"), SOURCE);
    writeFileSync(join(root, "src/sum.test.ts"), `import { expect, it } from "vitest";\nimport { sum } from "./sum.js";\nit("adds", () => { expect(sum(2, 3)).toBe(5); });\nit("returns a number", () => { expect(typeof sum(1, 1)).toBe("number"); });\n`);
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));
    execFileSync("git", ["init", "--quiet", root]);
    return root;
}
function fault(id: string, find: string, replace: string): RequirementFault {
    return { id, requirement: { id: "sum-adds", text: "sum returns the arithmetic sum" }, path: "src/sum.ts", find, replace, rationale: id, tests: ["src/sum.test.ts"], origin: "authored" };
}

describe("runFaults — positive", () => {
    it("P1: a fault a test notices by assertion is killed, naming the test; the live tree is never written", async () => {
        const root = project();
        const report = await runFaults({ root, faults: [fault("subtracts", "a + b", "a - b")], budgetMs: TIMEOUT });
        expect(report.faults).toEqual([{ fault: "subtracts", requirement: "sum-adds", status: "killed", killedBy: ["src/sum.test.ts › adds"], inconclusive: [] }]);
        expect(readFileSync(join(root, "src/sum.ts"), "utf8")).toBe(SOURCE);
        expect(existsSync(report.copyDir ?? "")).toBe(false);
    }, TIMEOUT);
});

describe("runFaults — own checks and reasons", () => {
    it("P2: a test whose oracle is its own helper (a plain Error thrown in the test file) kills the fault", async () => {
        const root = project();
        writeFileSync(join(root, "src/sum.oracle.test.ts"), `import { it } from "vitest";\nimport { sum } from "./sum.js";\nfunction check(ok: boolean): void { if (!ok) throw new Error("sum disagreed with the oracle"); }\nit("agrees with the oracle", () => { check(sum(2, 3) === 5); });\n`);
        const report = await runFaults({ root, budgetMs: TIMEOUT, faults: [{ ...fault("subtracts", "a + b", "a - b"), tests: ["src/sum.oracle.test.ts"] }] });
        expect(report.faults).toEqual([{ fault: "subtracts", requirement: "sum-adds", status: "killed", killedBy: ["src/sum.oracle.test.ts › agrees with the oracle"], inconclusive: [] }]);
    }, TIMEOUT);

    it("N2: a plain Error thrown by product code is inconclusive, and the report says why for each test", async () => {
        const root = project();
        const report = await runFaults({ root, budgetMs: TIMEOUT, faults: [fault("throws", "return a + b;", "throw new Error(\"sum unavailable\");")] });
        expect(report.faults).toEqual([{ fault: "throws", requirement: "sum-adds", status: "inconclusive", killedBy: [], inconclusive: ["src/sum.test.ts › adds", "src/sum.test.ts › returns a number"],
            inconclusiveReasons: { "src/sum.test.ts › adds": "Error: sum unavailable", "src/sum.test.ts › returns a number": "Error: sum unavailable" } }]);
    }, TIMEOUT);
});

describe("runFaults — negative", () => {
    it("N1: an equivalent fault survives, an absent anchor is invalid, a load failure is inconclusive — the fraction counts only killed vs survived", async () => {
        const root = project();
        const report = await runFaults({ root, budgetMs: TIMEOUT, faults: [
            fault("subtracts", "a + b", "a - b"),
            fault("adds-zero", "a + b", "a + b + 0"),
            fault("absent", "a * b", "a / b"),
            fault("breaks-load", "export function sum", "throw new Error(\"boom\");\nexport function sum"),
        ] });
        expect(report.faults.map(row => [row.fault, row.status])).toEqual([["subtracts", "killed"], ["adds-zero", "survived"], ["absent", "invalid"], ["breaks-load", "inconclusive"]]);
        expect(report.faults.find(row => row.fault === "absent")?.reason).toBe("anchor occurs 0 times in src/sum.ts (exactly one is required)");
        expect(report.requirements).toEqual([{ requirement: "sum-adds", killed: 1, survived: 1, inconclusive: 1, invalid: 1, fraction: 0.5 }]);
    }, TIMEOUT);
});
