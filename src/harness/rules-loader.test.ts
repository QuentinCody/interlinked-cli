import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { DEFAULT_CONFIG } from "./rules/default-config.js";
import { getDefaultConfig } from "./rules-loader.js";

describe("getDefaultConfig", () => {
	it("returns a deep clone whose nested objects are not the shared DEFAULT_CONFIG references", () => {
		const config = getDefaultConfig();
		expect(config.quality_checks).not.toBe(DEFAULT_CONFIG.quality_checks);
		expect(config.version).toBe(1);
		expect(config.taint_tracking.step_limits.Public).toBe(Number.POSITIVE_INFINITY);
	});

	it("isolates nested mutations from defaults and future loads", () => {
		const config = getDefaultConfig();
		const original = structuredClone(nonNull(DEFAULT_CONFIG.quality_checks.typescript));
		const check = nonNull(config.quality_checks.typescript);
		check.enabled = !original.enabled;
		check.file_types.push(".isolated-fixture");
		expect(DEFAULT_CONFIG.quality_checks.typescript).toEqual(original);
		expect(getDefaultConfig().quality_checks.typescript).toEqual(original);
	});
});
