import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyLogPath } from "../harness/hook-coverage-history-log.js";
import { harnessCoverageRepairCommand } from "./harness-coverage-repair.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const state = { schema: 1, generation: 3, policyGeneration: 1, files: { "a.ts": { identity: "v1", scope: "policy" } },
    pending: [{ id: "p1", path: "a.ts", identity: "v1", scope: "policy", writer: "unknown" }], acceptedPolicy: null,
    history: { bytes: 100, checks: 1, reviews: 0, recent: { checks: [0], reviews: [] } } };

function project(): { root: string; ledger: string } {
    const root = mkdtempSync(join(tmpdir(), "coverage-repair-cmd-"));
    roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    return { root, ledger: join(root, ".interlinked", "hook-coverage.json") };
}

function capture(): string[] {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    return lines;
}

describe("harness coverage repair-history — positive (must fire)", () => {
    it("P1: repairs a ledger whose log lost committed bytes, keeps pending work and names the orphan", async () => {
        const { ledger } = project();
        writeFileSync(ledger, JSON.stringify(state));
        writeFileSync(historyLogPath(ledger), "{\"partial\":true}\n");
        const lines = capture();
        await harnessCoverageRepairCommand({ json: true });
        const result: unknown = JSON.parse(lines.join("\n"));
        expect(result).toMatchObject({ repaired: true });
        expect(String((result as { orphan?: string }).orphan)).toContain(".orphan-");
        const repaired: unknown = JSON.parse(readFileSync(ledger, "utf8"));
        expect(repaired).toMatchObject({ generation: 3, pending: state.pending, history: { bytes: 0, checks: 0, reviews: 0 } });
        expect(existsSync(historyLogPath(ledger))).toBe(false);
        expect(readdirSync(join(ledger, "..")).some(name => name.includes(".orphan-"))).toBe(true);
        expect(process.exitCode ?? 0).toBe(0);
    });
});

describe("harness coverage repair-history — negative (must not fire)", () => {
    it("refuses to mutate a ledger while its daemon process is alive", async () => {
        const { root, ledger } = project();
        const original = JSON.stringify(state);
        writeFileSync(ledger, original);
        writeFileSync(join(root, ".interlinked", "harness.pid"), String(process.pid));
        await expect(harnessCoverageRepairCommand({ json: true })).rejects.toThrow("Stop the daemon");
        expect(readFileSync(ledger, "utf8")).toBe(original);
    });
    it("N1: an intact history is left alone and reported as such", async () => {
        const { ledger } = project();
        writeFileSync(ledger, JSON.stringify({ ...state, history: { bytes: 0, checks: 0, reviews: 0, recent: { checks: [], reviews: [] } } }));
        const lines = capture();
        await harnessCoverageRepairCommand({});
        expect(lines.join("\n")).toMatch(/^No repair: history intact/);
        expect(readFileSync(ledger, "utf8")).toContain('"bytes":0');
    });
    it("N2: a project with no ledger needs no repair", async () => {
        project();
        const lines = capture();
        await harnessCoverageRepairCommand({ json: true });
        expect(JSON.parse(lines.join("\n"))).toMatchObject({ repaired: false });
    });
});
