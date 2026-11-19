import { describe, expect, it } from "vitest";
import { hasPublicHttpUrl } from "./network-hosts.js";

describe("network-hosts mutation-kill", () => {
	// test-contract: boundary — a double-quoted loopback URL with a port and no path is not public egress
	it("treats a double-quoted loopback URL without a path as non-public", () => {
		expect(hasPublicHttpUrl('curl "http://127.0.0.1:8790"')).toBe(false);
	});

	// test-contract: boundary — a double-quoted public URL without a path is still public egress
	it("treats a double-quoted public URL without a path as public", () => {
		expect(hasPublicHttpUrl('curl "https://example.com"')).toBe(true);
	});
});
