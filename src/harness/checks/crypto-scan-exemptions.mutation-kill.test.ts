import { describe, expect, it } from "vitest";
import { stripWeakHashNonCalls } from "./crypto-scan-exemptions.js";

describe("stripWeakHashNonCalls — JSX text", () => {
	// test-contract: public-api — single-line JSX text naming sha1 is removed in `.jsx` files as in `.tsx`.
	it("strips JSX text that names a hash in a .jsx file", () => {
		expect(stripWeakHashNonCalls("<p>sha1</p>", "src/view.jsx")).toBe("<p></p>");
	});
});
