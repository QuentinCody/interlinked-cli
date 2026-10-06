import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookCoverageReport } from "../harness/hook-coverage-control.js";
import type { TestRunObservation } from "../harness/test-run-observation.js";
import { harnessCoverageVerifyCommand } from "./harness-coverage-verify.js";

const query = vi.hoisted(() => vi.fn());
const testObservation = vi.hoisted(() => vi.fn<() => TestRunObservation | null>(() => null));
const originalTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
vi.mock("./harness-capabilities.js", () => ({ queryHookCoverage: query }));
vi.mock("../harness/test-run-observation.js", () => ({ readTestRunObservation: testObservation }));
// Route promise delays through Vitest's clock too, so long waits are deterministic.
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }));
beforeEach(() => {
    query.mockReset();
    testObservation.mockReset();
    process.exitCode = 0;
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
    process.exitCode = 0; vi.useRealTimers(); vi.restoreAllMocks();
    if (originalTty) Object.defineProperty(process.stderr, "isTTY", originalTty);
    else Reflect.deleteProperty(process.stderr, "isTTY");
});

function report(status: "running" | "complete", findings = 0): HookCoverageReport {
    return { readiness: "ready", changed: true, pending: [], verification: {
        id: "run", status, total: 1, processed: status === "complete" ? 1 : 0,
        checked: status === "complete" ? 1 : 0, findings, unmeasured: [],
    } };
}

function progress(status: "running" | "complete"): HookCoverageReport {
    return { readiness: "ready", generation: 1, progress: { observedAt: "2026-09-14T12:00:00Z", pendingCount: 0,
        verification: { id: "run", status, total: 1, processed: status === "complete" ? 1 : 0,
            checked: status === "complete" ? 1 : 0, findings: 0, unmeasuredCount: 0 } } };
}

describe("harness coverage verify CLI", () => {
    it("shows periodic terminal progress during a slow batch while keeping JSON stdout clean", async () => {
        Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        query.mockResolvedValue({ ...progress("running"), changed: true });
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(21000);
        expect(stderr).toHaveBeenCalledTimes(3);
        expect(stderr.mock.calls[0]?.[0]).toContain("0/1 versions processed");
        expect(stderr.mock.calls[2]?.[0]).toContain("20s");
        expect(console.log).not.toHaveBeenCalled();
        query.mockResolvedValue(report("complete"));
        await vi.advanceTimersByTimeAsync(1000);
        await completion;
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(report("complete"));
    });

    it("keeps redirected JSON commands free of progress output", async () => {
        Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce(report("complete"));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(1000);
        await completion;
        expect(stderr).not.toHaveBeenCalled();
        expect(testObservation).not.toHaveBeenCalled();
    });

    it("labels the latest project test observation separately from verification progress", async () => {
        Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        testObservation.mockReturnValue({ runId: "unrelated", pid: 123, observedAt: "2026-10-05T22:00:00Z",
            status: "running", snapshot: "old", tests: ["one.test.ts", "two.test.ts"], reused: false });
        const initial = report("running", 2);
        initial.verification!.unmeasured = ["test unavailable"];
        query.mockResolvedValueOnce(initial).mockResolvedValueOnce(report("complete"));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(1000);
        await completion;
        expect(stderr.mock.calls.map(call => call[0])).toEqual([
            expect.stringContaining("2 findings; 1 unavailable details"),
            "[coverage] Latest project test observation: 2 files, running, recorded 2026-10-05T22:00:00Z.\n",
        ]);
        expect(testObservation).toHaveBeenCalledExactlyOnceWith(process.cwd());
    });
    it("waits for a compact start acknowledgement and still fetches full final evidence", async () => {
        const initial = { ...progress("running"), changed: true };
        query.mockResolvedValueOnce(initial).mockResolvedValueOnce(progress("complete")).mockResolvedValueOnce(report("complete"));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(2000);
        await completion;
        expect(process.exitCode).toBe(0);
        expect(query.mock.calls.map(call => call[1])).toEqual([
            { operation: "verify", detail: "progress" }, { operation: "status", detail: "progress" }, { operation: "status", detail: "verification" },
        ]);
    });

    it("does not certify an incomplete run with no findings or pending versions", async () => {
        const incomplete = report("complete");
        incomplete.verification!.checked = 0;
        incomplete.verification!.unmeasured = ["check did not run"];
        query.mockResolvedValue(incomplete);
        await harnessCoverageVerifyCommand({ json: true });
        expect(process.exitCode).toBe(1);
    });

    it("prints compact background acknowledgement as a running job", async () => {
        query.mockResolvedValue({ ...progress("running"), changed: true });
        await harnessCoverageVerifyCommand({ wait: false });
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("Verification running");
        expect(process.exitCode).toBe(0);
    });

    it("reports success only after the matching full completion report", async () => {
        const final = report("complete");
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce(progress("complete")).mockResolvedValueOnce(final);
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(2000);
        await completion;
        expect(process.exitCode).toBe(0);
        expect(query).toHaveBeenLastCalledWith(process.cwd(), { operation: "status" });
        expect(JSON.parse(vi.mocked(console.log).mock.calls.flat().join(" "))).toEqual(final);
    });

    it("refreshes full evidence after compact completion and catches newer pending versions", async () => {
        const final = report("complete");
        final.pending = [{ id: "new", path: "/workspace/new.ts", identity: "hash", scope: "reservation", writer: "unknown" }];
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce(progress("running"))
            .mockResolvedValueOnce(progress("complete")).mockResolvedValueOnce(final);
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(3000);
        await completion;
        expect(query.mock.calls.map(call => call[1])).toEqual([
            { operation: "verify", detail: "progress" }, { operation: "status", detail: "progress" },
            { operation: "status", detail: "progress" }, { operation: "status" },
        ]);
        expect(process.exitCode).toBe(1);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("/workspace/new.ts");
    });

    it("prints final detailed failures rather than certifying compact counters", async () => {
        const final = report("complete", 1);
        final.verification!.unmeasured = ["security tool unavailable"];
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce(progress("complete")).mockResolvedValueOnce(final);
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(2000);
        await completion;
        expect(process.exitCode).toBe(1);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("security tool unavailable");
    });

    it.each([report("running"), { readiness: "ready" }, progress("complete"),
        { ...report("complete"), verification: { ...report("complete").verification!, id: "replacement" } },
    ])("refuses an incomplete or changed final report: %j", async final => {
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce(progress("complete")).mockResolvedValueOnce(final);
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(2000);
        await completion;
        expect(process.exitCode).toBe(1);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("Final verification state changed or is incomplete");
    });

    it("cannot turn an unavailable final refresh into a clean exit", async () => {
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce(progress("complete"))
            .mockResolvedValue({ readiness: "unmeasured", reason: "final refresh timed out" });
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(121_000);
        await completion;
        expect(process.exitCode).toBe(1);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("final refresh timed out");
    });

    it("starts a background job without polling when requested", async () => {
        query.mockResolvedValue(report("running"));
        await harnessCoverageVerifyCommand({ json: true, wait: false });
        expect(query).toHaveBeenCalledExactlyOnceWith(process.cwd(), { operation: "verify", detail: "progress" });
        expect(process.exitCode).toBe(0);
    });

    it.each([0, 2])("waits for completion and reports exit status for %i findings", async findings => {
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce(report("complete", findings));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(1000);
        await completion;
        expect(query).toHaveBeenLastCalledWith(process.cwd(), { operation: "status", detail: "progress" });
        expect(process.exitCode).toBe(findings > 0 ? 1 : 0);
    });

    it("refuses a clean exit when pending versions remain after a run", async () => {
        const result = report("complete");
        result.pending = [{ id: "pending", path: "/workspace/a.ts", identity: "hash", scope: "reservation", writer: "unknown" }];
        query.mockResolvedValue(result);
        await harnessCoverageVerifyCommand({ json: true });
        expect(process.exitCode).toBe(1);
    });

    it("reports an interrupted run when the daemon loses the job", async () => {
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce({ readiness: "ready", pending: [] });
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(1000);
        await completion;
        expect(process.exitCode).toBe(1);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("daemon restarted");
    });

    it("waits through transient status failures without starting another verification", async () => {
        query.mockResolvedValueOnce(report("running"))
            .mockResolvedValueOnce({ readiness: "unmeasured", reason: "timeout" })
            .mockResolvedValueOnce({ readiness: "unmeasured", reason: "timeout" })
            .mockResolvedValueOnce(report("complete"));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(3000);
        await completion;
        expect(query.mock.calls.map(call => call[1])).toEqual([
            { operation: "verify", detail: "progress" }, { operation: "status", detail: "progress" }, { operation: "status", detail: "progress" }, { operation: "status", detail: "progress" },
        ]);
        expect(process.exitCode).toBe(0);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain('"status": "complete"');
    });

    it("resets the unavailable poll budget after a responsive running report", async () => {
        const unavailable = async () => {
            await new Promise(resolve => setTimeout(resolve, 35_000));
            return { readiness: "unmeasured", reason: "timeout" };
        };
        query.mockResolvedValueOnce(report("running"))
            .mockImplementationOnce(unavailable).mockImplementationOnce(unavailable)
            .mockResolvedValueOnce(report("running"))
            .mockImplementationOnce(unavailable).mockImplementationOnce(unavailable)
            .mockResolvedValueOnce(report("complete"));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(146_000);
        await completion;
        expect(query).toHaveBeenCalledTimes(7);
        expect(query).toHaveBeenLastCalledWith(process.cwd(), { operation: "status", detail: "progress" });
        expect(process.exitCode).toBe(0);
    });

    it("survives a minute of slow control timeouts without resubmitting verification", async () => {
        Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const timeout = async () => {
            await new Promise(resolve => setTimeout(resolve, 20_000));
            return { readiness: "unmeasured", reason: "socket timeout" };
        };
        query.mockResolvedValueOnce(report("running"))
            .mockImplementationOnce(timeout).mockImplementationOnce(timeout).mockImplementationOnce(timeout)
            .mockResolvedValueOnce(report("complete"));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(65_000);
        await completion;
        expect(process.exitCode).toBe(0);
        expect(query.mock.calls.filter(call => call[1].operation === "verify")).toHaveLength(1);
        expect(stderr.mock.calls.some(call => String(call[0]).includes("temporarily unavailable"))).toBe(true);
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(report("complete"));
    });

    it("does not retry host permission denial while waiting", async () => {
        query.mockResolvedValueOnce(report("running")).mockResolvedValueOnce({
            readiness: "unmeasured", retryable: false, reason: "Host permission denied",
        });
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(1000);
        await completion;
        expect(query).toHaveBeenCalledTimes(2);
        expect(process.exitCode).toBe(1);
    });

    it.each([true, false])("bounds unavailable polling and preserves its reason with json=%s", async json => {
        query.mockResolvedValueOnce(report("running"))
            .mockResolvedValue({ readiness: "unmeasured", reason: "Coverage socket timed out" });
        const completion = harnessCoverageVerifyCommand({ json });
        await vi.advanceTimersByTimeAsync(120_000);
        await completion;
        expect(query.mock.calls.length).toBeGreaterThan(4);
        expect(query.mock.calls.length).toBeLessThanOrEqual(121);
        expect(process.exitCode).toBe(1);
        const printed = vi.mocked(console.log).mock.calls.flat().join(" ");
        expect(printed).toContain("Coverage socket timed out");
        expect(printed).toContain("may still be running");
        expect(printed).not.toContain("daemon restarted");
    });

    it("fails when the running daemon cannot start verification", async () => {
        query.mockResolvedValue({ readiness: "ready", changed: false });
        await harnessCoverageVerifyCommand({ json: true });
        expect(process.exitCode).toBe(1);
    });
});
