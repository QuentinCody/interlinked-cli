import { describe, expect, it } from "vitest";
import { notMeasuredReason, type PendingHandle, pendingHandlesFrom } from "./gate-errors.js";

describe("pendingHandlesFrom", () => {
	it("returns the error itself when it is a bare handle", () => {
		const handle: PendingHandle = { jobId: "j1", runnerUrl: "http://runner" };
		expect(pendingHandlesFrom(handle)).toEqual([handle]);
	});

	it("returns the nested pending array, filtered to well-formed handles", () => {
		const good: PendingHandle = { jobId: "j2", runnerUrl: "http://runner" };
		const err = { pending: [good, { jobId: 1, runnerUrl: "http://x" }, null, "nope"] };
		expect(pendingHandlesFrom(err)).toEqual([good]);
	});

	it("returns an empty array for a non-object throw", () => {
		expect(pendingHandlesFrom("boom")).toEqual([]);
		expect(pendingHandlesFrom(null)).toEqual([]);
		expect(pendingHandlesFrom(undefined)).toEqual([]);
	});

	it("returns an empty array when pending is not an array", () => {
		expect(pendingHandlesFrom({ pending: { jobId: "j", runnerUrl: "u" } })).toEqual([]);
	});
});

describe("notMeasuredReason", () => {
	it("reports a still-running job whenever handles were recovered", () => {
		expect(notMeasuredReason(new Error("whatever"), 2)).toBe("mutation still running past the budget");
	});

	it("reports a busy runner by error name", () => {
		const err = Object.assign(new Error("nope"), { name: "MutationRunnerBusyError" });
		expect(notMeasuredReason(err, 0)).toContain("busy with another job");
	});

	it("reports a busy runner by HTTP 503 message", () => {
		expect(notMeasuredReason(new Error("runner said HTTP 503 Service Unavailable"), 0)).toContain(
			"busy with another job",
		);
	});

	it("reports the no-tests not-measurable reason with actionable wording", () => {
		const err = Object.assign(new Error("x"), { name: "MutationNotMeasurableError", reason: "no_tests" });
		expect(notMeasuredReason(err, 0)).toBe(
			"no test exercises this file, so mutation cannot measure it — add one and the gate starts protecting this code",
		);
	});

	it("quotes any other not-measurable reason", () => {
		const err = Object.assign(new Error("x"), { name: "MutationNotMeasurableError", reason: "engine_missing" });
		expect(notMeasuredReason(err, 0)).toBe("mutation not measurable here (engine_missing)");
	});

	it("falls back to 'unspecified' when the not-measurable reason is empty", () => {
		const err = Object.assign(new Error("x"), { name: "MutationNotMeasurableError", reason: "" });
		expect(notMeasuredReason(err, 0)).toBe("mutation not measurable here (unspecified)");
	});

	it("quotes the runner's own failure message", () => {
		expect(notMeasuredReason(new Error("  clone failed  "), 0)).toBe(
			"the mutation runner failed — clone failed",
		);
	});

	it("falls back to the bare failure string when there is no message", () => {
		expect(notMeasuredReason({}, 0)).toBe("the mutation runner failed");
		expect(notMeasuredReason(new Error("   "), 0)).toBe("the mutation runner failed");
		expect(notMeasuredReason("boom", 0)).toBe("the mutation runner failed");
	});
});
