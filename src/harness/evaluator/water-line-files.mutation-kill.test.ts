import { describe, expect, it } from "vitest";
import { isWaterLinePath, waterLineStem } from "./water-line-files.js";

describe("water-line path anchoring", () => {
	// test-contract: bug — a directory merely ending in `.interlinked` is not the `.interlinked/` directory
	it("rejects foo.interlinked/metric-caps.json", () => {
		expect(isWaterLinePath("/repo/foo.interlinked/metric-caps.json")).toBe(false);
		expect(waterLineStem("/repo/foo.interlinked/metric-caps.json")).toBeNull();
	});

	// test-contract: invariant — a real `.interlinked/` directory still matches, absolute or relative
	it("accepts the real .interlinked directory", () => {
		expect(waterLineStem("/repo/.interlinked/metric-caps.json")).toBe("metric-caps");
		expect(waterLineStem(".interlinked/metric-caps.json")).toBe("metric-caps");
	});
});
