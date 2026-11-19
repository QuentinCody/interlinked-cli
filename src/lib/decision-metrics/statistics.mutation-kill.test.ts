import { describe, expect, it } from "vitest";
import { binaryStatistics } from "./statistics.js";

describe("binaryStatistics — census kill", () => {
	// test-contract: boundary — probability exactly 1 lands in the top reliability bin, not outside all bins
	it("counts probability 1.0 in the last bin", () => {
		const stats = binaryStatistics([{ positive: true, probability: 1 }]);
		expect(stats.bins[9]?.count).toBe(1);
		expect(stats.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(1);
		expect(stats.ece).toBe(0);
	});
});
