import { describe, expect, it } from "vitest";
import { currentProcessSignal, withProcessCancellation } from "../../harness/check-engine/process-cancellation.js";
import { currentScanLedger, withVerifyTimings } from "./check-timing.js";
import { emptyToolReport, runUntilSoftDeadline } from "./batch-deadline.js";

describe("emptyToolReport", () => {
	it("P1: names the reason as one timeout skip entry and holds no results", () => {
		const report = emptyToolReport("external_tools", "soft deadline");
		expect(report.results).toEqual([]);
		expect(report.skipped).toEqual([{ check: "external_tools", reason: "soft deadline", category: "timeout" }]);
	});
});

describe("runUntilSoftDeadline", () => {
	it("P2: returns the work result when no deadline is set", async () => {
		await withVerifyTimings("/tmp", async () => {
			expect(await runUntilSoftDeadline("external_tools", async () => 7, () => -1)).toBe(7);
			expect(currentScanLedger()?.partial).toBeNull();
		});
	});
	it("P3: stops waiting at the deadline, marks the run partial and returns the fallback", async () => {
		await withVerifyTimings("/tmp", async () => {
			const never = (): Promise<number> => new Promise((_resolve, reject) => {
				const signal = currentProcessSignal();
				signal?.addEventListener("abort", () => reject(signal.reason));
			});
			const out = await runUntilSoftDeadline("external_tools", async () => never(), () => -1);
			expect(out).toBe(-1);
			expect(currentScanLedger()?.partial?.phase).toBe("external_tools");
		}, { deadlineAt: Date.now() + 30 });
	});
	it("N1: an abort from the owning command is not turned into a partial report", async () => {
		const controller = new AbortController();
		await withVerifyTimings("/tmp", async () => {
			await expect(withProcessCancellation(controller.signal, () => runUntilSoftDeadline("external_tools", async () => {
				controller.abort(new Error("SIGTERM"));
				throw controller.signal.reason;
			}, () => -1))).rejects.toThrow("SIGTERM");
		}, { deadlineAt: Date.now() + 60_000 });
	});
});
