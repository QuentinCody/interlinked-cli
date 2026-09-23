import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkE2eBaseline, type E2eStoreDeps } from "./e2e-store.js";
import { type E2eEntry } from "./e2e-ratchet.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const entry = (pct: number): E2eEntry => ({ lines_pct: pct, statements_pct: pct, branches_pct: pct, functions_pct: pct, lines_total: 100, lines_covered: pct });
function setup(pct = 50): { root: string; path: string; deps: E2eStoreDeps } {
    const root = mkdtempSync(join(tmpdir(), "e2e-store-"));
    roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    mkdirSync(join(root, "coverage-e2e"));
    const path = join(root, ".interlinked/coverage-e2e-baseline.json");
    writeFileSync(path, JSON.stringify({ version: 1, updated_at: "prior", files: { A: entry(pct) } }));
    return { root, path, deps: { inventory: () => ["A"], base: () => ({}), evidence: async () => undefined } };
}
function report(root: string, pct: number): void {
    const metric = { total: 100, covered: pct, pct };
    writeFileSync(join(root, "coverage-e2e/coverage-summary.json"), JSON.stringify({ A: { lines: metric, statements: metric, branches: metric, functions: metric } }));
}

describe("e2e baseline transactions", () => {
    it.each([[60, 55], [55, 60]])("serializes competing %i and %i writers against the latest floor", async (first, second) => {
        const { root, path, deps } = setup();
        let entered!: () => void;
        let release!: () => void;
        const inside = new Promise<void>((resolve) => { entered = resolve; });
        const hold = new Promise<void>((resolve) => { release = resolve; });
        const reports = [first, second].map((pct) => {
            const file = join(root, `report-${pct}.json`);
            const metric = { total: 100, covered: pct, pct };
            writeFileSync(file, JSON.stringify({ A: { lines: metric, statements: metric, branches: metric, functions: metric } }));
            return file;
        });
        const a = checkE2eBaseline({ root, report: reports[0], update: true }, { ...deps, evidence: async () => { entered(); await hold; } });
        await inside;
        const b = checkE2eBaseline({ root, report: reports[1], update: true }, deps);
        const settled = Promise.allSettled([a, b]);
        release();
        const results = await settled;
        expect(results.map((result) => result.status)).toEqual(first === 60 ? ["fulfilled", "rejected"] : ["fulfilled", "fulfilled"]);
        expect(JSON.parse(readFileSync(path, "utf8")).files).toEqual({ A: entry(60) });
    });
    it("leaves failed and unmeasured updates byte-identical", async () => {
        const { root, path, deps } = setup();
        const original = readFileSync(path, "utf8");
        report(root, 49);
        await expect(checkE2eBaseline({ root, update: true }, deps)).rejects.toThrow("A");
        expect(readFileSync(path, "utf8")).toBe(original);
        report(root, 60);
        await expect(checkE2eBaseline({ root, update: true }, { ...deps, evidence: async () => { throw new Error("unmeasured"); } })).rejects.toThrow("unmeasured");
        expect(readFileSync(path, "utf8")).toBe(original);
    });
    it("writes counts and percentages together only after a pass", async () => {
        const { root, path, deps } = setup();
        report(root, 60);
        await checkE2eBaseline({ root, update: true }, deps);
        expect(JSON.parse(readFileSync(path, "utf8")).files).toEqual({ A: entry(60) });
        report(root, 55);
        await expect(checkE2eBaseline({ root, update: true }, deps)).rejects.toThrow("A");
        expect(JSON.parse(readFileSync(path, "utf8")).files).toEqual({ A: entry(60) });
    });
    it("uses only the e2e report and refuses initialization over an existing baseline", async () => {
        const { root, deps } = setup();
        mkdirSync(join(root, "coverage"));
        writeFileSync(join(root, "coverage/coverage-summary.json"), "{}");
        await expect(checkE2eBaseline({ root }, deps)).rejects.toThrow();
        report(root, 60);
        await expect(checkE2eBaseline({ root, init: true }, deps)).rejects.toThrow("exists");
    });
});
