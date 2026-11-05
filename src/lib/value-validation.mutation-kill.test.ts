import { expect, it } from "vitest";
import { parseWire, wireNumber, wireObject } from "./value-validation.js";

// test-contract: invariant — a wire number is a FINITE number: NaN and ±Infinity are not representable in JSON and must not pass validation
it("rejects non-finite numbers", () => {
	expect(wireNumber(Number.NaN)).toBe(false);
	expect(wireNumber(Number.POSITIVE_INFINITY)).toBe(false);
	expect(() => parseWire({ count: Number.NEGATIVE_INFINITY }, wireObject({ count: wireNumber }), "count record")).toThrow("Invalid count record");
});
