import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metricsDiagnosticsCommand } from "./metrics-diagnostics.js";
import { metricsDiagnosticsCompareCommand } from "./metrics-diagnostics-compare.js";
import { collectDiagnosticReport } from "../lib/metrics/diagnostic-report.js";

let root: string;
const previousExitCode = process.exitCode;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "metrics-diagnostics-"));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
});
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
    rmSync(root, { recursive: true, force: true });
});

describe("metrics diagnostics output", () => {
    it("runs the explicitly selected Python profile and rejects unknown profiles", () => {
        writeFileSync(join(root, "worker.py"), "def worker(): return 1\n");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        metricsDiagnosticsCommand({ cwd: root, profile: "python", json: true });
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ profile: { id: "interlinked-iterative-python-v1" }, scope: { measuredFiles: 1 } });
        metricsDiagnosticsCommand({ cwd: root, profile: "unknown", json: true });
        expect(error).toHaveBeenCalledWith(expect.stringContaining("Diagnostic profile must"));
        expect(process.exitCode).toBe(1);
    });

    it("compares saved snapshots and returns nonzero when scope changes", () => {
        const before = join(root, "before.json"), after = join(root, "after.json");
        writeFileSync(before, JSON.stringify(collectDiagnosticReport(root)));
        writeFileSync(join(root, "additional.ts"), "export const other = 2;\n");
        writeFileSync(after, JSON.stringify(collectDiagnosticReport(root)));
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        metricsDiagnosticsCompareCommand(before, after, { json: true });
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ comparable: false, erosion: { numeratorDelta: null } });
        expect(process.exitCode).toBe(1);
    });
    it("exports explained counts and null erosion for a module without functions", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        metricsDiagnosticsCommand({ cwd: root, json: true });
        const result = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(result).toMatchObject({ schemaVersion: 1, modelCalls: 0, scope: { status: "complete", measuredFiles: 1 },
            verbosity: { numerator: 0, denominator: 1, fraction: 0 }, erosion: { fraction: null, state: "not-applicable" } });
        expect(result.measurementIdentity).toMatch(/^[a-f0-9]{64}$/);
    });

    it("shows partial scope in compact output rather than a clean quality verdict", () => {
        writeFileSync(join(root, "worker.py"), "def worker(): return 1\n");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        metricsDiagnosticsCommand({ cwd: root, short: true });
        expect(log).toHaveBeenCalledWith(expect.stringContaining("partial scope 1/2 files; no quality verdict"));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("(0/1 SLOC)"));
    });

    it("makes unsupported source and interpretation limits visible in normal output", () => {
        writeFileSync(join(root, "worker.py"), "def worker(): return 1\n");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        metricsDiagnosticsCommand({ cwd: root });
        const rendered = String(log.mock.calls[0]?.[0]);
        expect(rendered).toContain("Not measured: worker.py:");
        expect(rendered).toContain("not benchmark-compatible");
        expect(rendered).toContain("Redundant clone lines");
    });

    it("reports an inaccessible root as an error with failure exit status", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        metricsDiagnosticsCommand({ cwd: join(root, "missing"), json: true });
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toHaveProperty("error");
    });
});
