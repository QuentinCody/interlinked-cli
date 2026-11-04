import { describe, expect, it } from "vitest";
import { parseDurationMs, resolveSinceCutoff } from "./recurrence-time.js";

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
