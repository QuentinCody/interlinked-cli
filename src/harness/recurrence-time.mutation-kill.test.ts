import { describe, expect, it } from "vitest";
import { parseDurationMs, resolveSinceCutoff, updateSeenBounds } from "./recurrence-time.js";

describe("week durations — mutation-directed", () => {
	// test-contract: public-api — `--since 1w` means exactly seven days; the week unit was the only one no test pinned
	it("parses one week as seven days of milliseconds", () => {
		expect(parseDurationMs("1w")).toBe(7 * 24 * 60 * 60 * 1000);
	});

	// test-contract: public-api — a two-week --since cutoff lands exactly fourteen days before the reference clock
	it("resolves a week-relative cutoff to the calendar date fourteen days back", () => {
		expect(resolveSinceCutoff("2w", new Date("2026-05-15T12:00:00.000Z"))).toBe("2026-05-01T12:00:00.000Z");
	});
});

describe("duration grammar is anchored — mutation-directed", () => {
	// test-contract: boundary — a duration with a leading non-space prefix ("x1w") is not a duration; the start anchor must reject it
	it("rejects a duration preceded by junk text", () => {
		expect(parseDurationMs("x1w")).toBeNull();
	});

	// test-contract: boundary — only whitespace may separate the amount from its unit; "1xw" must not parse as one week
	it("rejects non-whitespace between the amount and the unit", () => {
		expect(parseDurationMs("1xw")).toBeNull();
	});
});

describe("updateSeenBounds keeps the first observation on a tie — mutation-directed", () => {
	// test-contract: invariant — an equal-instant timestamp is not EARLIER, so first_seen keeps the string it already recorded
	it("does not replace first_seen with an equal instant spelled differently", () => {
		const row = { first_seen: "2026-05-01T00:00:00Z", last_seen: "2026-05-02T00:00:00Z" };
		updateSeenBounds(row, "2026-05-01T00:00:00.000Z");
		expect(row.first_seen).toBe("2026-05-01T00:00:00Z");
	});
});
