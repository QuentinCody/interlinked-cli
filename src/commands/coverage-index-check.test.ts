import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexedSummaryOutcome } from "../harness/coverage-index/summary.js";

const indexedCoverageSummary = vi.fn<(options: { root: string; storeRoot?: string; timeoutMs: number }) => Promise<IndexedSummaryOutcome>>();
vi.mock("../harness/coverage-index/summary.js", () => ({ indexedCoverageSummary: (options: { root: string; storeRoot?: string; timeoutMs: number }) => indexedCoverageSummary(options) }));
const { coverageCheckCommand } = await import("./coverage.js");

let root: string, ledger: string;
const rows = () => readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "coverage-index-check-")));
    ledger = join(root, "stages.jsonl");
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    writeFileSync(join(root, ".interlinked", "coverage-baseline.json"), JSON.stringify({ version: 1, updated_at: "1970-01-01T00:00:00.000Z", files: { "src/a.ts": { lines_pct: 90, branches_pct: 50 } } }));
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", ledger);
    vi.stubEnv("INTERLINKED_STAGE", "push");
    process.exitCode = undefined;
    indexedCoverageSummary.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined; rmSync(root, { recursive: true, force: true }); });

describe("coverage check --from-index — positive (must fire)", () => {
    // test-contract: public-api — a certified index measurement is judged by the same ratchet as a report: a drop under --strict exits 1, and one `coverage:index` ledger row records the stage, the outcome and whether any shard re-ran
    it("P1: judges the index summary and records one push-stage row with findings", async () => {
        indexedCoverageSummary.mockResolvedValue({ indexed: true, summary: { "src/a.ts": { lines: { pct: 80, covered: 8, total: 10 }, branches: { pct: 50, covered: 1, total: 2 }, functions: { pct: 100, covered: 1, total: 1 } } }, rerunTests: 2, universeTests: 5, validate_ms: 3, exec_ms: 40 });
        await coverageCheckCommand({ fromIndex: true, indexStore: root, cwd: root, strict: true, json: true, timeout: "5000" });
        expect(process.exitCode).toBe(1);
        expect(indexedCoverageSummary).toHaveBeenLastCalledWith({ root, storeRoot: root, timeoutMs: 5000, workers: 1 });
        expect(rows()).toMatchObject([{ stage: "push", check: "coverage:index", status: "findings", reused: false, validate_ms: 3, exec_ms: 40 }]);
    });
    it("P2: a measurement that re-ran nothing is a reused pass", async () => {
        indexedCoverageSummary.mockResolvedValue({ indexed: true, summary: { "src/a.ts": { lines: { pct: 95, covered: 19, total: 20 }, branches: { pct: 50, covered: 1, total: 2 }, functions: { pct: 100, covered: 1, total: 1 } } }, rerunTests: 0, universeTests: 5, validate_ms: 3, exec_ms: 1 });
        await coverageCheckCommand({ fromIndex: true, cwd: root, strict: true, json: true });
        expect(process.exitCode).toBeUndefined();
        expect(indexedCoverageSummary).toHaveBeenLastCalledWith({ root, timeoutMs: 3_600_000, workers: 1 });
        expect(rows()).toMatchObject([{ check: "coverage:index", status: "passed", reused: true }]);
    });
});

describe("coverage check --from-index — negative (must not fire)", () => {
    // test-contract: invariant — when the index cannot certify, the command produces NO verdict: exit 75 (the no-verdict code the pre-push hook already distinguishes), no findings, and a row naming the reason as reuse_denied_reason
    it("N1: an uncertified index is exit 75 with the reason on the ledger row, never a pass", async () => {
        indexedCoverageSummary.mockResolvedValue({ indexed: false, reason: "Unstable or incomplete shard requires a full warm run", validate_ms: 2, exec_ms: 7 });
        await coverageCheckCommand({ fromIndex: true, cwd: root, strict: true, json: true });
        expect(process.exitCode).toBe(75);
        expect(rows()).toMatchObject([{ check: "coverage:index", status: "unavailable", reused: false, reuse_denied_reason: "plan-not-reusable:Unstable or incomplete shard requires a full warm run" }]);
    });
    // test-contract: invariant — the ratchet's partial-report verdict leaves findings EMPTY, so an index summary it judges partial must be exit 75 with an unavailable row (never "passed", whatever --strict says)
    it("N3: an index summary the ratchet judges partial is exit 75 and an unavailable row, not a pass", async () => {
        const paths = Array.from({ length: 20 }, (_, index) => `src/p${index}.ts`);
        writeFileSync(join(root, ".interlinked", "coverage-baseline.json"), JSON.stringify({ version: 1, updated_at: "1970-01-01T00:00:00.000Z", files: Object.fromEntries(paths.map(path => [path, { lines_pct: 90, branches_pct: 90 }])) }));
        const zero = { pct: 0, covered: 0, total: 10 };
        indexedCoverageSummary.mockResolvedValue({ indexed: true, summary: Object.fromEntries(paths.map(path => [path, { lines: zero, branches: zero, functions: zero, statements: zero }])), rerunTests: 0, universeTests: 20, validate_ms: 1, exec_ms: 2 });
        await coverageCheckCommand({ fromIndex: true, cwd: root, strict: true, json: true });
        expect(process.exitCode).toBe(75);
        expect(rows()).toMatchObject([{ check: "coverage:index", status: "unavailable", reused: true, reuse_denied_reason: expect.stringMatching(/^plan-not-reusable:partial-report:/) }]);
    });
    // test-contract: invariant — a failure the index route THROWS past its own handling is still no verdict at the command: exit 75 and an unavailable row carrying the message, never the generic exit-1 error path without a row
    it("N4: a thrown index failure is exit 75 with an unavailable row", async () => {
        indexedCoverageSummary.mockRejectedValue(new Error("Coverage runtime validation deadline exhausted; index unavailable"));
        await coverageCheckCommand({ fromIndex: true, cwd: root, strict: true, json: true });
        expect(process.exitCode).toBe(75);
        expect(rows()).toMatchObject([{ check: "coverage:index", status: "unavailable", reuse_denied_reason: "plan-not-reusable:Coverage runtime validation deadline exhausted; index unavailable" }]);
    });
    it("N2: an out-of-range timeout is refused before any measurement", async () => {
        await coverageCheckCommand({ fromIndex: true, cwd: root, json: true, timeout: "0" });
        expect(process.exitCode).toBe(1);
        expect(indexedCoverageSummary).not.toHaveBeenCalled();
    });
    // test-contract: boundary — --workers is a bounded integer 1-64: zero, above the cap, fractional and non-numeric values are refused (exit 1) before any measurement, so a typo never reaches the host governor
    it("N5: an invalid --workers value is refused before any measurement", async () => {
        for (const workers of ["0", "65", "1.5", "many"]) {
            process.exitCode = undefined;
            await coverageCheckCommand({ fromIndex: true, cwd: root, json: true, workers });
            expect(process.exitCode).toBe(1);
        }
        expect(indexedCoverageSummary).not.toHaveBeenCalled();
    });
    // test-contract: bug — a rejection that is not an Error object (a bare string) is still no verdict: exit 75, with the value itself as the ledger row's reason
    it("N6: a non-Error rejection is exit 75 with its text as the reason", async () => {
        indexedCoverageSummary.mockRejectedValue("index exploded");
        await coverageCheckCommand({ fromIndex: true, cwd: root, strict: true, json: true });
        expect(process.exitCode).toBe(75);
        expect(rows()).toMatchObject([{ check: "coverage:index", status: "unavailable", reuse_denied_reason: "plan-not-reusable:index exploded" }]);
    });
    // test-contract: public-api — a valid --workers value is forwarded to the index measurement unchanged as a number (the upper bound 64 included)
    it("P3: forwards a valid --workers value", async () => {
        indexedCoverageSummary.mockResolvedValue({ indexed: true, summary: { "src/a.ts": { lines: { pct: 95, covered: 19, total: 20 }, branches: { pct: 50, covered: 1, total: 2 }, functions: { pct: 100, covered: 1, total: 1 } } }, rerunTests: 0, universeTests: 5, validate_ms: 3, exec_ms: 1 });
        await coverageCheckCommand({ fromIndex: true, cwd: root, json: true, workers: "64" });
        expect(indexedCoverageSummary).toHaveBeenLastCalledWith(expect.objectContaining({ workers: 64 }));
    });
});
