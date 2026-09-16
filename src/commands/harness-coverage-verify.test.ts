import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookCoverageReport } from "../harness/hook-coverage-control.js";
import { harnessCoverageVerifyCommand } from "./harness-coverage-verify.js";

const query = vi.hoisted(() => vi.fn());
vi.mock("./harness-capabilities.js", () => ({ queryHookCoverage: query }));
beforeEach(() => {
    query.mockReset();
    process.exitCode = 0;
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { process.exitCode = 0; vi.useRealTimers(); vi.restoreAllMocks(); });

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
            { operation: "verify" }, { operation: "status", detail: "progress" },
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
        await vi.advanceTimersByTimeAsync(4000);
        await completion;
        expect(process.exitCode).toBe(1);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("final refresh timed out");
    });

    it("starts a background job without polling when requested", async () => {
        query.mockResolvedValue(report("running"));
        await harnessCoverageVerifyCommand({ json: true, wait: false });
        expect(query).toHaveBeenCalledExactlyOnceWith(process.cwd(), { operation: "verify" });
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
            { operation: "verify" }, { operation: "status", detail: "progress" }, { operation: "status", detail: "progress" }, { operation: "status", detail: "progress" },
        ]);
        expect(process.exitCode).toBe(0);
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain('"status": "complete"');
    });

    it("resets the unavailable poll budget after a responsive running report", async () => {
        const unavailable = { readiness: "unmeasured", reason: "timeout" };
        query.mockResolvedValueOnce(report("running"))
            .mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable)
            .mockResolvedValueOnce(report("running"))
            .mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable)
            .mockResolvedValueOnce(report("complete"));
        const completion = harnessCoverageVerifyCommand({ json: true });
        await vi.advanceTimersByTimeAsync(6000);
        await completion;
        expect(query).toHaveBeenCalledTimes(7);
        expect(query).toHaveBeenLastCalledWith(process.cwd(), { operation: "status", detail: "progress" });
        expect(process.exitCode).toBe(0);
    });

    it.each([true, false])("bounds unavailable polling and preserves its reason with json=%s", async json => {
        query.mockResolvedValueOnce(report("running"))
            .mockResolvedValue({ readiness: "unmeasured", reason: "Coverage socket timed out" });
        const completion = harnessCoverageVerifyCommand({ json });
        await vi.advanceTimersByTimeAsync(3000);
        await completion;
        expect(query).toHaveBeenCalledTimes(4);
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
