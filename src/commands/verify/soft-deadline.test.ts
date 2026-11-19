import { describe, expect, it } from "vitest";
import { SOFT_DEADLINE_ENV, resolveSoftDeadline, softDeadlineFor } from "./soft-deadline.js";

describe("softDeadlineFor", () => {
	it("P1: leaves 20 percent of a short timeout for printing the partial report", () => {
		expect(softDeadlineFor(1000, 10_000)).toBe(1000 + 10_000 - 2000);
	});
	it("P2: caps the printing margin at 30 seconds for a long timeout", () => {
		expect(softDeadlineFor(0, 840_000)).toBe(810_000);
	});
	it("N1: no timeout means no soft deadline", () => {
		expect(softDeadlineFor(0, 0)).toBeUndefined();
		expect(softDeadlineFor(0, undefined)).toBeUndefined();
	});
});

describe("resolveSoftDeadline", () => {
	it("P3: the supervisor's absolute deadline in the environment wins", () => {
		expect(resolveSoftDeadline(5000, 100, { [SOFT_DEADLINE_ENV]: "777" })).toBe(777);
	});
	it("P4: without the variable the command's own timeout counts from now", () => {
		expect(resolveSoftDeadline(10_000, 100, {})).toBe(100 + 10_000 - 2000);
	});
	it("N2: a malformed variable is ignored", () => {
		expect(resolveSoftDeadline(undefined, 100, { [SOFT_DEADLINE_ENV]: "soon" })).toBeUndefined();
	});
});
