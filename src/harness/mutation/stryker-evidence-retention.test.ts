import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { retainMutationReport } from "./stryker-evidence-store.js";
import { appendMutationRun, pruneMutationReports } from "./stryker-evidence-retention.js";

it("independently enforces age and byte limits, and repairs oversized run-log generations", () => {
    const dir = mkdtempSync(join(tmpdir(), "retention-bounds-"));
    const old = join(dir, "a".repeat(64) + ".json"), current = join(dir, "b".repeat(64) + ".json");
    const limits = { bytes: 100, reports: 100, ageMs: 1000, logBytes: 100 };
    try {
        writeFileSync(old, "a"); writeFileSync(current, "b");
        utimesSync(old, 0, 0);
        expect(pruneMutationReports(dir, current, limits, 2000)).toBe(1);
        expect(existsSync(old)).toBe(false);
        writeFileSync(old, "a".repeat(60)); writeFileSync(current, "b".repeat(60));
        expect(pruneMutationReports(dir, current, { ...limits, ageMs: Number.MAX_SAFE_INTEGER }, Date.now())).toBe(1);
        expect(readFileSync(current, "utf8")).toHaveLength(60);
        const log = join(dir, "runs.jsonl");
        writeFileSync(log, '"old"\n'.repeat(100));
        appendMutationRun(log, '"new"\n', 100);
        expect(statSync(log + ".previous").size).toBeLessThanOrEqual(100);
        expect(readFileSync(log, "utf8")).toBe('"new"\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("bounds report count, total bytes, age and both log generations while retaining the current report", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sidecar-retention-"));
    const dir = join(cwd, ".interlinked/mutation-evidence");
    const limits = { bytes: 2000, reports: 2, ageMs: 1000, logBytes: 800 };
    try {
        const first = retainMutationReport({ cwd, report: { marker: 0 }, run: "0", source: "test" }, limits);
        expect(first.retained).toBe(true);
        utimesSync(first.path!, 0, 0);
        writeFileSync(join(dir, "operator-note.txt"), "keep");
        let removed = 0;
        for (let i = 1; i < 10; i++) {
            const saved = retainMutationReport({ cwd, report: { marker: i }, run: String(i), source: "test" }, limits);
            expect(saved.retained).toBe(true);
            expect(JSON.parse(readFileSync(saved.path!, "utf8")).report_json).toContain(String(i));
            removed += saved.pruned!;
        }
        const reports = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
        expect(reports.length).toBeLessThanOrEqual(2);
        expect(reports.reduce((n, name) => n + statSync(join(dir, name)).size, 0)).toBeLessThanOrEqual(limits.bytes);
        expect(removed).toBeGreaterThan(0);
        expect(reports).not.toContain(first.sha256 + ".json");
        expect(readFileSync(join(dir, "operator-note.txt"), "utf8")).toBe("keep");
        for (const name of ["runs.jsonl", "runs.jsonl.previous"]) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(limits.logBytes);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
