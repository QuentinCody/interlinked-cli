import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./rules/default-config.js";
import { getDefaultConfig } from "./rules-loader.js";

describe("getDefaultConfig", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a deep clone whose nested objects are not the shared DEFAULT_CONFIG references", () => {
		const config = getDefaultConfig();
		expect(config.quality_checks).not.toBe(DEFAULT_CONFIG.quality_checks);
		expect(config.version).toBe(1);
	});

	it("falls back to a shallow clone (nested refs preserved) when JSON.stringify throws", () => {
		// Force the try-branch's JSON.parse(JSON.stringify(...)) round trip to
		// fail so the catch branch's shallow-spread fallback runs. The
		// discriminator is object identity: the successful path fully
		// serializes/deserializes DEFAULT_CONFIG, producing a brand-new
		// `quality_checks` object, while the fallback only spreads the
		// top level, so `quality_checks` stays the SAME reference as
		// DEFAULT_CONFIG's. Inverting the fallback (e.g. deep-cloning there
		// too) would make this assertion fail.
		vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
			throw new Error("stringify boom");
		});
		const config = getDefaultConfig();
		expect(config.quality_checks).toBe(DEFAULT_CONFIG.quality_checks);
		expect(config.rules).toEqual([]);
	});
});
