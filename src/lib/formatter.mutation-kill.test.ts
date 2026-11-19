import { afterEach, describe, expect, it, vi } from "vitest";
import { relativeTime } from "./formatter.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
	vi.useRealTimers();
});

describe("relativeTime — census kill", () => {
	// test-contract: boundary — exactly 30 days old falls back to a calendar date, 29 days stays relative
	it("switches from Nd ago to a date at exactly 30 days", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const thirty = new Date(NOW.getTime() - 30 * DAY_MS);
		expect(relativeTime(new Date(NOW.getTime() - 29 * DAY_MS).toISOString())).toBe("29d ago");
		expect(relativeTime(thirty.toISOString())).toBe(thirty.toLocaleDateString());
		expect(relativeTime(thirty.toISOString())).not.toBe("30d ago");
	});
});
