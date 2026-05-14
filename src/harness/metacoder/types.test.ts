import { describe, expect, it } from "vitest";

import {
	DEFAULT_METACODER_CONFIG,
	METACODER_TIMEOUT_DEFAULT_MS,
	USER_PROMPT_HOOK_TIMEOUT_MS,
} from "./types.js";

describe("DEFAULT_METACODER_CONFIG", () => {
	it("has the metacoder enabled by default", () => {
		expect(DEFAULT_METACODER_CONFIG.enabled).toBe(true);
	});

	it("uses the named timeout default", () => {
		expect(DEFAULT_METACODER_CONFIG.timeout_ms).toBe(METACODER_TIMEOUT_DEFAULT_MS);
	});
});

describe("hook / metacoder timeout pairing", () => {
	// Plan §2.4 contract: the hook waits strictly longer than the metacoder so
	// the harness can convert a clean timeout into an allow decision before
	// the socket gives up. Drift means 100% cold-fallback.
	it("USER_PROMPT_HOOK_TIMEOUT_MS exceeds METACODER_TIMEOUT_DEFAULT_MS with a buffer", () => {
		const buffer = USER_PROMPT_HOOK_TIMEOUT_MS - METACODER_TIMEOUT_DEFAULT_MS;
		expect(buffer).toBeGreaterThanOrEqual(2_000);
	});
});
