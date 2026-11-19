import { describe, expect, it } from "vitest";
import { REDIS_FOOTGUNS } from "./redis.js";

describe("redis_set_without_expire — PXAT", () => {
	// test-contract: public-api — SET with a PXAT absolute expiry option has an expiry and is not flagged.
	it("does not fire when the PXAT option is supplied", () => {
		const fg = REDIS_FOOTGUNS.find((g) => g.id === "redis_set_without_expire");
		if (!fg) throw new Error("not registered");
		expect(fg.detect("await redis.set(key, { PXAT: 1700000000000 });", "src/x.ts")).toEqual([]);
	});
});
